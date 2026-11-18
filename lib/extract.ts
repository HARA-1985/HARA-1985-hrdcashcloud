import "server-only";

/**
 * 請求書から支払情報を読み取る。
 * 優先順：① クラウドBoxに登録済みの取引情報 → ② PDFの文字情報から推定 → ③ AI読み取り（ANTHROPIC_API_KEY 設定時のみ）
 * どれで読めたかを method に残し、画面で必ず人が確認してから登録する前提。
 */
export interface Extracted {
  payee?: string; amount?: number; due?: string; issue?: string; regNo?: string; invoiceNo?: string;
  method: "box" | "text" | "ai" | "none"; note?: string;
}

const z2 = (n: number) => String(n).padStart(2, "0");
function toISO(y: number, m: number, d: number) {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  return `${y}-${z2(m)}-${z2(d)}`;
}
const WAREKI: Record<string, number> = { 令和: 2018, 平成: 1988 };

function parseDate(s: string): string | undefined {
  const t = s.normalize("NFKC");
  let m = t.match(/(令和|平成)\s*(\d{1,2}|元)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return toISO(WAREKI[m[1]] + (m[2] === "元" ? 1 : Number(m[2])), Number(m[3]), Number(m[4]));
  m = t.match(/(\d{4})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})/);
  if (m) return toISO(Number(m[1]), Number(m[2]), Number(m[3]));
  return undefined;
}
const parseYen = (s: string) => {
  const n = Number(s.normalize("NFKC").replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n > 0 && n < 10_000_000_000 ? n : undefined;
};

/* ---------- ① Box のメタデータ ---------- */
function str(v: unknown) { return typeof v === "string" && v.trim() ? v.trim() : undefined; }
function findKey(obj: Record<string, unknown>, re: RegExp): unknown {
  for (const [k, v] of Object.entries(obj)) {
    if (re.test(k) && v !== null && v !== "") return v;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = findKey(v as Record<string, unknown>, re);
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}
export function fromBoxMeta(f: Record<string, unknown>): Partial<Extracted> {
  const payeeRaw = findKey(f, /(partner|counterparty|supplier|vendor|client)_?(name)?$|^(trade_)?partner/i);
  const amountRaw = findKey(f, /^(total_)?amount$|amount_?(with_tax|including_tax|total)|^price$/i);
  const dateRaw = findKey(f, /^(transaction|deal|trade)_?date$/i);
  const dueRaw = findKey(f, /due_?date|payment_?(due|deadline)/i);
  const out: Partial<Extracted> = {};
  const p = typeof payeeRaw === "object" && payeeRaw ? str((payeeRaw as Record<string, unknown>).name) : str(payeeRaw);
  if (p) out.payee = p;
  const a = typeof amountRaw === "number" ? amountRaw : typeof amountRaw === "string" ? parseYen(amountRaw) : undefined;
  if (a) out.amount = a;
  const d = typeof dateRaw === "string" ? parseDate(dateRaw) : undefined;
  if (d) out.issue = d;
  const du = typeof dueRaw === "string" ? parseDate(dueRaw) : undefined;
  if (du) out.due = du;
  return out;
}

/* ---------- ② PDF の文字情報から推定 ---------- */
export function fromText(text: string, ownNames: string[]): Partial<Extracted> {
  const t = text.normalize("NFKC").replace(/　/g, " ");
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: Partial<Extracted> = {};

  // 金額：「ご請求金額」「合計」などの近くの金額 → なければ最大の円額
  const amountLabels = /(ご請求金額|御請求金額|請求金額|ご請求額|請求額|お支払金額|税込合計|合計金額|総合計|合計\(税込\)|合計)/;
  for (let i = 0; i < lines.length && !out.amount; i++) {
    if (!amountLabels.test(lines[i])) continue;
    const seg = (lines[i] + " " + (lines[i + 1] ?? "")).replace(amountLabels, " ");
    const m = seg.match(/[¥￥]?\s*([\d,]{3,})\s*(円|-|―)?/);
    if (m) out.amount = parseYen(m[1]);
  }
  if (!out.amount) {
    const all = [...t.matchAll(/[¥￥]\s*([\d,]{3,})|([\d,]{4,})\s*円/g)].map((m) => parseYen(m[1] ?? m[2] ?? "")).filter((n): n is number => !!n);
    if (all.length) out.amount = Math.max(...all);
  }

  // 支払期限
  const dueLabel = /(お支払期限|お支払い期限|支払期限|支払い期限|お振込期限|振込期限|お振込期日|振込期日|支払期日|お支払日|支払予定日|お支払予定日)/;
  for (let i = 0; i < lines.length && !out.due; i++) {
    if (dueLabel.test(lines[i])) out.due = parseDate(lines[i].replace(dueLabel, " ") + " " + (lines[i + 1] ?? ""));
  }
  // 請求日
  const issueLabel = /(請求日|発行日|請求書発行日|日付)/;
  for (let i = 0; i < lines.length && !out.issue; i++) {
    if (issueLabel.test(lines[i])) out.issue = parseDate(lines[i] + " " + (lines[i + 1] ?? ""));
  }

  // 適格請求書の登録番号
  const reg = t.match(/T\s?(\d{13})/);
  if (reg) out.regNo = "T" + reg[1];
  const inv = t.match(/(請求書番号|請求番号|No\.?)\s*[:：]?\s*([A-Za-z0-9\-]{3,30})/);
  if (inv) out.invoiceNo = inv[2];

  // 支払先（発行元）：会社名らしい行のうち、宛名（御中・様）と自社名を除いた最初の行
  const own = ownNames.map((n) => n.normalize("NFKC").replace(/\s/g, ""));
  const corp = /(株式会社|有限会社|合同会社|一般社団法人|一般財団法人|税理士法人|弁護士法人|監査法人|\(株\)|\(有\)|\(同\))/;
  for (const l of lines) {
    if (!corp.test(l) || /御中|様|宛/.test(l)) continue;
    const name = l.replace(/^(発行元|請求元|差出人)\s*[:：]?/, "").replace(/\s*(〒|TEL|Tel|電話|住所|登録番号).*$/, "").trim();
    if (!name || name.length > 40) continue;
    const flat = name.replace(/\s/g, "");
    if (own.some((o) => o && (flat.includes(o) || o.includes(flat)))) continue;
    out.payee = name;
    break;
  }
  return out;
}

export async function pdfText(bytes: Uint8Array): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n") : text;
  } catch {
    return "";
  }
}

