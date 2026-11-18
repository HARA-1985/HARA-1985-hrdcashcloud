import { authorize, json } from "@/lib/server";
import { mfConfig, revokeAndDelete } from "@/lib/mf";

/** 連携解除：MF側でトークンを失効させ、Vaultからも削除する（オーナーのみ） */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (a.role !== "owner") return json({ error: "連携の解除はオーナーのみできます" }, 403);
  const cfg = mfConfig();
  if (cfg) await revokeAndDelete(cfg, a.admin, body.companyId);
  else await a.admin.rpc("mf_token_delete", { cid: body.companyId });
  await a.admin.from("mf_connections").upsert({ company_id: body.companyId, status: "disconnected", office_name: null, office_code: null, last_error: null });
  await a.admin.from("audit_logs").insert({ company_id: body.companyId, actor: a.user.id, action: "delete", table_name: "mf_connections", detail: { event: "mf_disconnected" } });
  return json({ ok: true });
}
