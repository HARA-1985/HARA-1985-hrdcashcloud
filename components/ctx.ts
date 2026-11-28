import type { Dispatch, SetStateAction } from "react";
import type { AccessStatus, BankAccount, CardTx, Company, Doc, FirmClient, MfConnection, Payee, Payment, Profile, Role } from "@/lib/types";

export type Screen = "dashboard" | "monthly" | "schedule" | "invoice" | "expense" | "card" | "fb" | "folders" | "settings" | "clients" | "billing" | "admin";

export interface Ctx {
  userId: string;
  me: Profile | null;
  company: Company;
  /** 自分が見られる会社（顧問先・つながっている会計事務所を含む） */
  companies: Company[];
  firmClients: FirmClient[];
  /** 無料期間・サブスクの状態（HRD管理者は常に利用可） */
  access: AccessStatus | null;
  selectCompany: (id: string) => void;
  role: Role;
  isHrd: boolean;
  canWrite: boolean;
  canApprove: boolean;
  isOwner: boolean;
  payments: Payment[];
  banks: BankAccount[];
  payees: Payee[];
  docs: Doc[];
  cards: CardTx[];
  mf: MfConnection | null;
  loading: boolean;
  q: string;
  reload: () => Promise<void>;
  reloadOrg: () => Promise<void>;
  toast: (m: string, err?: boolean) => void;
  go: (s: Screen) => void;
  openDoc: (id: string) => void;
  setPayments: Dispatch<SetStateAction<Payment[]>>;
}
