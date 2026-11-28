// お支払い方法の変更・解約・領収書：Stripe カスタマーポータルの URL を返す（会社のオーナーのみ）
import { authorizeOwner, json } from "@/lib/server";
import { stripeClient } from "@/lib/stripe";

export async function POST(req: Request) {
  const stripe = stripeClient();
  if (!stripe) return json({ error: "お支払いの受付は準備中です" }, 503);
  const body = await req.json().catch(() => ({}));
  const a = await authorizeOwner(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);

  const { data: sub } = await a.admin.from("subscriptions").select("stripe_customer_id").eq("company_id", body.companyId).maybeSingle();
  if (!sub?.stripe_customer_id) return json({ error: "お支払い情報が見つかりません" }, 404);
  const origin = process.env.APP_ORIGIN ?? new URL(req.url).origin;
  const session = await stripe.billingPortal.sessions.create({ customer: sub.stripe_customer_id, return_url: `${origin}/` });
  return json({ url: session.url });
}
