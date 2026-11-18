"use client";
import { useRef, useState } from "react";
import type { Ctx } from "../ctx";
import { sb } from "@/lib/supabase";
import { parseDate, toISO, yen } from "@/lib/format";
import { ACCOUNT_TITLES, type Kind } from "@/lib/types";
import Icon from "../Icon";

interface Draft {
  key: string; docId: string; file: string;
  payee: string; item: string; amount: string; due: string; kind: Kind; account: string; bank: string;
  saving?: boolean; saved?: boolean;
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

  const newDraft = (docId: string, file: string): Draft => ({
    key: docId, docId, file,
    payee: isExp ? (ctx.me?.display_name ?? "") : guessPayee(file), item: isExp ? "立替経費精算" : "",
    amount: "", due: endOfMonth(), kind: "spot", account: isExp ? "未払金" : "買掛金", bank: ctx.banks[0]?.id ?? "",
  });
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
      addDrafts([newDraft(data.id, f.name)]);
      okCount++;
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
      <BoxImport ctx={ctx} docType={isExp ? "receipt" : "invoice"} onImported={(list) => { addDrafts(list.map((x) => newDraft(x.docId, x.fileName))); ctx.reload(); }}
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
        <datalist id="payees">{ctx.payees.map((p) => <option key={p.id} value={p.name} />)}</datalist>
        {drafts.map((d) => (
          <div key={d.key} className="stack" style={{ gap: 10, padding: 14, borderRadius: 12, background: d.saved ? "#F1F8F4" : "#F7F6F3", border: "1px solid #E4E2DC" }}>
            <div className="row" style={{ gap: 10 }}>
              <button type="button" className="btn btn-sm" onClick={() => ctx.openDoc(d.docId)}><Icon name="doc" size={14} />表示</button>
              <span className="grow muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.file}</span>
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

/* ---------- クラウドBoxから取り込む ---------- */
interface BoxItem { id: string; name: string; size: number; date: string | null; dateKey: string | null; imported: boolean; blocked?: boolean }

function BoxImport({ ctx, docType, onImported, onManual }: { ctx: Ctx; docType: "invoice" | "receipt"; onImported: (list: { docId: string; fileName: string }[]) => void; onManual: (file: File, boxId: string) => Promise<number> }) {
  const t = new Date();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(toISO(new Date(t.getFullYear(), t.getMonth() - 1, 1)));
  const [to, setTo] = useState(toISO(t));
  const [q, setQ] = useState(docType === "invoice" ? "請求" : "");
  const [items, setItems] = useState<BoxItem[] | null>(null);
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  async function call(path: string, payload: unknown) {
    const { data } = await sb().auth.getSession();
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token ?? ""}` }, body: JSON.stringify(payload) });
    return { ok: res.ok, j: await res.json().catch(() => ({})) };
  }
  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    if (from && to && from > to) { ctx.toast("期間の開始日が終了日より後になっています", true); return; }
    setBusy(true); setPicked(new Set()); setNote("");
    const { ok, j } = await call("/api/mf/box/files", { companyId: ctx.company.id, from, to, q });
    setBusy(false);
    if (!ok) { ctx.toast(j.error ?? "クラウドBoxを検索できませんでした", true); return; }
    setItems(j.items ?? []);
    const notes: string[] = [];
    if (j.noDateField) notes.push("Boxの一覧に日付情報が無いため、期間では絞り込めていません（キーワードで絞り込んでください）");
    if (j.truncated) notes.push("件数が多いため一部のみ表示しています。期間やキーワードを絞ってください");
    setNote(notes.join(" ／ "));
  }
  async function importPicked() {
    const ids = [...picked].slice(0, 20);
    if (!ids.length) return;
    setBusy(true);
    const { ok, j } = await call("/api/mf/box/import", { companyId: ctx.company.id, fileIds: ids, docType });
    setBusy(false);
    if (!ok) { ctx.toast(j.error ?? "取り込めませんでした", true); return; }
    const res = (j.results ?? []) as { fileId: string; ok: boolean; docId?: string; fileName?: string; message?: string; internal?: boolean }[];
    const good = res.filter((r) => r.ok && r.docId).map((r) => ({ docId: r.docId!, fileName: r.fileName ?? "" }));
    const bad = res.filter((r) => !r.ok);
    if (good.length) onImported(good);
    const goodIds = new Set(res.filter((r) => r.ok).map((r) => r.fileId));
    const blockedIds = new Set(res.filter((r) => r.internal).map((r) => r.fileId));
    setItems((cur) => cur?.map((it) => (goodIds.has(it.id) ? { ...it, imported: true } : blockedIds.has(it.id) ? { ...it, blocked: true } : it)) ?? null);
    setPicked(new Set());
    const other = bad.filter((r) => !r.internal);
    if (blockedIds.size && !other.length) ctx.toast(`${good.length}件取り込みました。${blockedIds.size}件はAPIで取り出せないファイルです。一覧の「Boxで開く」からダウンロードし、その行の「ファイルを置く」で取り込んでください`, true);
    else if (bad.length) ctx.toast(`${good.length}件取り込み、${bad.length}件できませんでした：${(other[0] ?? bad[0]).message ?? ""}`, true);
    else ctx.toast(`クラウドBoxから${good.length}件取り込みました。右の「内容の確認」で支払予定に登録してください`);
  }
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else if (n.size < 20) n.add(id); return n; });
  const kb = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB");

  return (
    <section className="card pad stack" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 10, justifyContent: "space-between" }}>
        <div className="row" style={{ gap: 10 }}>
          <Icon name="folders" size={20} color="#2440D8" />
          <h2 className="h2">マネーフォワード クラウドBoxから取り込む</h2>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "閉じる" : "期間を指定して探す"}</button>
      </div>
      {open && (
        <>
          <form className="row wrap" style={{ gap: 10, alignItems: "flex-end" }} onSubmit={search}>
            <label className="field" style={{ width: 170 }}><span>期間（開始）</span><input className="inp" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="field" style={{ width: 170 }}><span>期間（終了）</span><input className="inp" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <label className="field" style={{ flex: "1 1 200px" }}><span>ファイル名のキーワード（任意）</span><input className="inp" value={q} onChange={(e) => setQ(e.target.value)} placeholder="請求、取引先名など" /></label>
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "検索中…" : "検索"}</button>
          </form>
          {note && <p className="muted" style={{ fontSize: 12, margin: 0 }}>{note}</p>}
          {items && (
            items.length === 0 ? <div className="empty">条件に合うPDF・画像はありませんでした</div> : (
              <>
                <div className="scroll-x" style={{ maxHeight: 360, overflowY: "auto", border: "1px solid #EFEDE8", borderRadius: 12 }}>
                  <table className="tbl">
                    <thead><tr><th><span className="sr">選択</span></th><th>ファイル名</th><th>日付</th><th className="r">サイズ</th><th /></tr></thead>
                    <tbody>
                      {items.map((it) => (
                        <tr key={it.id}>
                          <td>{!it.imported && <input type="checkbox" aria-label={`${it.name}を選択`} checked={picked.has(it.id)} onChange={() => toggle(it.id)} style={{ width: 18, height: 18, accentColor: "#2440D8" }} />}</td>
                          <td style={{ fontWeight: 600, wordBreak: "break-all" }}>{it.name}</td>
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
                                    setItems((cur) => cur?.map((x) => (x.id === it.id ? { ...x, imported: true } : x)) ?? null);
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
                  <span className="muted" style={{ fontSize: 13 }}>{picked.size}件選択中（一度に20件まで）</span>
                  <button type="button" className="btn btn-primary" disabled={busy || picked.size === 0} onClick={importPicked}>{busy ? "取り込み中…" : "選んだファイルを取り込む"}</button>
                </div>
              </>
            )
          )}
          <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.7 }}>マネーフォワードの他サービス（クラウド会計の証憑添付・証憑自動取得など）から保存されたファイルは、マネーフォワードの仕様によりAPIでは取り出せません。その場合は行に「Boxで開く」「ファイルを置く」が出るので、Boxの画面でダウンロードしたファイルを置いてください（Boxのファイルと紐付けて記録します）。<br />クラウドBoxは読み取りのみで、Box側のファイルは変更・削除しません。取り込んだ書類は原本がBoxにあるため「保存済」として扱い、二重に取り込まれないようにしています。</p>
        </>
      )}
    </section>
  );
}
