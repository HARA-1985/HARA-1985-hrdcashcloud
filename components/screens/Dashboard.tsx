"use client";
import { useMemo, useState } from "react";
import type { Ctx } from "../ctx";
import { md, pct, sameMonth, sum, yen } from "@/lib/format";
import { CF_SECTIONS, cfItemOf, cfSectionOf, payeeCfMap, projectFixed, viewPayments } from "@/lib/view";
import Icon from "../Icon";

export default function Dashboard({ ctx }: { ctx: Ctx }) {
  const v = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const all = viewPayments(ctx.payments, ctx.banks);
    const thisM = all.filter((p) => sameMonth(p.d, today));
    const nextM = all.filter((p) => sameMonth(p.d, new Date(today.getFullYear(), today.getMonth() + 1, 1)));
    const tot = sum(thisM, (p) => p.amount);
    const fx = sum(thisM.filter((p) => p.kind === "fixed"), (p) => p.amount);
    const soon = all.filter((p) => p.d >= today && (p.d.getTime() - today.getTime()) / 864e5 <= 3 && p.status !== "paid").length;
    const wait = all.filter((p) => p.status === "pending").length;

    // 8週
    const start = new Date(today); start.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const until = new Date(start.getTime() + 56 * 864e5);
    const proj = projectFixed(all, until).filter((p) => p.status !== "paid");
    const nmStart = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextTot = sum(projectFixed(all, new Date(today.getFullYear(), today.getMonth() + 2, 0)).filter((p) => sameMonth(p.d, nmStart)), (p) => p.amount);
    const wk = Array.from({ length: 8 }, (_, i) => ({ f: 0, s: 0, st: new Date(start.getTime() + i * 7 * 864e5) }));
    for (const p of proj) {
      const i = Math.floor((p.d.getTime() - start.getTime()) / (7 * 864e5));
      if (i >= 0 && i < 8) { if (p.kind === "fixed") wk[i].f += p.amount; else wk[i].s += p.amount; }
    }
    const mx = Math.max(1, ...wk.map((w) => w.f + w.s));

    const group = (xs: typeof all, key: (p: (typeof all)[number]) => string) => {
      const m = new Map<string, number>();
      xs.forEach((p) => m.set(key(p), (m.get(key(p)) ?? 0) + p.amount));
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const banks = group(thisM, (p) => p.bankName);
    const payees = group(all.filter((p) => p.d >= today), (p) => p.payee_name).slice(0, 5);
    const upcoming = all.filter((p) => p.d >= today && p.status !== "paid").slice(0, 6);
    return { today, tot, fx, sp: tot - fx, count: thisM.length, next: Math.max(nextTot, sum(nextM, (p) => p.amount)), soon, wait, wk, mx, banks, payees, upcoming };
  }, [ctx.payments, ctx.banks]);

  if (ctx.loading && ctx.payments.length === 0) return <div className="skeleton" style={{ height: 420 }} />;

  if (ctx.payments.length === 0) {
    return (
      <div className="card empty" style={{ padding: 48 }}>
        <p style={{ fontSize: 16, fontWeight: 700, color: "#17191E", margin: "0 0 8px" }}>まだ支払予定がありません</p>
        請求書や立替経費を登録すると、ここに資金繰りが表示されます。
        <div className="row" style={{ gap: 8, justifyContent: "center", marginTop: 16 }}>
          {ctx.canWrite && <button className="btn btn-primary" type="button" onClick={() => ctx.go("invoice")}>請求書を登録</button>}
          {ctx.isOwner && <button className="btn" type="button" onClick={() => ctx.go("settings")}>設定でサンプルを入れる</button>}
        </div>
      </div>
    );
  }

  const mLabel = `${v.today.getMonth() + 1}月`;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <div className="kpi-dark">
          <span style={{ fontSize: 12, fontWeight: 600, color: "#C9CBD1" }}>{mLabel} 支払予定総額</span>
          <span className="num kpi-big" style={{ fontWeight: 700, letterSpacing: "-.02em" }}>{yen(v.tot)}</span>
          <span style={{ fontSize: 12, color: "#C9CBD1" }}>{v.count}件 ／ {v.today.getMonth() === 11 ? 1 : v.today.getMonth() + 2}月見込 {yen(v.next)}</span>
        </div>
        <div className="card pad stack kpi-card" style={{ gap: 10 }}>
          <span className="lbl">毎月固定</span>
          <span className="num kpi-mid" style={{ fontWeight: 700, color: "#2236B8" }}>{yen(v.fx)}</span>
          <div className="bar" style={{ background: "#EAEDFC" }}><div style={{ width: pct(v.fx, v.tot), background: "#2440D8" }} /></div>
          <span className="muted" style={{ fontSize: 12 }}>総額の {pct(v.fx, v.tot)}</span>
        </div>
        <div className="card pad stack kpi-card" style={{ gap: 10 }}>
          <span className="lbl">臨時</span>
          <span className="num kpi-mid" style={{ fontWeight: 700, color: "#9A420A" }}>{yen(v.sp)}</span>
          <div className="bar" style={{ background: "#FBEDE2" }}><div style={{ width: pct(v.sp, v.tot), background: "#E8743B" }} /></div>
          <span className="muted" style={{ fontSize: 12 }}>総額の {pct(v.sp, v.tot)}</span>
        </div>
        <div className="card pad stack" style={{ gap: 10, borderColor: "#F0C9AE", background: "#FFF8F3" }}>
          <span className="lbl" style={{ color: "#9A420A" }}>要対応</span>
          <div className="stack" style={{ gap: 8, fontSize: 14 }}>
            <div className="row" style={{ justifyContent: "space-between" }}><span>3日以内の支払</span><strong className="num">{v.soon}件</strong></div>
            <div className="row" style={{ justifyContent: "space-between" }}><span>承認待ち</span><strong className="num">{v.wait}件</strong></div>
          </div>
          <button type="button" className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => ctx.go("schedule")}>確認する →</button>
        </div>
      </div>

      <CfPanel ctx={ctx} />

      <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
        <section className="card pad stack" style={{ gap: 18, gridColumn: "1 / -1", minWidth: 0 }}>
          <div className="row wrap" style={{ justifyContent: "space-between", gap: 8 }}>
            <h2 className="h2">今後8週間の支払見込み <button type="button" className="btn btn-sm" style={{ marginLeft: 8, verticalAlign: "middle" }} onClick={() => ctx.go("monthly")}>月別で見る</button></h2>
            <div className="row muted" style={{ gap: 14, fontSize: 12 }}>
              <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: "#2440D8" }} />固定（見込含む）</span>
              <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: "#E8743B" }} />臨時</span>
            </div>
          </div>
          <div className="row" style={{ alignItems: "flex-end", gap: 12, height: 220, paddingTop: 22, borderBottom: "1px solid #E4E2DC" }} role="img" aria-label="今後8週間の週別支払見込み">
            {v.wk.map((w, i) => (
              <div key={i} className="stack" style={{ flex: 1, height: "100%", justifyContent: "flex-end", position: "relative" }}>
                <span className="num muted" style={{ position: "absolute", top: -20, left: 0, right: 0, textAlign: "center", fontSize: 11 }}>{w.f + w.s ? Math.round((w.f + w.s) / 10000) + "万" : "—"}</span>
                <div style={{ height: Math.round((w.s / v.mx) * 100) + "%", background: "#E8743B", borderRadius: "6px 6px 0 0" }} />
                <div style={{ height: Math.round((w.f / v.mx) * 100) + "%", background: "#2440D8" }} />
              </div>
            ))}
          </div>
          <div className="row" style={{ gap: 12, marginTop: -10 }}>
            {v.wk.map((w, i) => <span key={i} className="muted" style={{ flex: 1, textAlign: "center", fontSize: 11 }}>{md(w.st)}週</span>)}
          </div>
        </section>

        <section className="card pad stack" style={{ gap: 16 }}>
          <h2 className="h2">金融機関別（{mLabel}）</h2>
          {v.banks.length === 0 && <span className="muted" style={{ fontSize: 13 }}>今月の支払はありません</span>}
          {v.banks.map(([name, amt]) => (
            <div key={name} className="stack" style={{ gap: 6 }}>
              <div className="row" style={{ justifyContent: "space-between", fontSize: 13 }}><span style={{ fontWeight: 600 }}>{name}</span><span className="num">{yen(amt)}</span></div>
              <div className="bar" style={{ height: 8, background: "#EEEDE9" }}><div style={{ width: pct(amt, v.banks[0][1]), background: "#17191E" }} /></div>
            </div>
          ))}
        </section>

        <section className="card pad stack" style={{ gap: 12 }}>
          <h2 className="h2">相手先別 上位5社（今後）</h2>
          {v.payees.map(([name, amt], i) => (
            <div key={name} className="row" style={{ gap: 12, fontSize: 13, padding: "6px 0", borderBottom: "1px solid #EFEDE8" }}>
              <span className="num muted" style={{ width: 22, fontWeight: 600 }}>{i + 1}</span>
              <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
              <span className="num" style={{ fontWeight: 600 }}>{yen(amt)}</span>
            </div>
          ))}
        </section>

        <section className="card pad stack" style={{ gap: 4, gridColumn: "1 / -1", minWidth: 0 }}>
          <div className="row" style={{ justifyContent: "space-between", paddingBottom: 8 }}>
            <h2 className="h2">直近の支払予定</h2>
            <button type="button" className="btn btn-sm" onClick={() => ctx.go("schedule")}>すべて見る</button>
          </div>
          {v.upcoming.map((p) => (
            <div key={p.id} className="list-row">
              <div className="datebox"><span className="num" style={{ fontSize: 16, fontWeight: 700 }}>{p.md}</span><span className="muted" style={{ fontSize: 11 }}>{p.wd}</span></div>
              <div className="stack grow" style={{ flex: "1 1 200px", gap: 2 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{p.payee_name}</span>
                <span className="muted" style={{ fontSize: 12 }}>{p.item ?? ""} ・ {p.bankName}</span>
              </div>
              <span className={p.kindCls}>{p.kindLabel}</span>
              <span className="num r" style={{ width: 120, fontSize: 15, fontWeight: 700 }}>{p.amt}</span>
              {p.document_id
                ? <button type="button" className="btn btn-sm" onClick={() => ctx.openDoc(p.document_id!)} aria-label={`${p.payee_name}の書類を表示`}><Icon name="doc" size={14} width={2} />PDF</button>
                : <span style={{ width: 62 }} />}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

/** 支出をキャッシュフロー計算書の区分（営業・投資・財務）で見る */
function CfPanel({ ctx }: { ctx: Ctx }) {
  const [mi, setMi] = useState(0);
  const today = new Date();
  const months = [0, 1, 2].map((i) => new Date(today.getFullYear(), today.getMonth() + i, 1));
  const v = useMemo(() => {
    const all = viewPayments(ctx.payments, ctx.banks);
    const cfMap = payeeCfMap(ctx.payments);
    const proj = projectFixed(all, new Date(today.getFullYear(), today.getMonth() + 3, 0));
    const xs = proj.filter((p) => sameMonth(p.d, months[mi]));
    const total = sum(xs, (p) => p.amount);
    const secs = CF_SECTIONS.map((sec) => {
      const mine = xs.filter((p) => cfSectionOf(cfItemOf(p, cfMap)) === sec.key);
      const items = sec.items.map((it) => ({ it, v: sum(mine.filter((p) => cfItemOf(p, cfMap) === it), (p) => p.amount) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
      return { ...sec, v: sum(mine, (p) => p.amount), n: mine.length, items };
    });
    const est = sum(xs.filter((p) => p.est), (p) => p.amount);
    return { total, secs, est };
  }, [ctx.payments, ctx.banks, mi]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card pad stack" style={{ gap: 16 }}>
      <div className="row wrap" style={{ justifyContent: "space-between", gap: 10 }}>
        <div className="stack" style={{ gap: 2 }}>
          <h2 className="h2">キャッシュフロー区分別の支出</h2>
          <span className="muted" style={{ fontSize: 12 }}>支払予定を 営業・投資・財務 の支出項目で集計（入金は含みません）{v.est > 0 && ` ／ うち見込 ${yen(v.est)}`}</span>
        </div>
        <div className="row" style={{ gap: 4 }} role="group" aria-label="対象月">
          {months.map((m, i) => (
            <button key={i} type="button" className={"btn btn-sm" + (mi === i ? " btn-primary" : "")} aria-pressed={mi === i} onClick={() => setMi(i)}>{m.getMonth() + 1}月{i > 0 ? "（見込）" : ""}</button>
          ))}
        </div>
      </div>
      <div className="row" style={{ height: 12, borderRadius: 999, overflow: "hidden", background: "#F5F4F0" }} role="img" aria-label="区分別の構成比">
        {v.secs.map((s) => s.v > 0 && <div key={s.key} title={`${s.label} ${yen(s.v)}`} style={{ width: pct(s.v, v.total), background: s.color }} />)}
      </div>
      <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {v.secs.map((s) => (
          <div key={s.key} className="stack" style={{ gap: 8, padding: 16, borderRadius: 12, background: "#FAFAF8", border: "1px solid #EFEDE8", minWidth: 0 }}>
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <span className="row" style={{ gap: 6, fontSize: 13, fontWeight: 700 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, display: "inline-block" }} />{s.label}の支出</span>
              <span className="muted num" style={{ fontSize: 12 }}>{pct(s.v, v.total)}</span>
            </div>
            <span className="num" style={{ fontSize: 22, fontWeight: 700, color: s.v ? "#17191E" : "#9A9EA8" }}>{yen(s.v)}</span>
            <div className="stack" style={{ gap: 4 }}>
              {s.items.length === 0 && <span className="muted" style={{ fontSize: 12 }}>該当なし</span>}
              {s.items.slice(0, 5).map((x) => (
                <div key={x.it} className="row" style={{ justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                  <span style={{ color: "#4A4E57" }}>{x.it}</span><span className="num">{yen(x.v)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {ctx.canWrite && <button type="button" className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => ctx.go("invoice")}>支出項目を変更する（請求書画面）→</button>}
    </section>
  );
}
