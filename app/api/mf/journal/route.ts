import { authorize, json } from "@/lib/server";
import { MfNotConnected, mfApi, mfConfig } from "@/lib/mf";

interface AccountMap { titles?: Record<string, string>; banks?: Record<string, string> }

/**
 * 支払済みの支払予定から、支払仕訳（借方：買掛金/未払金など ／ 貸方：預金）を MF クラウド会計に登録する。
 * 二重登録防止：mf_payment_claim で none/error → syncing に変えられたものだけ処理し、成功時に done と仕訳IDを記録。
 */
export async function POST(req: Request) {
  const cfg = mfConfig();
  if (!cfg) return json({ error: "マネーフォワードAPIの接続情報が未設定です" }, 501);
  const body = await req.json().catch(() => ({}));
  const a = await authorize(req, body.companyId);
  if ("error" in a) return json({ error: a.error }, a.status);
  if (a.role !== "owner" && a.role !== "approver") return json({ error: "仕訳の登録はオーナーまたは承認者のみできます" }, 403);
  const ids: string[] = Array.isArray(body.paymentIds) ? body.paymentIds.filter((x: unknown) => typeof x === "string").slice(0, 50) : [];
  if (!ids.length) return json({ error: "対象がありません" }, 400);

  const [{ data: company }, { data: pays }] = await Promise.all([
    a.admin.from("companies").select("mf_account_map").eq("id", body.companyId).single(),
    a.admin.from("payments").select("id,company_id,due_date,payee_name,item,amount,account_title,bank_account_id,status,mf_sync_status").eq("company_id", body.companyId).in("id", ids),
  ]);
  const map = (company?.mf_account_map ?? {}) as AccountMap;
  const results: { id: string; ok: boolean; message?: string }[] = [];

  for (const p of pays ?? []) {
    if (p.status !== "paid") { results.push({ id: p.id, ok: false, message: "支払済みのものだけ登録できます" }); continue; }
    const debit = map.titles?.[p.account_title];
    const credit = p.bank_account_id ? map.banks?.[p.bank_account_id] : undefined;
    if (!debit || !credit) { results.push({ id: p.id, ok: false, message: "勘定科目の対応表が未設定です（設定 › マネーフォワード連携）" }); continue; }
    const { data: claimed } = await a.admin.rpc("mf_payment_claim", { pid: p.id });
    if (!claimed) { results.push({ id: p.id, ok: false, message: "登録済み、または処理中です" }); continue; }
    try {
      const res = await mfApi<Record<string, unknown>>(cfg, a.admin, body.companyId, "/journals", {
        method: "POST",
        // 会計API v3：本文は { journal: {...} } で包む。明細は debitor / creditor（税込額を value に）
        body: JSON.stringify({
          journal: {
            transaction_date: p.due_date,
            journal_type: "journal_entry",
            branches: [{ debitor: { account_id: debit, value: p.amount }, creditor: { account_id: credit, value: p.amount }, remark: `${p.payee_name} ${p.item ?? ""}`.trim().slice(0, 100) }],
          },
        }),
      });
      const j = (res?.journal ?? res) as Record<string, unknown>;
      const jid = String(j?.id ?? "");
      await a.admin.from("payments").update({ mf_sync_status: "done", mf_journal_id: jid || null, mf_synced_at: new Date().toISOString(), mf_sync_error: null }).eq("id", p.id);
      results.push({ id: p.id, ok: true });
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      await a.admin.from("payments").update({ mf_sync_status: "error", mf_sync_error: msg }).eq("id", p.id);
      results.push({ id: p.id, ok: false, message: msg });
      if (e instanceof MfNotConnected) break;
    }
  }
  await a.admin.from("audit_logs").insert({ company_id: body.companyId, actor: a.user.id, action: "insert", table_name: "mf_journals", detail: { results } });
  await a.admin.from("mf_connections").update({ last_synced_at: new Date().toISOString() }).eq("company_id", body.companyId);
  const ok = results.filter((r) => r.ok).length;
  return json({ ok: true, created: ok, results });
}
