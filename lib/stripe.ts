import "server-only";
import Stripe from "stripe";
import type { adminClient } from "@/lib/server";

type Admin = NonNullable<ReturnType<typeof adminClient>>;

/** STRIPE_SECRET_KEY が未設定なら null（課金の準備前） */
export function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key) : null;
}

export const ACTIVE_STATUSES = ["active", "trialing", "past_due"];

/** 会計事務所の有効な顧問先数（顧問先1社あたりの課金に使う。HRD の顧問先は対象外） */
export async function activeClientCount(admin: Admin, firmId: string): Promise<number> {
  const { count, error } = await admin.from("firm_clients")
    .select("company_id", { count: "exact", head: true })
    .eq("firm_id", firmId).eq("status", "active");
  if (error) throw error;
  return count ?? 0;
}

/** Stripe のサブスクを subscriptions テーブルへ反映 */
export async function syncSubscription(admin: Admin, sub: Stripe.Subscription) {
  const companyId = sub.metadata?.company_id;
  if (!companyId) { console.warn("[stripe] company_id のないサブスク", sub.id); return; }
  const clientPriceId = sub.metadata?.client_price_id || undefined;
  const clientItem = clientPriceId ? sub.items.data.find((i) => i.price.id === clientPriceId) : undefined;
  const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end
    ?? (sub.items.data[0] as unknown as { current_period_end?: number } | undefined)?.current_period_end;
  const { error } = await admin.from("subscriptions").upsert({
    company_id: companyId,
    plan_code: sub.metadata?.plan_code ?? null,
    status: sub.status,
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    stripe_subscription_id: sub.id,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at_period_end: sub.cancel_at_period_end,
    client_quantity: clientItem?.quantity ?? 0,
    updated_at: new Date().toISOString(),
  }, { onConflict: "company_id" });
  if (error) throw error;
}

/** 顧問先数の変化を Stripe の「顧問先1社あたり」の数量に反映 */
export async function syncClientQuantity(admin: Admin, stripe: Stripe, firmId: string) {
  const { data: row } = await admin.from("subscriptions")
    .select("stripe_subscription_id, status").eq("company_id", firmId).maybeSingle();
  if (!row?.stripe_subscription_id || !ACTIVE_STATUSES.includes(row.status)) return { synced: false };
  const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
  const clientPriceId = sub.metadata?.client_price_id;
  if (!clientPriceId) return { synced: false };
  const n = await activeClientCount(admin, firmId);
  const item = sub.items.data.find((i) => i.price.id === clientPriceId);
  if (item && n > 0 && item.quantity !== n) {
    await stripe.subscriptionItems.update(item.id, { quantity: n, proration_behavior: "create_prorations" });
  } else if (item && n === 0) {
    await stripe.subscriptionItems.del(item.id, { proration_behavior: "create_prorations" });
  } else if (!item && n > 0) {
    await stripe.subscriptionItems.create({ subscription: sub.id, price: clientPriceId, quantity: n, proration_behavior: "create_prorations" });
  }
  await syncSubscription(admin, await stripe.subscriptions.retrieve(sub.id));
  return { synced: true, clients: n };
}
