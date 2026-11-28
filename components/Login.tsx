"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";

type Mode = "login" | "signup";

export default function Login() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // LP の「1か月無料で始める」から来たとき（/?signup=1）は新規登録を開く
  useEffect(() => {
    if (new URL(window.location.href).searchParams.get("signup")) setMode("signup");
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const { error } = await sb().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin, shouldCreateUser: mode === "signup" },
    });
    setBusy(false);
    if (error) {
      setErr(mode === "login" && /signups? not allowed|not found/i.test(error.message)
        ? "このメールアドレスはまだ登録されていません。「新規登録」からお進みください。"
        : error.message);
    } else setSent(true);
  }

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <div className="row" style={{ gap: 10 }}>
          <div className="logo" style={{ color: "#fff" }}>HRD</div>
          <div className="stack" style={{ gap: 2 }}>
            <strong style={{ fontSize: 16 }}>HRD資金繰りクラウド</strong>
            <span className="muted" style={{ fontSize: 12 }}>HRD総合事務所</span>
          </div>
        </div>

        {!sent && (
          <div className="row" role="tablist" aria-label="ログイン方法" style={{ gap: 6, background: "#F5F4F0", padding: 4, borderRadius: 12 }}>
            {(["login", "signup"] as Mode[]).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setErr(""); }}
                className="grow" style={{ minHeight: 40, border: 0, borderRadius: 9, fontSize: 14, fontWeight: 600, background: mode === m ? "#FFFFFF" : "transparent", color: mode === m ? "#17191E" : "#5B5F68", boxShadow: mode === m ? "0 1px 2px rgba(0,0,0,.08)" : "none" }}>
                {m === "login" ? "ログイン" : "新規登録（1か月無料）"}
              </button>
            ))}
          </div>
        )}

        {sent ? (
          <p style={{ lineHeight: 1.8, margin: 0 }}>
            <strong>{email}</strong> に{mode === "signup" ? "登録" : "ログイン"}用のリンクを送りました。メールのリンクを開くと{mode === "signup" ? "登録の続きに進めます" : "ログインできます"}。
          </p>
        ) : (
          <>
            {mode === "signup" && (
              <div className="stack" style={{ gap: 6, padding: 14, borderRadius: 12, background: "#EAEDFC" }}>
                <strong style={{ fontSize: 14, color: "#2236B8" }}>登録から30日間は無料</strong>
                <span style={{ fontSize: 12, lineHeight: 1.7, color: "#24272E" }}>メールアドレスだけで始められます。無料期間のあとは、プランのお申し込みで引き続きご利用いただけます。</span>
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
