"use client";
import { useEffect, useMemo, useState } from "react";
import type { Ctx } from "../ctx";
import { parseDate, sum, toISO, yen } from "@/lib/format";
import { viewPayments } from "@/lib/view";
import { buildZengin, downloadSjis } from "@/lib/zengin";
import { sb } from "@/lib/supabase";

export default function Fb({ ctx }: { ctx: Ctx }) {
  const [bankId, setBankId] = useState(ctx.banks[0]?.id ?? "");
  const [date, setDate] = useState(() => { const t = new Date(); return toISO(new Date(t.getFullYear(), t.getMonth() + 1, 0)); });
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!bankId && ctx.banks[0]) setBankId(ctx.banks[0].id); }, [ctx.banks, bankId]);

  const all = useMemo(() => viewPayments(ctx.payments, ctx.banks), [ctx.payments, ctx.banks]);
  const target = (bid: string) => all.filter((p) => p.bank_account_id === bid && p.status === "approved" && p.source !== "card");
  const items = target(bankId);
  const chosen = items.filter((p) => !off.has(p.id));
  const bank = ctx.banks.find((b) => b.id === bankId);
  const payeeMap = useMemo(() => new Map(ctx.payees.map((p) => [p.id, p])), [ctx.payees]);
  const fb = bank ? buildZengin(bank, parseDate(date), chosen, payeeMap) : null;

  async function download() {
    if (!bank || !fb) return;
    if (!ctx.canApprove) { ctx.toast("FBデータはオーナーまたは承認者のみ作成できます", true); return; }
    if (fb.count === 0) { ctx.toast("振込できる明細がありません", true); return; }
    setBusy(true);
    const okIds = chosen.filter((p) => !fb.issues.some((i) => i.paymentId === p.id)).map((p) => p.id);
    const { error } = await sb().from("fb_exports").insert({
      company_id: ctx.company.id, bank_account_id: bank.id, transfer_date: date,
      record_count: fb.count, total_amount: fb.total, payment_ids: okIds,
    });
    setBusy(false);
    if (error) { ctx.toast(error.message, true); return; }
    downloadSjis(fb.text, `FB_${bank.bank_name}_${date.replace(/-/g, "")}.txt`);
    ctx.toast(`FBデータを作成しました（${fb.count}件・${yen(fb.total)}）`);
  }

  if (ctx.banks.length === 0) {
    return <div className="card empty">振込元口座が登録されていません。設定 › 振込元口座 から登録してください。</div>;
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {ctx.banks.map((b) => {
          const xs = target(b.id);
          return (
            <button key={b.id} type="button" className={"tile" + (bankId === b.id ? " is-on" : "")} aria-pressed={bankId === b.id} onClick={() => { setBankId(b.id); setOff(new Set()); }}>
              <span className="lbl">振込元口座</span>
              <span style={{ fontSize: 15, fontWeight: 700 }}>{b.bank_name} {b.branch_name ?? ""}</span>
              <span className="num muted" style={{ fontSize: 12 }}>対象 {xs.length}件 ・ {yen(sum(xs, (p) => p.amount))}</span>
            </button>
          );
        })}
      </div>

      <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", alignItems: "start" }}>
        <section className="card pad stack" style={{ gap: 12, minWidth: 0 }}>
          <div className="row wrap" style={{ justifyContent: "space-between", gap: 12 }}>
            <h2 className="h2">振込対象</h2>
            <label className="row" style={{ gap: 8, fontSize: 13 }}>振込指定日<input className="inp" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 170 }} /></label>
          </div>
          {items.length === 0 && <span className="muted" style={{ fontSize: 13, padding: "12px 0" }}>この口座から振り込む承認済みの支払はありません。</span>}
          {items.map((p) => {
            const issue = fb?.issues.find((i) => i.paymentId === p.id);
            return (
              <label key={p.id} className="row" style={{ gap: 12, padding: "10px 0", borderBottom: "1px solid #EFEDE8", fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={!off.has(p.id)} onChange={() => setOff((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })} style={{ width: 18, height: 18, accentColor: "#2440D8" }} />
                <span className="num" style={{ width: 52, fontWeight: 600 }}>{p.md}</span>
                <span className="stack grow" style={{ gap: 2 }}>
                  <span>{p.payee_name}</span>
                  {issue && <span style={{ color: "#9B1C1C", fontSize: 12 }}>{issue.message}（設定 › 支払先 で登録）</span>}
                </span>
                <span className="num" style={{ fontWeight: 700 }}>{p.amt}</span>
              </label>
            );
          })}
          {fb && fb.issues.filter((i) => !i.paymentId).map((i, k) => <span key={k} className="chip st-err" style={{ height: "auto", padding: "6px 10px" }}>{i.message}</span>)}
          <div className="row" style={{ justifyContent: "space-between", fontWeight: 700 }}><span>FBに含める合計</span><span className="num">{fb?.count ?? 0}件 ／ {yen(fb?.total ?? 0)}</span></div>
          <span className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>承認済みのみが対象です。カードの引落は自動で除外します。ファイルはShift_JISで作られ、サーバーには残りません（作成記録だけ残ります）。</span>
          <button type="button" className="btn btn-primary" disabled={busy || !fb || fb.count === 0 || !ctx.canApprove} onClick={download}>FBデータをダウンロード（全銀形式 .txt）</button>
        </section>
        <section className="stack" style={{ background: "#17191E", borderRadius: 16, padding: 22, gap: 12, minWidth: 0 }}>
          <div className="row" style={{ justifyContent: "space-between", color: "#FFFFFF" }}>
            <h2 className="h2">プレビュー（全銀協 総合振込 120桁）</h2>
            <span style={{ fontSize: 12, color: "#A9ACB4" }}>{fb ? fb.lines.length : 0}行</span>
          </div>
          <pre className="fb num">{fb?.lines.join("\n")}</pre>
        </section>
      </div>
    </div>
  );
}
