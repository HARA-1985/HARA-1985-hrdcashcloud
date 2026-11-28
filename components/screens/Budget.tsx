"use client";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { Ctx } from "../ctx";
import { sb } from "@/lib/supabase";
import { yen } from "@/lib/format";
import {
  actualLines, buildProposal, BUDGET_ITEMS, BUDGET_MAIN, diffRate, download, fiscalYearOf, fmtRate, fyLabel, fyMonths,
  isLargeVariance, mkey, mlabel, sumBy, toCsv, ymlabel, type ActualLine, type Budget as BudgetRow, type BudgetLine,
} from "@/lib/budget";

type Tab = "compare" | "input" | "proposal";
const K = (cf: string, payee: string) => `${cf}\u0000${payee}`;
const man = (n: number) => (Math.abs(n) >= 10000 ? `${(n / 10000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}万` : Math.round(n).toLocaleString("ja-JP"));
const varColor = (a: number, b: number) => (!isLargeVariance(a, b) ? undefined : a > b ? "#9B1C1C" : "#1C6A3E");

export default function Budget({ ctx }: { ctx: Ctx }) {
  const start = ctx.company.fiscal_start_month ?? 4;
  const curFy = fiscalYearOf(new Date(), start);
  const [tab, setTab] = useState<Tab>("compare");
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [lines, setLines] = useState<BudgetLine[]>([]);

  const loadBudgets = useCallback(async (select?: string) => {
    const { data, error } = await sb().from("budgets").select("*").eq("company_id", ctx.company.id).order("fiscal_year", { ascending: false }).order("updated_at", { ascending: false });
    if (error) { ctx.toast(error.message, true); return; }
    const list = (data as BudgetRow[]) ?? [];
    setBudgets(list);
    setSelId((cur) => select ?? (cur && list.some((b) => b.id === cur) ? cur
      : (list.find((b) => b.fiscal_year === curFy && b.status === "approved") ?? list.find((b) => b.fiscal_year === curFy) ?? list[0])?.id ?? null));
  }, [ctx, curFy]);
  useEffect(() => { loadBudgets(); }, [loadBudgets]);

  const sel = budgets.find((b) => b.id === selId) ?? null;
  const loadLines = useCallback(async () => {
    if (!selId) { setLines([]); return; }
    const { data } = await sb().from("budget_lines").select("cf_item,payee_name,month,amount").eq("budget_id", selId).limit(20000);
    setLines(((data as BudgetLine[]) ?? []).map((l) => ({ ...l, month: l.month.slice(0, 10) })));
  }, [selId]);
  useEffect(() => { loadLines(); }, [loadLines]);

  const fy = sel?.fiscal_year ?? curFy;
  const months = useMemo(() => fyMonths(fy, start), [fy, start]);
  const fyEnd = useMemo(() => new Date(fy + 1, start - 1, 1), [fy, start]);
  const actuals = useMemo(() => actualLines(ctx.payments, ctx.banks, fyEnd), [ctx.payments, ctx.banks, fyEnd]);
  const pastActuals = useMemo(() => actualLines(ctx.payments, ctx.banks), [ctx.payments, ctx.banks]);

  async function approve(on: boolean) {
    if (!sel) return;
    if (!window.confirm(on ? "この予算を承認します。承認後は変更できません（取り消しは可能）。よろしいですか？" : "承認を取り消して下書きに戻しますか？")) return;
    const { error } = await sb().rpc("budget_set_status", { p_budget: sel.id, p_approved: on });
    if (error) ctx.toast(error.message, true); else { ctx.toast(on ? "予算を承認しました" : "下書きに戻しました"); loadBudgets(sel.id); }
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="card pad row wrap" style={{ gap: 12 }}>
        <label className="field" style={{ flex: "1 1 280px" }}>
          <span>予算</span>
          <select className="inp" value={selId ?? ""} onChange={(e) => setSelId(e.target.value || null)}>
            {budgets.length === 0 && <option value="">まだ予算がありません</option>}
            {budgets.map((b) => <option key={b.id} value={b.id}>{b.fiscal_year}年度 ／ {b.name}（{b.status === "approved" ? "承認済み" : "下書き"}）</option>)}
          </select>
        </label>
        {sel && (
          <div className="stack" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 12 }}>{fyLabel(sel.fiscal_year, start)}</span>
            <div className="row" style={{ gap: 8 }}>
              <span className={"chip " + (sel.status === "approved" ? "st-ok" : "st-wait")}>{sel.status === "approved" ? "承認済み" : "下書き"}</span>
              {ctx.canApprove && <button type="button" className="btn btn-sm" onClick={() => approve(sel.status !== "approved")}>{sel.status === "approved" ? "承認を取り消す" : "承認する"}</button>}
            </div>
          </div>
        )}
        <div className="row grow" style={{ gap: 6, justifyContent: "flex-end" }} role="tablist">
          {([["compare", "① 予算実績比較"], ["input", "② 予算入力"], ["proposal", "③ 次年度予算案"]] as [Tab, string][]).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={"pill" + (tab === k ? " is-on" : "")} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
      </section>

      {tab === "compare" && <Compare ctx={ctx} budget={sel} lines={lines} actuals={actuals} months={months} onGoProposal={() => setTab("proposal")} />}
      {tab === "input" && <Input ctx={ctx} budget={sel} budgets={budgets} lines={lines} months={months} start={start} curFy={curFy}
        onSaved={() => { loadLines(); loadBudgets(); }} onCreated={(id) => loadBudgets(id || undefined)} />}
      {tab === "proposal" && <Proposal ctx={ctx} budgets={budgets} actuals={pastActuals} start={start} curFy={curFy}
        onCreated={(id) => { loadBudgets(id); setTab("input"); }} />}
    </div>
  );
}

