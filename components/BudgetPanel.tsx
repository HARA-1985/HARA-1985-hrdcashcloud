"use client";
import { useEffect, useMemo, useState } from "react";
import type { Ctx } from "./ctx";
import { sb } from "@/lib/supabase";
import { yen } from "@/lib/format";
import { actualLines, BUDGET_MAIN, diffRate, fiscalYearOf, fmtRate, isLargeVariance, mkey, sumBy, type Budget, type BudgetLine } from "@/lib/budget";

/** ダッシュボード：今月（または来月）の区分別 予算比較。大きく増えた区分は臨時の請求書から要因を示す */
export default function BudgetPanel({ ctx }: { ctx: Ctx }) {
  const start = ctx.company.fiscal_start_month ?? 4;
  const [offset, setOffset] = useState(0);
  const target = useMemo(() => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth() + offset, 1); }, [offset]);
  const month = mkey(target);
  const fy = fiscalYearOf(target, start);
  const [budget, setBudget] = useState<Budget | null | undefined>(undefined);
  const [lines, setLines] = useState<BudgetLine[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await sb().from("budgets").select("*").eq("company_id", ctx.company.id).eq("fiscal_year", fy).order("updated_at", { ascending: false });
      const list = (data as Budget[]) ?? [];
      const b = list.find((x) => x.status === "approved") ?? list[0] ?? null;
      if (!alive) return;
      setBudget(b);
      if (!b) { setLines([]); return; }
      const { data: ls } = await sb().from("budget_lines").select("cf_item,payee_name,month,amount").eq("budget_id", b.id).eq("month", month);
      if (alive) setLines((ls as BudgetLine[]) ?? []);
    })();
    return () => { alive = false; };
  }, [ctx.company.id, fy, month]);

  const actual = useMemo(() => {
    const end = new Date(target.getFullYear(), target.getMonth() + 1, 1);
    return actualLines(ctx.payments, ctx.banks, end).filter((a) => a.month === month);
  }, [ctx.payments, ctx.banks, target, month]);

  if (budget === undefined) return null;

  const bCat = sumBy(lines, (l) => l.cf_item, (l) => l.amount);
  const aCat = sumBy(actual, (a) => a.cf_item, (a) => a.amount);
  const mLabel = `${target.getMonth() + 1}月`;

  return (
    <section className="card pad stack" style={{ gap: 16 }}>
      <div className="row wrap" style={{ justifyContent: "space-between", gap: 8 }}>
        <h2 className="h2">予算比較（{mLabel}）
          <button type="button" className="btn btn-sm" style={{ marginLeft: 8, verticalAlign: "middle" }} onClick={() => ctx.go("budget")}>予算を見る</button>
        </h2>
        <div className="row" style={{ gap: 4 }} role="group" aria-label="対象月">
          {["今月", "来月（見込）"].map((l, i) => <button key={l} type="button" className={"btn btn-sm" + (offset === i ? " btn-primary" : "")} aria-pressed={offset === i} onClick={() => { setOffset(i); setOpen(null); }}>{l}</button>)}
        </div>
      </div>

      {!budget ? (
        <div className="row wrap" style={{ gap: 12, padding: 16, borderRadius: 12, background: "#F5F4F0" }}>
          <span className="grow" style={{ fontSize: 13 }}>{fy}年度の予算がまだありません。過去の支払実績から予算案を作ると、ここで区分ごとに予算と比べられます。</span>
          {ctx.canWrite && <button type="button" className="btn btn-sm btn-primary" onClick={() => ctx.go("budget")}>予算を作成</button>}
        </div>
      ) : (
        <>
          <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(210px, 100%), 1fr))", gap: 12 }}>
            {BUDGET_MAIN.map((c) => {
              const b = bCat.get(c) ?? 0, a = aCat.get(c) ?? 0;
              const large = isLargeVariance(a, b);
              const up = large && a > b;
              const w = Math.max(a, b) || 1;
              return (
                <button key={c} type="button" className="tile" onClick={() => setOpen(open === c ? null : c)} aria-expanded={open === c}
                  style={{ gap: 8, borderColor: up ? "#F0B4B4" : large ? "#B7E0C6" : undefined, background: up ? "#FFF7F7" : undefined, cursor: "pointer" }}>
                  <div className="row" style={{ width: "100%", gap: 6 }}>
                    <span className="lbl grow">{c}</span>
                    {large && <span className={"chip " + (up ? "st-err" : "st-ok")}>{up ? "増加" : "減少"} {fmtRate(diffRate(a, b))}</span>}
                  </div>
                  <span className="num" style={{ fontSize: 20, fontWeight: 700 }}>{yen(a)}</span>
                  <span className="muted num" style={{ fontSize: 12 }}>予算 {yen(b)} ／ 差 {a - b >= 0 ? "+" : ""}{yen(a - b)}</span>
                  <div className="stack" style={{ gap: 3, width: "100%" }}>
                    <div className="bar" style={{ background: "#EEEDE9" }}><div style={{ width: `${Math.round((b / w) * 100)}%`, background: "#A9ACB4" }} /></div>
                    <div className="bar" style={{ background: "#EEEDE9" }}><div style={{ width: `${Math.round((a / w) * 100)}%`, background: up ? "#C23B3B" : "#2440D8" }} /></div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="row muted" style={{ gap: 14, fontSize: 12 }}>
            <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 6, borderRadius: 3, background: "#A9ACB4" }} />予算</span>
            <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 6, borderRadius: 3, background: "#2440D8" }} />実績・見込</span>
            <span>差異 ±20% 以上かつ10万円以上で「増加／減少」を表示。カードを押すと内訳を表示します。</span>
          </div>
          {open && <Factors ctx={ctx} cf={open} lines={actual.filter((a) => a.cf_item === open)} budget={bCat.get(open) ?? 0} budgetLines={lines.filter((l) => l.cf_item === open)} />}
        </>
      )}
    </section>
  );
}

