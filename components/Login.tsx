"use client";
import { useState } from "react";
import { sb } from "@/lib/supabase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const { error } = await sb().auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: window.location.origin } });
    setBusy(false);
    if (error) setErr(error.message); else setSent(true);
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
        {sent ? (
          <p style={{ lineHeight: 1.8, margin: 0 }}>
            <strong>{email}</strong> にログイン用のリンクを送りました。メールのリンクを開くとログインできます。
          </p>
        ) : (
          <>
            <label className="field">
              <span>メールアドレス</span>
              <input className="inp" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "送信中…" : "ログインリンクを送る"}</button>
            <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.7 }}>パスワードは使いません。届いたメールのリンクからログインします。</p>
          </>
        )}
        {err && <p role="alert" style={{ color: "#9B1C1C", margin: 0, fontSize: 13 }}>{err}</p>}
      </form>
    </div>
  );
}
