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

  async function handle(files: File[]) {
    if (!ctx.canWrite) { ctx.toast("閲覧のみの権限では登録できません", true); return; }
    const ok = files.filter((f) => {
      if (f.size > MAX) { ctx.toast(`${f.name}：20MBを超えています`, true); return false; }
      if (f.type && !OK_TYPES.includes(f.type)) { ctx.toast(`${f.name}：PDF・画像のみ登録できます`, true); return false; }
      return true;
    });
    if (!ok.length) return;
    setUploading((n) => n + ok.length);
    await Promise.all(ok.map(async (f) => {
      const path = `${ctx.company.id}/${crypto.randomUUID()}-${f.name.replace(/[^\w.\-]+/g, "_")}`;
      const up = await sb().storage.from("inbox").upload(path, f, { contentType: f.type || undefined, upsert: false });
      if (up.error) { ctx.toast(`${f.name}：アップロードに失敗しました（${up.error.message}）`, true); setUploading((n) => n - 1); return; }
      const { data, error } = await sb().from("documents").insert({
        company_id: ctx.company.id, doc_type: isExp ? "receipt" : "invoice", file_name: f.name,
        mime_type: f.type || null, size_bytes: f.size, temp_path: path,
      }).select("id").single();
      setUploading((n) => n - 1);
      if (error || !data) { ctx.toast(`${f.name}：登録に失敗しました（${error?.message}）`, true); return; }
      setDrafts((ds) => [{
        key: data.id, docId: data.id, file: f.name,
        payee: isExp ? (ctx.me?.display_name ?? "") : guessPayee(f.name), item: isExp ? "立替経費精算" : "",
        amount: "", due: endOfMonth(), kind: "spot", account: isExp ? "未払金" : "買掛金", bank: ctx.banks[0]?.id ?? "",
      }, ...ds]);
    }));
    ctx.reload();
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
  );
}
