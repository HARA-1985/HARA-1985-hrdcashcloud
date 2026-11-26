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

/** 支払先ごとに、直近の支払で使った振込元口座・勘定科目・支出項目（新しく取り込む支払に引き継ぐ） */
export async function payeeDefaults(admin: NonNullable<ReturnType<typeof adminClient>>, companyId: string) {
  const { data } = await admin.from("payments").select("payee_name, due_date, bank_account_id, account_title, cf_item")
    .eq("company_id", companyId).neq("status", "cancelled").order("due_date", { ascending: false }).limit(5000);
  const m = new Map<string, { bank_account_id: string | null; account_title: string | null; cf_item: string | null }>();
  for (const p of data ?? []) {
    const cur = m.get(p.payee_name) ?? { bank_account_id: null, account_title: null, cf_item: null };
    if (!cur.bank_account_id && p.bank_account_id) cur.bank_account_id = p.bank_account_id;
    if (!cur.account_title && p.account_title) cur.account_title = p.account_title;
    if (!cur.cf_item && p.cf_item) cur.cf_item = p.cf_item;
    m.set(p.payee_name, cur);
  }
  return m;
}
