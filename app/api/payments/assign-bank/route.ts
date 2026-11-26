import { authorize, json } from "@/lib/server";

export const runtime = "nodejs";

/**
 * 銀行の出金明細（出金伝票）から、各支払の振込元口座を特定して payments.bank_account_id に反映する。
 * rows: { bank: 口座の名前（例「三菱UFJ銀行」「みずほ銀行」）, date: YYYY-MM-DD, amount, payee?: 相手先（任意） }
 * - 金額が一致し、日付が近い（±7日）支払に口座を付ける。相手先が書かれていれば名前の近いものを優先
 * - propagate=true のとき、支払先ごとに直近で特定できた口座を、since 以降（明細の無い期間）の支払にも付ける（承認済みは除く）
 * - dryRun=true なら書き込まずに結果だけ返す
 */
interface Row { bank: string; date: string; amount: number; payee?: string }
const nz = (s: string) => s.normalize("NFKC").replace(/[\s()（）株式会社有限会社カ\)ｶ]/g, "").toUpperCase();

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { companyId?: string; rows?: Row[]; propagate?: boolean; dryRun?: boolean; since?: string; defaultBank?: string; defaultSources?: string[] };
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (!a.role || !["owner", "approver"].includes(a.role)) return json({ error: "権限がありません（オーナー・承認者のみ）" }, 403);
  const { admin } = a; const cid = body.companyId!;
  const rows = (body.rows ?? []).slice(0, 3000).filter((r) => r && r.bank && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number(r.amount) > 0);

  const [{ data: banks }, { data: pays }] = await Promise.all([
    admin.from("bank_accounts").select("id, bank_name, branch_name, account_number").eq("company_id", cid),
    admin.from("payments").select("id, due_date, payee_name, amount, status, bank_account_id, source").eq("company_id", cid).neq("status", "cancelled"),
  ]);
  const { data: payees } = await admin.from("payees").select("name, name_kana").eq("company_id", cid);
  const kanaOf = new Map((payees ?? []).filter((p) => p.name_kana).map((p) => [p.name, nz(p.name_kana!)]));
  const bankOf = (name: string) => {
    const k = nz(name);
    return (banks ?? []).find((b) => nz(`${b.bank_name}${b.branch_name ?? ""}${b.account_number ?? ""}`) === k)
      ?? (banks ?? []).find((b) => nz(`${b.bank_name}${b.branch_name ?? ""}`) === k)
      ?? (banks ?? []).filter((b) => nz(b.bank_name) === k || nz(b.bank_name).includes(k) || k.includes(nz(b.bank_name)))[0];
  };
  const day = (s: string) => Date.parse(s + "T00:00:00Z") / 864e5;
  const used = new Set<string>();
  const assign: { id: string; bank: string; payee: string; due: string }[] = [];
  const unknownBank = new Set<string>(); const unmatched: Row[] = [];
  const second: { r: Row; b: { id: string } }[] = [];
  for (const r of rows) {
    const b = bankOf(r.bank);
    if (!b) { unknownBank.add(r.bank); continue; }
    const cands = (pays ?? []).filter((p) => !used.has(p.id) && p.amount === Math.round(Number(r.amount)) && Math.abs(day(p.due_date) - day(r.date)) <= 7);
    if (!cands.length) { second.push({ r, b }); continue; }
    const key = r.payee ? nz(r.payee) : "";
    cands.sort((x, y) => {
      const sx = key && (nz(x.payee_name).includes(key) || key.includes(nz(x.payee_name))) ? 0 : 1;
      const sy = key && (nz(y.payee_name).includes(key) || key.includes(nz(y.payee_name))) ? 0 : 1;
      return sx - sy || Math.abs(day(x.due_date) - day(r.date)) - Math.abs(day(y.due_date) - day(r.date));
    });
    const p = cands[0]; used.add(p.id);
    if (p.bank_account_id !== b.id) assign.push({ id: p.id, bank: b.id, payee: p.payee_name, due: p.due_date });
  }

  // 2回目：金額が一致しない出金（複数の請求書をまとめた振込、手数料差引など）は相手先名で照合
  // 相手先のカナ（支払先マスタの受取人名カナ）や、よくある摘要の言い換えで支払先を特定し、±10日の支払に口座を付ける
  const ALIAS: [RegExp, RegExp][] = [
    [/ｷﾕｳﾖ|給与/, /給与/], [/ｺｸｾﾞｲ|ﾆﾎﾝﾊﾞｼｾﾞｲﾑｼﾖ/, /国税|源泉|法人税/], [/ﾁﾎｳｾﾞｲ|チホウゼイ/, /地方税|住民税|事業税/],
    [/ｼﾔｶｲﾎｹﾝ/, /社会保険/], [/ﾛｳﾄﾞｳﾎｹﾝ|ロウドウホケン/, /労働保険/], [/金融公庫/, /金融公庫/], [/ｺﾞﾍﾝｻｲ/, /借入返済|返済/],
    [/ﾃｽｳﾘﾖｳ|ﾋﾞｼﾞﾈｽｻｲﾄ/, /銀行手数料（みずほ/], [/ＢＺ手数料|振込手数料|BZ手数料/, /銀行手数料（三菱UFJ/], [/コテイシサンゼイ/, /固定資産税/],
    [/ゼイリシ/, /税理士/],
  ];
  for (const { r, b } of second) {
    const key = nz(r.payee ?? "");
    const alias = ALIAS.find(([re]) => re.test(r.payee ?? ""))?.[1];
    const names = new Set((pays ?? []).map((p) => p.payee_name).filter((n) => {
      if (alias) return alias.test(n);
      if (key.length < 3) return false;
      const k = kanaOf.get(n); const nn = nz(n);
      return (k && (k.includes(key) || key.includes(k))) || nn.includes(key) || (nn.length >= 3 && key.includes(nn));
    }));
    if (!names.size) { unmatched.push(r); continue; }
    const hits = (pays ?? []).filter((p) => names.has(p.payee_name) && !used.has(p.id) && Math.abs(day(p.due_date) - day(r.date)) <= 10);
    if (!hits.length) { unmatched.push(r); continue; }
    for (const p of hits) { used.add(p.id); if (p.bank_account_id !== b.id) assign.push({ id: p.id, bank: b.id, payee: p.payee_name, due: p.due_date }); }
  }

  // 支払先ごとの直近の振込元 → 今後の未払いへ
  const prop: { id: string; bank: string; payee: string; due: string }[] = [];
  if (body.propagate) {
    const latest = new Map<string, { bank: string; due: string }>();
    const matchedIds = new Set(used);
    for (const p of pays ?? []) {
      if (!matchedIds.has(p.id)) continue;
      const bank = assign.find((x) => x.id === p.id)?.bank ?? p.bank_account_id!;
      const cur = latest.get(p.payee_name);
      if (bank && (!cur || p.due_date > cur.due)) latest.set(p.payee_name, { bank, due: p.due_date });
    }
    // since 以降（＝明細がまだ無い期間）の支払に引き継ぐ。指定が無ければ今日以降の未払い
    const since = body.since && /^\d{4}-\d{2}-\d{2}$/.test(body.since) ? body.since : new Date().toISOString().slice(0, 10);
    for (const p of pays ?? []) {
      const l = latest.get(p.payee_name);
      if (!l || used.has(p.id) || p.due_date < since || p.status === "approved" || (!body.since && p.status === "paid") || p.bank_account_id === l.bank) continue;
      prop.push({ id: p.id, bank: l.bank, payee: p.payee_name, due: p.due_date });
    }
  }

  // 履歴の無い支払先：指定の取込元（例：請求書）で口座が未設定のものに既定の口座を付ける
  if (body.defaultBank) {
    const b = bankOf(body.defaultBank);
    const since = body.since ?? new Date().toISOString().slice(0, 10);
    const done = new Set([...assign, ...prop].map((x) => x.id));
    if (b) for (const p of pays ?? []) {
      if (p.bank_account_id || done.has(p.id) || p.due_date < since || p.status === "approved") continue;
      if (body.defaultSources?.length && !body.defaultSources.includes(p.source)) continue;
      prop.push({ id: p.id, bank: b.id, payee: p.payee_name, due: p.due_date });
    }
  }

  if (!body.dryRun) {
    const byBank = new Map<string, string[]>();
    for (const x of [...assign, ...prop]) byBank.set(x.bank, [...(byBank.get(x.bank) ?? []), x.id]);
    for (const [bank, ids] of byBank) {
      for (let i = 0; i < ids.length; i += 200) {
        const { error } = await admin.from("payments").update({ bank_account_id: bank }).in("id", ids.slice(i, i + 200));
        if (error) return json({ error: error.message }, 500);
      }
    }
    await admin.from("audit_logs").insert({ company_id: cid, actor: a.user.id, action: "update", table_name: "payments", detail: { assign_bank: assign.length, propagated: prop.length } });
  }
  const bankName = new Map((banks ?? []).map((b) => [b.id, `${b.bank_name}${b.branch_name ? " " + b.branch_name : ""}`]));
  const summary = (xs: typeof assign) => Object.entries(xs.reduce<Record<string, number>>((m, x) => { const k = bankName.get(x.bank) ?? x.bank; m[k] = (m[k] ?? 0) + 1; return m; }, {}));
  return json({ ok: true, dryRun: !!body.dryRun, matched: used.size, assigned: assign.length, propagated: prop.length, byBank: summary(assign), propByBank: summary(prop), unknownBank: [...unknownBank], unmatched: unmatched.slice(0, 200), unmatchedCount: unmatched.length, banks: banks?.map((b) => bankName.get(b.id)) });
}
