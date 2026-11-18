const WD = ["日", "月", "火", "水", "木", "金", "土"];

export const yen = (n: number) => "¥" + Math.round(n).toLocaleString("ja-JP");

export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) + "%" : "0%");

/** "YYYY-MM-DD" をローカル日付として読む（タイムゾーンずれ防止） */
export function parseDate(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function toISO(d: Date): string {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

export const md = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
export const wd = (d: Date) => WD[d.getDay()];
export const ymLabel = (d: Date) => `${d.getFullYear()}年${d.getMonth() + 1}月`;
export const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
export const sameMonth = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

export function todayLabel(): string {
  const t = new Date();
  return `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日（${wd(t)}）`;
}

export const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
