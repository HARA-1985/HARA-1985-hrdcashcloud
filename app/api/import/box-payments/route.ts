import { authorize, json } from "@/lib/server";
import { kindOfFolder, parseBoxName, type BoxRow } from "@/lib/boxname";

export const runtime = "nodejs";

/**
 * クラウドBoxのファイル一覧（ID・フォルダ名・ファイル名）から支払予定を一括登録する。
 * - 同じBoxファイルは二重登録しない（documents の company+mf_box_file_id で判定）
 * - 振替日・振込日が今日以前なら「支払済」、以降は 振替＝口座振替 / 振込＝未承認
 * - 2か月以上出てくる支払先は「毎月固定」に寄せる
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { companyId?: string; rows?: BoxRow[]; from?: string; to?: string; year?: number; dryRun?: boolean };
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (!a.role || !["owner", "approver", "member"].includes(a.role)) return json({ error: "この会社に登録する権限がありません" }, 403);
  const { admin } = a;
  const cid = body.companyId!;
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 1000) : [];
  const year = body.year ?? new Date().getFullYear();
  const from = body.from ?? "1900-01-01", to = body.to ?? "2999-12-31";
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

  const parsed = rows.map((r) => parseBoxName({ boxId: String(r.boxId), folder: String(r.folder ?? ""), fileName: String(r.fileName ?? "") }, year))
    .map((p) => (!p.skip && p.due && (p.due < from || p.due > to) ? { ...p, skip: "期間外" } : p));
  // 同一ファイルの重複行を除く
  const seen = new Set<string>();
  const uniq = parsed.filter((p) => (seen.has(p.boxId) ? false : (seen.add(p.boxId), true)));
  const targets = uniq.filter((p) => !p.skip);

  const { data: existDocs } = await admin.from("documents").select("id, mf_box_file_id").eq("company_id", cid).in("mf_box_file_id", targets.map((t) => t.boxId).length ? targets.map((t) => t.boxId) : ["-"]);
  const already = new Set((existDocs ?? []).map((d) => d.mf_box_file_id));
  const toAdd = targets.filter((t) => !already.has(t.boxId));

  if (body.dryRun) return json({ ok: true, preview: uniq.map((p) => ({ ...p, already: already.has(p.boxId) })) });

  // 支払先
  const names = [...new Set(toAdd.map((t) => t.payee))];
  if (names.length) await admin.from("payees").upsert(names.map((name) => ({ company_id: cid, name })), { onConflict: "company_id,name", ignoreDuplicates: true });
  const { data: payees } = await admin.from("payees").select("id, name").eq("company_id", cid);
  const payeeId = new Map((payees ?? []).map((p) => [p.name, p.id]));

  let added = 0; const errors: string[] = [];
  for (let i = 0; i < toAdd.length; i += 100) {
    const chunk = toAdd.slice(i, i + 100);
    const { data: docs, error: de } = await admin.from("documents").insert(chunk.map((t) => ({
      company_id: cid, doc_type: "invoice", file_name: t.fileName, mime_type: /\.png$/i.test(t.fileName) ? "image/png" : "application/pdf",
      mf_box_file_id: t.boxId, mf_box_status: "stored", source: "mf_box", folder_month: `${t.due!.slice(0, 7)}-01`,
      account_title: "未払金", uploaded_by: a.user.id,
      ocr: { method: "filename", folder: t.folder, payee: t.payee, amount: t.amount, due: t.due },
    }))).select("id, mf_box_file_id");
    if (de) { errors.push(de.message); continue; }
    const docId = new Map((docs ?? []).map((d) => [d.mf_box_file_id, d.id]));
    const { error: pe } = await admin.from("payments").insert(chunk.map((t) => ({
      company_id: cid, due_date: t.due, payee_id: payeeId.get(t.payee) ?? null, payee_name: t.payee, item: t.item || null,
      amount: t.amount, kind: kindOfFolder(t.folder), source: "invoice", account_title: "未払金",
      status: t.due! <= today ? "paid" : t.method === "振替" ? "auto_debit" : "pending",
      document_id: docId.get(t.boxId) ?? null, created_by: a.user.id,
    })));
    if (pe) { errors.push(pe.message); continue; }
    added += chunk.length;
  }

  // 2か月以上出てくる支払先は毎月固定へ
  const { data: all } = await admin.from("payments").select("payee_name, due_date").eq("company_id", cid).neq("status", "cancelled");
  const months = new Map<string, Set<string>>();
  for (const p of all ?? []) { const s = months.get(p.payee_name) ?? new Set(); s.add(p.due_date.slice(0, 7)); months.set(p.payee_name, s); }
  const recurring = [...months.entries()].filter(([, s]) => s.size >= 2).map(([n]) => n);
  if (recurring.length) await admin.from("payments").update({ kind: "fixed" }).eq("company_id", cid).eq("kind", "spot").in("payee_name", recurring);

  await admin.from("audit_logs").insert({ company_id: cid, actor: a.user.id, action: "import", table_name: "payments", detail: { source: "mf_box_list", added, skipped: uniq.length - toAdd.length } });
  return json({
    ok: errors.length === 0, added, already: targets.length - toAdd.length,
    skipped: uniq.filter((p) => p.skip).map((p) => ({ fileName: p.fileName, reason: p.skip })),
    errors,
  });
}
