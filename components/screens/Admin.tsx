"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Ctx } from "../ctx";
import { sb } from "@/lib/supabase";
import { KIND_LABEL, type CompanyKind } from "@/lib/types";

interface Account {
  id: string; kind: CompanyKind; name: string; created_at: string; trial_ends_at: string | null;
  member_count: number; client_count: number; firm_names: string | null; subscription_status: string | null;
  current_period_end: string | null; has_access: boolean; suspended_at: string | null; suspended_reason: string | null; billing_exempt: boolean;
}
interface User { id: string; email: string; display_name: string | null; is_hrd_staff: boolean; created_at: string; last_sign_in_at: string | null; mfa_enabled: boolean; companies: string | null }
interface Log { id: number; created_at: string; company_name: string | null; actor_email: string | null; action: string; table_name: string }

const SUB: Record<string, string> = { active: "契約中", trialing: "契約中", past_due: "支払確認中", canceled: "解約", unpaid: "未払い", incomplete: "手続き中", incomplete_expired: "未完了", paused: "停止中" };
const ACTION: Record<string, string> = { insert: "追加", update: "変更", delete: "削除" };
const TABLE: Record<string, string> = { mf_connections: "マネーフォワード連携", payments: "支払予定", documents: "書類", bank_accounts: "振込元口座", payees: "支払先", fb_exports: "FBデータ", memberships: "メンバー", companies: "会社", firm_clients: "顧問関係", subscriptions: "サブスク", invitations: "招待", profiles: "管理者権限" };
type Tab = "accounts" | "users" | "logs";
type Filter = "all" | CompanyKind | "expired" | "suspended";
const d = (s: string | null) => (s ? new Date(s).toLocaleDateString("ja-JP") : "—");

/** HRD管理者：アカウント・ユーザー・操作ログ */
export default function Admin({ ctx }: { ctx: Ctx }) {
  const [tab, setTab] = useState<Tab>("accounts");
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="seg" role="tablist" style={{ alignSelf: "flex-start" }}>
        {([["accounts", "アカウント"], ["users", "ユーザー"], ["logs", "操作ログ"]] as [Tab, string][]).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === "accounts" && <Accounts ctx={ctx} />}
      {tab === "users" && <Users ctx={ctx} />}
      {tab === "logs" && <Logs ctx={ctx} />}
    </div>
  );
}

