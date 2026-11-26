"use client";
import { useMemo, useState } from "react";
import type { Ctx } from "../ctx";
import { pct, sameMonth, sum, yen, ymLabel } from "@/lib/format";
import { CATS, CF_SECTIONS, catOf, cfItemOf, cfSectionOf, payeeCfMap, projectFixed, viewPayments, type PayView } from "@/lib/view";
import { STATUS_CLS, STATUS_LABEL } from "@/lib/types";

export default function Monthly({ ctx }: { ctx: Ctx }) {
  const [sel, setSel] = useState(0);
  const [offset, setOffset] = useState(0); // 表示開始月（今月からの月数）
  const now = new Date();
  const months = useMemo(() => Array.from({ length: 6 }, (_, i) => new Date(now.getFullYear(), now.getMonth() + offset + i, 1)), [now.getFullYear(), now.getMonth(), offset]); // eslint-disable-line react-hooks/exhaustive-deps
  const move = (n: number) => { setOffset((o) => o + n); setSel(0); };

  const v = useMemo(() => {
    const until = new Date(months[5].getFullYear(), months[5].getMonth() + 1, 1);
    const proj = projectFixed(viewPayments(ctx.payments, ctx.banks), until);
    const inM = (m: Date) => (p: PayView) => sameMonth(p.d, m);
    const totals = months.map((m) => sum(proj.filter(inM(m)), (p) => p.amount));
    const mMax = Math.max(1, ...totals);
    const cards = months.map((m) => {
      const xs = proj.filter(inM(m));
      const t = sum(xs, (p) => p.amount), e = sum(xs.filter((p) => p.est), (p) => p.amount);
      const segs = CATS.map((c) => ({ ...c, v: sum(xs.filter((p) => catOf(p) === c.key), (p) => p.amount) }));
      return { m, t, segs, n: xs.length, conf: pct(t - e, t) };
    });
    const bankNames = [...new Set(proj.map((p) => p.bankName))];
    const cfMap = payeeCfMap(ctx.payments);
    type Def = [string, string, (p: PayView) => boolean, string?];
    const defs: Def[] = [
      ...CATS.map((c, i) => [i === 0 ? "支払の種類" : "", c.label, (p: PayView) => catOf(p) === c.key, c.color] as Def),
      ...CF_SECTIONS.map((c, i) => [i === 0 ? "CF区分" : "", c.label + "の支出", (p: PayView) => cfSectionOf(cfItemOf(p, cfMap)) === c.key] as Def),
      ...bankNames.map((b, i) => [i === 0 ? "金融機関" : "", b, (p: PayView) => p.bankName === b] as Def),
    ];
    const rows = defs.map(([g, label, f, color]) => {
      const vals = months.map((m) => sum(proj.filter(inM(m)).filter(f), (p) => p.amount));
      return { g, label, color, vals, total: vals.reduce((a, b) => a + b, 0) };
    }).filter((r) => r.total > 0 || !r.color);
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
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn btn-sm" onClick={() => move(-6)} aria-label="前の6か月">‹ 前の6か月</button>
          {offset !== 0 && <button type="button" className="btn btn-sm" onClick={() => { setOffset(0); setSel(0); }}>今月から</button>}
          <button type="button" className="btn btn-sm" onClick={() => move(6)} aria-label="次の6か月">次の6か月 ›</button>
        </div>
        <span className="muted" style={{ fontSize: 13 }}>{ymLabel(months[0])}〜{ymLabel(months[5])}（6か月）／ 支払の種類（買掛金・経費・給与・税金社保・借入返済）ごとに色分け。毎月固定の支払は、請求書が届く前から「見込」として先の月に入ります（支払先ごとに直近月の内容）</span>
      </div>
      <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {v.cards.map((c, i) => (
          <button key={i} type="button" className={"tile" + (sel === i ? " is-on" : "")} onClick={() => setSel(i)} aria-pressed={sel === i}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{c.m.getMonth() + 1}月</span>
            <span className="num" style={{ fontSize: 20, fontWeight: 700 }}>{yen(c.t)}</span>
            <div className="stack" style={{ height: 120, width: "100%", justifyContent: "flex-end", borderRadius: 8, overflow: "hidden", background: "#F5F4F0" }}>
              {[...c.segs].reverse().map((sg) => sg.v > 0 && <div key={sg.key} title={`${sg.label} ${yen(sg.v)}`} style={{ height: (sg.v / v.mMax) * 100 + "%", background: sg.color, borderTop: "1px solid #FFFFFF" }} />)}
            </div>
            <span className="num muted" style={{ fontSize: 12 }}>{c.n}件 ・ 確定 {c.conf}</span>
          </button>
        ))}
      </div>

      <div className="row wrap" style={{ gap: 14, fontSize: 12 }}>
        {CATS.map((c) => <span key={c.key} className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: c.color, display: "inline-block" }} />{c.label}</span>)}
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
                <td className="nw" style={{ fontWeight: 600 }}>{r.color && <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, display: "inline-block", marginRight: 6 }} />}{r.label}</td>
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
              <span className="muted" style={{ fontSize: 12 }}>{p.item ?? ""} ・ {p.bankName} ・ {CATS.find((c) => c.key === catOf(p))!.label}</span>
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
