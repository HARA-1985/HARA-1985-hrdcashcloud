import { authorize, json } from "@/lib/server";
import { BoxScopeMissing, MfApiError, MfNotConnected, boxErrorCode, boxRequest, mfConfig } from "@/lib/mf";

const DATE_KEYS = ["transaction_date", "issued_at", "issue_date", "created_at", "uploaded_at", "registered_at", "updated_at"];
const MAX_PAGES = 15;

function pickDate(f: Record<string, unknown>): { key: string; value: string } | null {
  for (const k of DATE_KEYS) {
    const v = f[k];
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return { key: k, value: v.slice(0, 10) };
  }
  return null;
}
const isPdfOrImage = (name: string, mime?: unknown) =>
  /\.(pdf|jpe?g|png|heic|webp)$/i.test(name) || (typeof mime === "string" && /^(application\/pdf|image\/)/.test(mime));

/**
 * クラウドBoxのファイル一覧を、期間（日付）とキーワードで絞り込んで返す。読み取りのみ。
 * 一覧APIに期間の検索条件が無いため、ページを順にたどってサーバー側で絞り込む（最大15ページ）。
 */
export async function POST(req: Request) {
  const cfg = mfConfig();
  if (!cfg) return json({ error: "マネーフォワードAPIの接続情報が未設定です" }, 501);
  const body = await req.json().catch(() => ({}));
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (!a.role || a.role === "viewer") return json({ error: "権限がありません" }, 403);

  const from = typeof body.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.from) ? body.from : null;
  const to = typeof body.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.to) ? body.to : null;
  const q = typeof body.q === "string" ? body.q.trim().toLowerCase().slice(0, 100) : "";

  try {
    const { data: imported } = await a.admin.from("documents").select("mf_box_file_id").eq("company_id", body.companyId).not("mf_box_file_id", "is", null);
    const done = new Set((imported ?? []).map((d) => d.mf_box_file_id as string));
    const items: { id: string; name: string; size: number; date: string | null; dateKey: string | null; imported: boolean }[] = [];
    let page = 1, pages = 0, more = false;
    for (; pages < MAX_PAGES; pages++) {
      const res = await boxRequest(cfg, a.admin, body.companyId, page === 1 ? "" : `?page=${page}`);
      if (!res.ok) throw new MfApiError(res.status, (await boxErrorCode(res)) || "一覧を取得できませんでした");
      const j = (await res.json()) as { files?: Record<string, unknown>[]; pagination?: { next_page?: number | null } };
      for (const f of j.files ?? []) {
        const id = String(f.file_id ?? "");
        const name = String(f.file_name ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(id) || !name || f.is_trashed === true) continue;
        if (!isPdfOrImage(name, f.content_type ?? f.mime_type)) continue;
        const d = pickDate(f);
        if ((from || to) && d) { if (from && d.value < from) continue; if (to && d.value > to) continue; }
        if (q && !name.toLowerCase().includes(q)) continue;
        items.push({ id, name, size: Number(f.content_length ?? 0), date: d?.value ?? null, dateKey: d?.key ?? null, imported: done.has(id) });
      }
      const next = j.pagination?.next_page;
      if (!next || next <= page) { more = false; break; }
      page = next; more = true;
    }
    const noDate = (from || to) && items.length > 0 && items.every((i) => !i.date);
    return json({ ok: true, items: items.slice(0, 300), truncated: more || items.length > 300, noDateField: !!noDate });
  } catch (e) {
    const status = e instanceof MfNotConnected || e instanceof BoxScopeMissing ? 409 : 502;
    return json({ error: (e as Error).message }, status);
  }
}