/* ---------- ③ AI 読み取り（任意） ---------- */
async function fromAI(bytes: Uint8Array, mime: string): Promise<Partial<Extracted> | null> {
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
      messages: [{
        role: "user",
        content: [
          isPdf ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
                : { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
          { type: "text", text: "これは日本の請求書です。請求書の発行元（支払先）、税込の請求金額、支払期限、請求日、適格請求書の登録番号、請求書番号を読み取り、次のJSONだけを返してください。読めない項目は null。{\"payee\":string|null,\"amount\":number|null,\"due_date\":\"YYYY-MM-DD\"|null,\"issue_date\":\"YYYY-MM-DD\"|null,\"registration_no\":string|null,\"invoice_no\":string|null}" },
        ],
      }],
    }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { content?: { type: string; text?: string }[] };
  const txt = j.content?.find((c) => c.type === "text")?.text ?? "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const out: Partial<Extracted> = {};
    if (str(o.payee)) out.payee = str(o.payee);
    if (typeof o.amount === "number" && o.amount > 0) out.amount = Math.round(o.amount);
    if (typeof o.due_date === "string") out.due = parseDate(o.due_date);
    if (typeof o.issue_date === "string") out.issue = parseDate(o.issue_date);
    if (str(o.registration_no)) out.regNo = str(o.registration_no);
    if (str(o.invoice_no)) out.invoiceNo = str(o.invoice_no);
    return out;
  } catch { return null; }
}

export async function extractInvoice(bytes: Uint8Array, mime: string, boxMeta: Record<string, unknown> | null, ownNames: string[]): Promise<Extracted> {
  const box = boxMeta ? fromBoxMeta(boxMeta) : {};
  const complete = (e: Partial<Extracted>) => !!(e.payee && e.amount && (e.due || e.issue));
  if (complete(box)) return { ...box, method: "box" };

  let text: Partial<Extracted> = {};
  if (mime === "application/pdf") {
    const t = await pdfText(bytes);
    if (t.trim().length > 20) text = fromText(t, ownNames);
  }
  const merged = { ...text, ...box }; // Box に登録済みの値を優先
  if (complete(merged)) return { ...merged, method: Object.keys(box).length ? "box" : "text" };

  const ai = await fromAI(bytes, mime).catch(() => null);
  if (ai) return { ...merged, ...Object.fromEntries(Object.entries(ai).filter(([k]) => !(k in box))), method: "ai" };
  const any = Object.keys(merged).length > 0;
  return { ...merged, method: any ? (Object.keys(box).length ? "box" : "text") : "none", note: any ? "一部のみ読み取り" : (mime === "application/pdf" ? "文字情報の無いPDF（スキャン画像）の可能性があります" : "画像のため自動読み取りできません") };
}
