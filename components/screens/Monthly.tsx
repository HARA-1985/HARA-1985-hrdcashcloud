"use client";
import { useMemo, useState } from "react";
import type { Ctx } from "../ctx";
import { pct, sameMonth, sum, yen, ymLabel } from "@/lib/format";
import { projectFixed, viewPayments, type PayView } from "@/lib/view";
import { STATUS_CLS, STATUS_LABEL } from "@/lib/types";

export default function Monthly({ ctx }: { ctx: Ctx }) {
  const [sel, setSel] = useState(0);
  const now = new Date();
  const months = useMemo(() => Array.from({ length: 6 }, (_, i) => new Date(now.getFullYear(), now.getMonth() + i, 1)), [now.getFullYear(), now.getMonth()]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = useMemo(() => {
    const until = new Date(months[5].getFullYear(), months[5].getMonth() + 1, 1);
    const proj = projectFixed(viewPayments(ctx.payments, ctx.banks), until);
    const inM = (m: Date) => (p: PayView) => sameMonth(p.d, m);
    const totals = months.map((m) => sum(proj.filter(inM(m)), (p) => p.amount));
    const mMax = Math.max(1, ...totals);
    const cards = months.map((m) => {
      const xs = proj.filter(inM(m));
      const t = sum(xs, (p) => p.amount), f = sum(xs.filter((p) => p.kind === "fixed"), (p) => p.amount), e = sum(xs.filter((p) => p.est), (p) => p.amount);
      return { m, t, f, s: t - f, n: xs.length, conf: pct(t - e, t) };
    });
    const bankNames = [...new Set(proj.map((p) => p.bankName))];
    const accs = [...new Set(proj.map((p) => p.account_title))];
    const defs: [string, string, (p: PayView) => boolean][] = [
      ["区分", "毎月固定", (p) => p.kind === "fixed"], ["", "臨時", (p) => p.kind === "spot"],
      ...bankNames.map((b, i) => [i === 0 ? "金融機関" : "", b, (p: PayView) => p.bankName === b] as [string, string, (p: PayView) => boolean]),
      ...accs.map((a, i) => [i === 0 ? "勘定科目" : "", a, (p: PayView) => p.account_title === a] as [string, string, (p: PayView) => boolean]),
    ];
    const rows = defs.map(([g, label, f]) => {
      const vals = months.map((m) => sum(proj.filter(inM(m)).filter(f), (p) => p.amount));
      return { g, label, vals, total: vals.reduce((a, b) => a + b, 0) };
    });
    const totalRow = { g: "", label: "支払総額", vals: totals, total: totals.reduce((a, b) => a + b, 0) };
    const items = proj.filter(inM(months[sel]));
    return { cards, mMax, rows, totalRow, items };
  }, [ctx.payments, ctx.banks, months, sel]);

  function exportCsv() {
    const head = ["集計軸", "項目", ...months.map((m) => ymLabel(m)), "合計"];
    const body = [...v.rows, v.totalRow].map((r) => [r.g, r.label, ...r.vals.map(String), String(r.total)]);
    const csv = "﻿" + [head, ...body].map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = `月別支払推移_${ctx.company.name}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row wrap" style={{ gap: 14 }}>
        <span className="muted" style={{ fontSize: 13 }}>{ymLabel(months[0])}〜{ymLabel(months[5])}（6か月）／ 毎月固定の支払は、請求書が届く前から「見込」として自動で入ります</span>
      </div>
      <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {v.cards.map((c, i) => (
          <button key={i} type="button" className={"tile" + (sel === i ? " is-on" : "")} onClick={() => setSel(i)} aria-pressed={sel === i}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{c.m.getMonth() + 1}月</span>
            <span className="num" style={{ fontSize: 20, fontWeight: 700 }}>{yen(c.t)}</span>
            <div className="stack" style={{ height: 120, width: "100%", justifyContent: "flex-end", borderRadius: 8, overflow: "hidden", background: "#F5F4F0" }}>
              <div style={{ height: Math.round((c.s / v.mMax) * 100) + "%", background: "#E8743B" }} />
              <div style={{ height: Math.round((c.f / v.mMax) * 100) + "%", background: "#2440D8" }} />
            </div>
            <span className="num muted" style={{ fontSize: 12 }}>{c.n}件 ・ 確定 {c.conf}</span>
          </button>
        ))}
      </div>

      <section className="card scroll-x">
        <div className="row wrap" style={{ padding: "18px 22px 8px", justifyContent: "space-between", gap: 12 }}>
          <h2 className="h2">月別 支払推移表</h2>
          <button type="button" className="btn btn-sm" onClick={exportCsv}>CSV出力（Excelで開けます）</button>
        </div>
        <table className="tbl">
          <thead>
            <tr><th>集計軸</th><th>項目</th>{months.map((m, i) => <th key={i} className={"r" + (sel === i ? " is-sel" : "")}>{m.getMonth() + 1}月</th>)}<th className="r">合計</th></tr>
          </thead>
          <tbody>
            {v.rows.map((r, idx) => (
              <tr key={idx} className={r.g && idx ? "is-grp" : ""}>
                <td className="nw" style={{ fontSize: 12, fontWeight: 600 }}>{r.g}</td>
                <td className="nw" style={{ fontWeight: 600 }}>{r.label}</td>
                {r.vals.map((x, i) => <td key={i} className={"num r nw" + (sel === i ? " is-sel" : "")}>{x ? yen(x) : "—"}</td>)}
                <td className="num r nw" style={{ fontWeight: 700 }}>{yen(r.total)}</td>
              </tr>
            ))}
            <tr className="is-total">
              <td /><td>支払総額</td>
              {v.totalRow.vals.map((x, i) => <td key={i} className={"num r nw" + (sel === i ? " is-sel" : "")}>{yen(x)}</td>)}
              <td className="num r nw">{yen(v.totalRow.total)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="card pad stack" style={{ gap: 4 }}>
        <div className="row wrap" style={{ justifyContent: "space-between", gap: 8, paddingBottom: 8 }}>
          <h2 className="h2">{ymLabel(months[sel])}の支払明細</h2>
          <span className="num" style={{ fontSize: 14, fontWeight: 700 }}>{v.items.length}件 ／ {yen(sum(v.items, (p) => p.amount))}</span>
        </div>
        {v.items.length === 0 && <div className="empty">この月の支払はありません</div>}
        {v.items.map((p) => (
          <div key={p.id} className="list-row">
            <span className="num" style={{ width: 64, fontWeight: 700 }}>{p.md} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{p.wd}</span></span>
            <div className="stack" style={{ flex: "1 1 220px", minWidth: 0, gap: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{p.payee_name}</span>
              <span className="muted" style={{ fontSize: 12 }}>{p.item ?? ""} ・ {p.bankName} ・ {p.account_title}</span>
            </div>
            <span className={p.kindCls}>{p.kindLabel}</span>
            {p.est ? <span className="chip st-auto">見込</span> : <span className={STATUS_CLS[p.status]}>{STATUS_LABEL[p.status]}</span>}
            <span className="num r" style={{ width: 120, fontSize: 15, fontWeight: 700 }}>{p.amt}</span>
            {p.document_id && !p.est
              ? <button type="button" className="btn btn-sm" onClick={() => ctx.openDoc(p.document_id!)}>PDF</button>
              : <span className="muted" style={{ width: 46, fontSize: 11, textAlign: "center" }}>{p.est ? "未着" : ""}</span>}
          </div>
        ))}
      </section>
    </div>
  );
}