function Accounts({ ctx }: { ctx: Ctx }) {
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

  const match = (r: Account, f: Filter) => f === "all" ? true : f === "expired" ? !r.has_access && !r.suspended_at : f === "suspended" ? !!r.suspended_at : r.kind === f;
  const shown = useMemo(() => rows.filter((r) => match(r, filter) && (!ctx.q || r.name.includes(ctx.q))), [rows, filter, ctx.q]);
  const count = (f: Filter) => rows.filter((r) => match(r, f)).length;
  const paying = rows.filter((r) => r.subscription_status && ["active", "trialing", "past_due"].includes(r.subscription_status)).length;

  async function call(fn: string, args: Record<string, unknown>, ok: string) {
    const { error } = await sb().rpc(fn, args);
    if (error) ctx.toast(error.message, true); else { ctx.toast(ok); load(); ctx.reloadOrg(); }
  }
  function extend(r: Account) {
    const v = window.prompt(`${r.name} の無料期間を延長（日数）`, "30");
    if (!v) return;
    const days = Number(v);
    if (!Number.isInteger(days) || days < 1 || days > 365) { ctx.toast("1〜365の日数を入力してください", true); return; }
    call("admin_extend_trial", { p_company: r.id, p_days: days }, `${days}日延長しました`);
  }
  function suspend(r: Account) {
    if (r.suspended_at) { if (window.confirm(`${r.name} を再開しますか？`)) call("admin_set_suspended", { p_company: r.id, p_suspended: false }, "再開しました"); return; }
    const reason = window.prompt(`${r.name} を停止します。理由（任意）`, "");
    if (reason === null) return;
    call("admin_set_suspended", { p_company: r.id, p_suspended: true, p_reason: reason }, "停止しました");
  }
  function exempt(r: Account) {
    const next = !r.billing_exempt;
    if (!window.confirm(next ? `${r.name} を無料扱いにしますか？` : `${r.name} を有料に戻しますか？`)) return;
    call("admin_set_billing_exempt", { p_company: r.id, p_exempt: next }, "変更しました");
  }

  return (
    <>
      <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(160px, 100%), 1fr))" }}>
        <div className="kpi-dark"><span style={{ fontSize: 12, color: "#A9ACB4" }}>会計事務所</span><span className="kpi-mid num">{count("accounting_firm") + count("hrd")}</span></div>
        <div className="card pad stack kpi-card" style={{ gap: 6 }}><span className="lbl">企業</span><span className="kpi-mid num">{count("client")}</span></div>
        <div className="card pad stack kpi-card" style={{ gap: 6 }}><span className="lbl">有料契約</span><span className="kpi-mid num" style={{ color: "#2236B8" }}>{paying}</span></div>
        <div className="card pad stack kpi-card" style={{ gap: 6 }}><span className="lbl">期限切れ</span><span className="kpi-mid num" style={{ color: "#9A420A" }}>{count("expired")}</span></div>
        <div className="card pad stack kpi-card" style={{ gap: 6 }}><span className="lbl">利用停止</span><span className="kpi-mid num" style={{ color: "#9B1C1C" }}>{count("suspended")}</span></div>
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        {([["all", "すべて"], ["accounting_firm", "会計事務所"], ["client", "企業"], ["expired", "期限切れ"], ["suspended", "利用停止"]] as [Filter, string][]).map(([k, label]) => (
          <button key={k} type="button" className={"pill" + (filter === k ? " is-on" : "")} onClick={() => setFilter(k)}>{label} <span className="num" style={{ opacity: .6 }}>{count(k)}</span></button>
        ))}
      </div>
      <section className="card scroll-x">
        {loading ? <div className="empty">読み込み中…</div> : shown.length === 0 ? <div className="empty">該当なし</div> : (
          <table className="tbl">
            <thead><tr><th>種別</th><th>名称</th><th>会計事務所</th><th>登録日</th><th>無料期間</th><th className="r">人数</th><th className="r">顧問先</th><th>契約</th><th>状態</th><th /></tr></thead>
            <tbody>{shown.map((r) => {
              const covered = !!r.firm_names;
              return (
                <tr key={r.id}>
                  <td className="nw"><span className={"chip " + (r.kind === "client" ? "chip-spot" : r.kind === "hrd" ? "st-auto" : "chip-fixed")}>{r.kind === "hrd" ? "HRD" : KIND_LABEL[r.kind]}</span></td>
                  <td><strong>{r.name}</strong>{r.suspended_reason && <div className="muted" style={{ fontSize: 11 }}>{r.suspended_reason}</div>}</td>
                  <td>{r.firm_names ?? "—"}</td>
                  <td className="num nw">{d(r.created_at)}</td>
                  <td className="num nw">{r.kind === "hrd" || covered || r.billing_exempt ? "—" : d(r.trial_ends_at)}</td>
                  <td className="r num">{r.member_count}</td>
                  <td className="r num">{r.kind === "client" ? "—" : r.client_count}</td>
                  <td className="nw">{r.billing_exempt ? "無料扱い" : r.subscription_status ? SUB[r.subscription_status] ?? r.subscription_status : covered ? "事務所の契約" : "—"}</td>
                  <td className="nw"><span className={"chip " + (r.suspended_at ? "st-err" : r.has_access ? "st-ok" : "st-wait")}>{r.suspended_at ? "停止中" : r.has_access ? "利用可" : "期限切れ"}</span></td>
                  <td className="r nw">
                    <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                      <button type="button" className="btn btn-sm" onClick={() => ctx.selectCompany(r.id)}>開く</button>
                      {r.kind !== "hrd" && (
                        <>
                          {!covered && !r.billing_exempt && <button type="button" className="btn btn-sm" onClick={() => extend(r)}>延長</button>}
                          <button type="button" className="btn btn-sm" onClick={() => exempt(r)}>{r.billing_exempt ? "有料に戻す" : "無料扱い"}</button>
                          <button type="button" className="btn btn-sm" style={{ color: r.suspended_at ? undefined : "#9B1C1C" }} onClick={() => suspend(r)}>{r.suspended_at ? "再開" : "停止"}</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </section>
    </>
  );
}

function Users({ ctx }: { ctx: Ctx }) {
  const [rows, setRows] = useState<User[]>([]);
  const load = useCallback(async () => {
    const { data, error } = await sb().rpc("admin_list_users");
    if (error) ctx.toast(error.message, true); else setRows((data as User[]) ?? []);
  }, [ctx]);
  useEffect(() => { load(); }, [load]);
  const shown = rows.filter((r) => !ctx.q || r.email.includes(ctx.q) || (r.companies ?? "").includes(ctx.q));

  async function toggle(u: User) {
    const next = !u.is_hrd_staff;
    if (!window.confirm(next ? `${u.email} を管理者にしますか？全社のデータを操作できます` : `${u.email} の管理者権限を解除しますか？`)) return;
    const { error } = await sb().rpc("admin_set_hrd_staff", { p_user: u.id, p_value: next });
    if (error) ctx.toast(error.message, true); else { ctx.toast("変更しました"); load(); }
  }

  return (
    <section className="card scroll-x">
      <div className="row" style={{ padding: "18px 22px 8px", gap: 10 }}>
        <h2 className="h2 grow">ユーザー</h2>
        <span className="muted num" style={{ fontSize: 13 }}>{rows.length}</span>
      </div>
      {shown.length === 0 ? <div className="empty">該当なし</div> : (
        <table className="tbl">
          <thead><tr><th>メールアドレス</th><th>所属</th><th>登録日</th><th>最終ログイン</th><th>2段階認証</th><th>管理者</th><th /></tr></thead>
          <tbody>{shown.map((u) => (
            <tr key={u.id}>
              <td><strong>{u.email}</strong>{u.display_name && <div className="muted" style={{ fontSize: 11 }}>{u.display_name}</div>}</td>
              <td style={{ fontSize: 12 }}>{(u.companies ?? "—").replace(/owner/g, "オーナー").replace(/approver/g, "承認者").replace(/member/g, "担当者").replace(/viewer/g, "閲覧のみ")}</td>
              <td className="num nw">{d(u.created_at)}</td>
              <td className="num nw">{u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString("ja-JP") : "—"}</td>
              <td className="nw"><span className={"chip " + (u.mfa_enabled ? "st-ok" : "st-auto")}>{u.mfa_enabled ? "設定済み" : "未設定"}</span></td>
              <td className="nw">{u.is_hrd_staff ? <span className="chip chip-fixed">管理者</span> : "—"}</td>
              <td className="r nw">{u.id !== ctx.userId && <button type="button" className="btn btn-sm" onClick={() => toggle(u)}>{u.is_hrd_staff ? "解除" : "管理者にする"}</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

function Logs({ ctx }: { ctx: Ctx }) {
  const [rows, setRows] = useState<Log[]>([]);
  useEffect(() => {
    sb().rpc("admin_audit_logs", { p_limit: 300 }).then(({ data, error }) => {
      if (error) ctx.toast(error.message, true); else setRows((data as Log[]) ?? []);
    });
  }, [ctx]);
  const shown = rows.filter((r) => !ctx.q || (r.company_name ?? "").includes(ctx.q) || (r.actor_email ?? "").includes(ctx.q));
  return (
    <section className="card scroll-x">
      <div style={{ padding: "18px 22px 8px" }}><h2 className="h2">操作ログ</h2></div>
      {shown.length === 0 ? <div className="empty">記録なし</div> : (
        <table className="tbl">
          <thead><tr><th>日時</th><th>会社</th><th>操作した人</th><th>対象</th><th>操作</th></tr></thead>
          <tbody>{shown.map((l) => (
            <tr key={l.id}>
              <td className="num nw">{new Date(l.created_at).toLocaleString("ja-JP")}</td>
              <td>{l.company_name ?? "—"}</td>
              <td>{l.actor_email ?? "システム"}</td>
              <td>{TABLE[l.table_name] ?? l.table_name}</td>
              <td>{ACTION[l.action] ?? l.action}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}
