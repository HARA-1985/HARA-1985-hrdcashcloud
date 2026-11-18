import { authorize, json } from "@/lib/server";
import { BoxScopeMissing, MfNotConnected, mfConfig } from "@/lib/mf";
import { fieldKeys, folderPathOf, isDocFile, listBoxFiles } from "@/lib/box-list";
import { fromBoxMeta } from "@/lib/extract";

/**
 * クラウドBoxの書類（PDF・画像）をフォルダ情報つきで一括取得する。読み取りのみ。
 * 画面側でフォルダをクリックして絞り込む（パスの手入力は不要）。
 */
export async function POST(req: Request) {
  const cfg = mfConfig();
  if (!cfg) return json({ error: "マネーフォワードAPIの接続情報が未設定です" }, 501);
  const body = await req.json().catch(() => ({}));
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (!a.role || a.role === "viewer") return json({ error: "権限がありません" }, 403);

  try {
    const [{ files, truncated }, { data: imported }] = await Promise.all([
      listBoxFiles(cfg, a.admin, body.companyId, 40),
      a.admin.from("documents").select("mf_box_file_id").eq("company_id", body.companyId).not("mf_box_file_id", "is", null),
    ]);
    const done = new Set((imported ?? []).map((d) => d.mf_box_file_id as string));
    const docs = files.filter((f) => f.is_trashed !== true && isDocFile(f) && /^[0-9a-f-]{36}$/i.test(String(f.file_id ?? "")));
    const withFolder = docs.filter((f) => folderPathOf(f) !== null).length;

    // 原因調査用：項目名と件数だけを記録（ファイル名・金額などの値は記録しない）
    console.info(JSON.stringify({ tag: "box_folder_scan", company: body.companyId, files: files.length, docs: docs.length, withFolder, truncated, fields: fieldKeys(files) }));

    const items = docs.slice(0, 2000).map((f) => {
      const meta = fromBoxMeta(f);
      const dateRaw = ["transaction_date", "issued_at", "created_at", "uploaded_at", "updated_at"].map((k) => f[k]).find((v) => typeof v === "string") as string | undefined;
      return {
        id: String(f.file_id), name: String(f.file_name ?? ""), size: Number(f.content_length ?? 0),
        folder: folderPathOf(f) ?? "", imported: done.has(String(f.file_id)),
        payee: meta.payee ?? null, amount: meta.amount ?? null, date: meta.issue ?? (dateRaw ? dateRaw.slice(0, 10) : null),
      };
    });
    return json({ ok: true, items, truncated, totalFiles: files.length, folderSupported: withFolder > 0, fields: withFolder > 0 ? undefined : fieldKeys(files) });
  } catch (e) {
    console.error(JSON.stringify({ tag: "box_folder_error", company: body.companyId, message: (e as Error).message.slice(0, 300) }));
    return json({ error: (e as Error).message }, e instanceof MfNotConnected || e instanceof BoxScopeMissing ? 409 : 502);
  }
}
