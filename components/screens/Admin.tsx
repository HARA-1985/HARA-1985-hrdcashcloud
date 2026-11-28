"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Ctx } from "../ctx";
import { sb } from "@/lib/supabase";
import { KIND_LABEL, type CompanyKind } from "@/lib/types";

interface Account {
  id: string; kind: CompanyKind; name: string; created_at: string; trial_ends_at: string | null;
  member_count: number; client_count: number; subscription_status: string | null; current_period_end: string | null; has_access: boolean;
}

const SUB: Record<string, string> = { active: "契約中", trialing: "契約中（課金前）", past_due: "支払確認中", canceled: "解約", unpaid: "未払い", incomplete: "手続き中", incomplete_expired: "未完了", paused: "停止中" };
type Filter = "all" | CompanyKind | "expired";

/** HRD管理者：全アカウントの状況と無料期間の延長 */
export default function Admin({ ctx }: { ctx: Ctx }) {
  const [rows, setRows] = useState<Account[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await sb().rpc("admin_list_accounts");
    setLoading(false);
    if (error) ctx.toast(error.message, true); else setRows((data as Account[]) ?? []);
  }, [ctx]);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => rows.filter((r) =>
    (filter === "all" || (filter === "expired" ? !r.has_access : r.kind === filter))
    && (!ctx.q || r.name.includes(ctx.q))), [rows, filter, ctx.q]);

  const count = (f: Filter) => rows.filter((r) => f === "all" || (f === "expired" ? !r.has_access : r.kind === f)).length;
  const paying = rows.filter((r) => r.subscription_status && ["active", "trialing", "past_due"].includes(r.subscription_status)).length;

  async function extend(r: Account) {
    const v = window.prompt(`「${r.name}」の無料期間を何日延長しますか？`, "30");
    if (!v) return;
    const days = Number(v);
    if (!Number.isInteger(days) || days < 1 || days > 365) { ctx.toast("1〜365の日数を入力してください", true); return; }
    const { error } = await sb().rpc("admin_extend_trial", { p_company: r.id, p_days: days });
    if (error) ctx.toast(error.message, true); else { ctx.toast(`${days}日延長しました`); load(); }
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))" }}>
        <div className="kpi-dark"><span style={{ fontSize: 12, color: "#A9ACB4" }}>会計事務所</span><span className="kpi-mid num">{count("accounting_firm")}</span></div>
        <div className="card pad stack kpi-card" style={{ gap: 6 }}><span className="lbl">企業</span><span className="kpi-mid num">{count("client")}</span></div>
        <div className="card pad stack kpi-card" style={{ gap: 6 }}><span className="lbl">有料契約</span><span className="kpi-mid num" style={{ color: "#2236B8" }}>{paying}</span></div>
        <div className="card pad stack kpi-card" style={{ gap: 6 }}><span className="lbl">期限切れ</span><span className="kpi-mid num" style={{ color: "#9A420A" }}>{count("expired")}</span></div>
      </div>

      <div className="row wrap" style={{ gap: 8 }}>
        {([["all", "すべて"], ["accounting_firm", "会計事務所"], ["client", "企業"], ["expired", "期限切れ"]] as [Filter, string][]).map(([k, label]) => (
          <button key={k} type="button" className={"pill" + (filter === k ? " is-on" : "")} onClick={() => setFilter(k)}>{label}（{count(k)}）</button>
        ))}
      </div>

      <section className="card scroll-x">
        {loading ? <div className="empty">読み込み中…</div> : shown.length === 0 ? <div className="empty">該当するアカウントはありません</div> : (
          <table className="tbl">
            <thead><tr><th>種別</th><th>名称</th><th>登録日</th><th>無料期間の終了</th><th className="r">メンバー</th><th className="r">顧問先</th><th>契約</th><th>利用</th><th className="r">操作</th></tr></thead>
            <tbody>{shown.map((r) => (
              <tr key={r.id}>
                <td className="nw"><span className={"chip " + (r.kind === "accounting_firm" ? "chip-fixed" : r.kind === "hrd" ? "st-auto" : "chip-spot")}>{KIND_LABEL[r.kind]}</span></td>
                <td><strong>{r.name}</strong></td>
                <td className="num nw">{new Date(r.created_at).toLocaleDateString("ja-JP")}</td>
                <td className="num nw">{r.kind === "hrd" ? "—" : r.trial_ends_at ? new Date(r.trial_ends_at).toLocaleDateString("ja-JP") : "—"}</td>
                <td className="r num">{r.member_count}</td>
                <td className="r num">{r.kind === "client" ? "—" : r.client_count}</td>
                <td className="nw">{r.subscription_status ? SUB[r.subscription_status] ?? r.subscription_status : "—"}</td>
                <td className="nw"><span className={"chip " + (r.has_access ? "st-ok" : "st-err")}>{r.has_access ? "利用可" : "期限切れ"}</span></td>
                <td className="r nw">
                  <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                    {r.kind !== "hrd" && <button type="button" className="btn btn-sm" onClick={() => extend(r)}>無料期間を延長</button>}
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => ctx.selectCompany(r.id)}>開く</button>
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}
