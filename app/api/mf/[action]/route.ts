import { authorize, json } from "@/lib/server";

/**
 * マネーフォワード クラウド連携の受け口。
 * - connect：OAuth認可の開始（各社が契約しているMFアカウントで承認）
 * - sync   ：カード明細の取得・証憑のクラウドBox保存・仕訳登録
 * APIの接続情報（Client ID / Secret）を取得し、公式ドキュメントのエンドポイントを確認してから実装を有効化します。
 */
export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (action !== "connect" && action !== "sync") return json({ error: "不明な操作です" }, 404);
  const body = await req.json().catch(() => ({}));
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (!a.role || a.role === "viewer") return json({ error: "権限がありません" }, 403);
  if (action === "connect" && a.role !== "owner") return json({ error: "連携の設定はオーナーのみできます" }, 403);
  if (!process.env.MF_CLIENT_ID || !process.env.MF_CLIENT_SECRET) {
    return json({ error: "マネーフォワードAPIの接続情報が未設定です（MF_CLIENT_ID / MF_CLIENT_SECRET）。取得後に有効になります。" }, 501);
  }
  return json({ error: "マネーフォワード連携は準備中です" }, 501);
}
