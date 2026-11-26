import "server-only";
import { fromText, pdfText } from "./extract";

/** 請求書などの PDF・画像から振込先口座を読み取る */
export interface BankInfo {
  name?: string; name_kana?: string;
  bank_name?: string; bank_code?: string; bank_kana?: string;
  branch_name?: string; branch_code?: string; branch_kana?: string;
  account_type?: "1" | "2" | "4"; account_number?: string;
  method: "text" | "ai" | "none"; note?: string;
}

interface ZBranch { code: string; name: string; kana: string }
interface ZBank { code: string; name: string; kana: string; branches: Record<string, ZBranch> }
let ZC: Record<string, ZBank> | null = null;
async function zc() {
  if (!ZC) ZC = ((await import("zengin-code")) as unknown as { default: Record<string, ZBank> }).default ?? null;
  return ZC!;
}
const nz = (s: string) => s.normalize("NFKC").replace(/[\s　]/g, "");

/** 銀行名・支店名（またはコード）から全銀コードとカナを引く */
export async function resolveCodes(b: BankInfo): Promise<BankInfo> {
  const z = await zc();
  const out = { ...b };
  let bank: ZBank | undefined = out.bank_code ? z[out.bank_code] : undefined;
  if (!bank && out.bank_name) {
    const k = nz(out.bank_name).replace(/^株式会社|株式会社$/g, "");
    const short = k.replace(/(銀行|信用金庫|信用組合|労働金庫)$/, "");
    const all = Object.values(z);
    bank = all.find((x) => nz(x.name) === short) ?? all.find((x) => nz(x.name) === k) ?? all.find((x) => k.startsWith(nz(x.name)) && nz(x.name).length >= 2);
  }
  if (bank) {
    out.bank_code = bank.code; out.bank_kana = bank.kana; out.bank_name ??= bank.name;
    let br: ZBranch | undefined = out.branch_code ? bank.branches[out.branch_code] : undefined;
    if (!br && out.branch_name) {
      const k = nz(out.branch_name).replace(/(支店|営業部|出張所|支所)$/, "");
      const all = Object.values(bank.branches);
      br = all.find((x) => nz(x.name) === k) ?? all.find((x) => nz(x.name) === nz(out.branch_name!)) ?? all.find((x) => nz(x.name).startsWith(k) && k.length >= 2);
    }
    if (br) { out.branch_code = br.code; out.branch_kana = br.kana; out.branch_name ??= br.name; }
  }
  return out;
}

const INST = "(?:ゆうちょ銀行|[^\\s:：、。,()（）「」【】]{1,16}?(?:銀行|信用金庫|信金|信用組合|労働金庫|農業協同組合))";

