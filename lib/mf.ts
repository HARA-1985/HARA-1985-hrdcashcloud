import "server-only";
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * マネーフォワード クラウド API 連携（サーバー専用）
 * - 認可：OAuth 2.0 認可コードフロー（state＋PKCE）。認可サーバー https://api.biz.moneyforward.com
 * - トークン：Supabase Vault に暗号化保存（service_role の関数経由でのみ読み書き）
 * - リフレッシュトークンは1回限り有効 → ロックを取ってから更新し、新しいトークンを即保存
 */

export const MF_AUTH_BASE = "https://api.biz.moneyforward.com";
export const MF_ACCOUNTING_BASE = process.env.MF_ACCOUNTING_BASE || "https://api-accounting.moneyforward.com/api/v3";
const DEFAULT_SCOPES = "mfc/accounting/journal.read mfc/accounting/journal.write mfc/accounting/accounts.read";

export function mfConfig() {
  const clientId = process.env.MF_CLIENT_ID;
  const clientSecret = process.env.MF_CLIENT_SECRET;
  const origin = (process.env.APP_ORIGIN || "https://studio.cpa-hara.com").replace(/\/+$/, "");
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    clientAuth: (process.env.MF_CLIENT_AUTH || "basic").toLowerCase() === "post" ? "post" : "basic",
    scopes: process.env.MF_SCOPES || DEFAULT_SCOPES,
    redirectUri: `${origin}/api/mf/callback`,
    origin,
  } as const;
}
export type MfConfig = NonNullable<ReturnType<typeof mfConfig>>;

/* ---------- state Cookie（改ざん防止の署名付き・10分で失効） ---------- */
const STATE_COOKIE = "mf_oauth";
function stateKey(cfg: MfConfig) {
  return crypto.createHmac("sha256", cfg.clientSecret).update("hrd-cash-cloud/mf-state/v1").digest();
}
const b64u = (b: Buffer) => b.toString("base64url");

export interface OAuthState { s: string; c: string; u: string; v: string; e: number }

export function newOAuthState(cfg: MfConfig, companyId: string, userId: string) {
  const s = b64u(crypto.randomBytes(24));
  const v = b64u(crypto.randomBytes(48)); // PKCE code_verifier
  const challenge = b64u(crypto.createHash("sha256").update(v).digest());
  const payload: OAuthState = { s, c: companyId, u: userId, v, e: Date.now() + 10 * 60 * 1000 };
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = b64u(crypto.createHmac("sha256", stateKey(cfg)).update(body).digest());
  const cookie = `${STATE_COOKIE}=${body}.${sig}; Path=/api/mf; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
  const url = new URL(`${MF_AUTH_BASE}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("scope", cfg.scopes);
  url.searchParams.set("state", s);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), cookie };
}

