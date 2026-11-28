// Stripe Webhook：サブスクの状態を subscriptions テーブルへ反映（Stripe の署名で検証）
import type Stripe from "stripe";
import { adminClient, json } from "@/lib/server";
import { stripeClient, syncSubscription } from "@/lib/stripe";

export async function POST(req: Request) {
  const stripe = stripeClient();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const admin = adminClient();
  if (!stripe || !secret || !admin) return json({ error: "not configured" }, 503);

  const signature = req.headers.get("stripe-signature");
  if (!signature) return json({ error: "missing signature" }, 400);
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, secret);
  } catch {
    return json({ error: "invalid signature" }, 400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.mode === "subscription" && s.subscription) {
          const id = typeof s.subscription === "string" ? s.subscription : s.subscription.id;
          await syncSubscription(admin, await stripe.subscriptions.retrieve(id));
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        await syncSubscription(admin, event.data.object as Stripe.Subscription);
        break;
      case "invoice.paid":
      case "invoice.payment_failed": {
        const inv = event.data.object as unknown as { subscription?: string | null; parent?: { subscription_details?: { subscription?: string } } };
        const id = inv.subscription ?? inv.parent?.subscription_details?.subscription;
        if (id) await syncSubscription(admin, await stripe.subscriptions.retrieve(id));
        break;
      }
    }
  } catch (e) {
    console.error("[stripe webhook]", event.type, e);
    return json({ error: "handler error" }, 500); // Stripe が再送する
  }
  return json({ received: true });
}
