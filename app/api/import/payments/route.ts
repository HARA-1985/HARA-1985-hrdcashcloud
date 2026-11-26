import { authorize, json, payeeDefaults } from "@/lib/server";

export const runtime = "nodejs";

interface Row { date: string; payee: string; item?: string; amount: number | string; kind?: string; method?: string }

/**
 * 請求書のない支払（口座引落・税金・社会保険・借入返済・給与など）をまとめて登録する。
 * 同じ日付・支払先・金額の支払予定がすでにあれば二重登録しない。
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { companyId?: string; rows?: Row[] };
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (!a.role || !["owner", "approver", "member"].includes(a.role)) return json({ error: "この会社に登録する権限がありません" }, 403);
  const { admin } = a; const cid = body.companyId!;
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const rows = (body.rows ?? []).slice(0, 1000).map((r) => ({
    date: String(r.date ?? "").trim().replace(/\//g, "-"), payee: String(r.payee ?? "").trim(), item: String(r.item ?? "").trim(),
    amount: Number(String(r.amount ?? "").replace(/[^\d]/g, "")), kind: /臨時|spot/.test(String(r.kind ?? "")) ? "spot" : "fixed",
    method: /振込/.test(String(r.method ?? "")) ? "振込" : "引落",
  }));
  const invalid = rows.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !r.payee || !r.amount).map((r) => `${r.date} ${r.payee}`);
  const ok = rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.payee && r.amount);
  if (!ok.length) return json({ ok: true, added: 0, already: 0, invalid });
  const dates = [...new Set(ok.map((r) => r.date))];
  const { data: exist } = await admin.from("payments").select("due_date, payee_name, amount").eq("company_id", cid).in("due_date", dates);
  const key = (d: string, p: string, n: number) => `${d}|${p}|${n}`;
  const have = new Set((exist ?? []).map((e) => key(e.due_date, e.payee_name, e.amount)));
  const toAdd = ok.filter((r) => !have.has(key(r.date, r.payee, r.amount)));
  const names = [...new Set(toAdd.map((r) => r.payee))];
  if (names.length) await admin.from("payees").upsert(names.map((name) => ({ company_id: cid, name })), { onConflict: "company_id,name", ignoreDuplicates: true });
  const { data: payees } = await admin.from("payees").select("id, name").eq("company_id", cid);
  const pid = new Map((payees ?? []).map((p) => [p.name, p.id]));
  const dflt = await payeeDefaults(admin, cid);
  let added = 0; const errors: string[] = [];
  for (let i = 0; i < toAdd.length; i += 200) {
    const chunk = toAdd.slice(i, i + 200);
    const { error } = await admin.from("payments").insert(chunk.map((r) => ({
      company_id: cid, due_date: r.date, payee_id: pid.get(r.payee) ?? null, payee_name: r.payee, item: r.item || null, amount: r.amount,
      kind: r.kind, source: "manual", account_title: dflt.get(r.payee)?.account_title ?? "未払金",
      bank_account_id: dflt.get(r.payee)?.bank_account_id ?? null, cf_item: dflt.get(r.payee)?.cf_item ?? null,
      status: r.date <= today ? "paid" : r.method === "引落" ? "auto_debit" : "pending", created_by: a.user.id,
    })));
    if (error) errors.push(error.message); else added += chunk.length;
  }
  await admin.from("audit_logs").insert({ company_id: cid, actor: a.user.id, action: "import", table_name: "payments", detail: { source: "manual_list", added } });
  return json({ ok: !errors.length, added, already: ok.length - toAdd.length, invalid, errors });
}
