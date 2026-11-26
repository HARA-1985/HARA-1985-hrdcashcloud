import { authorize, json } from "@/lib/server";

export const runtime = "nodejs";

/**
 * 銀行の出金明細（出金伝票）から、各支払の振込元口座を特定して payments.bank_account_id に反映する。
 * rows: { bank: 口座の名前（例「三菱UFJ銀行」「みずほ銀行」）, date: YYYY-MM-DD, amount, payee?: 相手先（任意） }
 * - 金額が一致し、日付が近い（±7日）支払に口座を付ける。相手先が書かれていれば名前の近いものを優先
 * - propagate=true のとき、支払先ごとに直近で特定できた口座を、その支払先の今後の未払い（承認済み以外）にも付ける
 * - dryRun=true なら書き込まずに結果だけ返す
 */
interface Row { bank: string; date: string; amount: number; payee?: string }
const nz = (s: string) => s.normalize("NFKC").replace(/[\s()（）株式会社有限会社カ\)ｶ]/g, "").toUpperCase();

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { companyId?: string; rows?: Row[]; propagate?: boolean; dryRun?: boolean };
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (!a.role || !["owner", "approver"].includes(a.role)) return json({ error: "権限がありません（オーナー・承認者のみ）" }, 403);
  const { admin } = a; const cid = body.companyId!;
  const rows = (body.rows ?? []).slice(0, 3000).filter((r) => r && r.bank && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number(r.amount) > 0);

  const [{ data: banks }, { data: pays }] = await Promise.all([
    admin.from("bank_accounts").select("id, bank_name, branch_name, account_number").eq("company_id", cid),
    admin.from("payments").select("id, due_date, payee_name, amount, status, bank_account_id").eq("company_id", cid).neq("status", "cancelled"),
  ]);
  const bankOf = (name: string) => {
    const k = nz(name);
    return (banks ?? []).find((b) => nz(`${b.bank_name}${b.branch_name ?? ""}${b.account_number ?? ""}`) === k)
      ?? (banks ?? []).find((b) => nz(`${b.bank_name}${b.branch_name ?? ""}`) === k)
      ?? (banks ?? []).filter((b) => nz(b.bank_name) === k || nz(b.bank_name).includes(k) || k.includes(nz(b.bank_name)))[0];
  };
  const day = (s: string) => Date.parse(s + "T00:00:00Z") / 864e5;
  const used = new Set<string>();
  const assign: { id: string; bank: string; payee: string; due: string }[] = [];
  const unknownBank = new Set<string>(); const unmatched: Row[] = [];
  for (const r of rows) {
    const b = bankOf(r.bank);
    if (!b) { unknownBank.add(r.bank); continue; }
    const cands = (pays ?? []).filter((p) => !used.has(p.id) && p.amount === Math.round(Number(r.amount)) && Math.abs(day(p.due_date) - day(r.date)) <= 7);
    if (!cands.length) { unmatched.push(r); continue; }
    const key = r.payee ? nz(r.payee) : "";
    cands.sort((x, y) => {
      const sx = key && (nz(x.payee_name).includes(key) || key.includes(nz(x.payee_name))) ? 0 : 1;
      const sy = key && (nz(y.payee_name).includes(key) || key.includes(nz(y.payee_name))) ? 0 : 1;
      return sx - sy || Math.abs(day(x.due_date) - day(r.date)) - Math.abs(day(y.due_date) - day(r.date));
    });
    const p = cands[0]; used.add(p.id);
    if (p.bank_account_id !== b.id) assign.push({ id: p.id, bank: b.id, payee: p.payee_name, due: p.due_date });
  }

  // 支払先ごとの直近の振込元 → 今後の未払いへ
  const prop: { id: string; bank: string; payee: string; due: string }[] = [];
  if (body.propagate) {
    const latest = new Map<string, { bank: string; due: string }>();
    const matchedIds = new Set(used);
    for (const p of pays ?? []) {
      if (!matchedIds.has(p.id)) continue;
      const bank = assign.find((x) => x.id === p.id)?.bank ?? p.bank_account_id!;
      const cur = latest.get(p.payee_name);
      if (bank && (!cur || p.due_date > cur.due)) latest.set(p.payee_name, { bank, due: p.due_date });
    }
    const today = new Date().toISOString().slice(0, 10);
    for (const p of pays ?? []) {
      const l = latest.get(p.payee_name);
      if (!l || used.has(p.id) || p.due_date < today || p.status === "paid" || p.status === "approved" || p.bank_account_id === l.bank) continue;
      prop.push({ id: p.id, bank: l.bank, payee: p.payee_name, due: p.due_date });
    }
  }

  if (!body.dryRun) {
    const byBank = new Map<string, string[]>();
    for (const x of [...assign, ...prop]) byBank.set(x.bank, [...(byBank.get(x.bank) ?? []), x.id]);
    for (const [bank, ids] of byBank) {
      for (let i = 0; i < ids.length; i += 200) {
        const { error } = await admin.from("payments").update({ bank_account_id: bank }).in("id", ids.slice(i, i + 200));
        if (error) return json({ error: error.message }, 500);
      }
    }
    await admin.from("audit_logs").insert({ company_id: cid, actor: a.user.id, action: "update", table_name: "payments", detail: { assign_bank: assign.length, propagated: prop.length } });
  }
  const bankName = new Map((banks ?? []).map((b) => [b.id, `${b.bank_name}${b.branch_name ? " " + b.branch_name : ""}`]));
  const summary = (xs: typeof assign) => Object.entries(xs.reduce<Record<string, number>>((m, x) => { const k = bankName.get(x.bank) ?? x.bank; m[k] = (m[k] ?? 0) + 1; return m; }, {}));
  return json({ ok: true, dryRun: !!body.dryRun, matched: used.size, assigned: assign.length, propagated: prop.length, byBank: summary(assign), propByBank: summary(prop), unknownBank: [...unknownBank], unmatched: unmatched.slice(0, 200), unmatchedCount: unmatched.length, banks: banks?.map((b) => bankName.get(b.id)) });
}
