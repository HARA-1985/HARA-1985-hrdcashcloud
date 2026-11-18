/**
 * クラウドBoxのファイル名から支払情報を読み取る。
 * 例：_【1126振替】ヤマト運輸請求書-01_20261031(14460)人形町.pdf
 *     → 振替日 11/26・口座振替・ヤマト運輸・14,460円・人形町
 * 貼り付け形式：1行1ファイル「BoxファイルID|場所(フォルダ名)|ファイル名」
 */
export interface BoxRow { boxId: string; folder: string; fileName: string }
export interface ParsedPay {
  boxId: string; folder: string; fileName: string;
  due: string | null; method: "振替" | "振込" | null; payee: string; item: string; amount: number | null;
  skip?: string; // 取り込まない理由
}

const z2h = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/，/g, ",");

export function parseRows(text: string): BoxRow[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [boxId, folder, ...rest] = l.split("|");
    return { boxId: (boxId ?? "").trim(), folder: (folder ?? "").trim(), fileName: rest.join("|").trim() };
  }).filter((r) => /^[0-9a-f-]{36}$/i.test(r.boxId) && r.fileName);
}

export function parseBoxName(r: BoxRow, year: number): ParsedPay {
  const raw = z2h(r.fileName);
  const base: ParsedPay = { ...r, due: null, method: null, payee: "", item: "", amount: null };
  if (!/\.(pdf|png|jpe?g)$/i.test(raw)) return { ...base, skip: "PDF・画像以外" };
  const name = raw.replace(/\.[^.]+$/, "");
  // 振替日・方法：【1126振替】／【1031振込・源泉あり】／(10.31振込)
  const m = name.match(/[【(（]\s*(\d{1,2})\.?(\d{2})\s*(?:までに)?\s*(振替|振込)[^】]*?[】)）]/);
  if (!m) return { ...base, skip: "振替日・振込日の記載なし" };
  const mm = Number(m[1]), dd = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return { ...base, skip: "日付が読めない" };
  const due = `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const method = m[3] as "振替" | "振込";
  if (/送金|小口用/.test(name)) return { ...base, due, method, skip: "口座間の資金移動" };
  if (/後日.{0,12}カードで引落/.test(name)) return { ...base, due, method, skip: "カード引落に含まれる" };

  // 金額：末尾側の括弧内の数字（「1021297円+52800円」は合算）
  let amount: number | null = null;
  const groups = [...name.matchAll(/[(（]([\d,円+\s]+)[)）]/g)].map((g) => g[1]).filter((g) => /\d/.test(g));
  const cand = groups.reverse().find((g) => /円/.test(g) || /^\s*[\d,]{3,}\s*$/.test(g));
  if (cand) {
    const nums = cand.split("+").map((s) => Number(s.replace(/[^\d]/g, ""))).filter((n) => n > 0);
    if (nums.length) amount = nums.reduce((a, b) => a + b, 0);
  }
  // 「（137000円）」が括弧外にあるケース：〜137000円(…)
  if (amount == null) { const g = name.match(/(\d[\d,]{2,})円/); if (g) amount = Number(g[1].replace(/,/g, "")); }

  // 支払先：】の後ろから、請求書・○月分・日付・括弧の手前まで
  let rest = name.slice((m.index ?? 0) + m[0].length).replace(/^[_\s]+/, "").replace(/^\d{6}_/, "");
  rest = rest.replace(/株式会社リージャー様?/g, "");
  const stop = rest.search(/(\d{1,2}[-・]?\d{0,2}月分|請求書|支払通知書|ご請求|\d{4}年|\d{8}|保険料納入|に係る|\d{3,}円|[(（_]|\s)/);
  let payee = (stop > 0 ? rest.slice(0, stop) : rest).trim();
  if (!payee) payee = rest.slice(0, 20).trim();
  const item = rest.replace(/\d{8,9}/g, "").replace(/[(（][\d,円+\s]+[)）]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (amount == null) return { ...base, due, method, payee, item, skip: "金額の記載なし" };
  return { ...base, due, method, payee, item, amount };
}

/** フォルダ名から固定費／臨時の初期値 */
export const kindOfFolder = (folder: string): "fixed" | "spot" =>
  /引落|システム部|事務所|契約書|報酬/.test(folder) ? "fixed" : "spot";
