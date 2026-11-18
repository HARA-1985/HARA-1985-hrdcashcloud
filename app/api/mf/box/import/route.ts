import crypto from "node:crypto";
import { authorize, json } from "@/lib/server";
import { BoxScopeMissing, MfApiError, MfNotConnected, boxDownload, boxErrorCode, boxRequest, mfConfig } from "@/lib/mf";

const MAX_BYTES = 20 * 1024 * 1024; // 一時保管バケットの上限に合わせる

function sniff(b: Uint8Array): string | null {
  const head = Buffer.from(b.subarray(0, 12));
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (head.subarray(4, 12).toString("latin1").startsWith("ftypheic") || head.subarray(4, 12).toString("latin1").startsWith("ftypmif1")) return "image/heic";
  return null;
}

/** 選んだBoxファイルを取り込み、請求書として登録待ちにする（原本はBoxにあるので保存済み扱い） */
export async function POST(req: Request) {
  const cfg = mfConfig();
  if (!cfg) return json({ error: "マネーフォワードAPIの接続情報が未設定です" }, 501);
  const body = await req.json().catch(() => ({}));
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (!a.role || a.role === "viewer") return json({ error: "権限がありません" }, 403);
  const ids: string[] = Array.isArray(body.fileIds) ? body.fileIds.filter((x: unknown) => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 20) : [];
  if (!ids.length) return json({ error: "取り込むファイルを選んでください" }, 400);
  const docType = body.docType === "receipt" ? "receipt" : "invoice";

  const results: { fileId: string; ok: boolean; docId?: string; fileName?: string; message?: string }[] = [];
  for (const fid of ids) {
    try {
      const { data: exists } = await a.admin.from("documents").select("id").eq("company_id", body.companyId).eq("mf_box_file_id", fid).maybeSingle();
      if (exists) { results.push({ fileId: fid, ok: false, message: "取り込み済みです" }); continue; }
      const meta = await boxRequest(cfg, a.admin, body.companyId, `/${fid}`);
      if (!meta.ok) throw new MfApiError(meta.status, (await boxErrorCode(meta)) || "ファイル情報を取得できませんでした");
      const mj = (await meta.json()) as Record<string, unknown> & { file?: Record<string, unknown> };
      const f = (mj.file ?? mj) as Record<string, unknown>;
      if (String(f.file_id ?? "") !== fid) throw new Error("Boxの応答が要求と一致しません");
      if (f.is_trashed === true) throw new Error("ゴミ箱にあるファイルです");
      if (Number(f.content_length ?? 0) > MAX_BYTES) throw new Error("20MBを超えるファイルは取り込めません");
      const name = String(f.file_name ?? "box-file").replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 200);

      const bytes = await boxDownload(cfg, a.admin, body.companyId, fid, MAX_BYTES);
      const mime = sniff(bytes);
      if (!mime) throw new Error("PDF・画像以外のファイルは取り込めません");
      const path = `${body.companyId}/${crypto.randomUUID()}-${name.replace(/[^\w.\-]+/g, "_")}`;
      const up = await a.admin.storage.from("inbox").upload(path, bytes, { contentType: mime, upsert: false });
      if (up.error) throw new Error("一時保管に失敗しました：" + up.error.message);
      const { data: doc, error } = await a.admin.from("documents").insert({
        company_id: body.companyId, doc_type: docType, file_name: name, mime_type: mime, size_bytes: bytes.byteLength,
        temp_path: path, mf_box_file_id: fid, mf_box_status: "stored", source: "mf_box", uploaded_by: a.user.id,
      }).select("id").single();
      if (error || !doc) { await a.admin.storage.from("inbox").remove([path]); throw new Error(error?.message ?? "登録に失敗しました"); }
      results.push({ fileId: fid, ok: true, docId: doc.id, fileName: name });
    } catch (e) {
      results.push({ fileId: fid, ok: false, message: (e as Error).message.slice(0, 200) });
      if (e instanceof MfNotConnected || e instanceof BoxScopeMissing) break;
    }
  }
  await a.admin.from("audit_logs").insert({ company_id: body.companyId, actor: a.user.id, action: "insert", table_name: "documents", detail: { event: "mf_box_import", results: results.map((r) => ({ fileId: r.fileId, ok: r.ok, message: r.message })) } });
  return json({ ok: true, results });
}
