import type { Dispatch, SetStateAction } from "react";
import type { BankAccount, CardTx, Company, Doc, MfConnection, Payee, Payment, Profile, Role } from "@/lib/types";

export type Screen = "dashboard" | "monthly" | "schedule" | "invoice" | "expense" | "card" | "fb" | "folders" | "settings";

export interface Ctx {
  userId: string;
  me: Profile | null;
  company: Company;
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
