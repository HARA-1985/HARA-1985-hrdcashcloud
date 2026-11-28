"use client";
import { useState } from "react";
import { sb } from "@/lib/supabase";
import type { SignupKind } from "./Login";

/** ログイン後、まだ会社がない人の初期登録（30日無料が始まる）。登録の種類ごとに導線を分ける */
export default function Onboarding({ initialKind, onDone, onSignOut }: {
  initialKind: SignupKind | null;
  onDone: (companyId: string, message: string) => void;
  onSignOut: () => void;
}) {
  const [kind, setKind] = useState<SignupKind | null>(initialKind);
  const [name, setName] = useState("");
  const [kana, setKana] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!kind) return;
    setBusy(true); setErr("");
    const { data, error } = await sb().rpc("register_account", { p_kind: kind, p_name: name.trim(), p_kana: kana.trim() || null });
    if (error) { setBusy(false); setErr(error.message); return; }
    const id = data as string;
    let msg = kind === "client" ? "登録しました。30日間無料でお使いいただけます" : "会計事務所として登録しました。「顧問先」から顧問先を登録できます";
    if (kind === "client" && code.trim()) {
      const r = await sb().rpc("company_link_firm", { p_company: id, p_firm_code: code.trim() });
      msg = r.error ? `登録しました（事務所コードは確認できませんでした：${r.error.message}）` : "登録し、顧問の会計事務所とつながりました";
    }
    setBusy(false);
    onDone(id, msg);
  }

  if (!kind) {
    return (
      <div className="login-wrap">
        <div className="login" style={{ maxWidth: 560 }}>
          <div className="stack" style={{ gap: 6 }}>
            <span className="lbl" style={{ color: "#2236B8" }}>はじめに</span>
            <h1 style={{ fontSize: 22, fontWeight: 700 }}>どちらとして登録しますか？</h1>
          </div>
          <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))", gap: 12 }}>
            <button type="button" className="tile" onClick={() => setKind("client")} style={{ padding: 18 }}>
              <strong style={{ fontSize: 15 }}>企業（クライアント）</strong>
              <span className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>自社の支払予定・請求書・振込データを管理します。</span>
            </button>
            <button type="button" className="tile" onClick={() => setKind("accounting_firm")} style={{ padding: 18 }}>
              <strong style={{ fontSize: 15 }}>会計事務所</strong>
              <span className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>顧問先ごとの資金繰りをまとめて管理します。</span>
            </button>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onSignOut}>ログアウト</button>
        </div>
      </div>
    );
  }

  const isClient = kind === "client";
  const steps = isClient
    ? ["会社情報の登録（いまここ）", "振込元口座・支払先の登録", "マネーフォワード クラウドとの連携", "請求書を置いて支払予定を作成"]
    : ["事務所情報の登録（いまここ）", "顧問先の登録・招待", "事務所のスタッフを招待", "顧問先ごとに資金繰りを確認"];

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit} style={{ maxWidth: 560 }}>
        <div className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="chip" style={{ background: isClient ? "#FBEDE2" : "#EAEDFC", color: isClient ? "#9A420A" : "#2236B8" }}>{isClient ? "企業（クライアント）" : "会計事務所"}</span>
            {!initialKind && <button type="button" onClick={() => setKind(null)} style={{ border: 0, background: "none", color: "#2440D8", fontSize: 12, textDecoration: "underline", padding: 0 }}>種類を変更</button>}
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>{isClient ? "会社の情報を登録" : "事務所の情報を登録"}</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>登録した日から30日間、すべての機能を無料でお使いいただけます。</p>
        </div>

        <ol className="stack" style={{ gap: 4, margin: 0, paddingLeft: 20, fontSize: 12, lineHeight: 1.8, color: "#4A4E57" }}>
          {steps.map((s, i) => <li key={s} style={{ fontWeight: i === 0 ? 700 : 400, color: i === 0 ? "#17191E" : undefined }}>{s}</li>)}
        </ol>

        <label className="field">
          <span>{isClient ? "会社名" : "事務所名"}</span>
          <input className="inp" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder={isClient ? "株式会社サンプル" : "サンプル会計事務所"} />
        </label>
        <label className="field">
          <span>フリガナ（任意{isClient ? "・振込データの依頼人名に使います" : ""}）</span>
          <input className="inp" maxLength={200} value={kana} onChange={(e) => setKana(e.target.value)} placeholder="ｻﾝﾌﾟﾙ(ｶ" />
        </label>
        {isClient && (
          <label className="field">
            <span>顧問の会計事務所の事務所コード（任意・あとからでも設定できます）</span>
            <input className="inp num" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="例：A1B2C3D4E5" maxLength={20} />
          </label>
        )}

        <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>{busy ? "登録中…" : "30日間の無料利用を始める"}</button>
        {err && <p role="alert" style={{ color: "#9B1C1C", margin: 0, fontSize: 13 }}>{err}</p>}
        <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.7 }}>
          招待を受けた方は、この登録は不要です。{" "}
          <button type="button" onClick={onSignOut} style={{ border: 0, background: "none", color: "#2440D8", padding: 0, fontSize: 12, textDecoration: "underline" }}>ログアウト</button>
        </p>
      </form>
    </div>
  );
}
