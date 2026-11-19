import { authorize, json } from "@/lib/server";

export const runtime = "nodejs";

/** 支払予定が1件もなく、口座も未登録の支払先を削除する（list=true なら一覧だけ返す） */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { companyId?: string; list?: boolean };
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (!a.role || !["owner", "approver"].includes(a.role)) return json({ error: "権限がありません" }, 403);
  const { admin } = a; const cid = body.companyId!;
  const [{ data: payees }, { data: pays }] = await Promise.all([
    admin.from("payees").select("id, name, bank_code").eq("company_id", cid),
    admin.from("payments").select("payee_id, payee_name").eq("company_id", cid),
  ]);
  const usedId = new Set((pays ?? []).map((p) => p.payee_id).filter(Boolean));
  const usedName = new Set((pays ?? []).map((p) => p.payee_name));
  const unused = (payees ?? []).filter((p) => !p.bank_code && !usedId.has(p.id) && !usedName.has(p.name));
  if (body.list) return json({ ok: true, names: unused.map((p) => p.name) });
  if (unused.length) await admin.from("payees").delete().in("id", unused.map((p) => p.id));
  await admin.from("audit_logs").insert({ company_id: cid, actor: a.user.id, action: "delete", table_name: "payees", detail: { removed: unused.map((p) => p.name) } });
  return json({ ok: true, removed: unused.map((p) => p.name) });
}
