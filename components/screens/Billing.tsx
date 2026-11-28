"use client";
import { useCallback, useEffect, useState } from "react";
import type { Ctx } from "../ctx";
import { sb } from "@/lib/supabase";
import { authedPost } from "@/lib/authed";
import type { Plan, Subscription } from "@/lib/types";

const yen = (n: number) => n.toLocaleString("ja-JP");
const STATUS_TEXT: Record<string, string> = {
  active: "ご契約中", trialing: "ご契約中", past_due: "お支払いの確認中", canceled: "解約済み",
  unpaid: "未払い", incomplete: "お申し込み手続き中", incomplete_expired: "お申し込みが完了しませんでした", paused: "一時停止中",
};

export function daysLeft(iso?: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000));
}

export default function Billing({ ctx }: { ctx: Ctx }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [sub, setSub] = useState<Subscription | null>(null);
  const [clients, setClients] = useState(0);
  const [busy, setBusy] = useState(false);
  const isFirm = ctx.company.kind === "accounting_firm";

  const load = useCallback(async () => {
    const [p, s, fc] = await Promise.all([
      sb().from("plans").select("code,company_kind,name,monthly_price_jpy,per_client_price_jpy,stripe_price_id").eq("company_kind", ctx.company.kind === "accounting_firm" ? "accounting_firm" : "client").eq("is_active", true).order("sort_order").limit(1).maybeSingle(),
      sb().from("subscriptions").select("company_id,plan_code,status,current_period_end,cancel_at_period_end,client_quantity").eq("company_id", ctx.company.id).maybeSingle(),
      isFirm ? sb().from("firm_clients").select("company_id", { count: "exact", head: true }).eq("firm_id", ctx.company.id).eq("status", "active") : Promise.resolve({ count: 0 }),
    ]);
    setPlan((p.data as Plan) ?? null);
    setSub((s.data as Subscription) ?? null);
    setClients(fc.count ?? 0);
  }, [ctx.company.id, ctx.company.kind, isFirm]);
  useEffect(() => { load(); }, [load]);

  async function go(path: string) {
    setBusy(true);
    const r = await authedPost<{ url?: string }>(path, { companyId: ctx.company.id });
    setBusy(false);
    if (r.ok && r.url) window.location.href = r.url;
    else ctx.toast(r.error ?? "手続きを開始できませんでした", true);
  }

  const left = daysLeft(ctx.company.trial_ends_at);
  const subscribed = !!sub && ["active", "trialing", "past_due"].includes(sub.status);
  const monthly = plan ? plan.monthly_price_jpy + (isFirm ? plan.per_client_price_jpy * clients : 0) : 0;

  if (ctx.company.kind === "hrd") return null;

  const status =
    ctx.access === "suspended" ? "利用停止中"
    : ctx.access === "active" ? (ctx.company.billing_exempt ? "ご利用中" : STATUS_TEXT[sub?.status ?? "active"])
    : ctx.access === "trial" ? `無料期間　残り${left}日`
    : ctx.access === "covered_by_firm" ? "会計事務所のプランでご利用中"
    : "無料期間終了";
  const date = ctx.access === "trial" && ctx.company.trial_ends_at ? `${new Date(ctx.company.trial_ends_at).toLocaleDateString("ja-JP")}まで`
    : subscribed && sub?.current_period_end ? `${sub.cancel_at_period_end ? "解約予定" : "次回更新"} ${new Date(sub.current_period_end).toLocaleDateString("ja-JP")}` : "";
  const showPlan = ctx.access !== "covered_by_firm" && ctx.access !== "suspended" && !ctx.company.billing_exempt && plan;

  return (
    <section className="card pad stack" style={{ gap: 20, maxWidth: 720 }}>
      <div className="stack" style={{ gap: 4 }}>
        <strong style={{ fontSize: 22, color: ctx.access === "expired" || ctx.access === "suspended" ? "#9B1C1C" : undefined }}>{status}</strong>
        {date && <span className="muted num" style={{ fontSize: 13 }}>{date}</span>}
      </div>
      {showPlan && (
        <div className="row wrap" style={{ gap: 16, justifyContent: "space-between", paddingTop: 20, borderTop: "1px solid #EFEDE8" }}>
          <div className="stack" style={{ gap: 4 }}>
            <span className="lbl">{plan.name}</span>
            <span className="num" style={{ fontSize: 30, fontWeight: 700 }}>¥{yen(monthly)}<span className="muted" style={{ fontSize: 13, fontWeight: 500 }}> ／月（税別）</span></span>
            {isFirm && <span className="muted num" style={{ fontSize: 12 }}>基本 ¥{yen(plan.monthly_price_jpy)} ＋ 顧問先 {clients}社 × ¥{yen(plan.per_client_price_jpy)}</span>}
          </div>
          {ctx.isOwner && (subscribed
            ? <button type="button" className="btn" disabled={busy} onClick={() => go("/api/billing/portal")}>お支払い設定</button>
            : <button type="button" className="btn btn-primary" disabled={busy} onClick={() => go("/api/billing/checkout")}>{busy ? "移動中…" : "申し込む"}</button>)}
        </div>
      )}
    </section>
  );
}
