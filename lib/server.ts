import "server-only";
import { createClient } from "@supabase/supabase-js";

export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** リクエストのトークンからユーザーを確認し、その会社での権限を返す */
export async function authorize(req: Request, companyId: string | undefined) {
  const admin = adminClient();
  if (!admin) return { error: "サーバーの設定（SUPABASE_SERVICE_ROLE_KEY）が未完了です", status: 503 as const };
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return { error: "ログインが必要です", status: 401 as const };
  const { data: u, error } = await admin.auth.getUser(token);
  if (error || !u.user) return { error: "ログインの有効期限が切れています", status: 401 as const };
  if (!companyId || !/^[0-9a-f-]{36}$/i.test(companyId)) return { error: "会社の指定が不正です", status: 400 as const };
  const [{ data: prof }, { data: mem }] = await Promise.all([
    admin.from("profiles").select("is_hrd_staff").eq("id", u.user.id).single(),
    admin.from("memberships").select("role").eq("company_id", companyId).eq("user_id", u.user.id).maybeSingle(),
  ]);
  const role = prof?.is_hrd_staff ? "owner" : (mem?.role as string | undefined);
  return { admin, user: u.user, role, isHrd: !!prof?.is_hrd_staff };
}

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
