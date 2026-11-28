"use client";
import { useCallback, useEffect, useState } from "react";
import { sb } from "@/lib/supabase";

/** ログイン後、2段階認証を設定している人に確認コードを求める画面 */
export function MfaChallenge({ onVerified, onSignOut }: { onVerified: () => void; onSignOut: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const { data } = await sb().auth.mfa.listFactors();
    const factor = data?.totp?.find((f) => f.status === "verified");
    if (!factor) { setBusy(false); onVerified(); return; }
    const { error } = await sb().auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
    setBusy(false);
    if (error) setErr("コードが正しくありません");
    else onVerified();
  }

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <div className="stack" style={{ gap: 6 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>2段階認証</h1>
        </div>
        <label className="field">
          <span>認証アプリの6桁コード</span>
          <input className="inp num" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus
            value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ fontSize: 22, letterSpacing: ".3em", textAlign: "center" }} />
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy || code.length !== 6}>{busy ? "確認中…" : "確認"}</button>
        {err && <p role="alert" style={{ color: "#9B1C1C", margin: 0, fontSize: 13 }}>{err}</p>}
        <button type="button" className="btn btn-ghost" onClick={onSignOut}>ログアウト</button>
      </form>
    </div>
  );
}

/** 設定画面：2段階認証の設定・解除 */
export function MfaSettings({ toast, required }: { toast: (m: string, err?: boolean) => void; required?: boolean }) {
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await sb().auth.mfa.listFactors();
    setFactorId(data?.totp?.find((f) => f.status === "verified")?.id ?? null);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function start() {
    setBusy(true);
    // 途中でやめた未確認の設定が残っていれば消してからやり直す
    const { data: list } = await sb().auth.mfa.listFactors();
    for (const f of list?.all ?? []) if (f.status !== "verified") await sb().auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await sb().auth.mfa.enroll({ factorType: "totp", friendlyName: "HRD資金繰りクラウド" });
    setBusy(false);
    if (error || !data) { toast("2段階認証を開始できませんでした：" + (error?.message ?? ""), true); return; }
    setEnrolling({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!enrolling) return;
    setBusy(true);
    const { error } = await sb().auth.mfa.challengeAndVerify({ factorId: enrolling.id, code: code.trim() });
    setBusy(false);
    if (error) { toast("確認コードが正しくありません", true); return; }
    setEnrolling(null); setCode("");
    toast("設定しました");
    load();
  }

  async function remove() {
    if (!factorId || !window.confirm("2段階認証を解除しますか？")) return;
    const { error } = await sb().auth.mfa.unenroll({ factorId });
    if (error) toast("解除できませんでした：" + error.message, true);
    else { toast("解除しました"); load(); }
  }

  return (
    <section className="card pad stack" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 10 }}>
        <h2 className="h2 grow">2段階認証</h2>
        <span className={"chip " + (factorId ? "st-ok" : "st-wait")}>{factorId ? "設定済み" : "未設定"}</span>
      </div>
      {required && !factorId && <p style={{ margin: 0, fontSize: 13, color: "#9A420A" }}>管理者アカウントは設定を推奨します</p>}
      {!enrolling && (
        <div className="row" style={{ gap: 8 }}>
          {factorId
            ? <button type="button" className="btn" onClick={remove}>解除</button>
            : <button type="button" className="btn btn-primary" disabled={busy} onClick={start}>設定</button>}
        </div>
      )}
      {enrolling && (
        <form className="stack" style={{ gap: 12 }} onSubmit={verify}>
          <span style={{ fontSize: 13 }}>認証アプリでQRコードを読み取り、表示された6桁を入力</span>
          <div className="row wrap" style={{ gap: 16, alignItems: "flex-start" }}>
            {/* Supabase が返す QR コード（SVG のデータURL） */}
            <img src={enrolling.qr} alt="2段階認証の設定用QRコード" width={180} height={180} style={{ border: "1px solid #E4E2DC", borderRadius: 12, background: "#fff" }} />
            <div className="stack" style={{ gap: 6, minWidth: 0 }}>
              <span className="lbl">キー</span>
              <code className="num" style={{ fontSize: 13, wordBreak: "break-all", padding: "6px 10px", borderRadius: 8, background: "#F5F4F0" }}>{enrolling.secret}</code>
            </div>
          </div>
          <div className="row wrap" style={{ gap: 10, alignItems: "flex-end" }}>
            <label className="field" style={{ flex: "0 1 200px" }}>
              <span>6桁コード</span>
              <input className="inp num" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>完了</button>
            <button type="button" className="btn btn-ghost" onClick={async () => { await sb().auth.mfa.unenroll({ factorId: enrolling.id }); setEnrolling(null); }}>やめる</button>
          </div>
        </form>
      )}
    </section>
  );
}
