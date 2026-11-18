import { authorize, json } from "@/lib/server";

const ROLES = ["owner", "approver", "member", "viewer"];

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const role = String(body.role ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "メールアドレスが正しくありません" }, 400);
  if (!ROLES.includes(role)) return json({ error: "権限の指定が正しくありません" }, 400);

  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (a.role !== "owner") return json({ error: "メンバーの招待はオーナーのみできます" }, 403);

  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  let userId: string | undefined;
  const { data: existing } = await a.admin.from("profiles").select("id").ilike("email", email).maybeSingle();
  if (existing) {
    userId = existing.id;
  } else {
    const inv = await a.admin.auth.admin.inviteUserByEmail(email, { redirectTo: origin });
    if (inv.error || !inv.data.user) return json({ error: "招待に失敗しました：" + (inv.error?.message ?? "") }, 400);
    userId = inv.data.user.id;
  }
  const { error } = await a.admin.from("memberships").upsert({ company_id: body.companyId, user_id: userId, role });
  if (error) return json({ error: error.message }, 400);
  await a.admin.from("audit_logs").insert({ company_id: body.companyId, actor: a.user.id, action: "insert", table_name: "memberships", detail: { email, role } });
  return json({ ok: true });
}
