"use client";
import { useMemo, useState } from "react";
import type { Ctx } from "../ctx";
import { parseDate, sum, yen, ymLabel } from "@/lib/format";
import Icon from "../Icon";

const UNSORTED = "未仕分け";

export default function Folders({ ctx }: { ctx: Ctx }) {
  const months = useMemo(() => {
    const s = new Set(ctx.docs.map((d) => d.folder_month ?? UNSORTED));
    return [...s].sort((a, b) => (a === UNSORTED ? 1 : b === UNSORTED ? -1 : b.localeCompare(a)));
  }, [ctx.docs]);
  const [month, setMonth] = useState<string | null>(null);
  const [acc, setAcc] = useState<string | null>(null);
  const m = month ?? months[0] ?? null;

  const inMonth = ctx.docs.filter((d) => (d.folder_month ?? UNSORTED) === m);
  const accs = [...new Set(inMonth.map((d) => d.account_title ?? "未設定"))];
  const a = acc && accs.includes(acc) ? acc : accs[0] ?? null;
  const files = inMonth.filter((d) => (d.account_title ?? "未設定") === a);
  const amountOf = (docId: string) => sum(ctx.payments.filter((p) => p.document_id === docId), (p) => p.amount);

  if (ctx.docs.length === 0) return <div className="card empty">まだ書類がありません</div>;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        {months.map((x) => (
          <button key={x} type="button" className={"pill" + (x === m ? " is-on" : "")} onClick={() => { setMonth(x); setAcc(null); }}>
            {x === UNSORTED ? UNSORTED : ymLabel(parseDate(x))}
          </button>
        ))}
      </div>
      <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        {accs.map((x) => {
          const ds = inMonth.filter((d) => (d.account_title ?? "未設定") === x);
          return (
            <button key={x} type="button" className={"tile" + (x === a ? " is-on" : "")} onClick={() => setAcc(x)} aria-pressed={x === a}>
              <Icon name="folders" size={26} color="#2440D8" />
              <span style={{ fontSize: 15, fontWeight: 700 }}>{x}</span>
              <span className="num muted" style={{ fontSize: 12 }}>{ds.length}ファイル ・ {yen(sum(ds, (d) => amountOf(d.id)))}</span>
            </button>
          );
        })}
      </div>
      <section className="card scroll-x">
        <table className="tbl">
          <thead><tr><th>ファイル名</th><th>種類</th><th className="r">金額</th><th>MF クラウドBox</th><th>登録日</th><th /></tr></thead>
          <tbody>
            {files.map((d) => (
              <tr key={d.id}>
                <td className="nw" style={{ fontWeight: 600 }}>{d.file_name}</td>
                <td>{d.doc_type === "invoice" ? "請求書" : d.doc_type === "receipt" ? "領収書" : "その他"}</td>
                <td className="num r" style={{ fontWeight: 700 }}>{amountOf(d.id) ? yen(amountOf(d.id)) : "—"}</td>
                <td><span className={"chip " + (d.mf_box_status === "stored" ? "st-ok" : d.mf_box_status === "failed" ? "st-err" : "st-wait")}>{d.mf_box_status === "stored" ? "保存済" : d.mf_box_status === "failed" ? "失敗" : "保存待ち"}</span></td>
                <td className="num muted">{new Date(d.created_at).toLocaleDateString("ja-JP")}</td>
                <td><button type="button" className="btn btn-sm" onClick={() => ctx.openDoc(d.id)}>開く</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
