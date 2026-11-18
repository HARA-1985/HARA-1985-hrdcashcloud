"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { sb, supabaseConfigured } from "@/lib/supabase";
import type { BankAccount, CardTx, Company, Doc, Membership, MfConnection, Payee, Payment, Profile, Role } from "@/lib/types";
import { todayLabel } from "@/lib/format";
import Icon from "./Icon";
import Login from "./Login";
import type { Ctx, Screen } from "./ctx";
import Dashboard from "./screens/Dashboard";
import Monthly from "./screens/Monthly";
import Schedule from "./screens/Schedule";
import Upload from "./screens/Upload";
import Cards from "./screens/Cards";
import Fb from "./screens/Fb";
import Folders from "./screens/Folders";
import Settings from "./screens/Settings";
import DocViewer from "./DocViewer";

const NAV: [Screen, string][] = [
  ["dashboard", "ダッシュボード"], ["monthly", "月別推移"], ["schedule", "支払予定"], ["invoice", "請求書"],
  ["expense", "立替経費"], ["card", "クレジットカード"], ["fb", "FBデータ"], ["folders", "書類フォルダ"], ["settings", "設定"],
];
const TITLES: Record<Screen, string> = {
  dashboard: "資金繰りダッシュボード", monthly: "月別推移", schedule: "支払予定", invoice: "請求書を登録", expense: "立替経費を登録",
  card: "クレジットカード（マネーフォワード連携）", fb: "FBデータ作成", folders: "書類フォルダ", settings: "設定",
};

