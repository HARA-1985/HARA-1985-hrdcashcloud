"use client";
import { useCallback, useEffect, useState } from "react";
import type { Ctx } from "../ctx";
import { sb } from "@/lib/supabase";
import { authedPost } from "@/lib/authed";
import type { Plan, Subscription } from "@/lib/types";

const yen = (n: number) => n.toLocaleString("ja-JP");
const STATUS_TEXT: Record<string, string> = {
  active: "ご契約中", trialing: "ご契約中（課金開始前）", past_due: "お支払いの確認中", canceled: "解約済み",
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

  if (ctx.company.kind === "hrd") {
    return <section className="card pad"><p style={{ margin: 0 }}>HRD総合事務所はお申し込み不要です。</p></section>;
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      {/* 現在の状態 */}
      <section className={ctx.access === "expired" ? "kpi-dark" : "card pad stack"} style={{ gap: 10 }}>
        <span className="lbl" style={{ color: ctx.access === "expired" ? "#A9ACB4" : undefined }}>現在のご利用状況</span>
        {ctx.access === "suspended" && (
          <>
            <strong style={{ fontSize: 22, color: "#9B1C1C" }}>このアカウントは利用停止中です</strong>
            <span className="muted" style={{ fontSize: 14, lineHeight: 1.8 }}>データはそのまま保管されています。詳しくはHRD総合事務所までお問い合わせください。</span>
          </>
        )}
        {ctx.access === "active" && <strong style={{ fontSize: 22 }}>{ctx.company.billing_exempt ? "ご利用中（無料提供）" : STATUS_TEXT[sub?.status ?? "active"]}</strong>}
        {ctx.access === "trial" && <strong style={{ fontSize: 22 }}>無料期間中：あと <span className="num" style={{ color: "#2236B8" }}>{left}</span> 日</strong>}
        {ctx.access === "covered_by_firm" && <strong style={{ fontSize: 22 }}>顧問の会計事務所のご契約でご利用中です</strong>}
        {ctx.access === "expired" && (
          <>
            <strong style={{ fontSize: 22 }}>無料期間が終了しました</strong>
            <span style={{ fontSize: 14, lineHeight: 1.8, color: "#C9CBD1" }}>登録いただいたデータはそのまま残っています。プランをお申し込みいただくと、すぐに続きからご利用いただけます。</span>
          </>
        )}
        {ctx.access === "trial" && ctx.company.trial_ends_at && (
          <span className="muted" style={{ fontSize: 13 }}>無料期間の終了日：{new Date(ctx.company.trial_ends_at).toLocaleDateString("ja-JP")}</span>
        )}
        {subscribed && sub?.current_period_end && (
          <span className="muted" style={{ fontSize: 13 }}>
            {sub.cancel_at_period_end ? "解約予定日" : "次回の更新日"}：{new Date(sub.current_period_end).toLocaleDateString("ja-JP")}
          </span>
        )}
      </section>

      {/* プラン */}
      {ctx.access !== "covered_by_firm" && ctx.access !== "suspended" && !ctx.company.billing_exempt && plan && (
        <section className="card pad stack" style={{ gap: 16 }}>
          <div className="row wrap" style={{ gap: 12, justifyContent: "space-between" }}>
            <div className="stack" style={{ gap: 4 }}>
              <span className="lbl">{plan.name}</span>
              <span style={{ fontSize: 32, fontWeight: 700 }} className="num">¥{yen(monthly)}<span style={{ fontSize: 14, fontWeight: 500 }} className="muted"> ／月（税別）</span></span>
              {isFirm && (
                <span className="muted" style={{ fontSize: 13 }}>
                  基本料 ¥{yen(plan.monthly_price_jpy)} ＋ 顧問先 {clients}社 × ¥{yen(plan.per_client_price_jpy)}
                </span>
              )}
            </div>
            {!ctx.isOwner ? (
              <span className="muted" style={{ fontSize: 13 }}>お申し込みはオーナーの方が行えます</span>
            ) : subscribed ? (
              <button type="button" className="btn" disabled={busy} onClick={() => go("/api/billing/portal")}>お支払い方法の変更・解約</button>
            ) : (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => go("/api/billing/checkout")}>{busy ? "移動中…" : "プランを申し込む"}</button>
            )}
          </div>
          <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.9 }}>
            <li>お支払いはクレジットカード（Stripe の安全な決済画面）で行います。</li>
            {ctx.access === "trial" && <li>無料期間中にお申し込みいただいても、課金は無料期間の終了後に始まります。</li>}
            {isFirm && <li>顧問先の数が変わると、翌月以降の金額に自動で反映されます（日割り）。</li>}
            <li>いつでも解約できます。解約後も期間の終わりまでご利用いただけます。</li>
          </ul>
        </section>
      )}
    </div>
  );
}
