"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Ctx } from "../ctx";
import { sb } from "@/lib/supabase";
import { authedPost } from "@/lib/authed";
import { KIND_LABEL, ROLE_LABEL, type CompanyKind, type Role } from "@/lib/types";

interface Member {
  company_id: string; company_name: string; company_kind: CompanyKind; firm_name: string | null;
  user_id: string; email: string; display_name: string | null; role: Role;
  created_at: string; last_sign_in_at: string | null; mfa_enabled: boolean;
}
interface Co { id: string; name: string; kind: CompanyKind }

const MATRIX: [string, Role[]][] = [
  ["支払予定・ダッシュボード・予算を見る", ["owner", "approver", "member", "viewer"]],
  ["請求書・立替経費の登録、支払予定・予算の作成", ["owner", "approver", "member"]],
  ["支払の承認、FBデータの作成、予算の承認", ["owner", "approver"]],
  ["振込元口座の登録、メンバーの招待・権限変更", ["owner"]],
  ["マネーフォワード連携、プランのお申し込み", ["owner"]],
];

/** アカウント一覧と権限管理：自分がオーナーの会社（会計事務所は顧問先も、HRD管理者は全社）のメンバー */
export default function Accounts({ ctx }: { ctx: Ctx }) {
  const [rows, setRows] = useState<Member[]>([]);
  const [cos, setCos] = useState<Co[]>([]);
  const [coFilter, setCoFilter] = useState<string>("all");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [inviteCo, setInviteCo] = useState<string>(ctx.company.id);
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [m, c] = await Promise.all([sb().rpc("managed_members"), sb().rpc("managed_companies")]);
    setLoading(false);
    if (m.error) { ctx.toast(m.error.message, true); return; }
    setRows((m.data as Member[]) ?? []);
    setCos((c.data as Co[]) ?? []);
  }, [ctx]);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => rows.filter((r) =>
    (coFilter === "all" || r.company_id === coFilter) && (roleFilter === "all" || r.role === roleFilter)
    && (!ctx.q || r.email.includes(ctx.q) || r.company_name.includes(ctx.q) || (r.display_name ?? "").includes(ctx.q))), [rows, coFilter, roleFilter, ctx.q]);
  const people = new Set(rows.map((r) => r.user_id)).size;

  async function changeRole(r: Member, role: Role) {
    if (role === "owner" && !window.confirm(`${r.email} を「${r.company_name}」のオーナーにします。口座登録やメンバー管理もできるようになります。よろしいですか？`)) return;
    const { error } = await sb().from("memberships").update({ role }).eq("company_id", r.company_id).eq("user_id", r.user_id);
    if (error) ctx.toast(error.message, true); else { ctx.toast("権限を変更しました"); load(); }
  }
  async function remove(r: Member) {
    if (!window.confirm(`${r.email} を「${r.company_name}」から外します。この会社のデータを見られなくなります。よろしいですか？`)) return;
    const { error } = await sb().from("memberships").delete().eq("company_id", r.company_id).eq("user_id", r.user_id);
    if (error) ctx.toast(error.message, true); else { ctx.toast("メンバーから外しました"); load(); }
  }
  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await authedPost("/api/invite", { email: email.trim(), role: inviteRole, companyId: inviteCo });
    setBusy(false);
    if (!r.ok) ctx.toast(r.error ?? "招待できませんでした", true);
    else { ctx.toast(`招待しました：${email}`); setEmail(""); load(); }
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))" }}>
        <div className="kpi-dark"><span style={{ fontSize: 12, color: "#A9ACB4" }}>管理している会社</span><span className="kpi-mid num">{cos.length}</span></div>
        <div className="card pad stack kpi-card" style={{ gap: 6 }}><span className="lbl">アカウント（人）</span><span className="kpi-mid num">{people}</span></div>
        <div className="card pad stack kpi-card" style={{ gap: 6 }}><span className="lbl">オーナー</span><span className="kpi-mid num">{rows.filter((r) => r.role === "owner").length}</span></div>
        <div className="card pad stack kpi-card" style={{ gap: 6 }}><span className="lbl">2段階認証 未設定</span><span className="kpi-mid num" style={{ color: "#9A420A" }}>{new Set(rows.filter((r) => !r.mfa_enabled).map((r) => r.user_id)).size}</span></div>
      </div>

      {cos.length > 0 && (
        <form className="card pad stack" style={{ gap: 12 }} onSubmit={invite}>
          <h2 className="h2">アカウントを追加（招待）</h2>
          <div className="row wrap" style={{ gap: 10, alignItems: "flex-end" }}>
            <label className="field" style={{ flex: "1 1 220px" }}><span>会社</span>
              <select className="inp" value={inviteCo} onChange={(e) => setInviteCo(e.target.value)}>
                {cos.map((c) => <option key={c.id} value={c.id}>{c.kind === "client" ? "" : "◆ "}{c.name}</option>)}
              </select>
            </label>
            <label className="field" style={{ flex: "1 1 240px" }}><span>メールアドレス</span><input className="inp" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></label>
            <label className="field" style={{ width: 150 }}><span>権限</span>
              <select className="inp" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>{(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "送信中…" : "招待する"}</button>
          </div>
          <span className="muted" style={{ fontSize: 12 }}>未登録の方には招待メールが届きます。登録済みの方はすぐに追加されます。会計事務所のメンバーは、顧問先でも事務所での権限と同じ操作ができます。</span>
        </form>
      )}

      <section className="card scroll-x">
        <div className="row wrap" style={{ padding: "18px 22px 8px", gap: 10 }}>
          <h2 className="h2 grow">アカウント一覧</h2>
          <select className="inp" style={{ height: 36, width: 220 }} value={coFilter} onChange={(e) => setCoFilter(e.target.value)} aria-label="会社で絞り込み">
            <option value="all">すべての会社</option>
            {cos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="inp" style={{ height: 36, width: 140 }} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="権限で絞り込み">
            <option value="all">すべての権限</option>
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </div>
        {loading ? <div className="empty">読み込み中…</div> : shown.length === 0 ? <div className="empty">該当するアカウントはありません</div> : (
          <table className="tbl">
            <thead><tr><th>会社</th><th>アカウント</th><th>権限</th><th>2段階認証</th><th>最終ログイン</th><th className="r">操作</th></tr></thead>
            <tbody>{shown.map((r) => (
              <tr key={r.company_id + r.user_id}>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <span className={"chip " + (r.company_kind === "client" ? "chip-spot" : "chip-fixed")}>{r.company_kind === "hrd" ? "HRD" : KIND_LABEL[r.company_kind]}</span>
                    <strong>{r.company_name}</strong>
                  </div>
                  {r.firm_name && <div className="muted" style={{ fontSize: 11 }}>顧問：{r.firm_name}</div>}
                </td>
                <td><strong>{r.display_name || r.email}</strong>{r.display_name && <div className="muted" style={{ fontSize: 11 }}>{r.email}</div>}</td>
                <td>
                  {r.user_id === ctx.userId ? <span className="chip st-auto">{ROLE_LABEL[r.role]}（自分）</span> : (
                    <select className="inp" style={{ width: 130, height: 34 }} value={r.role} onChange={(e) => changeRole(r, e.target.value as Role)} aria-label={`${r.email}の権限`}>
                      {(Object.keys(ROLE_LABEL) as Role[]).map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}
                    </select>
                  )}
                </td>
                <td><span className={"chip " + (r.mfa_enabled ? "st-ok" : "st-auto")}>{r.mfa_enabled ? "設定済み" : "未設定"}</span></td>
                <td className="num nw">{r.last_sign_in_at ? new Date(r.last_sign_in_at).toLocaleString("ja-JP") : "未ログイン"}</td>
                <td className="r">{r.user_id !== ctx.userId && <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(r)}>外す</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="card scroll-x">
        <div style={{ padding: "18px 22px 8px" }}><h2 className="h2">権限でできること</h2></div>
        <table className="tbl">
          <thead><tr><th>操作</th>{(Object.keys(ROLE_LABEL) as Role[]).map((r) => <th key={r} className="r">{ROLE_LABEL[r]}</th>)}</tr></thead>
          <tbody>{MATRIX.map(([label, roles]) => (
            <tr key={label}><td>{label}</td>{(Object.keys(ROLE_LABEL) as Role[]).map((r) => <td key={r} className="r">{roles.includes(r) ? "○" : "—"}</td>)}</tr>
          ))}</tbody>
        </table>
      </section>
    </div>
  );
}