export function readOAuthState(cfg: MfConfig, cookieHeader: string | null, stateParam: string | null): OAuthState | null {
  if (!cookieHeader || !stateParam) return null;
  const raw = cookieHeader.split(/;\s*/).find((c) => c.startsWith(STATE_COOKIE + "="))?.slice(STATE_COOKIE.length + 1);
  if (!raw) return null;
  const [body, sig] = raw.split(".");
  if (!body || !sig) return null;
  const expect = crypto.createHmac("sha256", stateKey(cfg)).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return null;
  const st = JSON.parse(Buffer.from(body, "base64url").toString()) as OAuthState;
  if (st.e < Date.now()) return null;
  const a = Buffer.from(st.s), b = Buffer.from(stateParam);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return st;
}
export const clearStateCookie = `${STATE_COOKIE}=; Path=/api/mf; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

/* ---------- トークン ---------- */
interface TokenResponse { access_token: string; refresh_token: string; expires_in?: number; scope?: string; token_type?: string }

async function tokenRequest(cfg: MfConfig, params: Record<string, string>, path = "/token"): Promise<Response> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (cfg.clientAuth === "basic") headers.Authorization = "Basic " + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  else { body.set("client_id", cfg.clientId); body.set("client_secret", cfg.clientSecret); }
  return fetch(`${MF_AUTH_BASE}${path}`, { method: "POST", headers, body, cache: "no-store" });
}

async function saveTokens(admin: SupabaseClient, companyId: string, t: TokenResponse, fallbackScope: string) {
  const expiresAt = new Date(Date.now() + Math.max(60, (t.expires_in ?? 3600) - 60) * 1000).toISOString();
  const { error } = await admin.rpc("mf_token_save", { cid: companyId, p_access: t.access_token, p_refresh: t.refresh_token, p_expires_at: expiresAt, p_scope: t.scope ?? fallbackScope });
  if (error) throw new Error("トークンの保存に失敗しました：" + error.message);
}

export async function exchangeCode(cfg: MfConfig, admin: SupabaseClient, companyId: string, code: string, verifier: string) {
  const res = await tokenRequest(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: verifier });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token || !j.refresh_token) throw new Error(`認可コードの交換に失敗しました（${res.status} ${j.error ?? ""}）`);
  await saveTokens(admin, companyId, j as TokenResponse, cfg.scopes);
}

/** 有効なアクセストークンを返す（期限切れならロックを取ってリフレッシュ） */
export async function getAccessToken(cfg: MfConfig, admin: SupabaseClient, companyId: string, force = false): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await admin.rpc("mf_token_get", { cid: companyId });
    if (error) throw new Error(error.message);
    const row = (data as { access_token: string | null; refresh_token: string | null; expires_at: string | null; scope: string | null }[])[0];
    if (!row?.refresh_token) throw new MfNotConnected();
    if (!force && row.access_token && row.expires_at && new Date(row.expires_at).getTime() > Date.now()) return row.access_token;
    const { data: locked } = await admin.rpc("mf_token_lock", { cid: companyId, seconds: 20 });
    if (!locked) { await new Promise((r) => setTimeout(r, 800)); force = false; continue; } // 他のリクエストが更新中
    const res = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: row.refresh_token });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      await admin.from("mf_connections").update({ status: "error", last_error: `トークン更新に失敗（${res.status} ${j.error ?? ""}）。連携し直してください。` }).eq("company_id", companyId);
      throw new Error("マネーフォワードの認証が切れました。設定から連携し直してください。");
    }
    await saveTokens(admin, companyId, { ...j, refresh_token: j.refresh_token ?? row.refresh_token }, row.scope ?? cfg.scopes);
    return j.access_token as string;
  }
  throw new Error("トークンの更新が混み合っています。少し待ってから再度お試しください。");
}

export class MfNotConnected extends Error { constructor() { super("この会社はマネーフォワードと未連携です"); } }

export async function revokeAndDelete(cfg: MfConfig, admin: SupabaseClient, companyId: string) {
  const { data } = await admin.rpc("mf_token_get", { cid: companyId });
  const row = (data as { refresh_token: string | null }[] | null)?.[0];
  if (row?.refresh_token) {
    await tokenRequest(cfg, { token: row.refresh_token, token_type_hint: "refresh_token" }, "/revoke").catch(() => undefined);
  }
  await admin.rpc("mf_token_delete", { cid: companyId });
}

/* ---------- API 呼び出し（トークン単位で毎秒3回まで → 余裕を見て間隔を空ける） ---------- */
const lastCall = new Map<string, number>();
async function throttle(companyId: string) {
  const wait = (lastCall.get(companyId) ?? 0) + 400 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall.set(companyId, Date.now());
}

export async function mfApi<T = unknown>(cfg: MfConfig, admin: SupabaseClient, companyId: string, path: string, init: RequestInit = {}): Promise<T> {
  let token = await getAccessToken(cfg, admin, companyId);
  for (let attempt = 0; attempt < 4; attempt++) {
    await throttle(companyId);
    const res = await fetch(`${MF_ACCOUNTING_BASE}${path}`, {
      ...init, cache: "no-store",
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && attempt === 0) { token = await getAccessToken(cfg, admin, companyId, true); continue; }
    if (res.status === 429 || res.status === 503) {
      const ra = Number(res.headers.get("retry-after")) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(ra, 10) * 1000));
      continue;
    }
    const text = await res.text();
    let j: unknown = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = text; }
    if (!res.ok) {
      const msg = typeof j === "object" && j ? JSON.stringify(j).slice(0, 400) : String(j).slice(0, 400);
      throw new MfApiError(res.status, msg);
    }
    return j as T;
  }
  throw new MfApiError(429, "マネーフォワードAPIの呼び出し回数の上限に達しました。少し待ってから再度お試しください。");
}

export class MfApiError extends Error { constructor(public status: number, public detail: string) { super(`マネーフォワードAPIエラー（${status}）：${detail}`); } }

/** 返ってきたJSONから配列部分を取り出す（APIのレスポンス形の差を吸収） */
export function pickArray(j: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(j)) return j as Record<string, unknown>[];
  if (j && typeof j === "object") {
    for (const k of keys) { const v = (j as Record<string, unknown>)[k]; if (Array.isArray(v)) return v as Record<string, unknown>[]; }
    for (const v of Object.values(j as Record<string, unknown>)) if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  return [];
}
