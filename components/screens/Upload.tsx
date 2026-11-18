"use client";
import { useMemo, useRef, useState } from "react";
import type { Ctx } from "../ctx";
import { sb } from "@/lib/supabase";
import { parseDate, toISO, yen } from "@/lib/format";
import { ACCOUNT_TITLES, type Kind } from "@/lib/types";
import Icon from "../Icon";

interface Draft {
  key: string; docId: string; file: string;
  payee: string; item: string; amount: string; due: string; kind: Kind; account: string; bank: string;
  saving?: boolean; saved?: boolean; method?: Ex["method"]; note?: string; reading?: boolean;
}
interface Ex { payee?: string; amount?: number; due?: string; issue?: string; regNo?: string; invoiceNo?: string; method: "box" | "text" | "ai" | "none"; note?: string }
const METHOD_LABEL: Record<Ex["method"], string> = { box: "Boxの取引情報", text: "PDFから読み取り", ai: "AIで読み取り", none: "読み取りできず" };

async function authedPost(path: string, payload: unknown) {
  const { data } = await sb().auth.getSession();
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token ?? ""}` }, body: JSON.stringify(payload) });
  return { ok: res.ok, j: await res.json().catch(() => ({})) };
}

const MAX = 20 * 1024 * 1024;
const OK_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/webp"];

function endOfMonth() { const t = new Date(); return toISO(new Date(t.getFullYear(), t.getMonth() + 1, 0)); }

/** ファイル名から相手先の候補を作る（例：202611_株式会社サンプル_請求書.pdf → 株式会社サンプル） */
function guessPayee(name: string) {
  const base = name.replace(/\.[^.]+$/, "").replace(/[_\-\s]+/g, " ");
  const parts = base.split(" ").filter((s) => s && !/^\d+$/.test(s) && !/(請求書|invoice|receipt|領収書|レシート)/i.test(s));
  return parts[0] ?? "";
}

export default function Upload({ ctx, mode }: { ctx: Ctx; mode: "invoice" | "expense" }) {
  const [over, setOver] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [uploading, setUploading] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const isExp = mode === "expense";

  const applyEx = (d: Draft, ex?: Ex): Draft => {
    if (!ex) return d;
    const payee = ex.payee ? (ctx.payees.find((p) => p.name.replace(/\s/g, "") === ex.payee!.replace(/\s/g, ""))?.name ?? ex.payee) : d.payee;
    const prior = ctx.payments.find((p) => p.payee_name === payee);
    return {
      ...d, payee, amount: ex.amount ? String(ex.amount) : d.amount, due: ex.due ?? d.due,
      item: ex.invoiceNo ? `請求書 ${ex.invoiceNo}` : d.item, method: ex.method, note: ex.note,
      // 同じ支払先の過去の設定（区分・勘定科目・口座）を引き継ぐ
      ...(prior ? { kind: prior.kind, account: prior.account_title, bank: prior.bank_account_id ?? d.bank } : {}),
    };
  };
  const newDraft = (docId: string, file: string, ex?: Ex): Draft => applyEx({
    key: docId, docId, file,
    payee: isExp ? (ctx.me?.display_name ?? "") : guessPayee(file), item: isExp ? "立替経費精算" : "",
    amount: "", due: endOfMonth(), kind: "spot", account: isExp ? "未払金" : "買掛金", bank: ctx.banks[0]?.id ?? "",
  }, ex);
  const addDrafts = (ds: Draft[]) => setDrafts((cur) => [...ds.filter((d) => !cur.some((c) => c.key === d.key)), ...cur]);

  async function handle(files: File[], boxFileId?: string): Promise<number> {
    let okCount = 0;
    if (!ctx.canWrite) { ctx.toast("閲覧のみの権限では登録できません", true); return 0; }
    const ok = files.filter((f) => {
      if (f.size > MAX) { ctx.toast(`${f.name}：20MBを超えています`, true); return false; }
      if (f.type && !OK_TYPES.includes(f.type)) { ctx.toast(`${f.name}：PDF・画像のみ登録できます`, true); return false; }
      return true;
    });
    if (!ok.length) return 0;
    setUploading((n) => n + ok.length);
    await Promise.all(ok.map(async (f) => {
      const path = `${ctx.company.id}/${crypto.randomUUID()}-${f.name.replace(/[^\w.\-]+/g, "_")}`;
      const up = await sb().storage.from("inbox").upload(path, f, { contentType: f.type || undefined, upsert: false });
      if (up.error) { ctx.toast(`${f.name}：アップロードに失敗しました（${up.error.message}）`, true); setUploading((n) => n - 1); return; }
      const { data, error } = await sb().from("documents").insert({
        company_id: ctx.company.id, doc_type: isExp ? "receipt" : "invoice", file_name: f.name,
        mime_type: f.type || null, size_bytes: f.size, temp_path: path,
        ...(boxFileId ? { mf_box_file_id: boxFileId, source: "mf_box", mf_box_status: "stored" } : {}),
      }).select("id").single();
      setUploading((n) => n - 1);
      if (error || !data) {
        await sb().storage.from("inbox").remove([path]);
        ctx.toast(error?.code === "23505" ? `${f.name}：このBoxファイルは取り込み済みです` : `${f.name}：登録に失敗しました（${error?.message}）`, true);
        return;
      }
      addDrafts([{ ...newDraft(data.id, f.name), reading: !isExp }]);
      okCount++;
      if (!isExp) {
        authedPost("/api/documents/extract", { companyId: ctx.company.id, docId: data.id }).then(({ ok, j }) => {
          setDrafts((ds) => ds.map((x) => (x.key === data.id ? { ...(ok ? applyEx(x, j.extracted) : x), reading: false } : x)));
        });
      }
    }));
    ctx.reload();
    return okCount;
  }

  async function save(d: Draft) {
    const amount = Number(d.amount.replace(/[^\d]/g, ""));
    if (!d.payee.trim() || !amount || !d.due) { ctx.toast("支払先・金額・支払日を入力してください", true); return; }
    setDrafts((ds) => ds.map((x) => (x.key === d.key ? { ...x, saving: true } : x)));
    const payee = ctx.payees.find((p) => p.name === d.payee.trim());
    const { error } = await sb().from("payments").insert({
      company_id: ctx.company.id, due_date: d.due, payee_id: payee?.id ?? null, payee_name: d.payee.trim(), item: d.item.trim() || null,
      amount, kind: d.kind, source: isExp ? "expense" : "invoice", bank_account_id: d.bank || null, account_title: d.account, document_id: d.docId,
    });
    if (!error) {
      const due = parseDate(d.due);
      await sb().from("documents").update({ folder_month: toISO(new Date(due.getFullYear(), due.getMonth(), 1)), account_title: d.account }).eq("id", d.docId);
    }
    setDrafts((ds) => ds.map((x) => (x.key === d.key ? { ...x, saving: false, saved: !error } : x)));
    if (error) ctx.toast(error.message, true); else { ctx.toast("支払予定を作成しました"); ctx.reload(); }
  }

  const upd = (key: string, patch: Partial<Draft>) => setDrafts((ds) => ds.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  return (
    <div className="stack" style={{ gap: 16 }}>
    {ctx.mf?.status === "connected" && ctx.canWrite && (
      <BoxImport ctx={ctx} docType={isExp ? "receipt" : "invoice"} onImported={(list) => { addDrafts(list.map((x) => newDraft(x.docId, x.fileName, x.extracted))); ctx.reload(); }}
        onManual={(file, boxId) => handle([file], boxId)} />
    )}
    <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", alignItems: "start" }}>
      <label
        className={"drop" + (over ? " is-over" : "")}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); handle(Array.from(e.dataTransfer.files)); }}
      >
        <div style={{ width: 64, height: 64, borderRadius: 18, background: "#EAEDFC", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="upload" size={30} color="#2440D8" />
        </div>
        <span style={{ fontSize: 20, fontWeight: 700 }}>{isExp ? "領収書・レシートをドロップ" : "請求書をドロップ"}</span>
        <span className="muted" style={{ fontSize: 14, maxWidth: 380, lineHeight: 1.7 }}>
          {isExp ? "画像やPDFをまとめて置くだけ。内容を確認して精算の支払予定を作ります。" : "PDFを置くだけ。内容を確認して支払予定を作り、月別・勘定科目別のフォルダに仕分けます。"}
        </span>
        <span className="btn" style={{ pointerEvents: "none" }}>ファイルを選択</span>
        <input ref={inputRef} className="sr" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.heic,.webp" onChange={(e) => { handle(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        <span className="muted" style={{ fontSize: 12 }}>PDF・JPG・PNG・HEIC ／ 1ファイル20MBまで ／ 複数同時OK</span>
        {uploading > 0 && <span className="chip st-wait">アップロード中 {uploading}件…</span>}
      </label>

      <section className="card pad stack" style={{ gap: 14, minHeight: 340 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 className="h2">内容の確認</h2>
          <span className="muted" style={{ fontSize: 12 }}>自動読み取り（AI-OCR）は次の段階で追加</span>
        </div>
        {drafts.length === 0 && <div className="empty">ファイルを置くと、ここで支払先・金額・支払日を確認して登録できます。</div>}
        {(() => {
          const ready = drafts.filter((d) => !d.saved && !d.saving && !d.reading && d.payee.trim() && Number(d.amount.replace(/[^\d]/g, "")) > 0 && d.due);
          return ready.length > 1 ? (
            <div className="row wrap" style={{ gap: 10, padding: "10px 12px", borderRadius: 10, background: "#F2F4FE" }}>
              <span style={{ fontSize: 13 }}>支払先・金額・支払日がそろっている <strong className="num">{ready.length}件</strong></span>
              <button type="button" className="btn btn-sm btn-primary" onClick={async () => { for (const d of ready) await save(d); }}>内容を確認したのでまとめて登録</button>
            </div>
          ) : null;
        })()}
        <datalist id="payees">{ctx.payees.map((p) => <option key={p.id} value={p.name} />)}</datalist>
        {drafts.map((d) => (
          <div key={d.key} className="stack" style={{ gap: 10, padding: 14, borderRadius: 12, background: d.saved ? "#F1F8F4" : "#F7F6F3", border: "1px solid #E4E2DC" }}>
            <div className="row" style={{ gap: 10 }}>
              <button type="button" className="btn btn-sm" onClick={() => ctx.openDoc(d.docId)}><Icon name="doc" size={14} />表示</button>
              <span className="grow muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.file}</span>
              {d.reading && <span className="chip st-wait">読み取り中…</span>}
              {!d.reading && d.method && !d.saved && <span className={"chip " + (d.method === "none" ? "st-err" : "st-auto")} title={d.note}>{METHOD_LABEL[d.method]}</span>}
              {d.saved && <span className="chip st-ok">登録済 {yen(Number(d.amount.replace(/[^\d]/g, "")))}</span>}
            </div>
            {!d.saved && (
              <>
                <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
                  <label className="field" style={{ gridColumn: "span 2" }}><span>{isExp ? "立替した人" : "支払先"}</span><input className="inp" list="payees" value={d.payee} onChange={(e) => upd(d.key, { payee: e.target.value })} /></label>
                  <label className="field"><span>金額（税込）</span><input className="inp num" inputMode="numeric" value={d.amount} onChange={(e) => upd(d.key, { amount: e.target.value })} placeholder="0" /></label>
                  <label className="field"><span>支払日</span><input className="inp" type="date" value={d.due} onChange={(e) => upd(d.key, { due: e.target.value })} /></label>
                  <label className="field" style={{ gridColumn: "span 2" }}><span>内容</span><input className="inp" value={d.item} onChange={(e) => upd(d.key, { item: e.target.value })} /></label>
                  <label className="field"><span>区分</span>
                    <select className="inp" value={d.kind} onChange={(e) => upd(d.key, { kind: e.target.value as Kind })}><option value="spot">臨時</option><option value="fixed">毎月固定</option></select>
                  </label>
                  <label className="field"><span>勘定科目</span>
                    <select className="inp" value={d.account} onChange={(e) => upd(d.key, { account: e.target.value })}>{ACCOUNT_TITLES.map((a) => <option key={a}>{a}</option>)}</select>
                  </label>
                  <label className="field" style={{ gridColumn: "span 2" }}><span>振込元口座</span>
                    <select className="inp" value={d.bank} onChange={(e) => upd(d.key, { bank: e.target.value })}>
                      <option value="">未設定</option>{ctx.banks.map((b) => <option key={b.id} value={b.id}>{b.bank_name} {b.branch_name ?? ""}</option>)}
                    </select>
                  </label>
                </div>
                <button type="button" className="btn btn-primary" disabled={d.saving} onClick={() => save(d)}>{d.saving ? "登録中…" : "支払予定に登録"}</button>
              </>
            )}
          </div>
        ))}
      </section>
    </div>
    </div>
  );
}

/* ---------- クラウドBoxから取り込む（フォルダをクリックで選ぶ） ---------- */
interface BoxItem { id: string; name: string; size: number; date: string | null; folder: string; imported: boolean; blocked?: boolean; payee?: string | null; amount?: number | null }
type ImportResult = { fileId: string; ok: boolean; docId?: string; fileName?: string; message?: string; internal?: boolean; extracted?: Ex };

const LAST_FOLDER_KEY = "hrd.boxFolder.v2";
const store = {
  get: (k: string) => { try { return window.localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { window.localStorage.setItem(k, v); } catch { /* noop */ } },
};

function BoxImport({ ctx, docType, onImported, onManual }: { ctx: Ctx; docType: "invoice" | "receipt"; onImported: (list: { docId: string; fileName: string; extracted?: Ex }[]) => void; onManual: (file: File, boxId: string) => Promise<number> }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<BoxItem[] | null>(null);
  const [folderSupported, setFolderSupported] = useState(true);
  const [fields, setFields] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [cur, setCur] = useState<string>("");
  const [withSub, setWithSub] = useState(false);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const lastFolder = store.get(`${LAST_FOLDER_KEY}:${ctx.company.id}`);

  async function call(path: string, payload: unknown) { return authedPost(path, payload); }

  async function load(goTo?: string) {
    setBusy(true); setPicked(new Set());
    const { ok, j } = await call("/api/mf/box/folder", { companyId: ctx.company.id });
    setBusy(false);
    if (!ok) { ctx.toast(j.error ?? "クラウドBoxを読み込めませんでした", true); return; }
    const items = (j.items ?? []) as BoxItem[];
    setAll(items); setFolderSupported(!!j.folderSupported); setFields(j.fields ?? []); setTruncated(!!j.truncated);
    const target = goTo ?? lastFolder ?? "";
    const exists = target && items.some((it) => it.folder === target || it.folder.startsWith(target + "/"));
    setCur(exists ? target : "");
  }
  function openPanel() {
    const next = !open;
    setOpen(next);
    if (next && !all) load();
  }
  function goFolder(path: string) {
    setCur(path); setPicked(new Set()); setQ("");
    if (path) store.set(`${LAST_FOLDER_KEY}:${ctx.company.id}`, path);
  }

  // 現在のフォルダ直下のサブフォルダ（件数つき）
  const subfolders = useMemo(() => {
    if (!all || !folderSupported) return [] as { path: string; name: string; count: number; pending: number }[];
    const m = new Map<string, { count: number; pending: number }>();
    for (const it of all) {
      if (!it.folder) continue;
      if (cur && !(it.folder === cur || it.folder.startsWith(cur + "/"))) continue;
      const rest = cur ? it.folder.slice(cur.length + 1) : it.folder;
      if (!rest) continue;
      const name = rest.split("/")[0];
      const path = cur ? `${cur}/${name}` : name;
      const v = m.get(path) ?? { count: 0, pending: 0 };
      v.count++; if (!it.imported) v.pending++;
      m.set(path, v);
    }
    return [...m.entries()].map(([path, v]) => ({ path, name: path.split("/").pop() ?? path, ...v })).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }, [all, cur, folderSupported]);

  // 表示するファイル
  const files = useMemo(() => {
    if (!all) return [] as BoxItem[];
    const kw = q.trim().toLowerCase();
    return all.filter((it) => {
      if (folderSupported) {
        if (withSub) { if (cur && !(it.folder === cur || it.folder.startsWith(cur + "/"))) return false; }
        else if (it.folder !== cur) return false;
      }
      return !kw || it.name.toLowerCase().includes(kw) || (it.payee ?? "").toLowerCase().includes(kw);
    }).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.name.localeCompare(b.name, "ja"));
  }, [all, cur, withSub, q, folderSupported]);

  const pending = files.filter((f) => !f.imported && !f.blocked);
  const crumbs = cur ? cur.split("/") : [];

  async function importIds(ids: string[]) {
    if (!ids.length) return;
    setBusy(true);
    let okN = 0, blockedN = 0, ngN = 0; let firstErr = "";
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      setProgress(`取り込み中… ${Math.min(i + batch.length, ids.length)} / ${ids.length}件（請求書の内容も読み取っています）`);
      const { ok, j } = await call("/api/mf/box/import", { companyId: ctx.company.id, fileIds: batch, docType });
      if (!ok) { firstErr = j.error ?? "取り込めませんでした"; ngN += ids.length - i; break; }
      const res = (j.results ?? []) as ImportResult[];
      const good = res.filter((r) => r.ok && r.docId).map((r) => ({ docId: r.docId!, fileName: r.fileName ?? "", extracted: r.extracted }));
      if (good.length) onImported(good);
      const goodIds = new Set(res.filter((r) => r.ok).map((r) => r.fileId));
      const blockedIds = new Set(res.filter((r) => r.internal).map((r) => r.fileId));
      okN += goodIds.size; blockedN += blockedIds.size;
      const other = res.filter((r) => !r.ok && !r.internal);
      ngN += other.length; if (!firstErr && other[0]) firstErr = other[0].message ?? "";
      setAll((curAll) => curAll?.map((it) => (goodIds.has(it.id) ? { ...it, imported: true } : blockedIds.has(it.id) ? { ...it, blocked: true } : it)) ?? null);
      setPicked((p) => { const n = new Set(p); batch.forEach((b) => n.delete(b)); return n; });
    }
    setBusy(false); setProgress("");
    const parts = [`${okN}件取り込みました`];
    if (blockedN) parts.push(`${blockedN}件はAPIで取り出せないため、行の「Boxで開く」「ファイルを置く」で取り込んでください`);
    if (ngN) parts.push(`${ngN}件できませんでした：${firstErr}`);
    ctx.toast(parts.join("。"), blockedN + ngN > 0);
  }

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const kb = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB");

  return (
    <section className="card pad stack" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 10, justifyContent: "space-between" }}>
        <div className="row" style={{ gap: 10 }}>
          <Icon name="folders" size={20} color="#2440D8" />
          <h2 className="h2">マネーフォワード クラウドBoxから取り込む</h2>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {open && all && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => load(cur)}>最新に更新</button>}
          <button type="button" className="btn btn-sm" onClick={openPanel} aria-expanded={open}>{open ? "閉じる" : "Boxのフォルダを開く"}</button>
        </div>
      </div>

      {open && !all && <div className="skeleton" style={{ height: 120 }} aria-label="読み込み中" />}

      {open && all && (
        <>
          {!folderSupported && (
            <div className="stack" style={{ gap: 8, padding: 12, borderRadius: 10, background: "#FFF8F3", border: "1px solid #F0C9AE", fontSize: 13, lineHeight: 1.7 }}>
              <span>クラウドBox APIの一覧にフォルダの情報が含まれていないため、フォルダ別に表示できません。Boxの書類をすべて新しい順に表示しています（上の検索欄で絞り込めます）。</span>
              <details><summary style={{ cursor: "pointer" }}>APIが返した項目（値は含みません）</summary>
                <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", margin: "6px 0 0" }}>{fields.join("\n")}</pre>
              </details>
            </div>
          )}

          {folderSupported && (
            <>
              {/* パンくず */}
              <nav aria-label="フォルダの場所" className="row wrap" style={{ gap: 4, fontSize: 14 }}>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => goFolder("")} style={{ fontWeight: cur ? 400 : 700 }}>すべてのフォルダ</button>
                {crumbs.map((c, i) => {
                  const path = crumbs.slice(0, i + 1).join("/");
                  return (
                    <span key={path} className="row" style={{ gap: 4 }}>
                      <span className="muted">›</span>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => goFolder(path)} style={{ fontWeight: i === crumbs.length - 1 ? 700 : 400 }}>{c}</button>
                    </span>
                  );
                })}
                {lastFolder && lastFolder !== cur && (
                  <button type="button" className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => goFolder(lastFolder)}>前回のフォルダ：{lastFolder.split("/").pop()}</button>
                )}
              </nav>

              {/* サブフォルダ */}
              {subfolders.length > 0 && (
                <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
                  {subfolders.map((f) => (
                    <button key={f.path} type="button" className="tile" onClick={() => goFolder(f.path)} style={{ padding: 12 }}>
                      <span className="row" style={{ gap: 8 }}><Icon name="folders" size={18} color="#2440D8" /><strong style={{ fontSize: 14 }}>{f.name}</strong></span>
                      <span className="num muted" style={{ fontSize: 12 }}>{f.count}件{f.pending ? `（未取込 ${f.pending}件）` : "（すべて取込済）"}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ファイル一覧 */}
          <div className="row wrap" style={{ gap: 10, alignItems: "center" }}>
            <label htmlFor="boxq" className="sr">ファイル名・取引先で絞り込み</label>
            <input id="boxq" className="inp" style={{ flex: "1 1 220px", height: 38 }} placeholder="ファイル名・取引先で絞り込み" value={q} onChange={(e) => setQ(e.target.value)} />
            {folderSupported && subfolders.length > 0 && (
              <label className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={withSub} onChange={(e) => setWithSub(e.target.checked)} style={{ width: 18, height: 18, accentColor: "#2440D8" }} />下のフォルダの書類も表示</label>
            )}
          </div>

          {files.length === 0 ? (
            <div className="empty">{folderSupported && subfolders.length ? "このフォルダには書類がありません。上のフォルダをクリックして開いてください。" : "書類がありません"}</div>
          ) : (
            <>
              <div className="scroll-x" style={{ maxHeight: 380, overflowY: "auto", border: "1px solid #EFEDE8", borderRadius: 12 }}>
                <table className="tbl">
                  <thead><tr>
                    <th><input type="checkbox" aria-label="未取込をすべて選択" checked={pending.length > 0 && pending.every((p) => picked.has(p.id))} onChange={(e) => setPicked(e.target.checked ? new Set(pending.map((p) => p.id)) : new Set())} style={{ width: 18, height: 18, accentColor: "#2440D8" }} /></th>
                    <th>ファイル</th><th>日付</th><th className="r">サイズ</th><th />
                  </tr></thead>
                  <tbody>
                    {files.map((it) => (
                      <tr key={it.id}>
                        <td>{!it.imported && !it.blocked && <input type="checkbox" aria-label={`${it.name}を選択`} checked={picked.has(it.id)} onChange={() => toggle(it.id)} style={{ width: 18, height: 18, accentColor: "#2440D8" }} />}</td>
                        <td style={{ wordBreak: "break-all" }}>
                          <div style={{ fontWeight: 600 }}>{it.name}</div>
                          {(it.payee || it.amount || (withSub && it.folder !== cur)) && (
                            <div className="muted" style={{ fontSize: 12 }}>{[it.payee, it.amount ? yen(it.amount) : null, withSub && it.folder !== cur ? it.folder : null].filter(Boolean).join(" ・ ")}</div>
                          )}
                        </td>
                        <td className="num nw">{it.date ?? "—"}</td>
                        <td className="num r nw">{kb(it.size)}</td>
                        <td className="nw">
                          {it.imported && <span className="chip st-ok">取込済</span>}
                          {!it.imported && it.blocked && (
                            <div className="row" style={{ gap: 6 }}>
                              <a className="btn btn-sm" href={`https://box.moneyforward.com/files/${it.id}`} target="_blank" rel="noopener noreferrer">Boxで開く</a>
                              <label className="btn btn-sm btn-primary" style={{ cursor: "pointer" }}>
                                ファイルを置く
                                <input className="sr" type="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.webp" onChange={async (e) => {
                                  const f = e.target.files?.[0]; e.target.value = "";
                                  if (!f) return;
                                  if (!(await onManual(f, it.id))) return;
                                  setAll((c) => c?.map((x) => (x.id === it.id ? { ...x, imported: true } : x)) ?? null);
                                }} />
                              </label>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row wrap" style={{ gap: 10 }}>
                <span className="muted" style={{ fontSize: 13 }}>{files.length}件中 未取込 {pending.length}件 ・ 選択 {picked.size}件</span>
                {pending.length > 0 && picked.size === 0 && (
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => importIds(pending.map((p) => p.id))}>{busy ? "取り込み中…" : `未取込の${pending.length}件をすべて取り込む`}</button>
                )}
                {picked.size > 0 && (
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => importIds([...picked])}>{busy ? "取り込み中…" : `選んだ${picked.size}件を取り込む`}</button>
                )}
              </div>
              {truncated && <p className="muted" style={{ fontSize: 12, margin: 0 }}>Boxのファイルが多いため、新しいものから一部のみ読み込んでいます。</p>}
            </>
          )}
          {progress && <span className="chip st-wait" style={{ alignSelf: "flex-start", height: "auto", padding: "6px 10px" }}>{progress}</span>}
          <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.7 }}>取り込むと支払先・金額・支払期限を自動で読み取り、右の「内容の確認」に入ります。Boxは読み取りのみで、Box側のファイルは変更・削除しません。マネーフォワードの他サービスから保存されたファイルはAPIで取り出せないため、行の「Boxで開く」「ファイルを置く」で取り込みます。</p>
        </>
      )}
    </section>
  );
}