function Factors({ ctx, cf, lines, budget, budgetLines }: {
  ctx: Ctx; cf: string; lines: ReturnType<typeof actualLines>; budget: number; budgetLines: BudgetLine[];
}) {
  const spot = lines.filter((a) => a.kind === "spot").sort((x, y) => y.amount - x.amount);
  const total = lines.reduce((s, a) => s + a.amount, 0);
  const spotTotal = spot.reduce((s, a) => s + a.amount, 0);
  // 相手先別に予算との差が大きい順
  const bp = sumBy(budgetLines, (l) => l.payee_name, (l) => l.amount);
  const ap = sumBy(lines, (a) => a.payee_name, (a) => a.amount);
  const payees = [...new Set([...bp.keys(), ...ap.keys()])].map((p) => ({ p, b: bp.get(p) ?? 0, a: ap.get(p) ?? 0 }))
    .map((x) => ({ ...x, d: x.a - x.b })).sort((x, y) => y.d - x.d).filter((x) => x.d !== 0).slice(0, 5);

  return (
    <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))", gap: 12 }}>
      <div className="stack" style={{ gap: 8, padding: 16, borderRadius: 12, border: "1px solid #F0C9AE", background: "#FFF8F3" }}>
        <strong style={{ fontSize: 13, color: "#9A420A" }}>{cf}：臨時の請求書（増加要因の候補）</strong>
        <span className="muted" style={{ fontSize: 12 }}>臨時 {yen(spotTotal)}（{total ? Math.round((spotTotal / total) * 100) : 0}%）／ 予算との差 {total - budget >= 0 ? "+" : ""}{yen(total - budget)}</span>
        {spot.length === 0 ? <span className="muted" style={{ fontSize: 13 }}>この月の臨時の支払はありません。毎月固定の金額の変化をご確認ください。</span> : spot.slice(0, 6).map((a) => (
          <div key={a.id} className="row" style={{ gap: 10, fontSize: 13, padding: "6px 0", borderBottom: "1px solid #F3DCCB" }}>
            <span className="num muted" style={{ width: 42 }}>{a.due.getMonth() + 1}/{a.due.getDate()}</span>
            <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><strong>{a.payee_name}</strong> <span className="muted">{a.item ?? ""}</span></span>
            <span className="num" style={{ fontWeight: 700 }}>{yen(a.amount)}</span>
            {a.document_id && <button type="button" className="btn btn-sm" onClick={() => ctx.openDoc(a.document_id!)}>請求書</button>}
          </div>
        ))}
      </div>
      <div className="stack" style={{ gap: 8, padding: 16, borderRadius: 12, border: "1px solid #E4E2DC" }}>
        <strong style={{ fontSize: 13 }}>{cf}：相手先別 予算との差（大きい順）</strong>
        {payees.length === 0 ? <span className="muted" style={{ fontSize: 13 }}>差はありません</span> : payees.map((x) => (
          <div key={x.p} className="row" style={{ gap: 10, fontSize: 13, padding: "6px 0", borderBottom: "1px solid #EFEDE8" }}>
            <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.p || "（区分全体）"}</span>
            <span className="num muted" style={{ fontSize: 12 }}>予算 {yen(x.b)}</span>
            <span className="num" style={{ fontWeight: 700, color: x.d > 0 ? "#9B1C1C" : "#1C6A3E", minWidth: 100, textAlign: "right" }}>{x.d >= 0 ? "+" : ""}{yen(x.d)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