const store = {
  get(k: string) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { window.localStorage.setItem(k, v); } catch { /* noop */ } },
};

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<Profile | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [members, setMembers] = useState<Membership[]>([]);
  const [cid, setCid] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [payments, setPayments] = useState<Payment[]>([]);
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [cards, setCards] = useState<CardTx[]>([]);
  const [mf, setMf] = useState<MfConnection | null>(null);
  const [loading, setLoading] = useState(false);
  const [toastMsg, setToast] = useState<{ m: string; err?: boolean } | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((m: string, err = false) => {
    setToast({ m, err });
    if (tRef.current) clearTimeout(tRef.current);
    tRef.current = setTimeout(() => setToast(null), err ? 5000 : 2600);
  }, []);

  /* --- マネーフォワード連携から戻ってきたとき --- */
  useEffect(() => {
    const u = new URL(window.location.href);
    const r = u.searchParams.get("mf");
    if (!r) return;
    const msg = u.searchParams.get("mf_msg");
    if (r === "connected") { toast("マネーフォワードと連携しました"); setScreen("settings"); }
    else toast(msg || "マネーフォワード連携に失敗しました", true);
    u.searchParams.delete("mf"); u.searchParams.delete("mf_msg");
    window.history.replaceState(null, "", u.pathname + u.search);
  }, [toast]);

  /* --- auth --- */
  useEffect(() => {
    if (!supabaseConfigured()) { setSession(null); return; }
    sb().auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb().auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  /* --- 所属会社の読み込み --- */
  const loadOrg = useCallback(async () => {
    if (!session) return;
    await sb().rpc("bootstrap");
    const [p, c, m] = await Promise.all([
      sb().from("profiles").select("id,display_name,email,is_hrd_staff").eq("id", session.user.id).single(),
      sb().from("companies").select("id,name,name_kana,kind,mf_plan,mf_account_map").order("kind", { ascending: true }).order("name"),
      sb().from("memberships").select("company_id,user_id,role").eq("user_id", session.user.id),
    ]);
    setMe((p.data as Profile) ?? null);
    const list = (c.data as Company[]) ?? [];
    setCompanies(list);
    setMembers((m.data as Membership[]) ?? []);
    const saved = store.get("hrd.cid");
    setCid((cur) => (cur && list.some((x) => x.id === cur) ? cur : saved && list.some((x) => x.id === saved) ? saved : list[0]?.id ?? null));
  }, [session]);
  useEffect(() => { loadOrg(); }, [loadOrg]);

  /* --- 会社のデータ --- */
  const reload = useCallback(async () => {
    if (!cid) return;
    setLoading(true);
    const c = sb();
    const [pay, bk, pe, dc, cd, mfc] = await Promise.all([
      c.from("payments").select("*").eq("company_id", cid).neq("status", "cancelled").order("due_date"),
      c.from("bank_accounts").select("*").eq("company_id", cid).order("created_at"),
      c.from("payees").select("*").eq("company_id", cid).order("name"),
      c.from("documents").select("*").eq("company_id", cid).order("created_at", { ascending: false }),
      c.from("card_transactions").select("*").eq("company_id", cid).order("used_on", { ascending: false }).limit(200),
      c.from("mf_connections").select("*").eq("company_id", cid).maybeSingle(),
    ]);
    const err = [pay, bk, pe, dc, cd].find((r) => r.error);
    if (err?.error) toast("読み込みに失敗しました：" + err.error.message, true);
    setPayments((pay.data as Payment[]) ?? []);
    setBanks((bk.data as BankAccount[]) ?? []);
    setPayees((pe.data as Payee[]) ?? []);
    setDocs((dc.data as Doc[]) ?? []);
    setCards((cd.data as CardTx[]) ?? []);
    setMf((mfc.data as MfConnection) ?? null);
    setLoading(false);
  }, [cid, toast]);
  useEffect(() => { if (cid) { store.set("hrd.cid", cid); reload(); } }, [cid, reload]);

  const company = companies.find((x) => x.id === cid) ?? null;
  const role: Role | null = me?.is_hrd_staff ? "owner" : (members.find((m) => m.company_id === cid)?.role ?? null);

  const ctx: Ctx | null = useMemo(() => {
    if (!session || !company || !role) return null;
    return {
      userId: session.user.id, me, company, role, isHrd: !!me?.is_hrd_staff,
      canWrite: role !== "viewer", canApprove: role === "owner" || role === "approver", isOwner: role === "owner",
      payments, banks, payees, docs, cards, mf, loading, q,
      reload, reloadOrg: loadOrg, toast, go: setScreen, openDoc: setDocId, setPayments,
    };
  }, [session, company, role, me, payments, banks, payees, docs, cards, mf, loading, q, reload, loadOrg, toast]);

  if (!supabaseConfigured()) {
    return <div className="login-wrap"><div className="login"><h1 style={{ fontSize: 20 }}>設定が必要です</h1><p className="muted">環境変数 NEXT_PUBLIC_SUPABASE_URL と NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください。</p></div></div>;
  }
  if (session === undefined) return <div className="login-wrap" aria-busy="true" />;
  if (!session) return <Login />;

  const wait = payments.filter((p) => p.status === "pending").length;

  return (
    <div className="shell">
      <nav className="side" aria-label="メインメニュー">
        <div className="brand">
          <div className="logo">HRD</div>
          <div className="stack" style={{ gap: 2 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>HRD資金繰りクラウド</span>
            <span style={{ fontSize: 11, color: "#A9ACB4" }}>{me?.is_hrd_staff ? "HRD管理者" : role ? "顧問先ユーザー" : ""}</span>
          </div>
        </div>
        {companies.length > 0 && (
          <label className="stack" style={{ gap: 6 }}>
            <span style={{ fontSize: 11, color: "#A9ACB4", padding: "0 4px" }}>会社</span>
            <select className="co-select" value={cid ?? ""} onChange={(e) => { setCid(e.target.value); setScreen("dashboard"); }}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.kind === "hrd" ? "★ " : ""}{c.name}</option>)}
            </select>
          </label>
        )}
        <div className="stack" style={{ gap: 4 }}>
          {NAV.map(([k, label]) => (
            <button key={k} type="button" className={"nav-btn" + (screen === k ? " is-active" : "")} onClick={() => setScreen(k)} disabled={!ctx} aria-current={screen === k ? "page" : undefined}>
              <Icon name={k} />
              <span className="grow">{label}</span>
              {k === "schedule" && wait > 0 && <span className="badge num">{wait}</span>}
            </button>
          ))}
        </div>
        <div className="side-note">
          <span style={{ fontSize: 11, color: "#A9ACB4" }}>原本の保管先</span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>マネーフォワード クラウドBox{mf?.status === "connected" ? "（連携中）" : "（未連携）"}</span>
        </div>
        <button type="button" className="nav-btn" onClick={() => sb().auth.signOut()}><Icon name="logout" /><span className="grow">ログアウト</span></button>
      </nav>

      <main className="main">
        <header className="row wrap" style={{ gap: 16 }}>
          <div className="stack" style={{ gap: 4, flex: "1 1 260px" }}>
            <span className="lbl">{todayLabel()}{company ? ` ・ ${company.name}` : ""}</span>
            <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-.01em" }}>{TITLES[screen]}</h1>
          </div>
          <div style={{ position: "relative", flex: "0 1 320px", minWidth: 200 }}>
            <span style={{ position: "absolute", left: 13, top: 13 }}><Icon name="search" color="#5B5F68" /></span>
            <label htmlFor="q" className="sr">相手先・内容で検索</label>
            <input id="q" className="inp srch" type="search" placeholder="相手先・内容で検索" value={q} onChange={(e) => { setQ(e.target.value); if (e.target.value && screen !== "schedule") setScreen("schedule"); }} />
          </div>
          {ctx?.canWrite && (
            <button type="button" className="btn btn-primary" onClick={() => setScreen("invoice")}><Icon name="plus" size={16} width={2.2} />書類を登録</button>
          )}
        </header>

        {!ctx && companies.length === 0 && (
          <div className="card empty">
            まだ利用できる会社がありません。<br />HRD総合事務所から招待を受けると、ここに会社が表示されます。
          </div>
        )}
        {ctx && screen === "dashboard" && <Dashboard ctx={ctx} />}
        {ctx && screen === "monthly" && <Monthly ctx={ctx} />}
        {ctx && screen === "schedule" && <Schedule ctx={ctx} />}
        {ctx && (screen === "invoice" || screen === "expense") && <Upload key={screen} ctx={ctx} mode={screen} />}
        {ctx && screen === "card" && <Cards ctx={ctx} />}
        {ctx && screen === "fb" && <Fb ctx={ctx} />}
        {ctx && screen === "folders" && <Folders ctx={ctx} />}
        {ctx && screen === "settings" && <Settings ctx={ctx} />}
      </main>

      {ctx && docId && <DocViewer ctx={ctx} docId={docId} onClose={() => setDocId(null)} />}
      {toastMsg && (
        <div role="status" className={"toast" + (toastMsg.err ? " err" : "")}>
          {!toastMsg.err && <Icon name="check" color="#7BE0A4" width={2.4} />}{toastMsg.m}
        </div>
      )}
    </div>
  );
}
