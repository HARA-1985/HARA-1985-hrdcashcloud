"use client";
import { useMemo, useState } from "react";
import type { Ctx } from "../ctx";
import { sameMonth, sum, yen } from "@/lib/format";
import { viewPayments } from "@/lib/view";
import { SOURCE_LABEL, STATUS_CLS, STATUS_LABEL, type PayStatus } from "@/lib/types";
import { sb } from "@/lib/supabase";

type KindF = "all" | "fixed" | "spot";
type MonthF = "all" | "this" | "next";
type StatusF = "open" | "pending" | "approved" | "paid";

export default function Schedule({ ctx }: { ctx: Ctx }) {
  const [kind, setKind] = useState<KindF>("all");
  const [month, setMonth] = useState<MonthF>("all");
  const [st, setSt] = useState<StatusF>("open");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const q = ctx.q.trim().toLowerCase();
    return viewPayments(ctx.payments, ctx.banks).filter((p) =>
      (kind === "all" || p.kind === kind) &&
      (month === "all" || (month === "this" ? sameMonth(p.d, now) : sameMonth(p.d, next))) &&
      (st === "open" ? p.status !== "paid" : p.status === st) &&
      (!q || (p.payee_name + " " + (p.item ?? "") + " " + p.amount).toLowerCase().includes(q)));
  }, [ctx.payments, ctx.banks, ctx.q, kind, month, st]);

  async function setStatus(ids: string[], status: PayStatus, msg: string) {
    if (!ids.length) return;
    setBusy(true);
    const prev = ctx.payments;
    ctx.setPayments((ps) => ps.map((p) => (ids.includes(p.id) ? { ...p, status } : p))); // 先に画面へ反映
    const { error } = await sb().from("payments").update({ status }).in("id", ids);
    setBusy(false);
    if (error) { ctx.setPayments(prev); ctx.toast(error.message, true); return; }
    setPicked(new Set());
    ctx.toast(msg);
    ctx.reload();
  }

  const mfOn = ctx.mf?.status === "connected" && ctx.canApprove;
  const mfTargets = rows.filter((p) => p.status === "paid" && p.mf_sync_status !== "done" && p.mf_sync_status !== "syncing").map((p) => p.id);

  async function postToMf(ids: string[]) {
    if (!ids.length) return;
    setBusy(true);
    const { data } = await sb().auth.getSession();
    const res = await fetch("/api/mf/journal", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token ?? ""}` }, body: JSON.stringify({ companyId: ctx.company.id, paymentIds: ids }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { ctx.toast(j.error ?? "仕訳を登録できませんでした", true); return; }
    const ng = (j.results ?? []).filter((r: { ok: boolean }) => !r.ok);
    if (ng.length) ctx.toast(`${j.created}件登録、${ng.length}件失敗：${ng[0].message ?? ""}`, true);
    else ctx.toast(`マネーフォワードに仕訳を${j.created}件登録しました`);
    ctx.reload();
  }

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pendingPicked = rows.filter((p) => picked.has(p.id) && p.status === "pending").map((p) => p.id);

  const Pills = <T extends string>({ opts, val, set }: { opts: [T, string][]; val: T; set: (v: T) => void }) => (
    <>{opts.map(([k, l]) => <button key={k} type="button" className={"pill" + (val === k ? " is-on" : "")} aria-pressed={val === k} onClick={() => set(k)}>{l}</button>)}</>
  );

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <Pills opts={[["all", "すべて"], ["fixed", "毎月固定"], ["spot", "臨時"]]} val={kind} set={setKind} />
        <span className="sep" />
        <Pills opts={[["all", "全期間"], ["this", "今月"], ["next", "翌月"]]} val={month} set={setMonth} />
        <span className="sep" />
        <Pills opts={[["open", "未払い"], ["pending", "承認待ち"], ["approved", "承認済"], ["paid", "支払済"]]} val={st} set={setSt} />
        <span className="grow" />
        <span className="muted" style={{ fontSize: 13 }}>表示中 <strong className="num" style={{ color: "#17191E" }}>{rows.length}件 ／ {yen(sum(rows, (p) => p.amount))}</strong></span>
      </div>

      {mfOn && mfTargets.length > 0 && (st === "paid" || st === "open") && (
        <div className="card row wrap" style={{ padding: "12px 16px", gap: 12 }}>
          <span>支払済みでマネーフォワード未登録：<strong className="num">{mfTargets.length}件</strong></span>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => postToMf(mfTargets)}>まとめて仕訳登録</button>
        </div>
      )}

      {ctx.canApprove && pendingPicked.length > 0 && (
        <div className="card row wrap" style={{ padding: "12px 16px", gap: 12, background: "#F2F4FE", borderColor: "#C9D1F7" }}>
          <span style={{ fontWeight: 600 }}>{pendingPicked.length}件を選択中</span>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => setStatus(pendingPicked, "approved", `${pendingPicked.length}件を承認しました`)}>まとめて承認</button>
          <button type="button" className="btn btn-sm" onClick={() => setPicked(new Set())}>選択を解除</button>
        </div>
      )}

      <div className="card scroll-x">
        {rows.length === 0 ? <div className="empty">条件に合う支払予定はありません</div> : (
          <table className="tbl">
            <thead>
              <tr>
                {ctx.canApprove && <th><span className="sr">選択</span></th>}
                <th>支払日</th><th>相手先 ／ 内容</th><th>区分</th><th>取込元</th><th>金融機関</th><th>勘定科目</th><th className="r">金額</th><th>書類</th><th>ステータス</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  {ctx.canApprove && (
                    <td>{p.status === "pending" && <input type="checkbox" aria-label={`${p.payee_name}を選択`} checked={picked.has(p.id)} onChange={() => toggle(p.id)} style={{ width: 18, height: 18, accentColor: "#2440D8" }} />}</td>
                  )}
                  <td className="num nw" style={{ fontWeight: 600 }}>{p.md} <span className="muted" style={{ fontWeight: 400 }}>({p.wd})</span></td>
                  <td style={{ minWidth: 220 }}><div className="stack" style={{ gap: 2 }}><span style={{ fontWeight: 600 }}>{p.payee_name}</span><span className="muted" style={{ fontSize: 12 }}>{p.item}</span></div></td>
                  <td><span className={p.kindCls}>{p.kindLabel}</span></td>
                  <td className="nw" style={{ color: "#4A4E57" }}>{SOURCE_LABEL[p.source]}</td>
                  <td className="nw" style={{ color: "#4A4E57" }}>{p.bankName}</td>
                  <td className="nw" style={{ color: "#4A4E57" }}>{p.account_title}</td>
                  <td className="num r nw" style={{ fontWeight: 700 }}>{p.amt}</td>
                  <td>{p.document_id ? <button type="button" className="btn btn-sm" onClick={() => ctx.openDoc(p.document_id!)} aria-label={`${p.payee_name}の書類を表示`}>PDF</button> : <span className="muted" style={{ fontSize: 12 }}>—</span>}</td>
                  <td className="nw"><span className={STATUS_CLS[p.status]}>{STATUS_LABEL[p.status]}</span></td>
                  <td className="nw">
                    <div className="row" style={{ gap: 6 }}>
                      {ctx.canApprove && p.status === "pending" && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => setStatus([p.id], "approved", "承認しました：" + p.payee_name)}>承認</button>}
                      {ctx.canApprove && p.status === "approved" && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setStatus([p.id], "pending", "承認を取り消しました")}>承認取消</button>}
                      {ctx.canWrite && (p.status === "approved" || p.status === "auto_debit") && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setStatus([p.id], "paid", "支払済にしました")}>支払済にする</button>}
                      {p.status === "paid" && p.mf_sync_status === "done" && <span className="chip st-ok">MF登録済</span>}
                      {p.status === "paid" && p.mf_sync_status === "syncing" && <span className="chip st-wait">MF登録中</span>}
                      {mfOn && p.status === "paid" && (p.mf_sync_status === "none" || p.mf_sync_status === "error" || !p.mf_sync_status) && (
                        <button type="button" className="btn btn-sm" disabled={busy} title={p.mf_sync_error ?? undefined} onClick={() => postToMf([p.id])} style={p.mf_sync_status === "error" ? { borderColor: "#E9A3A3", color: "#9B1C1C" } : undefined}>
                          {p.mf_sync_status === "error" ? "MF再登録" : "MFへ仕訳"}
                        </button>
                      )}
                      {ctx.canWrite && p.status === "pending" && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => { if (confirm(`${p.payee_name} ${p.amt} を取り消しますか？`)) setStatus([p.id], "cancelled", "取り消しました"); }}>取消</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!ctx.canApprove && <p className="muted" style={{ fontSize: 12, margin: 0 }}>承認はオーナーまたは承認者が行います。</p>}
    </div>
  );
}
