import { md, parseDate, wd, yen } from "./format";
import type { BankAccount, Payment } from "./types";

export interface PayView extends Payment {
  d: Date; md: string; wd: string; amt: string; kindLabel: string; kindCls: string; bankName: string; est?: boolean;
}

export function viewPayments(ps: Payment[], banks: BankAccount[]): PayView[] {
  const bn = new Map(banks.map((b) => [b.id, b.bank_name]));
  return ps.map((p) => {
    const d = parseDate(p.due_date);
    return {
      ...p, d, md: md(d), wd: wd(d), amt: yen(p.amount),
      kindLabel: p.kind === "fixed" ? "固定" : "臨時",
      kindCls: p.kind === "fixed" ? "chip chip-fixed" : "chip chip-spot",
      bankName: (p.bank_account_id && bn.get(p.bank_account_id)) || "未設定",
    };
  }).sort((a, b) => a.d.getTime() - b.d.getTime());
}

/**
 * 毎月固定の支払を、請求書が届く前から「見込」として先の月に入れる。
 * - 支払先ごとに「いちばん新しい月」の明細だけを、その翌月以降へ複製する（過去の月を何重にも複製しない）
 * - すでに実績（登録済みの支払）がある月には入れない
 * - 今月より前の月には入れない／直近3か月に実績がない支払先は見込を作らない
 */
export function projectFixed(ps: PayView[], until: Date): PayView[] {
  const out = [...ps];
  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const ym = (d: Date) => d.getFullYear() * 12 + d.getMonth();
  const byPayee = new Map<string, PayView[]>();
  for (const p of ps) {
    if (p.kind !== "fixed" || p.status === "cancelled") continue;
    const arr = byPayee.get(p.payee_name) ?? [];
    arr.push(p); byPayee.set(p.payee_name, arr);
  }
  for (const arr of byPayee.values()) {
    const months = new Set(arr.map((p) => ym(p.d)));
    const latest = Math.max(...months);
    if (latest < ym(thisMonth) - 2) continue; // 3か月以上出てこない支払先は終了したとみなす
    const lines = arr.filter((p) => ym(p.d) === latest);
    for (let k = 1; k < 24; k++) {
      const target = latest + k;
      const ty = Math.floor(target / 12), tm = target % 12;
      if (new Date(ty, tm, 1) >= until) break;
      if (new Date(ty, tm, 1) < thisMonth || months.has(target)) continue;
      for (const p of lines) {
        const last = new Date(ty, tm + 1, 0).getDate();
        const nd = new Date(ty, tm, Math.min(p.d.getDate(), last));
        out.push({ ...p, id: p.id + "-e" + k, d: nd, md: md(nd), wd: wd(nd), est: true, status: "pending", document_id: null });
      }
    }
  }
  return out.sort((a, b) => a.d.getTime() - b.d.getTime());
}
