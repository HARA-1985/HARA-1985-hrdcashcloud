"use client";
import { useEffect, useState } from "react";
import type { Ctx } from "./ctx";
import { sb } from "@/lib/supabase";
import { parseDate, sum, yen, ymLabel } from "@/lib/format";
import { SOURCE_LABEL } from "@/lib/types";
import Icon from "./Icon";

export default function DocViewer({ ctx, docId, onClose }: { ctx: Ctx; docId: string; onClose: () => void }) {
  const doc = ctx.docs.find((d) => d.id === docId);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const pays = ctx.payments.filter((p) => p.document_id === docId);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!doc?.temp_path) { setErr(doc?.mf_box_status === "stored" ? "原本はマネーフォワード クラウドBoxに保存されています。右の「クラウドBoxで原本を開く」から表示できます。" : "ファイルが見つかりません"); return; }
      const { data, error } = await sb().storage.from("inbox").createSignedUrl(doc.temp_path, 120);
      if (!alive) return;
      if (error || !data) setErr(error?.message ?? "表示できません"); else setUrl(data.signedUrl);
    })();
    return () => { alive = false; };
  }, [doc?.temp_path, doc?.mf_box_status]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isImg = doc?.mime_type?.startsWith("image/");
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="書類プレビュー" onClick={(e) => e.stopPropagation()}>
        <div style={{ flex: "999 1 520px", minWidth: 0, background: "#E9E7E1", padding: 20, display: "flex", justifyContent: "center", alignItems: "center", minHeight: 520 }}>
          {url && !isImg && <iframe title={doc?.file_name} src={url} style={{ width: "100%", height: "78vh", border: 0, background: "#fff", borderRadius: 6 }} />}
          {url && isImg && /* eslint-disable-next-line @next/next/no-img-element */ <img src={url} alt={doc?.file_name ?? ""} style={{ maxWidth: "100%", maxHeight: "78vh", borderRadius: 6 }} />}
          {!url && !err && <div className="skeleton" style={{ width: "80%", height: 480 }} />}
          {err && <p className="muted">{err}</p>}
        </div>
        <aside className="stack" style={{ flex: "1 1 280px", padding: 24, gap: 16 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="lbl">書類情報</span>
            <button type="button" onClick={onClose} aria-label="閉じる" style={{ width: 44, height: 44, border: 0, borderRadius: 10, background: "#F5F4F0", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="close" width={2} /></button>
          </div>
          <strong style={{ fontSize: 15, wordBreak: "break-all" }}>{doc?.file_name}</strong>
          {pays.length > 0 && <div className="num" style={{ fontSize: 28, fontWeight: 700 }}>{yen(sum(pays, (p) => p.amount))}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "96px minmax(0,1fr)", gap: "10px 12px", fontSize: 13 }}>
            {pays[0] && <><span className="muted">支払先</span><span style={{ fontWeight: 600 }}>{pays[0].payee_name}</span>
              <span className="muted">支払日</span><span>{pays[0].due_date}</span>
              <span className="muted">取込元</span><span>{SOURCE_LABEL[pays[0].source]}</span></>}
            <span className="muted">保管先</span>
            <span style={{ color: "#2236B8", wordBreak: "break-all" }}>
              /{doc?.folder_month ? ymLabel(parseDate(doc.folder_month)) : "未仕分け"}/{doc?.account_title ?? "未設定"}/
            </span>
            <span className="muted">MF クラウドBox</span>
            <span>{doc?.mf_box_status === "stored" ? "保存済" : doc?.mf_box_status === "failed" ? "保存に失敗" : "保存待ち（連携後に自動保存）"}</span>
          </div>
          {url && <a className="btn btn-primary" href={url} target="_blank" rel="noreferrer" style={{ marginTop: "auto" }}>新しいタブで開く</a>}
          {!url && doc?.mf_box_file_id && <a className="btn btn-primary" href={`https://box.moneyforward.com/files/${doc.mf_box_file_id}`} target="_blank" rel="noopener noreferrer" style={{ marginTop: "auto" }}>クラウドBoxで原本を開く</a>}
        </aside>
      </div>
    </div>
  );
}
