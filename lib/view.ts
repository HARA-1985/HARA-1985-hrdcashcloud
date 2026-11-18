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

/** 毎月固定の支払を、請求書が届く前から「見込」として先の月に複製する */
export function projectFixed(ps: PayView[], until: Date): PayView[] {
  const out = [...ps];
  const latestByKey = new Map<string, PayView>();
  for (const p of ps) {
    if (p.kind !== "fixed") continue;
    const key = p.payee_name + "|" + (p.item ?? "");
    const cur = latestByKey.get(key);
    if (!cur || cur.d < p.d) latestByKey.set(key, p);
  }
  for (const p of latestByKey.values()) {
    for (let k = 1; k < 24; k++) {
      const nd = new Date(p.d.getFullYear(), p.d.getMonth() + k, p.d.getDate());
      if (nd >= until) break;
      out.push({ ...p, id: p.id + "-e" + k, d: nd, md: md(nd), wd: wd(nd), est: true, status: "pending", document_id: null });
    }
  }
  return out.sort((a, b) => a.d.getTime() - b.d.getTime());
}
