import type { BankAccount, Payment } from "./types";
import { CF_ITEMS, cfItemOf, payeeCfMap, projectFixed, viewPayments, type PayView } from "./view";

/** ダッシュボードで予算と比べる主な区分 */
export const BUDGET_MAIN = ["仕入支払", "経費支払", "人件費", "税金・社会保険"] as const;
export const BUDGET_ITEMS: string[] = CF_ITEMS;

export interface Budget {
  id: string; company_id: string; fiscal_year: number; name: string; status: "draft" | "approved";
  note: string | null; source: Record<string, unknown>; approved_at: string | null; created_at: string; updated_at: string;
}
export interface BudgetLine { cf_item: string; payee_name: string; month: string; amount: number }

/** 実績・見込の1件（支払予定を区分・相手先・月に直したもの） */
export interface ActualLine {
  id: string; cf_item: string; payee_name: string; month: string; amount: number;
  kind: "fixed" | "spot"; est: boolean; item: string | null; document_id: string | null; due: Date;
}

export const mkey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
export const mlabel = (k: string) => `${Number(k.slice(5, 7))}月`;
export const ymlabel = (k: string) => `${k.slice(0, 4)}年${Number(k.slice(5, 7))}月`;

/** 日付が属する事業年度（期首の年）。期首月が4月なら 2027年3月 → 2026 */
export function fiscalYearOf(d: Date, startMonth: number): number {
  return d.getMonth() + 1 >= startMonth ? d.getFullYear() : d.getFullYear() - 1;
}
/** 事業年度の12か月（月初の日付キー） */
export function fyMonths(fy: number, startMonth: number): string[] {
  return Array.from({ length: 12 }, (_, i) => mkey(new Date(fy, startMonth - 1 + i, 1)));
}
export const fyLabel = (fy: number, startMonth: number) =>
  startMonth === 1 ? `${fy}年1月〜12月` : `${fy}年${startMonth}月〜${fy + 1}年${startMonth - 1}月`;

/**
 * 支払予定を実績・見込の明細に直す。
 * - 取消以外の登録済みの支払は「実績」
 * - until までの毎月固定の見込（請求書が届く前の分）は est=true
 */
export function actualLines(payments: Payment[], banks: BankAccount[], until?: Date): ActualLine[] {
  const live = payments.filter((p) => p.status !== "cancelled");
  const byPayee = payeeCfMap(live);
  const views: PayView[] = viewPayments(live, banks);
  const all = until ? projectFixed(views, until) : views;
  return all.map((p) => ({
    id: p.id, cf_item: cfItemOf(p, byPayee), payee_name: p.payee_name, month: mkey(p.d), amount: p.amount,
    kind: p.kind, est: !!p.est, item: p.item, document_id: p.document_id, due: p.d,
  }));
}

/** 区分×月、相手先×月の集計 */
export function sumBy<T>(xs: T[], key: (x: T) => string, val: (x: T) => number): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + val(x));
  return m;
}

export const diffRate = (actual: number, budget: number) => (budget > 0 ? (actual - budget) / budget : actual > 0 ? 1 : 0);
export const fmtRate = (r: number) => `${r >= 0 ? "+" : ""}${Math.round(r * 100)}%`;

/** 大きな増減の判定：差異率 ±20% 以上 かつ 差額 10万円以上 */
export const VARIANCE_RATE = 0.2;
export const VARIANCE_YEN = 100_000;
export const isLargeVariance = (actual: number, budget: number) =>
  Math.abs(actual - budget) >= VARIANCE_YEN && Math.abs(diffRate(actual, budget)) >= VARIANCE_RATE;

export interface ProposalOptions {
  baseFrom: string; baseTo: string;  // 参照する実績の期間（月初キー、両端含む）
  growth: Record<string, number>;     // 区分ごとの増減率（0.05 = +5%）
  includeSpot: boolean;               // 臨時の支払も含める
  roundTo: number;                    // 端数処理（1000円単位など）
  byPayee: boolean;                   // 相手先別に作る（false なら区分全体で作る）
}

/**
 * 過去の支払実績から次年度の予算案を作る。
 * 参照期間の各月の実績を「同じ月（何月か）」の予算にあてはめ、区分ごとの増減率をかける。
 * 参照期間に含まれない月（12か月に満たない場合）は、参照期間の月平均で埋める。
 */
export function buildProposal(actuals: ActualLine[], fy: number, startMonth: number, o: ProposalOptions): BudgetLine[] {
  const base = actuals.filter((a) => !a.est && a.month >= o.baseFrom && a.month <= o.baseTo && (o.includeSpot || a.kind === "fixed"));
  // 参照期間に含まれる月（暦の月 1〜12）。期間内で実績がなかった月は 0、期間外の月は月平均で埋める
  // 参照期間が12か月を超えるときは、同じ月の実績を平均する（occ = その月が参照期間に何回あるか）
  const covered = new Set<number>();
  const occ = new Map<number, number>();
  let monthsInBase = 0;
  for (let d = new Date(Number(o.baseFrom.slice(0, 4)), Number(o.baseFrom.slice(5, 7)) - 1, 1); mkey(d) <= o.baseTo; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    covered.add(d.getMonth() + 1); occ.set(d.getMonth() + 1, (occ.get(d.getMonth() + 1) ?? 0) + 1); monthsInBase++;
  }
  monthsInBase = Math.max(1, monthsInBase);
  const key = (a: ActualLine) => `${a.cf_item}\u0000${o.byPayee ? a.payee_name : ""}`;
  // 何月（1〜12）ごとの実績
  const byKeyMonth = new Map<string, Map<number, number>>();
  const totals = new Map<string, number>();
  for (const a of base) {
    const k = key(a);
    const mm = Number(a.month.slice(5, 7));
    const inner = byKeyMonth.get(k) ?? new Map<number, number>();
    inner.set(mm, (inner.get(mm) ?? 0) + a.amount);
    byKeyMonth.set(k, inner);
    totals.set(k, (totals.get(k) ?? 0) + a.amount);
  }
  const months = fyMonths(fy, startMonth);
  const round = (v: number) => (o.roundTo > 1 ? Math.round(v / o.roundTo) * o.roundTo : Math.round(v));
  const out: BudgetLine[] = [];
  for (const [k, inner] of byKeyMonth) {
    const [cf_item, payee_name] = k.split("\u0000");
    const g = 1 + (o.growth[cf_item] ?? 0);
    const avg = (totals.get(k) ?? 0) / monthsInBase;
    for (const m of months) {
      const mm = Number(m.slice(5, 7));
      const v = inner.has(mm) ? inner.get(mm)! / (occ.get(mm) ?? 1) : covered.has(mm) ? 0 : avg;
      const amount = round(v * g);
      if (amount > 0) out.push({ cf_item, payee_name, month: m, amount });
    }
  }
  return out;
}

/** CSV（Excel で開けるよう BOM 付き） */
export function toCsv(rows: (string | number)[][]): string {
  const esc = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
}
export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
