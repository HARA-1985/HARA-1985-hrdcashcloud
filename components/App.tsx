"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { sb, supabaseConfigured } from "@/lib/supabase";
import { KIND_LABEL, isFirmKind, type AccessStatus, type BankAccount, type CardTx, type Company, type Doc, type FirmClient, type Membership, type MfConnection, type Payee, type Payment, type Profile, type Role } from "@/lib/types";
import { todayLabel } from "@/lib/format";
import Icon from "./Icon";
import Login from "./Login";
import Onboarding from "./Onboarding";
import type { SignupKind } from "./Login";
import { MfaChallenge } from "./Mfa";
import type { Ctx, Screen } from "./ctx";
import Dashboard from "./screens/Dashboard";
import Monthly from "./screens/Monthly";
import Schedule from "./screens/Schedule";
import Upload from "./screens/Upload";
import Cards from "./screens/Cards";
import Fb from "./screens/Fb";
import Folders from "./screens/Folders";
import Settings from "./screens/Settings";
import Clients from "./screens/Clients";
import Billing, { daysLeft } from "./screens/Billing";
import Admin from "./screens/Admin";
import Budget from "./screens/Budget";
import Accounts from "./screens/Accounts";
import DocViewer from "./DocViewer";

const NAV: [Screen, string][] = [
  ["dashboard", "ダッシュボード"], ["monthly", "月別推移"], ["schedule", "支払予定"], ["invoice", "請求書"],
  ["expense", "立替経費"], ["card", "クレジットカード"], ["fb", "FBデータ"], ["folders", "書類フォルダ"], ["settings", "設定"],
];
/** 操作がないまま一定時間たったら自動でログアウト（共有PC・席を離れたときの対策） */
const IDLE_LIMIT_MS = 30 * 60 * 1000;
/** 期限切れでも開ける画面 */
const ALWAYS_OPEN: Screen[] = ["billing", "clients", "admin"];
const ROLE_ORDER: Role[] = ["owner", "approver", "member", "viewer"];
const TITLES: Record<Screen, string> = {
  dashboard: "資金繰りダッシュボード", monthly: "月別推移", schedule: "支払予定", invoice: "請求書を登録", expense: "立替経費を登録",
  card: "クレジットカード（マネーフォワード連携）", fb: "FBデータ作成", folders: "書類フォルダ", settings: "設定",
  clients: "顧問先", billing: "プラン・お支払い", admin: "HRD管理（全アカウント）",
  budget: "予算（入力・予算実績比較・次年度予算案）", accounts: "アカウントと権限",
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
  const [firmClients, setFirmClients] = useState<FirmClient[]>([]);
  const [orgLoaded, setOrgLoaded] = useState(false);
  const [access, setAccess] = useState<AccessStatus | null>(null);
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

  /* --- Stripe の申し込み画面から戻ってきたとき --- */
  useEffect(() => {
    const u = new URL(window.location.href);
    const r = u.searchParams.get("billing");
    if (!r) return;
    if (r === "success") toast("お申し込みありがとうございます。反映まで数秒かかることがあります");
    setScreen("billing");
    u.searchParams.delete("billing");
    window.history.replaceState(null, "", u.pathname + u.search);
  }, [toast]);

  /* --- auth --- */
  const [mfaOk, setMfaOk] = useState<boolean | null>(null);
  useEffect(() => {
    if (!supabaseConfigured()) { setSession(null); return; }
    sb().auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb().auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  /* --- 2段階認証：設定済みの人は確認コードを入力するまで先に進めない --- */
  const checkMfa = useCallback(async () => {
    if (!session) { setMfaOk(null); return; }
    const { data } = await sb().auth.mfa.getAuthenticatorAssuranceLevel();
    setMfaOk(!(data && data.nextLevel === "aal2" && data.currentLevel !== "aal2"));
  }, [session]);
  useEffect(() => { checkMfa(); }, [checkMfa]);

  /* --- 一定時間操作がなければ自動ログアウト --- */
  useEffect(() => {
    if (!session) return;
    let last = Date.now();
    const touch = () => { last = Date.now(); };
    const evs = ["mousemove", "keydown", "pointerdown", "scroll", "touchstart"];
    evs.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const timer = setInterval(async () => {
      if (Date.now() - last > IDLE_LIMIT_MS) {
        await sb().auth.signOut();
        window.alert("30分間操作がなかったため、安全のためログアウトしました。");
      }
    }, 60 * 1000);
    return () => { evs.forEach((e) => window.removeEventListener(e, touch)); clearInterval(timer); };
  }, [session]);

  /* --- 所属会社の読み込み --- */
  const loadOrg = useCallback(async () => {
    if (!session || !mfaOk) return;
    await sb().rpc("bootstrap");
    const [p, c, m, f] = await Promise.all([
      sb().from("profiles").select("id,display_name,email,is_hrd_staff").eq("id", session.user.id).single(),
      sb().from("companies").select("id,name,name_kana,kind,mf_plan,mf_account_map,trial_ends_at,firm_code,managed_by_firm_id,suspended_at,billing_exempt,fiscal_start_month").order("kind", { ascending: true }).order("name"),
      sb().from("memberships").select("company_id,user_id,role").eq("user_id", session.user.id),
      sb().from("firm_clients").select("firm_id,company_id,status,created_at"),
    ]);
    const prof = (p.data as Profile) ?? null;
    setMe(prof);
    const all = (c.data as Company[]) ?? [];
    const mem = (m.data as Membership[]) ?? [];
    const links = (f.data as FirmClient[]) ?? [];
    setCompanies(all);
    setMembers(mem);
    setFirmClients(links);
    setOrgLoaded(true);
    // 切り替えメニューに出すのは、自分が役割を持つ会社（直接の所属 or 会計事務所経由）
    const mine = new Set(mem.map((x) => x.company_id));
    const usable = prof?.is_hrd_staff ? all : all.filter((x) => mine.has(x.id) || links.some((l) => l.status === "active" && l.company_id === x.id && mine.has(l.firm_id)));
    const saved = store.get("hrd.cid");
    setCid((cur) => (cur && usable.some((x) => x.id === cur) ? cur : saved && usable.some((x) => x.id === saved) ? saved : usable[0]?.id ?? null));
  }, [session, mfaOk]);
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

  /* --- 無料期間・サブスクの状態 --- */
  const loadAccess = useCallback(async () => {
    if (!cid) { setAccess(null); return; }
    const { data } = await sb().rpc("access_status", { p_company: cid });
    setAccess((data as AccessStatus) ?? null);
  }, [cid]);
  useEffect(() => { loadAccess(); }, [loadAccess, companies]);

  const isHrd = !!me?.is_hrd_staff;
  const mySet = useMemo(() => new Set(members.map((m) => m.company_id)), [members]);
  const switchable = useMemo(() => isHrd ? companies : companies.filter((x) => mySet.has(x.id)
    || firmClients.some((l) => l.status === "active" && l.company_id === x.id && mySet.has(l.firm_id))), [isHrd, companies, mySet, firmClients]);
  const company = switchable.find((x) => x.id === cid) ?? null;
  // 役割：HRD管理者は全社オーナー／直接の所属／会計事務所経由（事務所での役割を引き継ぐ）
  const role: Role | null = useMemo(() => {
    if (isHrd) return "owner";
    const cand: Role[] = [];
    const direct = members.find((m) => m.company_id === cid)?.role;
    if (direct) cand.push(direct);
    for (const l of firmClients) {
      if (l.status !== "active" || l.company_id !== cid) continue;
      const r = members.find((m) => m.company_id === l.firm_id)?.role;
      if (r) cand.push(r);
    }
    return cand.sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))[0] ?? null;
  }, [isHrd, members, firmClients, cid]);
  const expired = !isHrd && (access === "expired" || access === "suspended");
  const selectCompany = useCallback((id: string) => { setCid(id); setScreen("dashboard"); }, []);

  const ctx: Ctx | null = useMemo(() => {
    if (!session || !company || !role) return null;
    return {
      userId: session.user.id, me, company, role, isHrd, companies, firmClients, access, selectCompany,
      canWrite: role !== "viewer", canApprove: role === "owner" || role === "approver", isOwner: role === "owner",
      payments, banks, payees, docs, cards, mf, loading, q,
      reload, reloadOrg: loadOrg, toast, go: setScreen, openDoc: setDocId, setPayments,
    };
  }, [session, company, role, me, isHrd, companies, firmClients, access, selectCompany, payments, banks, payees, docs, cards, mf, loading, q, reload, loadOrg, toast]);

  // 期限切れのときは業務画面を開かず、お申し込み画面へ
  const view: Screen = expired && !ALWAYS_OPEN.includes(screen) ? "billing" : screen;
  const nav: [Screen, string][] = [
    ...NAV.slice(0, 2), ["budget", "予算"], ...NAV.slice(2, -1),
    ...(company ? [["clients", company.kind === "client" ? "顧問の会計事務所" : "顧問先"] as [Screen, string]] : []),
    ...(role === "owner" ? [["accounts", "アカウントと権限"] as [Screen, string]] : []),
    NAV[NAV.length - 1],
    ...(company && company.kind !== "hrd" ? [["billing", "プラン・お支払い"] as [Screen, string]] : []),
    ...(isHrd ? [["admin", "HRD管理"] as [Screen, string]] : []),
  ];
  const title = view === "clients" && company?.kind === "client" ? "顧問の会計事務所" : TITLES[view];

  // 会社切り替えメニューのグループ：自分の事務所・自社 → 事務所ごとの顧問先 → その他（HRD管理者のみ）
  const groups = (() => {
    const firmIds = new Set(switchable.filter((c) => isFirmKind(c.kind) && (mySet.has(c.id) || isHrd)).map((c) => c.id));
    const used = new Set<string>();
    const out: { label: string; items: Company[] }[] = [];
    const own = switchable.filter((c) => mySet.has(c.id) || (isHrd && c.kind === "hrd"));
    own.forEach((c) => used.add(c.id));
    if (own.length) out.push({ label: "自分の事務所・会社", items: own });
    for (const fid of firmIds) {
      const firm = switchable.find((c) => c.id === fid);
      const items = switchable.filter((c) => !used.has(c.id) && firmClients.some((l) => l.status === "active" && l.firm_id === fid && l.company_id === c.id));
      items.forEach((c) => used.add(c.id));
      if (items.length) out.push({ label: `${firm?.name ?? "会計事務所"}の顧問先`, items });
    }
    const rest = switchable.filter((c) => !used.has(c.id));
    if (rest.length) out.push({ label: "その他のアカウント", items: rest });
    return out;
  })();

  if (!supabaseConfigured()) {
    return <div className="login-wrap"><div className="login"><h1 style={{ fontSize: 20 }}>設定が必要です</h1><p className="muted">環境変数 NEXT_PUBLIC_SUPABASE_URL と NEXT_PUBLIC_SUPABASE_ANON_KEY を設定してください。</p></div></div>;
  }
  if (session === undefined) return <div className="login-wrap" aria-busy="true" />;
  if (!session) return <Login />;
  if (mfaOk === null) return <div className="login-wrap" aria-busy="true" />;
  if (!mfaOk) return <MfaChallenge onVerified={() => { setMfaOk(true); }} onSignOut={() => sb().auth.signOut()} />;
  if (orgLoaded && !isHrd && switchable.length === 0) {
    const k = session.user.user_metadata?.signup_kind;
    return <Onboarding initialKind={k === "client" || k === "accounting_firm" ? (k as SignupKind) : null}
      onDone={async (id, msg) => { await loadOrg(); setCid(id); setScreen(k === "accounting_firm" ? "clients" : "dashboard"); toast(msg); }}
      onSignOut={() => sb().auth.signOut()} />;
  }

  const wait = payments.filter((p) => p.status === "pending").length;

  return (
    <div className="shell">
      <nav className="side" aria-label="メインメニュー">
        <div className="brand">
          <div className="logo">HRD</div>
          <div className="stack" style={{ gap: 2 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>HRD資金繰りクラウド</span>
            <span style={{ fontSize: 11, color: "#A9ACB4" }}>{isHrd ? "マスター管理者（HRD総合事務所）" : company ? KIND_LABEL[company.kind] : ""}</span>
          </div>
        </div>
        {switchable.length > 0 && (
          <label className="stack" style={{ gap: 6 }}>
            <span style={{ fontSize: 11, color: "#A9ACB4", padding: "0 4px" }}>会社</span>
            <select className="co-select" value={cid ?? ""} onChange={(e) => { setCid(e.target.value); setScreen("dashboard"); }}>
              {groups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.items.map((c) => <option key={c.id} value={c.id}>{c.kind === "hrd" ? "★ " : c.kind === "accounting_firm" ? "◆ " : ""}{c.name}{c.suspended_at ? "（停止中）" : ""}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
        )}
        <div className="stack" style={{ gap: 4 }}>
          {nav.map(([k, label]) => (
            <button key={k} type="button" className={"nav-btn" + (view === k ? " is-active" : "")} onClick={() => setScreen(k)} disabled={!ctx || (expired && !ALWAYS_OPEN.includes(k))} aria-current={view === k ? "page" : undefined}>
              <Icon name={k} />
              <span className="grow">{label}</span>
              {k === "schedule" && wait > 0 && <span className="badge num">{wait}</span>}
            </button>
          ))}
        </div>
        {access === "trial" && company && (
          <button type="button" className="side-note" onClick={() => setScreen("billing")} style={{ border: 0, textAlign: "left", color: "#FFFFFF" }}>
            <span style={{ fontSize: 11, color: "#A9ACB4" }}>無料期間</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>あと <span className="num">{daysLeft(company.trial_ends_at)}</span> 日（プランを見る）</span>
          </button>
        )}
        <div className="side-note" style={access === "trial" ? { marginTop: 0 } : undefined}>
          <span style={{ fontSize: 11, color: "#A9ACB4" }}>原本の保管先</span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>マネーフォワード クラウドBox{mf?.status === "connected" ? "（連携中）" : "（未連携）"}</span>
        </div>
        <button type="button" className="nav-btn" onClick={() => sb().auth.signOut()}><Icon name="logout" /><span className="grow">ログアウト</span></button>
      </nav>

      <main className="main">
        <header className="row wrap" style={{ gap: 16 }}>
          <div className="stack" style={{ gap: 4, flex: "1 1 260px" }}>
            <span className="lbl">{todayLabel()}{company ? ` ・ ${company.name}` : ""}</span>
            <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-.01em" }}>{title}</h1>
          </div>
          <div style={{ position: "relative", flex: "0 1 320px", minWidth: 200 }}>
            <span style={{ position: "absolute", left: 13, top: 13 }}><Icon name="search" color="#5B5F68" /></span>
            <label htmlFor="q" className="sr">相手先・内容で検索</label>
            <input id="q" className="inp srch" type="search" placeholder="相手先・内容で検索" value={q} onChange={(e) => { setQ(e.target.value); if (e.target.value && screen !== "schedule") setScreen("schedule"); }} />
          </div>
          {ctx?.canWrite && !expired && (
            <button type="button" className="btn btn-primary" onClick={() => setScreen("invoice")}><Icon name="plus" size={16} width={2.2} />書類を登録</button>
          )}
        </header>

        {!ctx && companies.length === 0 && (
          <div className="card empty">
            まだ利用できる会社がありません。<br />HRD総合事務所から招待を受けると、ここに会社が表示されます。
          </div>
        )}
        {ctx && expired && view === "billing" && screen !== "billing" && (
          <div role="alert" className="card pad" style={{ background: "#FFF8F3", borderColor: "#FBEDE2", color: "#9A420A", fontSize: 14, fontWeight: 600 }}>
            無料期間が終了したため、この画面は開けません。プランをお申し込みいただくと、すぐに続きからご利用いただけます。
          </div>
        )}
        {ctx && view === "dashboard" && <Dashboard ctx={ctx} />}
        {ctx && view === "monthly" && <Monthly ctx={ctx} />}
        {ctx && view === "schedule" && <Schedule ctx={ctx} />}
        {ctx && (view === "invoice" || view === "expense") && <Upload key={view} ctx={ctx} mode={view} />}
        {ctx && view === "card" && <Cards ctx={ctx} />}
        {ctx && view === "fb" && <Fb ctx={ctx} />}
        {ctx && view === "folders" && <Folders ctx={ctx} />}
        {ctx && view === "settings" && <Settings ctx={ctx} />}
        {ctx && view === "clients" && <Clients ctx={ctx} />}
        {ctx && view === "billing" && <Billing ctx={ctx} />}
        {ctx && view === "admin" && isHrd && <Admin ctx={ctx} />}
        {ctx && view === "budget" && <Budget ctx={ctx} />}
        {ctx && view === "accounts" && ctx.isOwner && <Accounts ctx={ctx} />}
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