/* ============================== ① 予算実績比較 ============================== */
function Compare({ ctx, budget, lines, actuals, months, onGoProposal }: {
  ctx: Ctx; budget: BudgetRow | null; lines: BudgetLine[]; actuals: ActualLine[]; months: string[]; onGoProposal: () => void;
}) {
  const nowKey = mkey(new Date());
  const [month, setMonth] = useState<string>(months.includes(nowKey) ? nowKey : months[0]);
  const [cat, setCat] = useState<string>("仕入支払");
  const [detail, setDetail] = useState<{ cf: string; month: string } | null>(null);
  useEffect(() => { setMonth(months.includes(nowKey) ? nowKey : months[0]); }, [months, nowKey]);

  const inFy = useMemo(() => actuals.filter((a) => months.includes(a.month)), [actuals, months]);
  const bCat = useMemo(() => sumBy(lines, (l) => l.cf_item, (l) => l.amount), [lines]);
  const aCat = useMemo(() => sumBy(inFy, (a) => a.cf_item, (a) => a.amount), [inFy]);
  const aCatDone = useMemo(() => sumBy(inFy.filter((a) => !a.est && a.month <= nowKey), (a) => a.cf_item, (a) => a.amount), [inFy, nowKey]);
  const bCatM = useMemo(() => sumBy(lines.filter((l) => l.month === month), (l) => l.cf_item, (l) => l.amount), [lines, month]);
  const aCatM = useMemo(() => sumBy(inFy.filter((a) => a.month === month), (a) => a.cf_item, (a) => a.amount), [inFy, month]);
  const cats = useMemo(() => BUDGET_ITEMS.filter((c) => (bCat.get(c) ?? 0) > 0 || (aCat.get(c) ?? 0) > 0), [bCat, aCat]);

  const totB = [...bCat.values()].reduce((s, v) => s + v, 0);
  const totLanding = [...aCat.values()].reduce((s, v) => s + v, 0);
  const totDone = [...aCatDone.values()].reduce((s, v) => s + v, 0);
  const budgetToDate = lines.filter((l) => l.month <= nowKey).reduce((s, l) => s + l.amount, 0);

  // 相手先×月
  const payeeRows = useMemo(() => {
    const keys = new Set<string>();
    lines.filter((l) => l.cf_item === cat).forEach((l) => keys.add(l.payee_name));
    inFy.filter((a) => a.cf_item === cat).forEach((a) => keys.add(a.payee_name));
    const b = sumBy(lines.filter((l) => l.cf_item === cat), (l) => `${l.payee_name}\u0000${l.month}`, (l) => l.amount);
    const a = sumBy(inFy.filter((x) => x.cf_item === cat), (x) => `${x.payee_name}\u0000${x.month}`, (x) => x.amount);
    return [...keys].map((p) => ({
      payee: p,
      cells: months.map((m) => ({ b: b.get(`${p}\u0000${m}`) ?? 0, a: a.get(`${p}\u0000${m}`) ?? 0 })),
    })).map((r) => ({ ...r, tb: r.cells.reduce((s, c) => s + c.b, 0), ta: r.cells.reduce((s, c) => s + c.a, 0) }))
      .sort((x, y) => Math.max(y.ta, y.tb) - Math.max(x.ta, x.tb));
  }, [lines, inFy, cat, months]);

  function exportCsv() {
    const head = ["区分", "相手先", ...months.flatMap((m) => [`${ymlabel(m)} 予算`, `${ymlabel(m)} 実績・見込`]), "年間予算", "年間 実績・見込", "差異"];
    const rows: (string | number)[][] = [head];
    for (const c of cats) {
      const keys = new Set<string>([...lines.filter((l) => l.cf_item === c).map((l) => l.payee_name), ...inFy.filter((a) => a.cf_item === c).map((a) => a.payee_name)]);
      for (const p of keys) {
        const cells = months.flatMap((m) => [
          lines.filter((l) => l.cf_item === c && l.payee_name === p && l.month === m).reduce((s, l) => s + l.amount, 0),
          inFy.filter((a) => a.cf_item === c && a.payee_name === p && a.month === m).reduce((s, a) => s + a.amount, 0),
        ]);
        const tb = cells.filter((_, i) => i % 2 === 0).reduce((s, v) => s + v, 0);
        const ta = cells.filter((_, i) => i % 2 === 1).reduce((s, v) => s + v, 0);
        rows.push([c, p || "（区分全体）", ...cells, tb, ta, ta - tb]);
      }
    }
    download(`予算実績比較_${ctx.company.name}_${budget?.fiscal_year ?? ""}.csv`, toCsv(rows));
  }

  if (!budget) {
    return (
      <div className="card empty" style={{ padding: 40 }}>
        <p style={{ fontSize: 16, fontWeight: 700, color: "#17191E", margin: "0 0 8px" }}>まだ予算がありません</p>
        過去の支払実績から、次年度の予算案をすぐに作れます。
        <div className="row" style={{ gap: 8, justifyContent: "center", marginTop: 16 }}>
          {ctx.canWrite && <button type="button" className="btn btn-primary" onClick={onGoProposal}>過去実績から予算案を作る</button>}
        </div>
      </div>
    );
  }

  const det = detail ? inFy.filter((a) => a.cf_item === detail.cf && a.month === detail.month).sort((x, y) => (x.kind === y.kind ? y.amount - x.amount : x.kind === "spot" ? -1 : 1)) : [];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))" }}>
        <div className="kpi-dark"><span style={{ fontSize: 12, color: "#C9CBD1" }}>年間予算</span><span className="num kpi-mid" style={{ fontWeight: 700 }}>{yen(totB)}</span></div>
        <div className="card pad stack kpi-card" style={{ gap: 6 }}>
          <span className="lbl">実績（今月まで）</span><span className="num kpi-mid" style={{ fontWeight: 700 }}>{yen(totDone)}</span>
          <span className="muted" style={{ fontSize: 12 }}>同期間の予算 {yen(budgetToDate)}（{budgetToDate ? Math.round((totDone / budgetToDate) * 100) : 0}%）</span>
        </div>
        <div className="card pad stack kpi-card" style={{ gap: 6 }}>
          <span className="lbl">年間着地見込</span><span className="num kpi-mid" style={{ fontWeight: 700, color: varColor(totLanding, totB) ?? "#2236B8" }}>{yen(totLanding)}</span>
          <span className="muted" style={{ fontSize: 12 }}>実績＋登録済みの予定＋毎月固定の見込</span>
        </div>
        <div className="card pad stack kpi-card" style={{ gap: 6 }}>
          <span className="lbl">予算との差（着地見込）</span>
          <span className="num kpi-mid" style={{ fontWeight: 700, color: totLanding > totB ? "#9B1C1C" : "#1C6A3E" }}>{totLanding - totB >= 0 ? "+" : ""}{yen(totLanding - totB)}</span>
          <span className="muted" style={{ fontSize: 12 }}>{fmtRate(diffRate(totLanding, totB))}</span>
        </div>
      </div>

      <section className="card scroll-x">
        <div className="row wrap" style={{ padding: "18px 22px 8px", gap: 12 }}>
          <h2 className="h2 grow">区分別 予算実績比較</h2>
          <label className="row" style={{ gap: 8, fontSize: 13 }}><span className="muted">月</span>
            <select className="inp" style={{ height: 36, width: 130 }} value={month} onChange={(e) => setMonth(e.target.value)}>{months.map((m) => <option key={m} value={m}>{ymlabel(m)}</option>)}</select>
          </label>
          <button type="button" className="btn btn-sm" onClick={exportCsv}>CSVで出力</button>
        </div>
        <table className="tbl">
          <thead>
            <tr><th rowSpan={2}>区分</th><th colSpan={4} className="r" style={{ borderLeft: "1px solid #E4E2DC" }}>{mlabel(month)}</th><th colSpan={4} className="r" style={{ borderLeft: "1px solid #E4E2DC" }}>年間</th></tr>
            <tr>
              <th className="r" style={{ borderLeft: "1px solid #E4E2DC" }}>予算</th><th className="r">実績・見込</th><th className="r">差異</th><th className="r">差異率</th>
              <th className="r" style={{ borderLeft: "1px solid #E4E2DC" }}>予算</th><th className="r">着地見込</th><th className="r">差異</th><th className="r">消化</th>
            </tr>
          </thead>
          <tbody>
            {cats.map((c) => {
              const b = bCatM.get(c) ?? 0, a = aCatM.get(c) ?? 0, yb = bCat.get(c) ?? 0, ya = aCat.get(c) ?? 0;
              return (
                <tr key={c} style={{ cursor: "pointer" }} onClick={() => setDetail({ cf: c, month })} title="クリックで内訳を表示">
                  <td><strong>{c}</strong>{isLargeVariance(a, b) && a > b && <span className="chip st-err" style={{ marginLeft: 8 }}>増加</span>}</td>
                  <td className="r num" style={{ borderLeft: "1px solid #EFEDE8" }}>{yen(b)}</td>
                  <td className="r num">{yen(a)}</td>
                  <td className="r num" style={{ color: varColor(a, b), fontWeight: varColor(a, b) ? 700 : 400 }}>{a - b >= 0 ? "+" : ""}{yen(a - b)}</td>
                  <td className="r num" style={{ color: varColor(a, b) }}>{b || a ? fmtRate(diffRate(a, b)) : "—"}</td>
                  <td className="r num" style={{ borderLeft: "1px solid #EFEDE8" }}>{yen(yb)}</td>
                  <td className="r num">{yen(ya)}</td>
                  <td className="r num" style={{ color: varColor(ya, yb) }}>{ya - yb >= 0 ? "+" : ""}{yen(ya - yb)}</td>
                  <td className="r" style={{ minWidth: 110 }}>
                    <div className="bar" style={{ background: "#EEEDE9", height: 8 }}><div style={{ width: `${Math.min(100, yb ? Math.round(((aCatDone.get(c) ?? 0) / yb) * 100) : 0)}%`, background: "#2440D8" }} /></div>
                    <span className="num muted" style={{ fontSize: 11 }}>{yb ? Math.round(((aCatDone.get(c) ?? 0) / yb) * 100) : 0}%</span>
                  </td>
                </tr>
              );
            })}
            <tr className="is-total">
              <td>合計</td>
              <td className="r num">{yen([...bCatM.values()].reduce((s, v) => s + v, 0))}</td>
              <td className="r num">{yen([...aCatM.values()].reduce((s, v) => s + v, 0))}</td>
              <td className="r num">{yen([...aCatM.values()].reduce((s, v) => s + v, 0) - [...bCatM.values()].reduce((s, v) => s + v, 0))}</td>
              <td />
              <td className="r num">{yen(totB)}</td><td className="r num">{yen(totLanding)}</td><td className="r num">{yen(totLanding - totB)}</td><td />
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12, margin: 0, padding: "10px 22px 16px" }}>差異が ±20% 以上かつ10万円以上の区分を色で表示しています。行をクリックすると、その月の内訳（臨時の請求書を先頭）を表示します。</p>
      </section>

      {detail && (
        <section className="card pad stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 10 }}>
            <h2 className="h2 grow">{ymlabel(detail.month)}・{detail.cf} の内訳</h2>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDetail(null)}>閉じる</button>
          </div>
          {det.length === 0 ? <span className="muted" style={{ fontSize: 13 }}>この月の支払はありません</span> : det.map((a) => (
            <div key={a.id} className="list-row" style={{ fontSize: 13 }}>
              <span className={"chip " + (a.kind === "spot" ? "chip-spot" : "chip-fixed")}>{a.kind === "spot" ? "臨時" : a.est ? "固定（見込）" : "固定"}</span>
              <strong style={{ minWidth: 160 }}>{a.payee_name}</strong>
              <span className="muted grow">{a.item ?? ""}</span>
              <span className="num" style={{ fontWeight: 700 }}>{yen(a.amount)}</span>
              {a.document_id && <button type="button" className="btn btn-sm" onClick={() => ctx.openDoc(a.document_id!)}>請求書</button>}
            </div>
          ))}
        </section>
      )}

      <section className="card scroll-x">
        <div className="row wrap" style={{ padding: "18px 22px 8px", gap: 12 }}>
          <h2 className="h2 grow">相手先別・月別（実績・見込 ／ 予算）</h2>
          <select className="inp" style={{ height: 36, width: 200 }} value={cat} onChange={(e) => setCat(e.target.value)} aria-label="区分">
            {BUDGET_ITEMS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {payeeRows.length === 0 ? <div className="empty">この区分の予算・実績はありません</div> : (
          <table className="tbl" style={{ fontSize: 12 }}>
            <thead><tr><th>相手先</th>{months.map((m) => <th key={m} className="r">{mlabel(m)}</th>)}<th className="r">年間</th></tr></thead>
            <tbody>{payeeRows.map((r) => (
              <tr key={r.payee}>
                <td className="nw" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}><strong>{r.payee || "（区分全体）"}</strong></td>
                {r.cells.map((c, i) => (
                  <td key={i} className="r num nw" style={{ background: isLargeVariance(c.a, c.b) ? (c.a > c.b ? "#FDF1F1" : "#EEF8F2") : undefined }}>
                    <div style={{ fontWeight: 600, color: varColor(c.a, c.b) }}>{c.a ? man(c.a) : "—"}</div>
                    <div className="muted" style={{ fontSize: 10 }}>{c.b ? man(c.b) : ""}</div>
                  </td>
                ))}
                <td className="r num nw"><div style={{ fontWeight: 700, color: varColor(r.ta, r.tb) }}>{man(r.ta)}</div><div className="muted" style={{ fontSize: 10 }}>{man(r.tb)}</div></td>
              </tr>
            ))}</tbody>
          </table>
        )}
        <p className="muted" style={{ fontSize: 12, margin: 0, padding: "10px 22px 16px" }}>上段：実績・見込、下段（小さい数字）：予算。予算より大きく多い月は赤、少ない月は緑で表示します。</p>
      </section>
    </div>
  );
}

