import { authorize, json } from "@/lib/server";
import { mfConfig, newOAuthState } from "@/lib/mf";

/** 連携開始：認可URLを返し、state/PKCE を署名付き HttpOnly Cookie に保存する（オーナーのみ） */
export async function POST(req: Request) {
  const cfg = mfConfig();
  if (!cfg) return json({ error: "マネーフォワードAPIの接続情報（MF_CLIENT_ID / MF_CLIENT_SECRET）がまだ設定されていません。" }, 501);
  const body = await req.json().catch(() => ({}));
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (a.role !== "owner") return json({ error: "連携の設定はオーナーのみできます" }, 403);
  const { url, cookie } = newOAuthState(cfg, body.companyId, a.user.id);
  return new Response(JSON.stringify({ ok: true, url }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": cookie },
  });
}
