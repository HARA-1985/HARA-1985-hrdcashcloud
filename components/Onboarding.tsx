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
    let msg = "登録しました";
    if (kind === "client" && code.trim()) {
      const r = await sb().rpc("company_link_firm", { p_company: id, p_firm_code: code.trim() });
      if (r.error) msg = `登録しました（事務所コード：${r.error.message}）`;
    }
    setBusy(false);
    onDone(id, msg);
  }

  if (!kind) {
    return (
      <div className="login-wrap">
        <div className="login" style={{ maxWidth: 560 }}>
          <div className="stack" style={{ gap: 6 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700 }}>登録の種類</h1>
          </div>
          <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))", gap: 12 }}>
            <button type="button" className="tile" onClick={() => setKind("client")} style={{ padding: 18 }}>
              <strong style={{ fontSize: 15 }}>企業</strong>
            </button>
            <button type="button" className="tile" onClick={() => setKind("accounting_firm")} style={{ padding: 18 }}>
              <strong style={{ fontSize: 15 }}>会計事務所</strong>
            </button>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onSignOut}>ログアウト</button>
        </div>
      </div>
    );
  }

  const isClient = kind === "client";

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit} style={{ maxWidth: 560 }}>
        <div className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="chip" style={{ background: isClient ? "#FBEDE2" : "#EAEDFC", color: isClient ? "#9A420A" : "#2236B8" }}>{isClient ? "企業" : "会計事務所"}</span>
            {!initialKind && <button type="button" onClick={() => setKind(null)} style={{ border: 0, background: "none", color: "#2440D8", fontSize: 12, textDecoration: "underline", padding: 0 }}>変更</button>}
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>{isClient ? "会社情報" : "事務所情報"}</h1>
        </div>

        <label className="field">
          <span>{isClient ? "会社名" : "事務所名"}</span>
          <input className="inp" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder={isClient ? "株式会社サンプル" : "サンプル会計事務所"} />
        </label>
        <label className="field">
          <span>フリガナ（任意）</span>
          <input className="inp" maxLength={200} value={kana} onChange={(e) => setKana(e.target.value)} placeholder="ｻﾝﾌﾟﾙ(ｶ" />
        </label>
        {isClient && (
          <label className="field">
            <span>会計事務所の事務所コード（任意）</span>
            <input className="inp num" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="例：A1B2C3D4E5" maxLength={20} />
          </label>
        )}

        <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>{busy ? "登録中…" : "無料で始める"}</button>
        {err && <p role="alert" style={{ color: "#9B1C1C", margin: 0, fontSize: 13 }}>{err}</p>}
        <button type="button" className="btn btn-ghost" onClick={onSignOut}>ログアウト</button>
      </form>
    </div>
  );
}
