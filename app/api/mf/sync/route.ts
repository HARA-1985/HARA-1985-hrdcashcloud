import { authorize, json } from "@/lib/server";

/**
 * クラウドBox（原本保存）・カード明細の取り込み。
 * クラウドBox API はマネーフォワードのトライアル提供で、公開仕様がまだ無いため、仕様入手後に実装する。
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  return json({ error: "クラウドBox API・カード明細の取り込みは、マネーフォワードからAPI仕様を受け取り次第有効になります。" }, 501);
}
