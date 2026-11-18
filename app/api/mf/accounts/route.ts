import { authorize, json } from "@/lib/server";
import { MfNotConnected, mfApi, mfConfig, pickArray } from "@/lib/mf";

/** MFの勘定科目一覧（科目対応表の設定用）。オーナー・承認者のみ */
export async function POST(req: Request) {
  const cfg = mfConfig();
  if (!cfg) return json({ error: "マネーフォワードAPIの接続情報が未設定です" }, 501);
  const body = await req.json().catch(() => ({}));
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (a.role !== "owner" && a.role !== "approver") return json({ error: "権限がありません" }, 403);
  try {
    const raw = await mfApi(cfg, a.admin, body.companyId, "/accounts");
    const accounts = pickArray(raw, ["accounts", "data"]).map((x) => ({
      id: String(x.id ?? ""), name: String(x.name ?? x.account_name ?? ""), category: String(x.category ?? x.account_group ?? x.financial_statement_type ?? ""),
      available: x.available !== false && x.is_active !== false,
    })).filter((x) => x.id && x.name);
    return json({ ok: true, accounts });
  } catch (e) {
    return json({ error: (e as Error).message }, e instanceof MfNotConnected ? 409 : 502);
  }
}
