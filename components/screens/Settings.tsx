"use client";
import { useCallback, useEffect, useState } from "react";
import type { Ctx } from "../ctx";
import { sb } from "@/lib/supabase";
import { toZenginKana } from "@/lib/zengin";
import { ROLE_LABEL, type AuditLog, type Membership, type Payee, type Role } from "@/lib/types";

type Member = Membership & { name: string; email: string };

const ACTION: Record<string, string> = { insert: "追加", update: "変更", delete: "削除" };
const TABLE: Record<string, string> = { payments: "支払予定", documents: "書類", bank_accounts: "振込元口座", payees: "支払先", fb_exports: "FBデータ", memberships: "メンバー", companies: "会社" };

async function authedFetch(path: string, body: unknown) {
  const { data } = await sb().auth.getSession();
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token ?? ""}` }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, ...j } as { ok: boolean; error?: string; url?: string };
}

export default function Settings({ ctx }: { ctx: Ctx }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  const loadSide = useCallback(async () => {
    const [m, l] = await Promise.all([
      sb().from("memberships").select("company_id,user_id,role").eq("company_id", ctx.company.id),
      sb().from("audit_logs").select("id,actor,action,table_name,record_id,created_at").eq("company_id", ctx.company.id).order("created_at", { ascending: false }).limit(30),
    ]);
    const ms = (m.data as Membership[]) ?? [];
    const ids = [...new Set([...ms.map((x) => x.user_id), ...((l.data as AuditLog[]) ?? []).map((x) => x.actor).filter(Boolean) as string[]])];
    const p = ids.length ? await sb().from("profiles").select("id,display_name,email").in("id", ids) : { data: [] };
    const nm = new Map(((p.data as { id: string; display_name: string | null; email: string | null }[]) ?? []).map((x) => [x.id, x.display_name || x.email || "—"]));
    const em = new Map(((p.data as { id: string; email: string | null }[]) ?? []).map((x) => [x.id, x.email ?? ""]));
    setNames(nm);
    setMembers(ms.map((x) => ({ ...x, name: nm.get(x.user_id) ?? "—", email: em.get(x.user_id) ?? "" })));
    setLogs((l.data as AuditLog[]) ?? []);
  }, [ctx.company.id]);
  useEffect(() => { loadSide(); }, [loadSide]);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <CompanySection ctx={ctx} />
      {ctx.isHrd && <NewClient ctx={ctx} />}
      <BanksSection ctx={ctx} />
      <PayeesSection ctx={ctx} />
      <MembersSection ctx={ctx} members={members} onChange={loadSide} />
      <MfSection ctx={ctx} />
      <section className="card scroll-x">
        <div style={{ padding: "18px 22px 8px" }}><h2 className="h2">操作ログ（最新30件）</h2></div>
        {logs.length === 0 ? <div className="empty">まだ操作の記録はありません</div> : (
          <table className="tbl">
            <thead><tr><th>日時</th><th>操作した人</th><th>対象</th><th>操作</th></tr></thead>
            <tbody>{logs.map((l) => (
              <tr key={l.id}>
                <td className="num nw">{new Date(l.created_at).toLocaleString("ja-JP")}</td>
                <td>{l.actor ? names.get(l.actor) ?? "—" : "システム"}</td>
                <td>{TABLE[l.table_name] ?? l.table_name}</td>
                <td>{ACTION[l.action] ?? l.action}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function CompanySection({ ctx }: { ctx: Ctx }) {
  const [busy, setBusy] = useState(false);
  async function seed() {
    setBusy(true);
    const { data, error } = await sb().rpc("seed_demo", { cid: ctx.company.id });
    setBusy(false);
    if (error) ctx.toast(error.message, true);
    else if (!data) ctx.toast("支払予定があるため、サンプルは入れませんでした", true);
    else { ctx.toast(`サンプルを${data}件入れました`); ctx.reload(); }
  }
  return (
    <section className="card pad stack" style={{ gap: 12 }}>
      <h2 className="h2">会社</h2>
      <div style={{ display: "grid", gridTemplateColumns: "140px minmax(0,1fr)", gap: "10px 14px", fontSize: 14 }}>
        <span className="muted">会社名</span><strong>{ctx.company.name}</strong>
        <span className="muted">区分</span><span>{ctx.company.kind === "hrd" ? "HRD総合事務所（管理側）" : "顧問先"}</span>
        <span className="muted">MFプラン</span><span>{ctx.company.mf_plan ?? "—"}（クラウドBoxの保存上限はプランにより1,000件）</span>
        <span className="muted">あなたの権限</span><span>{ctx.isHrd ? "HRD管理者（全社）" : ROLE_LABEL[ctx.role]}</span>
      </div>
      {ctx.isOwner && ctx.payments.length === 0 && (
        <div className="row wrap" style={{ gap: 10 }}>
          <button type="button" className="btn" disabled={busy} onClick={seed}>サンプルデータを入れて動きを確認</button>
          <span className="muted" style={{ fontSize: 12 }}>支払予定が空の会社にだけ入ります</span>
        </div>
      )}
    </section>
  );
}

function NewClient({ ctx }: { ctx: Ctx }) {
  const [name, setName] = useState("");
  const [kana, setKana] = useState("");
  const [busy, setBusy] = useState(false);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const { error } = await sb().rpc("create_company", { p_name: name.trim(), p_kana: toZenginKana(kana) || null, p_plan: "スモールビジネス" });
    setBusy(false);
    if (error) ctx.toast(error.message, true); else { ctx.toast("顧問先を追加しました：" + name); setName(""); setKana(""); ctx.reloadOrg(); }
  }
  return (
    <form className="card pad stack" style={{ gap: 12 }} onSubmit={add}>
      <h2 className="h2">顧問先を追加（HRD管理者のみ）</h2>
      <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <label className="field"><span>会社名</span><input className="inp" value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label className="field"><span>会社名カナ（FB用）</span><input className="inp" value={kana} onChange={(e) => setKana(e.target.value)} placeholder="ｻﾝﾌﾟﾙ(ｶ" /></label>
      </div>
      <button className="btn btn-primary" type="submit" disabled={busy} style={{ alignSelf: "flex-start" }}>追加</button>
    </form>
  );
}

function BanksSection({ ctx }: { ctx: Ctx }) {
  const empty = { bank_name: "", bank_code: "", bank_kana: "", branch_code: "", branch_name: "", branch_kana: "", account_type: "1", account_number: "", holder_kana: "", client_code: "" };
  const [f, setF] = useState(empty);
  const [open, setOpen] = useState(false);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    const row = { ...f, company_id: ctx.company.id, bank_kana: toZenginKana(f.bank_kana), branch_kana: toZenginKana(f.branch_kana), holder_kana: toZenginKana(f.holder_kana) };
    const { error } = await sb().from("bank_accounts").insert(row);
    if (error) ctx.toast(error.message, true); else { ctx.toast("振込元口座を登録しました"); setF(empty); setOpen(false); ctx.reload(); }
  }
  const mask = (n: string | null) => (n ? "***" + n.slice(-4) : "—");
  return (
    <section className="card pad stack" style={{ gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="h2">振込元口座</h2>
        {ctx.isOwner && <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => !o)}>{open ? "閉じる" : "口座を追加"}</button>}
      </div>
      {ctx.banks.length === 0 && <span className="muted" style={{ fontSize: 13 }}>まだ登録がありません</span>}
      {ctx.banks.map((b) => (
        <div key={b.id} className="list-row" style={{ fontSize: 13 }}>
          <strong style={{ minWidth: 160 }}>{b.bank_name} {b.branch_name}</strong>
          <span className="muted num">銀行 {b.bank_code ?? "—"} ・ 支店 {b.branch_code ?? "—"} ・ {b.account_type === "2" ? "当座" : "普通"} {mask(b.account_number)}</span>
          <span className="muted">委託者コード {b.client_code ? "設定済" : "未設定"}</span>
        </div>
      ))}
      {open && (
        <form className="stack" style={{ gap: 12 }} onSubmit={add}>
          <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
            <label className="field"><span>銀行名</span><input className="inp" required value={f.bank_name} onChange={(e) => setF({ ...f, bank_name: e.target.value })} /></label>
            <label className="field"><span>銀行コード（4桁）</span><input className="inp num" inputMode="numeric" maxLength={4} value={f.bank_code} onChange={(e) => setF({ ...f, bank_code: e.target.value })} /></label>
            <label className="field"><span>銀行名カナ</span><input className="inp" value={f.bank_kana} onChange={(e) => setF({ ...f, bank_kana: e.target.value })} /></label>
            <label className="field"><span>支店名</span><input className="inp" value={f.branch_name} onChange={(e) => setF({ ...f, branch_name: e.target.value })} /></label>
            <label className="field"><span>支店コード（3桁）</span><input className="inp num" inputMode="numeric" maxLength={3} value={f.branch_code} onChange={(e) => setF({ ...f, branch_code: e.target.value })} /></label>
            <label className="field"><span>支店名カナ</span><input className="inp" value={f.branch_kana} onChange={(e) => setF({ ...f, branch_kana: e.target.value })} /></label>
            <label className="field"><span>預金種目</span><select className="inp" value={f.account_type} onChange={(e) => setF({ ...f, account_type: e.target.value })}><option value="1">普通</option><option value="2">当座</option></select></label>
            <label className="field"><span>口座番号（7桁）</span><input className="inp num" inputMode="numeric" maxLength={7} value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value })} /></label>
            <label className="field"><span>依頼人名カナ</span><input className="inp" value={f.holder_kana} onChange={(e) => setF({ ...f, holder_kana: e.target.value })} /></label>
            <label className="field"><span>委託者コード（10桁）</span><input className="inp num" inputMode="numeric" maxLength={10} value={f.client_code} onChange={(e) => setF({ ...f, client_code: e.target.value })} /></label>
          </div>
          <button className="btn btn-primary" type="submit" style={{ alignSelf: "flex-start" }}>登録</button>
        </form>
      )}
    </section>
  );
}

function PayeesSection({ ctx }: { ctx: Ctx }) {
  const [edit, setEdit] = useState<Payee | null>(null);
  const blank: Payee = { id: "", company_id: ctx.company.id, name: "", name_kana: "", bank_code: "", bank_kana: "", branch_code: "", branch_kana: "", account_type: "1", account_number: "" };
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const row = { company_id: ctx.company.id, name: edit.name.trim(), name_kana: toZenginKana(edit.name_kana) || null, bank_code: edit.bank_code || null, bank_kana: toZenginKana(edit.bank_kana) || null, branch_code: edit.branch_code || null, branch_kana: toZenginKana(edit.branch_kana) || null, account_type: edit.account_type || "1", account_number: edit.account_number || null };
    const q = edit.id ? sb().from("payees").update(row).eq("id", edit.id) : sb().from("payees").insert(row);
    const { error } = await q;
    if (error) { ctx.toast(error.message, true); return; }
    if (!edit.id) {
      // 同名の支払予定を新しい支払先に紐付け
      const { data } = await sb().from("payees").select("id").eq("company_id", ctx.company.id).eq("name", row.name).single();
      if (data) await sb().from("payments").update({ payee_id: data.id }).eq("company_id", ctx.company.id).eq("payee_name", row.name).is("payee_id", null);
    }
    ctx.toast("支払先を保存しました"); setEdit(null); ctx.reload();
  }
  const unlinked = [...new Set(ctx.payments.filter((p) => !p.payee_id && p.source !== "card").map((p) => p.payee_name))];
  return (
    <section className="card pad stack" style={{ gap: 12 }}>
      <div className="row wrap" style={{ justifyContent: "space-between", gap: 8 }}>
        <h2 className="h2">支払先（振込先口座）</h2>
        {ctx.canWrite && <button type="button" className="btn btn-sm" onClick={() => setEdit(blank)}>支払先を追加</button>}
      </div>
      {unlinked.length > 0 && ctx.canWrite && (
        <div className="row wrap" style={{ gap: 8, fontSize: 13 }}>
          <span className="muted">口座が未登録：</span>
          {unlinked.map((n) => <button key={n} type="button" className="pill" onClick={() => setEdit({ ...blank, name: n })}>{n}</button>)}
        </div>
      )}
      {ctx.payees.map((p) => (
        <div key={p.id} className="list-row" style={{ fontSize: 13 }}>
          <strong className="grow" style={{ flex: "1 1 200px" }}>{p.name}</strong>
          <span className="muted num">{p.name_kana ?? ""}</span>
          <span className="muted num">{p.bank_code ? `${p.bank_code}-${p.branch_code ?? "?"} ${p.account_type === "2" ? "当座" : "普通"} ***${(p.account_number ?? "").slice(-4)}` : "口座未登録"}</span>
          {ctx.canWrite && <button type="button" className="btn btn-sm" onClick={() => setEdit(p)}>編集</button>}
        </div>
      ))}
      {edit && (
        <form className="stack" style={{ gap: 12, padding: 14, background: "#F7F6F3", borderRadius: 12 }} onSubmit={save}>
          <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
            <label className="field"><span>支払先名</span><input className="inp" required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="field"><span>受取人名カナ</span><input className="inp" value={edit.name_kana ?? ""} onChange={(e) => setEdit({ ...edit, name_kana: e.target.value })} placeholder="ｻﾝﾌﾟﾙ(ｶ" /></label>
            <label className="field"><span>銀行コード</span><input className="inp num" maxLength={4} value={edit.bank_code ?? ""} onChange={(e) => setEdit({ ...edit, bank_code: e.target.value })} /></label>
            <label className="field"><span>銀行名カナ</span><input className="inp" value={edit.bank_kana ?? ""} onChange={(e) => setEdit({ ...edit, bank_kana: e.target.value })} /></label>
            <label className="field"><span>支店コード</span><input className="inp num" maxLength={3} value={edit.branch_code ?? ""} onChange={(e) => setEdit({ ...edit, branch_code: e.target.value })} /></label>
            <label className="field"><span>支店名カナ</span><input className="inp" value={edit.branch_kana ?? ""} onChange={(e) => setEdit({ ...edit, branch_kana: e.target.value })} /></label>
            <label className="field"><span>預金種目</span><select className="inp" value={edit.account_type ?? "1"} onChange={(e) => setEdit({ ...edit, account_type: e.target.value })}><option value="1">普通</option><option value="2">当座</option><option value="4">貯蓄</option></select></label>
            <label className="field"><span>口座番号</span><input className="inp num" maxLength={7} value={edit.account_number ?? ""} onChange={(e) => setEdit({ ...edit, account_number: e.target.value })} /></label>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-primary" type="submit">保存</button>
            <button className="btn" type="button" onClick={() => setEdit(null)}>キャンセル</button>
          </div>
        </form>
      )}
    </section>
  );
}

function MembersSection({ ctx, members, onChange }: { ctx: Ctx; members: Member[]; onChange: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await authedFetch("/api/invite", { email: email.trim(), role, companyId: ctx.company.id });
    setBusy(false);
    if (!r.ok) ctx.toast(r.error ?? "招待できませんでした", true); else { ctx.toast("招待メールを送りました：" + email); setEmail(""); onChange(); }
  }
  async function changeRole(uid: string, r: Role) {
    const { error } = await sb().from("memberships").update({ role: r }).eq("company_id", ctx.company.id).eq("user_id", uid);
    if (error) ctx.toast(error.message, true); else { ctx.toast("権限を変更しました"); onChange(); }
  }
  async function remove(uid: string, name: string) {
    if (!confirm(`${name} をこの会社から外しますか？`)) return;
    const { error } = await sb().from("memberships").delete().eq("company_id", ctx.company.id).eq("user_id", uid);
    if (error) ctx.toast(error.message, true); else { ctx.toast("メンバーから外しました"); onChange(); }
  }
  return (
    <section className="card pad stack" style={{ gap: 12 }}>
      <h2 className="h2">メンバーと権限</h2>
      <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.7 }}>オーナー：全操作・口座登録・メンバー管理 ／ 承認者：承認・FBデータ作成 ／ 担当者：書類登録・支払予定の作成 ／ 閲覧のみ：見るだけ。HRD管理者は全社を管理できます。</p>
      {members.map((m) => (
        <div key={m.user_id} className="list-row" style={{ fontSize: 13 }}>
          <strong style={{ minWidth: 140 }}>{m.name}</strong>
          <span className="muted grow">{m.email}</span>
          {ctx.isOwner && m.user_id !== ctx.userId ? (
            <>
              <select className="inp" style={{ width: 140, height: 36 }} value={m.role} onChange={(e) => changeRole(m.user_id, e.target.value as Role)} aria-label={`${m.name}の権限`}>
                {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(m.user_id, m.name)}>外す</button>
            </>
          ) : <span className="chip st-auto">{ROLE_LABEL[m.role]}</span>}
        </div>
      ))}
      {ctx.isOwner && (
        <form className="row wrap" style={{ gap: 10, alignItems: "flex-end" }} onSubmit={invite}>
          <label className="field" style={{ flex: "1 1 240px" }}><span>招待するメールアドレス</span><input className="inp" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="field" style={{ width: 160 }}><span>権限</span>
            <select className="inp" value={role} onChange={(e) => setRole(e.target.value as Role)}>{(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "送信中…" : "招待する"}</button>
        </form>
      )}
    </section>
  );
}

function MfSection({ ctx }: { ctx: Ctx }) {
  const [busy, setBusy] = useState(false);
  async function connect() {
    setBusy(true);
    const r = await authedFetch("/api/mf/connect", { companyId: ctx.company.id });
    setBusy(false);
    if (r.ok && r.url) window.location.href = r.url; else ctx.toast(r.error ?? "連携を開始できませんでした", true);
  }
  const st = ctx.mf?.status ?? "disconnected";
  return (
    <section className="card pad stack" style={{ gap: 12 }}>
      <h2 className="h2">マネーフォワード連携</h2>
      <div style={{ display: "grid", gridTemplateColumns: "160px minmax(0,1fr)", gap: "10px 14px", fontSize: 14 }}>
        <span className="muted">状態</span><span><span className={"chip " + (st === "connected" ? "st-ok" : st === "error" ? "st-err" : "st-auto")}>{st === "connected" ? "連携中" : st === "error" ? "エラー" : "未連携"}</span></span>
        <span className="muted">使う機能</span><span>クラウド会計（仕訳・証憑添付）／ クラウドBox（原本保管）／ カード明細の取得</span>
        <span className="muted">接続先</span><span>この会社が契約しているマネーフォワード クラウド</span>
      </div>
      {ctx.isOwner && <button type="button" className="btn btn-primary" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={connect}>{st === "connected" ? "連携し直す" : "マネーフォワードと連携する"}</button>}
    </section>
  );
}
