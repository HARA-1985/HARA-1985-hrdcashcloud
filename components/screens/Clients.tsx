"use client";
import { useState } from "react";
import type { Ctx } from "../ctx";
import { sb } from "@/lib/supabase";
import { authedPost } from "@/lib/authed";

/** 会計事務所：顧問先の登録・一覧・事務所コード／企業：顧問の会計事務所とつながる */
export default function Clients({ ctx }: { ctx: Ctx }) {
  return ctx.company.kind === "client" ? <MyFirms ctx={ctx} /> : <FirmClients ctx={ctx} />;
}

function FirmClients({ ctx }: { ctx: Ctx }) {
  const [name, setName] = useState("");
  const [kana, setKana] = useState("");
  const [busy, setBusy] = useState(false);
  const firmId = ctx.company.id;
  const isFirm = ctx.company.kind === "accounting_firm";
  const links = ctx.firmClients.filter((f) => f.firm_id === firmId && f.status === "active");
  const nameOf = (id: string) => ctx.companies.find((c) => c.id === id)?.name ?? "—";

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await sb().rpc("firm_create_client", { p_firm: firmId, p_name: name.trim(), p_kana: kana.trim() || null });
    if (error) { setBusy(false); ctx.toast(error.message, true); return; }
    if (isFirm) await authedPost("/api/billing/sync-clients", { firmId });
    setBusy(false);
    setName(""); setKana("");
    ctx.toast("顧問先を登録しました");
    await ctx.reloadOrg();
  }

  async function unlink(companyId: string) {
    if (!window.confirm(`「${nameOf(companyId)}」との顧問関係を解除します。事務所のメンバーはこの会社を見られなくなります。よろしいですか？`)) return;
    const { error } = await sb().rpc("unlink_firm_client", { p_firm: firmId, p_company: companyId });
    if (error) { ctx.toast(error.message, true); return; }
    if (isFirm) await authedPost("/api/billing/sync-clients", { firmId });
    ctx.toast("顧問関係を解除しました");
    await ctx.reloadOrg();
  }

  async function rotate() {
    if (!window.confirm("事務所コードを作り直します。古いコードは使えなくなります。よろしいですか？")) return;
    const { error } = await sb().rpc("firm_rotate_code", { p_firm: firmId });
    if (error) ctx.toast(error.message, true); else { ctx.toast("事務所コードを作り直しました"); await ctx.reloadOrg(); }
  }

  async function copy(code: string) {
    try { await navigator.clipboard.writeText(code); ctx.toast("事務所コードをコピーしました"); } catch { ctx.toast("コピーできませんでした", true); }
  }

  const canAdd = ctx.isOwner || ctx.canApprove;

  return (
    <div className="stack" style={{ gap: 20 }}>
      {ctx.company.firm_code && (
        <section className="card pad stack" style={{ gap: 12 }}>
          <h2 className="h2">事務所コード</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
            すでにHRD資金繰りクラウドを使っている企業にこのコードを伝えると、企業側の「顧問の会計事務所」画面から、この事務所の顧問先としてつながります。
          </p>
          <div className="row wrap" style={{ gap: 10 }}>
            <code className="num" style={{ fontSize: 22, fontWeight: 700, letterSpacing: ".12em", padding: "8px 16px", borderRadius: 10, background: "#F5F4F0" }}>{ctx.company.firm_code}</code>
            <button type="button" className="btn" onClick={() => copy(ctx.company.firm_code!)}>コピー</button>
            {ctx.isOwner && <button type="button" className="btn btn-ghost" onClick={rotate}>コードを作り直す</button>}
          </div>
        </section>
      )}

      {canAdd && (
        <form className="card pad stack" style={{ gap: 14 }} onSubmit={add}>
          <h2 className="h2">顧問先を登録</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
            {isFirm ? "登録した顧問先は、事務所のご契約でご利用いただけます（顧問先1社ごとに月額が加算されます）。" : "HRDの顧問先として登録します。"}
            登録後、顧問先を開いて「設定」からご担当者を招待できます。
          </p>
          <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
            <label className="field" style={{ flex: "2 1 240px" }}><span>会社名</span><input className="inp" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="株式会社サンプル" /></label>
            <label className="field" style={{ flex: "1 1 180px" }}><span>フリガナ（任意）</span><input className="inp" maxLength={200} value={kana} onChange={(e) => setKana(e.target.value)} placeholder="ｻﾝﾌﾟﾙ(ｶ" /></label>
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? "登録中…" : "登録する"}</button>
          </div>
        </form>
      )}

      <section className="card scroll-x">
        <div className="row" style={{ padding: "18px 22px 8px", gap: 10 }}>
          <h2 className="h2 grow">顧問先一覧</h2>
          <span className="muted num" style={{ fontSize: 13 }}>{links.length}社</span>
        </div>
        {links.length === 0 ? <div className="empty">まだ顧問先はありません。上のフォームから登録するか、事務所コードを顧問先に伝えてください。</div> : (
          <table className="tbl">
            <thead><tr><th>会社名</th><th>登録日</th><th className="r">操作</th></tr></thead>
            <tbody>{links.map((l) => (
              <tr key={l.company_id}>
                <td><strong>{nameOf(l.company_id)}</strong></td>
                <td className="num nw">{l.created_at ? new Date(l.created_at).toLocaleDateString("ja-JP") : "—"}</td>
                <td className="r nw">
                  <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                    <button type="button" className="btn btn-sm" onClick={() => ctx.selectCompany(l.company_id)}>開く</button>
                    {ctx.isOwner && <button type="button" className="btn btn-sm btn-ghost" onClick={() => unlink(l.company_id)}>解除</button>}
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

function MyFirms({ ctx }: { ctx: Ctx }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const companyId = ctx.company.id;
  const links = ctx.firmClients.filter((f) => f.company_id === companyId && f.status === "active");
  const nameOf = (id: string) => ctx.companies.find((c) => c.id === id)?.name ?? "顧問の会計事務所";

  async function link(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { data, error } = await sb().rpc("company_link_firm", { p_company: companyId, p_firm_code: code.trim() });
    if (!error && data) await authedPost("/api/billing/sync-clients", { firmId: data as string });
    setBusy(false);
    if (error) { ctx.toast(error.message, true); return; }
    setCode("");
    ctx.toast("会計事務所とつながりました");
    await ctx.reloadOrg();
  }

  async function unlink(firmId: string) {
    if (!window.confirm(`「${nameOf(firmId)}」との顧問関係を解除します。事務所の方はこの会社を見られなくなります。よろしいですか？`)) return;
    const { error } = await sb().rpc("unlink_firm_client", { p_firm: firmId, p_company: companyId });
    if (error) { ctx.toast(error.message, true); return; }
    await authedPost("/api/billing/sync-clients", { firmId });
    ctx.toast("顧問関係を解除しました");
    await ctx.reloadOrg();
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="card scroll-x">
        <div style={{ padding: "18px 22px 8px" }}><h2 className="h2">顧問の会計事務所</h2></div>
        {links.length === 0 ? <div className="empty">つながっている会計事務所はありません。</div> : (
          <table className="tbl">
            <thead><tr><th>事務所名</th><th className="r">操作</th></tr></thead>
            <tbody>{links.map((l) => (
              <tr key={l.firm_id}>
                <td><strong>{nameOf(l.firm_id)}</strong></td>
                <td className="r">{ctx.isOwner && <button type="button" className="btn btn-sm btn-ghost" onClick={() => unlink(l.firm_id)}>解除</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      {ctx.isOwner && (
        <form className="card pad stack" style={{ gap: 14 }} onSubmit={link}>
          <h2 className="h2">事務所コードでつながる</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
            顧問の会計事務所から受け取った事務所コードを入力してください。つながると、事務所の方がこの会社の資金繰りを確認・サポートできるようになり、事務所のご契約でご利用いただけます。
          </p>
          <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
            <label className="field" style={{ flex: "1 1 220px" }}><span>事務所コード（10桁）</span><input className="inp num" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="例：A1B2C3D4E5" maxLength={20} /></label>
            <button type="submit" className="btn btn-primary" disabled={busy || code.trim().length < 6}>{busy ? "確認中…" : "つながる"}</button>
          </div>
        </form>
      )}
    </div>
  );
}
