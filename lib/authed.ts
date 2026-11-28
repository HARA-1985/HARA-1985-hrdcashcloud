"use client";
import { sb } from "@/lib/supabase";

/** ログイン中のユーザーのトークンを付けてサーバーAPIを呼ぶ */
export async function authedPost<T extends Record<string, unknown> = Record<string, unknown>>(path: string, body: unknown) {
  const { data } = await sb().auth.getSession();
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token ?? ""}` },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, status: res.status, ...j };
}
