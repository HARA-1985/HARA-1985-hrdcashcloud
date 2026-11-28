export type Role = "owner" | "approver" | "member" | "viewer";
export type Kind = "fixed" | "spot";
export type Source = "invoice" | "expense" | "card" | "manual";
export type PayStatus = "pending" | "approved" | "auto_debit" | "paid" | "cancelled";

export interface MfAccountMap { titles?: Record<string, string>; banks?: Record<string, string> }
export type CompanyKind = "hrd" | "accounting_firm" | "client";
export interface Company {
  id: string; name: string; name_kana: string | null; kind: CompanyKind; mf_plan: string | null; mf_account_map?: MfAccountMap | null;
  trial_ends_at?: string | null; firm_code?: string | null; managed_by_firm_id?: string | null;
  suspended_at?: string | null; billing_exempt?: boolean; fiscal_start_month?: number;
}
export interface FirmClient { firm_id: string; company_id: string; status: "active" | "revoked"; created_at?: string }
/** active：契約中（無料扱い含む）／trial：無料期間中／covered_by_firm：会計事務所の契約で利用中／expired：期限切れ／suspended：利用停止中 */
export type AccessStatus = "active" | "trial" | "covered_by_firm" | "expired" | "suspended";
export interface Plan { code: string; company_kind: "accounting_firm" | "client"; name: string; monthly_price_jpy: number; per_client_price_jpy: number; stripe_price_id: string | null }
export interface Subscription { company_id: string; plan_code: string | null; status: string; current_period_end: string | null; cancel_at_period_end: boolean; client_quantity: number }
export const KIND_LABEL: Record<CompanyKind, string> = { hrd: "HRD総合事務所（会計事務所）", accounting_firm: "会計事務所", client: "企業" };
/** 会計事務所として顧問先を持てる種別 */
export const isFirmKind = (k: CompanyKind | undefined) => k === "accounting_firm" || k === "hrd";
export interface Profile { id: string; display_name: string | null; email: string | null; is_hrd_staff: boolean }
export interface Membership { company_id: string; user_id: string; role: Role }

export interface BankAccount {
  id: string; company_id: string; bank_name: string; bank_code: string | null; bank_kana: string | null;
  branch_code: string | null; branch_name: string | null; branch_kana: string | null;
  account_type: string; account_number: string | null; holder_kana: string | null; client_code: string | null;
}

export interface Payee {
  id: string; company_id: string; name: string; name_kana: string | null;
  bank_code: string | null; bank_kana: string | null; branch_code: string | null; branch_kana: string | null;
  account_type: string | null; account_number: string | null;
}

export interface Doc {
  id: string; company_id: string; doc_type: "invoice" | "receipt" | "card_statement" | "other";
  file_name: string; mime_type: string | null; size_bytes: number | null; temp_path: string | null;
  mf_box_file_id: string | null; mf_box_status: "pending" | "stored" | "failed";
  folder_month: string | null; account_title: string | null; created_at: string;
}

export interface Payment {
  id: string; company_id: string; due_date: string; payee_id: string | null; payee_name: string; item: string | null;
  amount: number; kind: Kind; source: Source; bank_account_id: string | null; account_title: string; cf_item?: string | null;
  status: PayStatus; document_id: string | null; approved_at: string | null; created_at: string;
  mf_sync_status?: "none" | "syncing" | "done" | "error"; mf_sync_error?: string | null; mf_journal_id?: string | null;
}

export interface CardTx {
  id: string; card_name: string; used_on: string; merchant: string; amount: number;
  suggested_account: string | null; receipt_document_id: string | null;
}

export interface MfConnection { company_id: string; status: "disconnected" | "connected" | "error"; office_name: string | null; office_code?: string | null; last_synced_at: string | null; connected_at?: string | null; last_error?: string | null }

export interface AuditLog { id: number; actor: string | null; action: string; table_name: string; record_id: string | null; created_at: string }

export const ACCOUNT_TITLES = ["買掛金", "未払金", "未払費用", "預り金", "未払法人税等"] as const;

export const STATUS_LABEL: Record<PayStatus, string> = {
  pending: "承認待ち", approved: "承認済", auto_debit: "自動引落", paid: "支払済", cancelled: "取消",
};
export const STATUS_CLS: Record<PayStatus, string> = {
  pending: "chip st-wait", approved: "chip st-ok", auto_debit: "chip st-auto", paid: "chip st-auto", cancelled: "chip st-err",
};
export const SOURCE_LABEL: Record<Source, string> = { invoice: "請求書", expense: "立替経費", card: "カード", manual: "手入力" };
export const ROLE_LABEL: Record<Role, string> = { owner: "オーナー", approver: "承認者", member: "担当者", viewer: "閲覧のみ" };
