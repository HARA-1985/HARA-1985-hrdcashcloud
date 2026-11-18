import { authorize, json } from "@/lib/server";
import { extractInvoice } from "@/lib/extract";

/** アップロード済みの請求書から支払情報を読み取る（サーバー側で一時保管ファイルを読む） */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (!a.role || a.role === "viewer") return json({ error: "権限がありません" }, 403);
  if (typeof body.docId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.docId)) return json({ error: "書類の指定が不正です" }, 400);

  const { data: doc } = await a.admin.from("documents").select("id,company_id,temp_path,mime_type,size_bytes").eq("id", body.docId).eq("company_id", body.companyId).maybeSingle();
  if (!doc?.temp_path) return json({ error: "書類が見つかりません" }, 404);
  if ((doc.size_bytes ?? 0) > 20 * 1024 * 1024) return json({ error: "ファイルが大きすぎます" }, 400);
  const dl = await a.admin.storage.from("inbox").download(doc.temp_path);
  if (dl.error || !dl.data) return json({ error: "ファイルを読めませんでした" }, 500);
  const bytes = new Uint8Array(await dl.data.arrayBuffer());
  const { data: co } = await a.admin.from("companies").select("name").eq("id", body.companyId).single();
  const extracted = await extractInvoice(bytes, doc.mime_type ?? "application/pdf", null, [co?.name ?? ""].filter(Boolean));
  await a.admin.from("documents").update({ ocr: extracted }).eq("id", doc.id);
  return json({ ok: true, extracted });
}
