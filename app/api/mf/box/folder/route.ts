import { authorize, json } from "@/lib/server";
import { BoxScopeMissing, MfNotConnected, mfConfig } from "@/lib/mf";
import { fieldKeys, folderPathOf, inFolder, isDocFile, listBoxFiles } from "@/lib/box-list";
import { fromBoxMeta } from "@/lib/extract";

/** 指定フォルダの請求書を一覧で返す（読み取りのみ）。フォルダ情報が無い応答なら診断用に項目名を返す */
export async function POST(req: Request) {
  const cfg = mfConfig();
  if (!cfg) return json({ error: "マネーフォワードAPIの接続情報が未設定です" }, 501);
  const body = await req.json().catch(() => ({}));
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (!a.role || a.role === "viewer") return json({ error: "権限がありません" }, 403);
  const path = typeof body.path === "string" ? body.path.slice(0, 300) : "";
  const includeSub = body.includeSub === true;

  try {
    const [{ files, truncated }, { data: imported }] = await Promise.all([
      listBoxFiles(cfg, a.admin, body.companyId, 30),
      a.admin.from("documents").select("mf_box_file_id").eq("company_id", body.companyId).not("mf_box_file_id", "is", null),
    ]);
    const done = new Set((imported ?? []).map((d) => d.mf_box_file_id as string));
    const docs = files.filter((f) => f.is_trashed !== true && isDocFile(f) && /^[0-9a-f-]{36}$/i.test(String(f.file_id ?? "")));
    const anyFolderInfo = docs.some((f) => folderPathOf(f) !== null);
    const matched = anyFolderInfo ? docs.filter((f) => inFolder(f, path, includeSub) === true) : [];
    const folders = anyFolderInfo ? [...new Set(docs.map((f) => folderPathOf(f)).filter((x): x is string => !!x))].sort().slice(0, 200) : [];
    const items = matched.slice(0, 500).map((f) => {
      const meta = fromBoxMeta(f);
      return {
        id: String(f.file_id), name: String(f.file_name ?? ""), size: Number(f.content_length ?? 0), folder: folderPathOf(f),
        imported: done.has(String(f.file_id)), payee: meta.payee ?? null, amount: meta.amount ?? null, date: meta.issue ?? null,
      };
    });
    return json({
      ok: true, items, truncated, totalFiles: files.length, folderSupported: anyFolderInfo, folders,
      fields: anyFolderInfo ? undefined : fieldKeys(files),
    });
  } catch (e) {
    return json({ error: (e as Error).message }, e instanceof MfNotConnected || e instanceof BoxScopeMissing ? 409 : 502);
  }
}
