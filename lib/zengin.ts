import Encoding from "encoding-japanese";
import type { BankAccount, Payee, Payment } from "./types";

/* ---------- 半角カナ変換（全銀で使える文字だけ残す） ---------- */
const FULL = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン";
const HALF = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ";
const DAKU = "ガギグゲゴザジズゼゾダヂヅデドバビブベボ";
const DAKU_BASE = "カキクケコサシスセソタチツテトハヒフヘホ";
const HANDAKU = "パピプペポ";
const HANDAKU_BASE = "ハヒフヘホ";
const SMALL = "ァィゥェォッャュョヮ";
const SMALL_BASE = "アイウエオツヤユヨワ";
const ALLOWED = /[0-9A-Zｱ-ﾝﾞﾟ()\-./ ]/;

export function toZenginKana(input: string | null | undefined): string {
  if (!input) return "";
  let s = input.normalize("NFKC");
  s = s.replace(/株式会社$/, "(ｶ").replace(/^株式会社/, "ｶ)").replace(/株式会社/, "(ｶ)")
       .replace(/有限会社$/, "(ﾕ").replace(/^有限会社/, "ﾕ)")
       .replace(/合同会社$/, "(ﾄﾞ").replace(/^合同会社/, "ﾄﾞ)");
  let out = "";
  for (const raw of s) {
    let ch = raw;
    const code = ch.charCodeAt(0);
    if (code >= 0x3041 && code <= 0x3096) ch = String.fromCharCode(code + 0x60); // ひらがな→カタカナ
    if (ch === "ヴ") { out += "ｳﾞ"; continue; }
    let i = SMALL.indexOf(ch); if (i >= 0) ch = SMALL_BASE[i];
    i = DAKU.indexOf(ch); if (i >= 0) { out += HALF[FULL.indexOf(DAKU_BASE[i])] + "ﾞ"; continue; }
    i = HANDAKU.indexOf(ch); if (i >= 0) { out += HALF[FULL.indexOf(HANDAKU_BASE[i])] + "ﾟ"; continue; }
    i = FULL.indexOf(ch); if (i >= 0) { out += HALF[i]; continue; }
    if (ch === "ー" || ch === "－" || ch === "―" || ch === "‐") { out += "-"; continue; }
    if (ch === "・" || ch === "､" || ch === "、") { out += "."; continue; }
    if (ch === "　") ch = " ";
    ch = ch.toUpperCase();
    // NFKC で半角カナの小書きも大きくする
    const hs = "ｧｨｩｪｫｯｬｭｮ", hb = "ｱｲｳｴｵﾂﾔﾕﾖ";
    const j = hs.indexOf(ch); if (j >= 0) ch = hb[j];
    if (ALLOWED.test(ch)) out += ch;
  }
  return out;
}

const padR = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
const padN = (v: string | number, n: number) => String(v).replace(/\D/g, "").padStart(n, "0").slice(-n);

export interface FbIssue { paymentId: string; payee: string; message: string }

export interface FbResult { text: string; lines: string[]; issues: FbIssue[]; count: number; total: number }

/** 全銀協フォーマット 総合振込（120桁固定長） */
export function buildZengin(from: BankAccount, transferDate: Date, payments: Payment[], payees: Map<string, Payee>): FbResult {
  const issues: FbIssue[] = [];
  const mmdd = padN(transferDate.getMonth() + 1, 2) + padN(transferDate.getDate(), 2);
  const header =
    "1" + "21" + "0" +
    padN(from.client_code ?? "", 10) +
    padR(toZenginKana(from.holder_kana), 40) +
    mmdd +
    padN(from.bank_code ?? "", 4) + padR(toZenginKana(from.bank_kana), 15) +
    padN(from.branch_code ?? "", 3) + padR(toZenginKana(from.branch_kana), 15) +
    (from.account_type === "2" ? "2" : "1") + padN(from.account_number ?? "", 7) +
    padR("", 17);

  if (!from.client_code) issues.push({ paymentId: "", payee: from.bank_name, message: "振込元口座の委託者コードが未設定です" });
  if (!from.account_number || !from.bank_code || !from.branch_code)
    issues.push({ paymentId: "", payee: from.bank_name, message: "振込元口座の銀行・支店・口座番号が未設定です" });

  const data: string[] = [];
  let total = 0;
  for (const p of payments) {
    const pe = p.payee_id ? payees.get(p.payee_id) : undefined;
    if (!pe || !pe.bank_code || !pe.branch_code || !pe.account_number) {
      issues.push({ paymentId: p.id, payee: p.payee_name, message: "振込先の口座情報が未登録です" });
      continue;
    }
    const name = toZenginKana(pe.name_kana || pe.name);
    if (!name) issues.push({ paymentId: p.id, payee: p.payee_name, message: "受取人名（カナ）が未登録です" });
    total += p.amount;
    data.push(
      "2" +
      padN(pe.bank_code, 4) + padR(toZenginKana(pe.bank_kana), 15) +
      padN(pe.branch_code, 3) + padR(toZenginKana(pe.branch_kana), 15) +
      "0000" +
      (pe.account_type === "2" ? "2" : pe.account_type === "4" ? "4" : "1") +
      padN(pe.account_number, 7) +
      padR(name, 30) +
      padN(p.amount, 10) +
      "0" + padR("", 10) + padR("", 10) +
      "7" + " " + padR("", 7)
    );
  }
  const trailer = "8" + padN(data.length, 6) + padN(total, 12) + padR("", 101);
  const end = "9" + padR("", 119);
  const lines = [header, ...data, trailer, end];
  return { text: lines.join("\r\n") + "\r\n", lines, issues, count: data.length, total };
}

/** Shift_JIS に変換してダウンロード（ファイルはサーバーに残さない） */
export function downloadSjis(text: string, filename: string) {
  const unicode = Encoding.stringToCode(text);
  const sjis = Encoding.convert(unicode, { to: "SJIS", from: "UNICODE" });
  const blob = new Blob([new Uint8Array(sjis)], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