/* ============================== ② 予算入力 ============================== */
interface Row { cf: string; payee: string; vals: number[] }

function Input({ ctx, budget, budgets, lines, months, start, curFy, onSaved, onCreated }: {
  ctx: Ctx; budget: BudgetRow | null; budgets: BudgetRow[]; lines: BudgetLine[]; months: string[]; start: number; curFy: number;
  onSaved: () => void; onCreated: (id: string) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newCf, setNewCf] = useState<string>(BUDGET_MAIN[0]);
  const [newPayee, setNewPayee] = useState("");
  const [nfy, setNfy] = useState(curFy);
  const [nname, setNname] = useState("当初予算");
  const locked = !budget || budget.status === "approved" || !ctx.canWrite;

  useEffect(() => {
    const m = new Map<string, Row>();
    for (const l of lines) {
      const k = K(l.cf_item, l.payee_name);
      const r = m.get(k) ?? { cf: l.cf_item, payee: l.payee_name, vals: months.map(() => 0) };
      const i = months.indexOf(l.month);
      if (i >= 0) r.vals[i] += l.amount;
      m.set(k, r);
    }
    setRows([...m.values()].sort((a, b) => BUDGET_ITEMS.indexOf(a.cf) - BUDGET_ITEMS.indexOf(b.cf) || a.payee.localeCompare(b.payee, "ja")));
    setDirty(false);
  }, [lines, months]);

  const setVal = (ri: number, mi: number, v: number) => { setRows((rs) => rs.map((r, i) => (i === ri ? { ...r, vals: r.vals.map((x, j) => (j === mi ? v : x)) } : r))); setDirty(true); };
  const fill = (ri: number) => { setRows((rs) => rs.map((r, i) => { if (i !== ri) return r; const v = r.vals.find((x) => x > 0) ?? 0; return { ...r, vals: r.vals.map(() => v) }; })); setDirty(true); };
  const del = (ri: number) => { setRows((rs) => rs.filter((_, i) => i !== ri)); setDirty(true); };
  function add(e: React.FormEvent) {
    e.preventDefault();
    if (rows.some((r) => r.cf === newCf && r.payee === newPayee.trim())) { ctx.toast("同じ区分・相手先の行があります", true); return; }
    setRows((rs) => [...rs, { cf: newCf, payee: newPayee.trim(), vals: months.map(() => 0) }].sort((a, b) => BUDGET_ITEMS.indexOf(a.cf) - BUDGET_ITEMS.indexOf(b.cf) || a.payee.localeCompare(b.payee, "ja")));
    setNewPayee(""); setDirty(true);
  }

  async function save() {
    if (!budget) return;
    setBusy(true);
    const payload = rows.flatMap((r) => r.vals.map((v, i) => ({ cf_item: r.cf, payee_name: r.payee, month: months[i], amount: v }))).filter((x) => x.amount > 0);
    const { error } = await sb().rpc("budget_replace_lines", { p_budget: budget.id, p_lines: payload });
    setBusy(false);
    if (error) ctx.toast(error.message, true); else { ctx.toast("予算を保存しました"); onSaved(); }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const { data, error } = await sb().from("budgets").insert({ company_id: ctx.company.id, fiscal_year: nfy, name: nname.trim() }).select("id").single();
    if (error) ctx.toast(/duplicate|unique/i.test(error.message) ? "同じ年度・名前の予算があります" : error.message, true);
    else { ctx.toast("予算を作成しました"); onCreated((data as { id: string }).id); }
  }

  async function remove() {
    if (!budget || !window.confirm(`「${budget.fiscal_year}年度 ${budget.name}」を削除します。元に戻せません。よろしいですか？`)) return;
    const { error } = await sb().from("budgets").delete().eq("id", budget.id);
    if (error) ctx.toast(error.message, true); else { ctx.toast("削除しました"); onCreated(""); }
  }

  const payeeNames = useMemo(() => [...new Set(ctx.payees.map((p) => p.name).concat(ctx.payments.map((p) => p.payee_name)))].sort(), [ctx.payees, ctx.payments]);
  const groups = BUDGET_ITEMS.filter((c) => rows.some((r) => r.cf === c));
  const colTot = months.map((_, i) => rows.reduce((s, r) => s + r.vals[i], 0));

  return (
    <div className="stack" style={{ gap: 20 }}>
      {ctx.canWrite && (
        <form className="card pad row wrap" style={{ gap: 12, alignItems: "flex-end" }} onSubmit={create}>
          <h2 className="h2" style={{ width: "100%" }}>新しい予算を作る（空の表から入力）</h2>
          <label className="field" style={{ width: 140 }}><span>年度（期首の年）</span><input className="inp num" type="number" min={2000} max={2100} value={nfy} onChange={(e) => setNfy(Number(e.target.value))} /></label>
          <label className="field" style={{ flex: "1 1 200px" }}><span>名前</span><input className="inp" required maxLength={100} value={nname} onChange={(e) => setNname(e.target.value)} /></label>
          <span className="muted" style={{ fontSize: 12, flex: "1 1 220px" }}>{fyLabel(nfy, start)}／期首月は「設定」で変更できます</span>
          <button type="submit" className="btn">作成</button>
          {budgets.length > 0 && <span className="muted" style={{ fontSize: 12, width: "100%" }}>過去実績から作る場合は「③ 次年度予算案」をお使いください。</span>}
        </form>
      )}

      {!budget ? <div className="card empty">予算を作成または選択してください</div> : (
        <section className="card scroll-x">
          <div className="row wrap" style={{ padding: "18px 22px 8px", gap: 10 }}>
            <h2 className="h2 grow">{budget.fiscal_year}年度 ／ {budget.name}</h2>
            {budget.status === "approved" && <span className="muted" style={{ fontSize: 12 }}>承認済みのため変更できません（「承認を取り消す」で編集できます）</span>}
            {ctx.isOwner && budget.status === "draft" && <button type="button" className="btn btn-sm btn-ghost" onClick={remove}>この予算を削除</button>}
            <button type="button" className="btn btn-primary" disabled={locked || busy || !dirty} onClick={save}>{busy ? "保存中…" : dirty ? "保存する" : "保存済み"}</button>
          </div>
          <table className="tbl" style={{ fontSize: 12 }}>
            <thead><tr><th>相手先</th>{months.map((m) => <th key={m} className="r">{mlabel(m)}</th>)}<th className="r">年間</th><th /></tr></thead>
            <tbody>
              {groups.map((g) => {
                const gRows = rows.map((r, i) => ({ r, i })).filter((x) => x.r.cf === g);
                const gTot = months.map((_, mi) => gRows.reduce((s, x) => s + x.r.vals[mi], 0));
                return (
                  <Fragment key={g}>
                    <tr className="is-grp"><td colSpan={months.length + 3} style={{ background: "#F5F4F0", fontWeight: 700 }}>{g}</td></tr>
                    {gRows.map(({ r, i }) => (
                      <tr key={K(r.cf, r.payee)}>
                        <td className="nw" style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{r.payee || "（区分全体）"}</td>
                        {r.vals.map((v, mi) => (
                          <td key={mi} style={{ padding: "4px 3px" }}>
                            <input className="inp num" aria-label={`${r.payee || g} ${mlabel(months[mi])}`} disabled={locked} inputMode="numeric"
                              style={{ height: 32, width: 92, padding: "0 6px", fontSize: 12, textAlign: "right" }}
                              value={v ? v.toLocaleString("ja-JP") : ""} onChange={(e) => setVal(i, mi, Number(e.target.value.replace(/[^\d]/g, "")) || 0)} />
                          </td>
                        ))}
                        <td className="r num nw" style={{ fontWeight: 700 }}>{yen(r.vals.reduce((s, x) => s + x, 0))}</td>
                        <td className="nw">{!locked && (<div className="row" style={{ gap: 4 }}>
                          <button type="button" className="btn btn-sm" title="最初に入力した金額を全月に入れる" onClick={() => fill(i)}>全月同額</button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => del(i)}>削除</button>
                        </div>)}</td>
                      </tr>
                    ))}
                    <tr><td className="muted">{g} 計</td>{gTot.map((v, mi) => <td key={mi} className="r num muted">{v ? v.toLocaleString("ja-JP") : ""}</td>)}<td className="r num muted">{yen(gTot.reduce((s, v) => s + v, 0))}</td><td /></tr>
                  </Fragment>
                );
              })}
              <tr className="is-total"><td>合計</td>{colTot.map((v, i) => <td key={i} className="r num">{v ? v.toLocaleString("ja-JP") : ""}</td>)}<td className="r num">{yen(colTot.reduce((s, v) => s + v, 0))}</td><td /></tr>
            </tbody>
          </table>
          {!locked && (
            <form className="row wrap" style={{ gap: 10, alignItems: "flex-end", padding: "14px 22px 18px" }} onSubmit={add}>
              <label className="field" style={{ width: 200 }}><span>区分</span>
                <select className="inp" value={newCf} onChange={(e) => setNewCf(e.target.value)}>{BUDGET_ITEMS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
              </label>
              <label className="field" style={{ flex: "1 1 220px" }}><span>相手先（空欄なら区分全体）</span>
                <input className="inp" list="budget-payees" maxLength={200} value={newPayee} onChange={(e) => setNewPayee(e.target.value)} placeholder="例：アイル" />
                <datalist id="budget-payees">{payeeNames.map((n) => <option key={n} value={n} />)}</datalist>
              </label>
              <button type="submit" className="btn">行を追加</button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}

/* ============================== ③ 次年度予算案 ============================== */
function Proposal({ ctx, budgets, actuals, start, curFy, onCreated }: {
  ctx: Ctx; budgets: BudgetRow[]; actuals: ActualLine[]; start: number; curFy: number; onCreated: (id: string) => void;
}) {
  const nowKey = mkey(new Date());
  const firstActual = actuals.filter((a) => !a.est).map((a) => a.month).sort()[0] ?? nowKey;
  const [target, setTarget] = useState(curFy + 1);
  const defFrom = fyMonths(curFy, start)[0];
  const [from, setFrom] = useState(defFrom < firstActual ? firstActual : defFrom);
  const [to, setTo] = useState(nowKey);
  const [includeSpot, setIncludeSpot] = useState(false);
  const [byPayee, setByPayee] = useState(true);
  const [roundTo, setRoundTo] = useState(1000);
  const [growth, setGrowth] = useState<Record<string, number>>({});
  const [name, setName] = useState("予算案（過去実績から作成）");
  const [copyFrom, setCopyFrom] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const monthsOpts = useMemo(() => {
    const out: string[] = [];
    const s = new Date(Number(firstActual.slice(0, 4)), Number(firstActual.slice(5, 7)) - 1, 1);
    for (let d = s; mkey(d) <= nowKey; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) out.push(mkey(d));
    return out.length ? out : [nowKey];
  }, [firstActual, nowKey]);

  const proposal = useMemo(() => buildProposal(actuals, target, start, {
    baseFrom: from, baseTo: to, growth: Object.fromEntries(Object.entries(growth).map(([k, v]) => [k, v / 100])), includeSpot, roundTo, byPayee,
  }), [actuals, target, start, from, to, growth, includeSpot, roundTo, byPayee]);

  const base = useMemo(() => actuals.filter((a) => !a.est && a.month >= from && a.month <= to && (includeSpot || a.kind === "fixed")), [actuals, from, to, includeSpot]);
  const baseMonths = new Set(base.map((a) => a.month)).size;
  const baseCat = sumBy(base, (a) => a.cf_item, (a) => a.amount);
  const propCat = sumBy(proposal, (l) => l.cf_item, (l) => l.amount);
  const cats = BUDGET_ITEMS.filter((c) => (baseCat.get(c) ?? 0) > 0 || (propCat.get(c) ?? 0) > 0);

  async function create() {
    setBusy(true);
    let linesToSave: BudgetLine[] = proposal;
    let source: Record<string, unknown> = { method: "actuals", baseFrom: from, baseTo: to, includeSpot, byPayee, roundTo, growth };
    if (copyFrom) {
      const { data } = await sb().from("budget_lines").select("cf_item,payee_name,month,amount").eq("budget_id", copyFrom).limit(20000);
      const src = budgets.find((b) => b.id === copyFrom)!;
      const shift = target - src.fiscal_year;
      linesToSave = ((data as BudgetLine[]) ?? []).map((l) => {
        const d = new Date(Number(l.month.slice(0, 4)) + shift, Number(l.month.slice(5, 7)) - 1, 1);
        const g = 1 + (growth[l.cf_item] ?? 0) / 100;
        return { ...l, month: mkey(d), amount: roundTo > 1 ? Math.round((l.amount * g) / roundTo) * roundTo : Math.round(l.amount * g) };
      });
      source = { method: "copy", from: src.id, growth };
    }
    const { data: b, error } = await sb().from("budgets").insert({ company_id: ctx.company.id, fiscal_year: target, name: name.trim(), source }).select("id").single();
    if (error) { setBusy(false); ctx.toast(/duplicate|unique/i.test(error.message) ? "同じ年度・名前の予算があります。名前を変えてください" : error.message, true); return; }
    const id = (b as { id: string }).id;
    const r = await sb().rpc("budget_replace_lines", { p_budget: id, p_lines: linesToSave });
    setBusy(false);
    if (r.error) ctx.toast(r.error.message, true); else { ctx.toast(`予算案を作成しました（${r.data}行）。内容を確認・修正してください`); onCreated(id); }
  }

  const prevBudgets = budgets.filter((b) => b.fiscal_year < target);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="card pad stack" style={{ gap: 16 }}>
        <h2 className="h2">過去の支払実績から次年度の予算案を作る</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
          参照期間の実績を、同じ月の予算にあてはめます（例：前年4月の実績 → 来年度4月の予算）。参照期間が12か月に満たない場合、実績のない月は月平均で埋めます。区分ごとに増減率を設定できます。
        </p>
        <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
          <label className="field" style={{ width: 150 }}><span>作成する年度</span><input className="inp num" type="number" min={2000} max={2100} value={target} onChange={(e) => setTarget(Number(e.target.value))} /></label>
          <label className="field" style={{ width: 150 }}><span>参照期間（から）</span>
            <select className="inp" value={from} onChange={(e) => setFrom(e.target.value)} disabled={!!copyFrom}>{monthsOpts.map((m) => <option key={m} value={m}>{ymlabel(m)}</option>)}</select>
          </label>
          <label className="field" style={{ width: 150 }}><span>参照期間（まで）</span>
            <select className="inp" value={to} onChange={(e) => setTo(e.target.value)} disabled={!!copyFrom}>{monthsOpts.map((m) => <option key={m} value={m}>{ymlabel(m)}</option>)}</select>
          </label>
          <label className="field" style={{ width: 150 }}><span>端数</span>
            <select className="inp" value={roundTo} onChange={(e) => setRoundTo(Number(e.target.value))}><option value={1}>1円単位</option><option value={1000}>千円単位</option><option value={10000}>万円単位</option></select>
          </label>
          <label className="field" style={{ flex: "1 1 220px" }}><span>予算の名前</span><input className="inp" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
        </div>
        <div className="row wrap" style={{ gap: 18, fontSize: 13 }}>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={byPayee} onChange={(e) => setByPayee(e.target.checked)} disabled={!!copyFrom} />相手先別に作る</label>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={includeSpot} onChange={(e) => setIncludeSpot(e.target.checked)} disabled={!!copyFrom} />臨時の支払も含める（含めない場合は毎月固定のみ）</label>
          {prevBudgets.length > 0 && (
            <label className="row" style={{ gap: 6 }}>前年度の予算をコピーして作る：
              <select className="inp" style={{ height: 34, width: 240 }} value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                <option value="">使わない（実績から作る）</option>
                {prevBudgets.map((b) => <option key={b.id} value={b.id}>{b.fiscal_year}年度 ／ {b.name}</option>)}
              </select>
            </label>
          )}
        </div>
      </section>

      <section className="card scroll-x">
        <div className="row wrap" style={{ padding: "18px 22px 8px", gap: 10 }}>
          <h2 className="h2 grow">区分別のプレビュー</h2>
          {!copyFrom && <span className="muted" style={{ fontSize: 12 }}>参照した実績：{baseMonths}か月分</span>}
        </div>
        <table className="tbl">
          <thead><tr><th>区分</th>{!copyFrom && <th className="r">参照期間の実績</th>}<th className="r" style={{ width: 140 }}>増減率</th>{!copyFrom && <th className="r">予算案（年間）</th>}</tr></thead>
          <tbody>
            {(copyFrom ? BUDGET_ITEMS.filter((c) => BUDGET_MAIN.includes(c as never)) : cats).map((c) => (
              <tr key={c}>
                <td><strong>{c}</strong></td>
                {!copyFrom && <td className="r num">{yen(baseCat.get(c) ?? 0)}</td>}
                <td className="r"><div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                  <input className="inp num" type="number" step={1} min={-90} max={300} aria-label={`${c}の増減率`} style={{ height: 32, width: 76, textAlign: "right" }}
                    value={growth[c] ?? 0} onChange={(e) => setGrowth((g) => ({ ...g, [c]: Number(e.target.value) }))} /><span>%</span>
                </div></td>
                {!copyFrom && <td className="r num" style={{ fontWeight: 700 }}>{yen(propCat.get(c) ?? 0)}</td>}
              </tr>
            ))}
            {!copyFrom && <tr className="is-total"><td>合計</td><td className="r num">{yen([...baseCat.values()].reduce((s, v) => s + v, 0))}</td><td /><td className="r num">{yen([...propCat.values()].reduce((s, v) => s + v, 0))}</td></tr>}
          </tbody>
        </table>
        <div className="row wrap" style={{ gap: 10, padding: "14px 22px 18px", justifyContent: "flex-end" }}>
          <span className="muted" style={{ fontSize: 12 }}>作成後、「② 予算入力」で相手先・月ごとに修正できます。</span>
          <button type="button" className="btn btn-primary" disabled={!ctx.canWrite || busy || (!copyFrom && proposal.length === 0)} onClick={create}>{busy ? "作成中…" : `${target}年度の予算案を作成`}</button>
        </div>
      </section>
    </div>
  );
}
