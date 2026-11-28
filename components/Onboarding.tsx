"use client";
import { useState } from "react";
import { sb } from "@/lib/supabase";

type Kind = "client" | "accounting_firm";

const KINDS: { k: Kind; title: string; body: string }[] = [
  { k: "client", title: "企業として使う", body: "自社の支払予定・請求書・振込データを管理します。自社のマネーフォワード クラウドとつなげます。" },
  { k: "accounting_firm", title: "会計事務所として使う", body: "顧問先を登録して、顧問先ごとの資金繰りをまとめて管理します。" },
];

/** ログイン後、まだ会社がない人の初期登録（30日無料が始まる） */
export default function Onboarding({ onDone, onSignOut }: { onDone: (companyId: string) => void; onSignOut: () => void }) {
  const [kind, setKind] = useState<Kind>("client");
  const [name, setName] = useState("");
  const [kana, setKana] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const { data, error } = await sb().rpc("register_account", { p_kind: kind, p_name: name.trim(), p_kana: kana.trim() || null });
    setBusy(false);
    if (error) setErr(error.message); else onDone(data as string);
  }

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit} style={{ maxWidth: 520 }}>
        <div className="stack" style={{ gap: 6 }}>
          <span className="lbl" style={{ color: "#2236B8" }}>はじめに（1分で完了）</span>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>ご利用の形を選んでください</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>登録した日から30日間、すべての機能を無料でお使いいただけます。</p>
        </div>

        <fieldset className="stack" style={{ gap: 10, border: 0, padding: 0, margin: 0 }}>
          <legend className="sr">利用の形</legend>
          {KINDS.map((x) => (
            <label key={x.k} className={"tile" + (kind === x.k ? " is-on" : "")} style={{ cursor: "pointer" }}>
              <span className="row" style={{ gap: 10 }}>
                <input type="radio" name="kind" value={x.k} checked={kind === x.k} onChange={() => setKind(x.k)} />
                <strong style={{ fontSize: 15 }}>{x.title}</strong>
              </span>
              <span className="muted" style={{ fontSize: 12, lineHeight: 1.7, paddingLeft: 26 }}>{x.body}</span>
            </label>
          ))}
        </fieldset>

        <label className="field">
          <span>{kind === "client" ? "会社名" : "事務所名"}</span>
          <input className="inp" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "client" ? "株式会社サンプル" : "サンプル会計事務所"} />
        </label>
        <label className="field">
          <span>フリガナ（任意・振込データの依頼人名に使います）</span>
          <input className="inp" maxLength={200} value={kana} onChange={(e) => setKana(e.target.value)} placeholder="ｻﾝﾌﾟﾙ(ｶ" />
        </label>

        <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>{busy ? "登録中…" : "30日間の無料利用を始める"}</button>
        {err && <p role="alert" style={{ color: "#9B1C1C", margin: 0, fontSize: 13 }}>{err}</p>}
        <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.7 }}>
          会計事務所から招待を受けた方は、この登録は不要です。招待メールのリンクからログインしてください。{" "}
          <button type="button" className="btn-ghost" onClick={onSignOut} style={{ border: 0, background: "none", color: "#2440D8", padding: 0, fontSize: 12, textDecoration: "underline" }}>ログアウト</button>
        </p>
      </form>
    </div>
  );
}
