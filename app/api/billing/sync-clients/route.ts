// 会計事務所の顧問先数が変わったら、Stripe の「顧問先1社あたり」の数量を合わせる
import { adminClient, json } from "@/lib/server";
import { stripeClient, syncClientQuantity } from "@/lib/stripe";

export async function POST(req: Request) {
  const stripe = stripeClient();
  const admin = adminClient();
  if (!stripe || !admin) return json({ synced: false, reason: "not configured" });
  const body = await req.json().catch(() => ({}));
  const firmId = String(body.firmId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(firmId)) return json({ error: "会社の指定が不正です" }, 400);

  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const { data: u } = token ? await admin.auth.getUser(token) : { data: { user: null } };
  if (!u?.user) return json({ error: "ログインが必要です" }, 401);
  const { data: mem } = await admin.from("memberships").select("role").eq("company_id", firmId).eq("user_id", u.user.id).maybeSingle();
  const { data: prof } = await admin.from("profiles").select("is_hrd_staff").eq("id", u.user.id).single();
  if (!mem && !prof?.is_hrd_staff) return json({ error: "権限がありません" }, 403);

  const { data: co } = await admin.from("companies").select("kind").eq("id", firmId).single();
  if (co?.kind !== "accounting_firm") return json({ synced: false, reason: "not a firm" });
  try {
    return json(await syncClientQuantity(admin, stripe, firmId));
  } catch (e) {
    console.error("[billing sync]", e);
    return json({ error: "Stripe への反映に失敗しました" }, 500);
  }
}
