// サブスクの申し込み：Stripe Checkout の URL を返す（会社のオーナーのみ）
import { authorizeOwner, json } from "@/lib/server";
import { ACTIVE_STATUSES, activeClientCount, stripeClient } from "@/lib/stripe";

export async function POST(req: Request) {
  const stripe = stripeClient();
  if (!stripe) return json({ error: "お支払いの受付は準備中です。HRD総合事務所までお問い合わせください" }, 503);
  const body = await req.json().catch(() => ({}));
  const a = await authorizeOwner(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  const companyId = body.companyId as string;

  const { data: co } = await a.admin.from("companies").select("id, name, kind, trial_ends_at").eq("id", companyId).single();
  if (!co) return json({ error: "会社が見つかりません" }, 404);
  if (co.kind === "hrd") return json({ error: "HRD総合事務所はお申し込み不要です" }, 400);

  const { data: plan } = await a.admin.from("plans").select("*")
    .eq("company_kind", co.kind).eq("is_active", true).order("sort_order").limit(1).maybeSingle();
  if (!plan?.stripe_price_id) return json({ error: "料金プランの設定が未完了です。HRD総合事務所までお問い合わせください" }, 503);

  const { data: existing } = await a.admin.from("subscriptions")
    .select("stripe_customer_id, status").eq("company_id", companyId).maybeSingle();
  if (existing && ACTIVE_STATUSES.includes(existing.status)) return json({ error: "すでにお申し込み済みです" }, 409);

  let customerId = existing?.stripe_customer_id as string | undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: a.user.email ?? undefined, name: co.name, metadata: { company_id: companyId } });
    customerId = customer.id;
    await a.admin.from("subscriptions").upsert(
      { company_id: companyId, plan_code: plan.code, status: "incomplete", stripe_customer_id: customerId },
      { onConflict: "company_id" },
    );
  }

  const lineItems: { price: string; quantity: number }[] = [{ price: plan.stripe_price_id, quantity: 1 }];
  if (co.kind === "accounting_firm" && plan.stripe_client_price_id) {
    const n = await activeClientCount(a.admin, companyId);
    if (n > 0) lineItems.push({ price: plan.stripe_client_price_id, quantity: n });
  }

  // 無料期間中の申し込みは、残りの無料期間が終わってから課金開始（Stripe の制約で48時間以上先のときのみ）
  const trialEnd = co.trial_ends_at ? Math.floor(new Date(co.trial_ends_at).getTime() / 1000) : 0;
  const useTrialEnd = trialEnd > Math.floor(Date.now() / 1000) + 49 * 3600;
  const metadata = { company_id: companyId, plan_code: plan.code, client_price_id: plan.stripe_client_price_id ?? "" };
  const origin = process.env.APP_ORIGIN ?? new URL(req.url).origin;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: lineItems,
    locale: "ja",
    allow_promotion_codes: true,
    metadata,
    subscription_data: { metadata, ...(useTrialEnd ? { trial_end: trialEnd } : {}) },
    success_url: `${origin}/?billing=success`,
    cancel_url: `${origin}/?billing=cancel`,
  });
  return json({ url: session.url });
}
