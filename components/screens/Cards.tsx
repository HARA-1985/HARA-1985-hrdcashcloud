"use client";
import { useMemo, useState } from "react";
import type { Ctx } from "../ctx";
import { md, parseDate, sum, yen } from "@/lib/format";
import { sb } from "@/lib/supabase";
import Icon from "../Icon";

export default function Cards({ ctx }: { ctx: Ctx }) {
  const [busy, setBusy] = useState(false);
  const byCard = useMemo(() => {
    const m = new Map<string, typeof ctx.cards>();
    ctx.cards.forEach((t) => m.set(t.card_name, [...(m.get(t.card_name) ?? []), t]));
    return [...m.entries()];
  }, [ctx.cards]);
  const upcoming = ctx.payments.filter((p) => p.source === "card" && p.status !== "paid");

  async function sync() {
    setBusy(true);
    const { data } = await sb().auth.getSession();
    const res = await fetch("/api/mf/sync", { method: "POST", headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}`, "Content-Type": "application/json" }, body: JSON.stringify({ companyId: ctx.company.id }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) ctx.toast(j.error ?? "同期できませんでした", true); else { ctx.toast("カード明細を同期しました"); ctx.reload(); }
  }

  const connected = ctx.mf?.status === "connected";
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card pad row wrap" style={{ gap: 16 }}>
        <div className="stack grow" style={{ gap: 4, flex: "1 1 280px" }}>
          <strong>マネーフォワード クラウド</strong>
          <span className="muted" style={{ fontSize: 13 }}>
            {connected ? `${ctx.mf?.office_name ?? ""}　最終同期 ${ctx.mf?.last_synced_at ? new Date(ctx.mf.last_synced_at).toLocaleString("ja-JP") : "—"}` : ""}
          </span>
        </div>
        <span className={"chip " + (connected ? "st-ok" : "st-auto")}>{connected ? "連携中" : "未連携"}</span>
        <button type="button" className="btn" disabled={busy || !ctx.canWrite} onClick={sync}><Icon name="sync" size={16} />{busy ? "同期中…" : "いま同期"}</button>
      </div>

      {upcoming.length > 0 && (
        <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          {upcoming.map((p) => (
            <div key={p.id} className="card pad stack" style={{ gap: 6 }}>
              <span className="lbl">次回引落</span>
              <strong style={{ fontSize: 15 }}>{p.payee_name}</strong>
              <span className="num" style={{ fontSize: 24, fontWeight: 700 }}>{yen(p.amount)}</span>
              <span className="muted" style={{ fontSize: 12 }}>{md(parseDate(p.due_date))} 引落</span>
            </div>
          ))}
        </div>
      )}

      <section className="card scroll-x">
        <div className="row" style={{ padding: "18px 22px 8px", justifyContent: "space-between" }}>
          <h2 className="h2">利用明細</h2>
          <span className="muted" style={{ fontSize: 12 }}>{ctx.cards.length}件 ・ {yen(sum(ctx.cards, (t) => t.amount))}</span>
        </div>
        {ctx.cards.length === 0 ? <div className="empty">利用明細はありません</div> : (
          <table className="tbl">
            <thead><tr><th>利用日</th><th>利用先</th><th>カード</th><th>勘定科目</th><th className="r">金額</th><th>領収書</th></tr></thead>
            <tbody>
              {byCard.flatMap(([, ts]) => ts).map((t) => (
                <tr key={t.id}>
                  <td className="num" style={{ fontWeight: 600 }}>{md(parseDate(t.used_on))}</td>
                  <td>{t.merchant}</td>
                  <td style={{ color: "#4A4E57" }}>{t.card_name}</td>
                  <td><span className="chip st-auto">{t.suggested_account ?? "—"}</span></td>
                  <td className="num r" style={{ fontWeight: 700 }}>{yen(t.amount)}</td>
                  <td>{t.receipt_document_id ? <button type="button" className="btn btn-sm" onClick={() => ctx.openDoc(t.receipt_document_id!)}>表示</button> : <span className="chip st-wait">未添付</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