export function parseBankText(raw: string): Omit<BankInfo, "method"> {
  const t = raw.normalize("NFKC").replace(/　/g, " ");
  // 振込先の記載まわりを優先して探す
  const anchor = t.search(/(振込先|お振込先|振込口座|お支払先|お支払い先|口座情報|入金先)/);
  const seg = anchor >= 0 ? t.slice(anchor, anchor + 400) : t;
  const out: Omit<BankInfo, "method"> = {};
  const LABEL = /^(お?取引銀行|お?振込銀行|振込先銀行|銀行名?|金融機関名?|振込先|お振込先)$/;
  const pick = (src: string) => [...src.matchAll(new RegExp(`(${INST})`, "g"))]
    .map((m) => ({ m, name: m[1].replace(/^(お?振込先|お?取引銀行|銀行名|金融機関名?)[:：／/]?/, "") }))
    .find((x) => x.name.length >= 3 && !LABEL.test(x.name));
  const hit = pick(seg) ?? pick(t);
  const bm = hit ? [hit.m[1], hit.m[1]] : null;
  if (hit) out.bank_name = hit.name.replace(/信金$/, "信用金庫");
  const after = bm ? seg.slice(Math.max(0, seg.indexOf(bm[1]) + bm[1].length)) : seg;
  const brm = after.match(/^[\s:：・/]*([^\s:：、。,()（）]{1,14}?(?:支店|営業部|出張所|支所))/) ?? after.match(/([^\s:：、。,()（）]{1,14}?(?:支店|営業部|出張所))/) ?? (/本店/.test(after.slice(0, 20)) ? ["", "本店"] : null);
  if (brm) out.branch_name = brm[1].replace(/^支店名[:：]?/, "");
  const codes = seg.match(/(?:銀行コード|金融機関コード)[:：\s]*(\d{4})/); if (codes) out.bank_code = codes[1];
  const bcodes = seg.match(/(?:支店コード|店番|店番号)[:：\s]*(\d{3})/); if (bcodes) out.branch_code = bcodes[1];
  const tm = seg.match(/(普通|当座|貯蓄)(?:預金)?(?:口座)?[\s:：No.番号]*(\d{4,8})/) ?? t.match(/(普通|当座|貯蓄)(?:預金)?(?:口座)?[\s:：No.番号]*(\d{4,8})/);
  if (tm) { out.account_type = tm[1] === "当座" ? "2" : tm[1] === "貯蓄" ? "4" : "1"; out.account_number = tm[2].padStart(7, "0"); }
  else {
    const ty = seg.match(/(普通|当座)/); if (ty) out.account_type = ty[1] === "当座" ? "2" : "1";
    const nm = seg.match(/口座番号[\s:：]*(\d{4,8})/); if (nm) out.account_number = nm[1].padStart(7, "0");
  }
  const hm = seg.match(/(?:口座名義(?:人)?|名義(?:人)?|受取人(?:名)?)[\s:：]*([ｦ-ﾟァ-ヶー()（）.\-\s A-Z0-9]{3,40})/);
  if (hm) out.name_kana = hm[1].trim();
  return out;
}

async function fromAI(bytes: Uint8Array, mime: string): Promise<Omit<BankInfo, "method"> | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const isPdf = mime === "application/pdf";
  if (!isPdf && !/^image\/(jpeg|png|webp)$/.test(mime)) return null;
  const b64 = Buffer.from(bytes).toString("base64");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      max_tokens: 400,
      messages: [{ role: "user", content: [
        isPdf ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
              : { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
        { type: "text", text: "これは日本の請求書などです。発行元（支払先）の会社名と、記載された振込先口座を読み取り、次のJSONだけを返してください。読めない項目は null。{\"payee\":string|null,\"bank_name\":string|null,\"branch_name\":string|null,\"account_type\":\"普通\"|\"当座\"|null,\"account_number\":string|null,\"holder_kana\":string|null}" },
      ] }],
    }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { content?: { type: string; text?: string }[] };
  const m = (j.content?.find((c) => c.type === "text")?.text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, string | null>;
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    return {
      name: s(o.payee), bank_name: s(o.bank_name), branch_name: s(o.branch_name),
      account_type: o.account_type === "当座" ? "2" : o.account_type ? "1" : undefined,
      account_number: s(o.account_number)?.replace(/\D/g, "").padStart(7, "0"), name_kana: s(o.holder_kana),
    };
  } catch { return null; }
}

export async function extractBank(bytes: Uint8Array, mime: string, ownNames: string[]): Promise<BankInfo> {
  let base: Omit<BankInfo, "method"> = {};
  if (mime === "application/pdf") {
    const t = await pdfText(bytes);
    if (t.trim().length > 20) base = { name: fromText(t, ownNames).payee, ...parseBankText(t) };
  }
  const enough = (b: Omit<BankInfo, "method">) => !!(b.bank_name && b.account_number);
  let method: BankInfo["method"] = Object.values(base).some(Boolean) ? "text" : "none";
  if (!enough(base)) {
    const ai = await fromAI(bytes, mime).catch(() => null);
    if (ai) { base = { ...base, ...Object.fromEntries(Object.entries(ai).filter(([, v]) => v)) }; method = "ai"; }
  }
  const r = await resolveCodes({ ...base, method });
  if (!r.account_number || !r.bank_code) r.note = method === "none"
    ? (mime === "application/pdf" ? "文字情報の無いPDF（スキャン画像）の可能性があります。AI読み取り（ANTHROPIC_API_KEY）を設定すると読めます" : "画像は AI読み取りの設定時のみ読めます")
    : "一部のみ読み取りました。空欄を確認してください";
  return r;
}
