"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";

type Mode = "login" | "signup";
export type SignupKind = "client" | "accounting_firm";

const SIGNUP: Record<SignupKind, { title: string; lead: string; points: string[] }> = {
  client: {
    title: "企業（クライアント）として登録",
    lead: "自社の支払予定・請求書・振込データを管理します。",
    points: ["自社のマネーフォワード クラウドとつなげる", "顧問の会計事務所とあとからつながれる", "30日間すべての機能を無料で利用"],
  },
  accounting_firm: {
    title: "会計事務所として登録",
    lead: "顧問先ごとの資金繰りをまとめて管理します。",
    points: ["顧問先を登録・招待して一覧で管理", "事務所コードで既存ユーザーとつながる", "30日間すべての機能を無料で利用"],
  },
};

/** URL の ?signup= から初期状態を決める（LP の導線用：client / firm / 1） */
function fromUrl(): { mode: Mode; kind: SignupKind | null } {
  const v = new URL(window.location.href).searchParams.get("signup");
  if (!v) return { mode: "login", kind: null };
  if (v === "client") return { mode: "signup", kind: "client" };
  if (v === "firm" || v === "accounting_firm") return { mode: "signup", kind: "accounting_firm" };
  return { mode: "signup", kind: null };
}

export default function Login() {
  const [mode, setMode] = useState<Mode>("login");
  const [kind, setKind] = useState<SignupKind | null>(null);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { const s = fromUrl(); setMode(s.mode); setKind(s.kind); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const { error } = await sb().auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: window.location.origin,
        shouldCreateUser: mode === "signup",
        // 登録の種類を引き継ぎ、ログイン後の初期登録で使う
        ...(mode === "signup" && kind ? { data: { signup_kind: kind } } : {}),
      },
    });
    setBusy(false);
    if (error) {
      setErr(mode === "login" && /signups? not allowed|not found|otp_disabled/i.test(error.message)
        ? "このメールアドレスはまだ登録されていません。「新規登録」からお進みください。"
        : /rate|seconds/i.test(error.message) ? "送信が続いたため、しばらく時間をおいてからお試しください。" : error.message);
    } else setSent(true);
  }

  const tabs = (
    <div className="row" role="tablist" aria-label="ログイン方法" style={{ gap: 6, background: "#F5F4F0", padding: 4, borderRadius: 12 }}>
      {(["login", "signup"] as Mode[]).map((m) => (
        <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setErr(""); if (m === "login") setKind(null); }}
          className="grow" style={{ minHeight: 40, border: 0, borderRadius: 9, fontSize: 14, fontWeight: 600, background: mode === m ? "#FFFFFF" : "transparent", color: mode === m ? "#17191E" : "#5B5F68", boxShadow: mode === m ? "0 1px 2px rgba(0,0,0,.08)" : "none" }}>
          {m === "login" ? "ログイン" : "新規登録（1か月無料）"}
        </button>
      ))}
    </div>
  );

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit} style={{ maxWidth: mode === "signup" && !kind ? 560 : 420 }}>
        <div className="row" style={{ gap: 10 }}>
          <div className="logo" style={{ color: "#fff" }}>HRD</div>
          <div className="stack" style={{ gap: 2 }}>
            <strong style={{ fontSize: 16 }}>HRD資金繰りクラウド</strong>
            <span className="muted" style={{ fontSize: 12 }}>HRD総合事務所</span>
          </div>
        </div>

        {sent ? (
          <p style={{ lineHeight: 1.8, margin: 0 }}>
            <strong>{email}</strong> に{mode === "signup" ? "登録" : "ログイン"}用のリンクを送りました。メールのリンクを開くと{mode === "signup" ? "登録の続きに進めます" : "ログインできます"}。
            <br /><span className="muted" style={{ fontSize: 12 }}>リンクの有効期限は1時間です。届かない場合は迷惑メールフォルダもご確認ください。</span>
          </p>
        ) : mode === "signup" && !kind ? (
          <>
            {tabs}
            <div className="stack" style={{ gap: 6 }}>
              <strong style={{ fontSize: 15 }}>どちらとして登録しますか？</strong>
              <span className="muted" style={{ fontSize: 12 }}>登録の種類によって、使える機能と初期設定が変わります。</span>
            </div>
            <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))", gap: 12 }}>
              {(Object.keys(SIGNUP) as SignupKind[]).map((k) => (
                <button key={k} type="button" className="tile" onClick={() => setKind(k)} style={{ gap: 10, padding: 18 }}>
                  <span className="chip" style={{ background: k === "client" ? "#FBEDE2" : "#EAEDFC", color: k === "client" ? "#9A420A" : "#2236B8" }}>{k === "client" ? "クライアント" : "会計事務所"}</span>
                  <strong style={{ fontSize: 15 }}>{SIGNUP[k].title}</strong>
                  <span className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>{SIGNUP[k].lead}</span>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.8, color: "#24272E" }}>
                    {SIGNUP[k].points.map((p) => <li key={p}>{p}</li>)}
                  </ul>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#2440D8" }}>この内容で登録する →</span>
                </button>
              ))}
            </div>
            <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.7 }}>会計事務所から招待メールが届いている方は、登録は不要です。招待メールのリンクからログインしてください。</p>
          </>
        ) : (
          <>
            {tabs}
            {mode === "signup" && kind && (
              <div className="stack" style={{ gap: 6, padding: 14, borderRadius: 12, background: kind === "client" ? "#FFF8F3" : "#EAEDFC" }}>
                <div className="row" style={{ gap: 8 }}>
                  <strong className="grow" style={{ fontSize: 14, color: kind === "client" ? "#9A420A" : "#2236B8" }}>{SIGNUP[kind].title}</strong>
                  <button type="button" onClick={() => setKind(null)} style={{ border: 0, background: "none", color: "#2440D8", fontSize: 12, textDecoration: "underline", padding: 0 }}>変更</button>
                </div>
                <span style={{ fontSize: 12, lineHeight: 1.7, color: "#24272E" }}>登録から30日間は無料です。無料期間のあとは、プランのお申し込みで引き続きご利用いただけます。</span>
              </div>
            )}
            <label className="field">
              <span>メールアドレス</span>
              <input className="inp" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? "送信中…" : mode === "signup" ? "登録用のリンクを送る" : "ログインリンクを送る"}
            </button>
            <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.7 }}>パスワードは使いません。届いたメールのリンクから{mode === "signup" ? "登録" : "ログイン"}します。</p>
          </>
        )}
        {err && <p role="alert" style={{ color: "#9B1C1C", margin: 0, fontSize: 13 }}>{err}</p>}
      </form>
    </div>
  );
}
