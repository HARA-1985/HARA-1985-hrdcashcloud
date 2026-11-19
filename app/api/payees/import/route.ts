import { authorize, json } from "@/lib/server";
import { toZenginKana } from "@/lib/zengin";

export const runtime = "nodejs";

interface Row { name: string; bank_code: string; bank_kana?: string; branch_code: string; branch_kana?: string; account_type: string; account_number: string; name_kana?: string }
const norm = (s: string) => s.normalize("NFKC").replace(/\s|　/g, "").replace(/株式会社|\(株\)|（株）/g, "");
const TYPE: Record<string, string> = { 普通: "1", 当座: "2", 貯蓄: "4", "1": "1", "2": "2", "4": "4", "9": "9" };

/** 支払先の振込先口座をまとめて登録する（支払先名で照合。見つからない名前は登録しない） */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { companyId?: string; rows?: Row[] };
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (!a.role || !["owner", "approver"].includes(a.role)) return json({ error: "口座を登録する権限がありません（オーナー・承認者のみ）" }, 403);
  const { admin } = a; const cid = body.companyId!;
  const rows = (body.rows ?? []).slice(0, 500);
  const { data: payees } = await admin.from("payees").select("id, name").eq("company_id", cid);
  const byNorm = new Map((payees ?? []).map((p) => [norm(p.name), p]));
  const updated: string[] = [], unmatched: string[] = [], invalid: string[] = [];
  for (const r of rows) {
    const p = byNorm.get(norm(r.name ?? ""));
    if (!p) { unmatched.push(r.name); continue; }
    const bank = String(r.bank_code ?? "").replace(/\D/g, ""), branch = String(r.branch_code ?? "").replace(/\D/g, "");
    const num = String(r.account_number ?? "").replace(/\D/g, "").padStart(7, "0");
    const type = TYPE[String(r.account_type ?? "").trim()];
    if (bank.length !== 4 || branch.length !== 3 || num.length !== 7 || !type) { invalid.push(r.name); continue; }
    const { error } = await admin.from("payees").update({
      bank_code: bank, bank_kana: toZenginKana(r.bank_kana) || null, branch_code: branch, branch_kana: toZenginKana(r.branch_kana) || null,
      account_type: type, account_number: num, name_kana: toZenginKana(r.name_kana) || null,
    }).eq("id", p.id);
    if (error) { invalid.push(`${r.name}（${error.message}）`); continue; }
    await admin.from("payments").update({ payee_id: p.id }).eq("company_id", cid).eq("payee_name", p.name).is("payee_id", null);
    updated.push(p.name);
  }
  await admin.from("audit_logs").insert({ company_id: cid, actor: a.user.id, action: "import", table_name: "payees", detail: { updated: updated.length, unmatched, invalid } });
  return json({ ok: true, updated: updated.length, unmatched, invalid });
}
