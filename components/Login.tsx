"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";

type Mode = "login" | "signup";
export type SignupKind = "client" | "accounting_firm";

const SIGNUP: Record<SignupKind, { title: string; lead: string }> = {
  client: { title: "企業", lead: "自社の資金繰りを管理" },
  accounting_firm: { title: "会計事務所", lead: "顧問先の資金繰りを管理" },
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
        ? "未登録のメールアドレスです"
        : /rate|seconds/i.test(error.message) ? "しばらく時間をおいてお試しください" : error.message);
    } else setSent(true);
  }

  const tabs = (
    <div className="row" role="tablist" aria-label="ログイン方法" style={{ gap: 6, background: "#F5F4F0", padding: 4, borderRadius: 12 }}>
      {(["login", "signup"] as Mode[]).map((m) => (
        <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setErr(""); if (m === "login") setKind(null); }}
          className="grow" style={{ minHeight: 40, border: 0, borderRadius: 9, fontSize: 14, fontWeight: 600, background: mode === m ? "#FFFFFF" : "transparent", color: mode === m ? "#17191E" : "#5B5F68", boxShadow: mode === m ? "0 1px 2px rgba(0,0,0,.08)" : "none" }}>
          {m === "login" ? "ログイン" : "新規登録"}
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
            <strong>{email}</strong> にリンクを送信しました。
          </p>
        ) : mode === "signup" && !kind ? (
          <>
            {tabs}
            <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))", gap: 12 }}>
              {(Object.keys(SIGNUP) as SignupKind[]).map((k) => (
                <button key={k} type="button" className="tile" onClick={() => setKind(k)} style={{ gap: 6, padding: 20 }}>
                  <strong style={{ fontSize: 16 }}>{SIGNUP[k].title}</strong>
                  <span className="muted" style={{ fontSize: 12 }}>{SIGNUP[k].lead}</span>
                </button>
              ))}
            </div>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>招待を受けた方は登録不要です</p>
          </>
        ) : (
          <>
            {tabs}
            {mode === "signup" && kind && (
              <div className="row" style={{ gap: 8, padding: "12px 14px", borderRadius: 12, background: "#F5F4F0" }}>
                <strong className="grow" style={{ fontSize: 14 }}>{SIGNUP[kind].title}として登録</strong>
                <span className="muted" style={{ fontSize: 12 }}>30日間無料</span>
                <button type="button" onClick={() => setKind(null)} style={{ border: 0, background: "none", color: "#2440D8", fontSize: 12, textDecoration: "underline", padding: 0 }}>変更</button>
              </div>
            )}
            <label className="field">
              <span>メールアドレス</span>
              <input className="inp" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? "送信中…" : "リンクを送信"}
            </button>
          </>
        )}
        {err && <p role="alert" style={{ color: "#9B1C1C", margin: 0, fontSize: 13 }}>{err}</p>}
      </form>
    </div>
  );
}
