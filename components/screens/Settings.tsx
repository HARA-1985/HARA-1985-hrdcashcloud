"use client";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { Ctx } from "../ctx";
import { sb } from "@/lib/supabase";
import { toZenginKana } from "@/lib/zengin";
import { MfaSettings } from "../Mfa";
import { ACCOUNT_TITLES, ROLE_LABEL, type AuditLog, type MfAccountMap, type Membership, type Payee, type Role } from "@/lib/types";

type Member = Membership & { name: string; email: string };

const ACTION: Record<string, string> = { insert: "追加", update: "変更", delete: "削除" };
const TABLE: Record<string, string> = { mf_connections: "マネーフォワード連携", mf_journals: "MF仕訳登録", payments: "支払予定", documents: "書類", bank_accounts: "振込元口座", payees: "支払先", fb_exports: "FBデータ", memberships: "メンバー", companies: "会社" };

async function authedFetch(path: string, body: unknown) {
  const { data } = await sb().auth.getSession();
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token ?? ""}` }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, ...j } as { ok: boolean; error?: string; url?: string; updated?: number; unmatched?: string[]; invalid?: string[] };
}

export default function Settings({ ctx }: { ctx: Ctx }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  const loadSide = useCallback(async () => {
    const [m, l] = await Promise.all([
      sb().from("memberships").select("company_id,user_id,role").eq("company_id", ctx.company.id),
      sb().from("audit_logs").select("id,actor,action,table_name,record_id,created_at").eq("company_id", ctx.company.id).order("created_at", { ascending: false }).limit(30),
    ]);
    const ms = (m.data as Membership[]) ?? [];
    const ids = [...new Set([...ms.map((x) => x.user_id), ...((l.data as AuditLog[]) ?? []).map((x) => x.actor).filter(Boolean) as string[]])];
    const p = ids.length ? await sb().from("profiles").select("id,display_name,email").in("id", ids) : { data: [] };
    const nm = new Map(((p.data as { id: string; display_name: string | null; email: string | null }[]) ?? []).map((x) => [x.id, x.display_name || x.email || "—"]));
    const em = new Map(((p.data as { id: string; email: string | null }[]) ?? []).map((x) => [x.id, x.email ?? ""]));
    setNames(nm);
    setMembers(ms.map((x) => ({ ...x, name: nm.get(x.user_id) ?? "—", email: em.get(x.user_id) ?? "" })));
    setLogs((l.data as AuditLog[]) ?? []);
  }, [ctx.company.id]);
  useEffect(() => { loadSide(); }, [loadSide]);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <CompanySection ctx={ctx} />
      <BanksSection ctx={ctx} />
      <PayeesSection ctx={ctx} />
      <MembersSection ctx={ctx} members={members} onChange={loadSide} />
      <MfSection ctx={ctx} />
      <MfaSettings toast={ctx.toast} required={!!ctx.me?.is_hrd_staff} />
      <section className="card scroll-x">
        <div style={{ padding: "18px 22px 8px" }}><h2 className="h2">操作ログ</h2></div>
        {logs.length === 0 ? <div className="empty">まだ操作の記録はありません</div> : (
          <table className="tbl">
            <thead><tr><th>日時</th><th>操作した人</th><th>対象</th><th>操作</th></tr></thead>
            <tbody>{logs.map((l) => (
              <tr key={l.id}>
                <td className="num nw">{new Date(l.created_at).toLocaleString("ja-JP")}</td>
                <td>{l.actor ? names.get(l.actor) ?? "—" : "システム"}</td>
                <td>{TABLE[l.table_name] ?? l.table_name}</td>
                <td>{ACTION[l.action] ?? l.action}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function CompanySection({ ctx }: { ctx: Ctx }) {
  const [busy, setBusy] = useState(false);
  async function seed() {
    setBusy(true);
    const { data, error } = await sb().rpc("seed_demo", { cid: ctx.company.id });
    setBusy(false);
    if (error) ctx.toast(error.message, true);
    else if (!data) ctx.toast("支払予定があるため、サンプルは入れませんでした", true);
    else { ctx.toast(`サンプルを${data}件入れました`); ctx.reload(); }
  }
  return (
    <section className="card pad stack" style={{ gap: 12 }}>
      <h2 className="h2">会社</h2>
      <div style={{ display: "grid", gridTemplateColumns: "140px minmax(0,1fr)", gap: "10px 14px", fontSize: 14 }}>
        <span className="muted">会社名</span><strong>{ctx.company.name}</strong>
        <span className="muted">区分</span><span>{ctx.company.kind === "client" ? "企業" : "会計事務所"}</span>
        <span className="muted">期首月</span><span><FiscalStart ctx={ctx} /></span>
        <span className="muted">MFプラン</span><span>{ctx.company.mf_plan ?? "—"}</span>
        <span className="muted">あなたの権限</span><span>{ctx.isHrd ? "マスター管理者" : ROLE_LABEL[ctx.role]}</span>
      </div>
      {ctx.isOwner && ctx.payments.length === 0 && (
        <div className="row wrap" style={{ gap: 10 }}>
          <button type="button" className="btn" disabled={busy} onClick={seed}>サンプルデータを入れて動きを確認</button>
          <span className="muted" style={{ fontSize: 12 }}>支払予定が空の会社にだけ入ります</span>
        </div>
      )}
    </section>
  );
}

function FiscalStart({ ctx }: { ctx: Ctx }) {
  const v = ctx.company.fiscal_start_month ?? 4;
  async function change(m: number) {
    const { error } = await sb().from("companies").update({ fiscal_start_month: m }).eq("id", ctx.company.id);
    if (error) ctx.toast(error.message, true); else { ctx.toast(`期首月を${m}月にしました`); ctx.reloadOrg(); }
  }
  if (!ctx.isOwner) return <>{v}月</>;
  return (
    <span className="row" style={{ gap: 8 }}>
      <select className="inp" style={{ width: 100, height: 34 }} value={v} onChange={(e) => change(Number(e.target.value))} aria-label="期首月">
        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}月</option>)}
      </select>
    </span>
  );
}

function BanksSection({ ctx }: { ctx: Ctx }) {
  const empty = { bank_name: "", bank_code: "", bank_kana: "", branch_code: "", branch_name: "", branch_kana: "", account_type: "1", account_number: "", holder_kana: "", client_code: "" };
  const [f, setF] = useState(empty);
  const [open, setOpen] = useState(false);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    const row = { ...f, company_id: ctx.company.id, bank_kana: toZenginKana(f.bank_kana), branch_kana: toZenginKana(f.branch_kana), holder_kana: toZenginKana(f.holder_kana) };
    const { error } = await sb().from("bank_accounts").insert(row);
    if (error) ctx.toast(error.message, true); else { ctx.toast("振込元口座を登録しました"); setF(empty); setOpen(false); ctx.reload(); }
  }
  const mask = (n: string | null) => (n ? "***" + n.slice(-4) : "—");
  return (
    <section className="card pad stack" style={{ gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="h2">振込元口座</h2>
        {ctx.isOwner && <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => !o)}>{open ? "閉じる" : "口座を追加"}</button>}
      </div>
      {ctx.banks.length === 0 && <span className="muted" style={{ fontSize: 13 }}>まだ登録がありません</span>}
      {ctx.banks.map((b) => (
        <div key={b.id} className="list-row" style={{ fontSize: 13 }}>
          <strong style={{ minWidth: 160 }}>{b.bank_name} {b.branch_name}</strong>
          <span className="muted num">銀行 {b.bank_code ?? "—"} ・ 支店 {b.branch_code ?? "—"} ・ {b.account_type === "2" ? "当座" : "普通"} {mask(b.account_number)}</span>
          <span className="muted">委託者コード {b.client_code ? "設定済" : "未設定"}</span>
        </div>
      ))}
      {open && (
        <form className="stack" style={{ gap: 12 }} onSubmit={add}>
          <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
            <label className="field"><span>銀行名</span><input className="inp" required value={f.bank_name} onChange={(e) => setF({ ...f, bank_name: e.target.value })} /></label>
            <label className="field"><span>銀行コード（4桁）</span><input className="inp num" inputMode="numeric" maxLength={4} value={f.bank_code} onChange={(e) => setF({ ...f, bank_code: e.target.value })} /></label>
            <label className="field"><span>銀行名カナ</span><input className="inp" value={f.bank_kana} onChange={(e) => setF({ ...f, bank_kana: e.target.value })} /></label>
            <label className="field"><span>支店名</span><input className="inp" value={f.branch_name} onChange={(e) => setF({ ...f, branch_name: e.target.value })} /></label>
            <label className="field"><span>支店コード（3桁）</span><input className="inp num" inputMode="numeric" maxLength={3} value={f.branch_code} onChange={(e) => setF({ ...f, branch_code: e.target.value })} /></label>
            <label className="field"><span>支店名カナ</span><input className="inp" value={f.branch_kana} onChange={(e) => setF({ ...f, branch_kana: e.target.value })} /></label>
            <label className="field"><span>預金種目</span><select className="inp" value={f.account_type} onChange={(e) => setF({ ...f, account_type: e.target.value })}><option value="1">普通</option><option value="2">当座</option></select></label>
            <label className="field"><span>口座番号（7桁）</span><input className="inp num" inputMode="numeric" maxLength={7} value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value })} /></label>
            <label className="field"><span>依頼人名カナ</span><input className="inp" value={f.holder_kana} onChange={(e) => setF({ ...f, holder_kana: e.target.value })} /></label>
            <label className="field"><span>委託者コード（10桁）</span><input className="inp num" inputMode="numeric" maxLength={10} value={f.client_code} onChange={(e) => setF({ ...f, client_code: e.target.value })} /></label>
          </div>
          <button className="btn btn-primary" type="submit" style={{ alignSelf: "flex-start" }}>登録</button>
        </form>
      )}
    </section>
  );
}

function PayeesSection({ ctx }: { ctx: Ctx }) {
  const [edit, setEdit] = useState<Payee | null>(null);
  const blank: Payee = { id: "", company_id: ctx.company.id, name: "", name_kana: "", bank_code: "", bank_kana: "", branch_code: "", branch_kana: "", account_type: "1", account_number: "" };
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const row = { company_id: ctx.company.id, name: edit.name.trim(), name_kana: toZenginKana(edit.name_kana) || null, bank_code: edit.bank_code || null, bank_kana: toZenginKana(edit.bank_kana) || null, branch_code: edit.branch_code || null, branch_kana: toZenginKana(edit.branch_kana) || null, account_type: edit.account_type || "1", account_number: edit.account_number || null };
    const q = edit.id ? sb().from("payees").update(row).eq("id", edit.id) : sb().from("payees").insert(row);
    const { error } = await q;
    if (error) { ctx.toast(error.message, true); return; }
    if (!edit.id) {
      // 同名の支払予定を新しい支払先に紐付け
      const { data } = await sb().from("payees").select("id").eq("company_id", ctx.company.id).eq("name", row.name).single();
      if (data) await sb().from("payments").update({ payee_id: data.id }).eq("company_id", ctx.company.id).eq("payee_name", row.name).is("payee_id", null);
    }
    ctx.toast("支払先を保存しました"); setEdit(null); setReadNote(""); ctx.reload();
  }
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState("");
  async function readPdf(f: File | undefined) {
    if (!f) return;
    setReading(true); setReadNote("");
    const { data } = await sb().auth.getSession();
    const fd = new FormData(); fd.append("companyId", ctx.company.id); fd.append("file", f);
    const res = await fetch("/api/payees/extract", { method: "POST", headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}` }, body: fd });
    const j = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; info?: Record<string, string | undefined> };
    setReading(false);
    if (!res.ok || !j.info) { ctx.toast(j.error ?? "読み取れませんでした", true); return; }
    const i = j.info;
    const nn = (x: string) => x.normalize("NFKC").replace(/\s|株式会社|\(株\)/g, "");
    const exist = i.name ? ctx.payees.find((p) => nn(p.name) === nn(i.name!)) : undefined;
    const base = exist ?? { ...blank, name: i.name ?? "" };
    setEdit({
      ...base,
      name_kana: i.name_kana || base.name_kana || "",
      bank_code: i.bank_code || base.bank_code || "", bank_kana: i.bank_kana || base.bank_kana || "",
      branch_code: i.branch_code || base.branch_code || "", branch_kana: i.branch_kana || base.branch_kana || "",
      account_type: i.account_type || base.account_type || "1", account_number: i.account_number || base.account_number || "",
    });
    const seen = [i.bank_name, i.branch_name, i.account_number && `${i.account_type === "2" ? "当座" : "普通"} ${i.account_number}`].filter(Boolean).join(" ／ ");
    setReadNote(`${f.name} から読み取り：${seen || "口座情報なし"}${exist ? `（既存の支払先「${exist.name}」を更新します）` : ""}${i.note ? `。${i.note}` : ""}。内容を確認して「保存」してください`);
  }
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { if (edit) setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 30); }, [edit?.id, !!edit]); // eslint-disable-line react-hooks/exhaustive-deps
  const editForm = edit && (
        <form ref={formRef} className="stack" style={{ gap: 12, padding: 14, background: "#F7F6F3", borderRadius: 12 }} onSubmit={save}>
          {readNote && <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7, color: "#2236B8" }}>{readNote}</p>}
          <div className="grid-auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
            <label className="field"><span>支払先名</span><input className="inp" required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="field"><span>受取人名カナ</span><input className="inp" value={edit.name_kana ?? ""} onChange={(e) => setEdit({ ...edit, name_kana: e.target.value })} placeholder="ｻﾝﾌﾟﾙ(ｶ" /></label>
            <label className="field"><span>銀行コード</span><input className="inp num" maxLength={4} value={edit.bank_code ?? ""} onChange={(e) => setEdit({ ...edit, bank_code: e.target.value })} /></label>
            <label className="field"><span>銀行名カナ</span><input className="inp" value={edit.bank_kana ?? ""} onChange={(e) => setEdit({ ...edit, bank_kana: e.target.value })} /></label>
            <label className="field"><span>支店コード</span><input className="inp num" maxLength={3} value={edit.branch_code ?? ""} onChange={(e) => setEdit({ ...edit, branch_code: e.target.value })} /></label>
            <label className="field"><span>支店名カナ</span><input className="inp" value={edit.branch_kana ?? ""} onChange={(e) => setEdit({ ...edit, branch_kana: e.target.value })} /></label>
            <label className="field"><span>預金種目</span><select className="inp" value={edit.account_type ?? "1"} onChange={(e) => setEdit({ ...edit, account_type: e.target.value })}><option value="1">普通</option><option value="2">当座</option><option value="4">貯蓄</option></select></label>
            <label className="field"><span>口座番号</span><input className="inp num" maxLength={7} value={edit.account_number ?? ""} onChange={(e) => setEdit({ ...edit, account_number: e.target.value })} /></label>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-primary" type="submit">保存</button>
            <button className="btn" type="button" onClick={() => setEdit(null)}>キャンセル</button>
          </div>
        </form>
  );
  const unlinked = [...new Set(ctx.payments.filter((p) => !p.payee_id && p.source !== "card").map((p) => p.payee_name))];
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState("");
  const bulkRows = bulkText.split(/\r?\n/).map((l) => l.split("\t")).filter((c) => c.length >= 7 && c[0].trim())
    .map(([name, bank_code, bank_kana, branch_code, branch_kana, account_type, account_number, name_kana]) => ({ name: name.trim(), bank_code, bank_kana, branch_code, branch_kana, account_type, account_number, name_kana }));
  const [unused, setUnused] = useState<string[] | null>(null);
  async function cleanup() {
    const l = await authedFetch("/api/payees/cleanup", { companyId: ctx.company.id, list: true }) as { ok: boolean; error?: string; names?: string[] };
    if (!l.ok) { ctx.toast(l.error ?? "確認できませんでした", true); return; }
    if (!l.names?.length) { ctx.toast("整理する支払先はありません"); setUnused(null); return; }
    setUnused(l.names);
  }
  async function doCleanup() {
    const r = await authedFetch("/api/payees/cleanup", { companyId: ctx.company.id }) as { ok: boolean; error?: string; removed?: string[] };
    if (!r.ok) { ctx.toast(r.error ?? "削除できませんでした", true); return; }
    ctx.toast(`${r.removed?.length ?? 0}件の支払先を削除しました`); setUnused(null); ctx.reload();
  }
  async function saveBulk() {
    setBulkBusy(true);
    const r = await authedFetch("/api/payees/import", { companyId: ctx.company.id, rows: bulkRows });
    setBulkBusy(false);
    if (!r.ok) { ctx.toast(r.error ?? "登録できませんでした", true); return; }
    const msg = `${r.updated}件の口座を登録しました` + (r.unmatched?.length ? `。支払先が見つからない：${r.unmatched.join("、")}` : "") + (r.invalid?.length ? `。形式エラー：${r.invalid.join("、")}` : "");
    setBulkResult(msg); ctx.toast(`${r.updated}件の口座を登録しました`); setBulkText(""); ctx.reload();
  }
  return (
    <section className="card pad stack" style={{ gap: 12 }}>
      <div className="row wrap" style={{ justifyContent: "space-between", gap: 8 }}>
        <h2 className="h2">支払先</h2>
        <div className="row" style={{ gap: 8 }}>
          {ctx.canApprove && <button type="button" className="btn btn-sm" onClick={cleanup}>使われていない支払先を整理</button>}
          {ctx.canApprove && <button type="button" className="btn btn-sm" onClick={() => setBulk((v) => !v)} aria-expanded={bulk}>口座をまとめて登録</button>}
          {ctx.canWrite && (
            <label className="btn btn-sm" style={{ cursor: reading ? "wait" : "pointer" }}>
              {reading ? "読み取り中…" : "PDFから読み取って登録"}
              <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="sr" disabled={reading}
                onChange={(e) => { readPdf(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
          )}
          {ctx.canWrite && <button type="button" className="btn btn-sm" onClick={() => { setReadNote(""); setEdit(blank); }}>支払先を追加</button>}
        </div>
      </div>
      {unused && (
        <div className="stack" style={{ gap: 8, padding: 14, background: "#FFF8F3", border: "1px solid #F0C9AE", borderRadius: 12, fontSize: 13 }}>
          <span>支払予定が1件もなく、口座も未登録の支払先が {unused.length}件あります：{unused.join("、")}</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" id="payee-cleanup-confirm" className="btn btn-sm btn-primary" onClick={doCleanup}>この{unused.length}件を削除する</button>
            <button type="button" className="btn btn-sm" onClick={() => setUnused(null)}>やめる</button>
          </div>
        </div>
      )}
      {bulk && (
        <div className="stack" style={{ gap: 10, padding: 14, background: "#F7F6F3", borderRadius: 12 }}>
          <span className="muted" style={{ fontSize: 12 }}>形式：支払先名⇥銀行コード⇥銀行名カナ⇥支店コード⇥支店名カナ⇥普通/当座⇥口座番号⇥受取人名カナ</span>
          <label htmlFor="payee-bulk" className="sr">口座の一覧</label>
          <textarea id="payee-bulk" className="inp" style={{ minHeight: 120, fontSize: 12, fontFamily: "ui-monospace, monospace" }} value={bulkText} onChange={(e) => setBulkText(e.target.value)} placeholder={"ストローハット\t1341\tｾｲﾌﾞｼﾝｷﾝ\t001\tﾎﾝﾃﾝ\t普通\t2032451\tｶ)ｽﾄﾛｰﾊﾂﾄ"} />
          <div className="row wrap" style={{ gap: 10 }}>
            <span className="muted" style={{ fontSize: 13 }}>{bulkRows.length}件</span>
            <button type="button" id="payee-bulk-save" className="btn btn-primary" disabled={!bulkRows.length || bulkBusy} onClick={saveBulk}>{bulkBusy ? "登録中…" : `${bulkRows.length}件の口座を登録`}</button>
          </div>
          {bulkResult && <p style={{ fontSize: 13, margin: 0, lineHeight: 1.7 }}>{bulkResult}</p>}
        </div>
      )}
      {edit && !edit.id && editForm}
      {unlinked.length > 0 && ctx.canWrite && (
        <div className="row wrap" style={{ gap: 8, fontSize: 13 }}>
          <span className="muted">口座が未登録：</span>
          {unlinked.map((n) => <button key={n} type="button" className="pill" onClick={() => setEdit({ ...blank, name: n })}>{n}</button>)}
        </div>
      )}
      {ctx.payees.map((p) => (
        <div key={p.id} className="list-row" style={{ fontSize: 13 }}>
          <strong className="grow" style={{ flex: "1 1 200px" }}>{p.name}</strong>
          <span className="muted num">{p.name_kana ?? ""}</span>
          <span className="muted num">{p.bank_code ? `${p.bank_code}-${p.branch_code ?? "?"} ${p.account_type === "2" ? "当座" : "普通"} ***${(p.account_number ?? "").slice(-4)}` : "口座未登録"}</span>
          {ctx.canWrite && <button type="button" className="btn btn-sm" onClick={() => { setReadNote(""); setEdit(edit?.id === p.id ? null : p); }}>{edit?.id === p.id ? "閉じる" : "編集"}</button>}
        </div>
      )).flatMap((row, i) => (edit && edit.id && edit.id === ctx.payees[i].id ? [row, <Fragment key="edit">{editForm}</Fragment>] : [row]))}
    </section>
  );
}

function MembersSection({ ctx, members, onChange }: { ctx: Ctx; members: Member[]; onChange: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await authedFetch("/api/invite", { email: email.trim(), role, companyId: ctx.company.id });
    setBusy(false);
    if (!r.ok) ctx.toast(r.error ?? "招待できませんでした", true); else { ctx.toast("招待メールを送りました：" + email); setEmail(""); onChange(); }
  }
  async function changeRole(uid: string, r: Role) {
    const { error } = await sb().from("memberships").update({ role: r }).eq("company_id", ctx.company.id).eq("user_id", uid);
    if (error) ctx.toast(error.message, true); else { ctx.toast("権限を変更しました"); onChange(); }
  }
  async function remove(uid: string, name: string) {
    if (!confirm(`${name} をこの会社から外しますか？`)) return;
    const { error } = await sb().from("memberships").delete().eq("company_id", ctx.company.id).eq("user_id", uid);
    if (error) ctx.toast(error.message, true); else { ctx.toast("メンバーから外しました"); onChange(); }
  }
  return (
    <section className="card pad stack" style={{ gap: 12 }}>
      <h2 className="h2">メンバーと権限</h2>
      {members.map((m) => (
        <div key={m.user_id} className="list-row" style={{ fontSize: 13 }}>
          <strong style={{ minWidth: 140 }}>{m.name}</strong>
          <span className="muted grow">{m.email}</span>
          {ctx.isOwner && m.user_id !== ctx.userId ? (
            <>
              <select className="inp" style={{ width: 140, height: 36 }} value={m.role} onChange={(e) => changeRole(m.user_id, e.target.value as Role)} aria-label={`${m.name}の権限`}>
                {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(m.user_id, m.name)}>外す</button>
            </>
          ) : <span className="chip st-auto">{ROLE_LABEL[m.role]}</span>}
        </div>
      ))}
      {ctx.isOwner && (
        <form className="row wrap" style={{ gap: 10, alignItems: "flex-end" }} onSubmit={invite}>
          <label className="field" style={{ flex: "1 1 240px" }}><span>招待するメールアドレス</span><input className="inp" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="field" style={{ width: 160 }}><span>権限</span>
            <select className="inp" value={role} onChange={(e) => setRole(e.target.value as Role)}>{(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "送信中…" : "招待する"}</button>
        </form>
      )}
    </section>
  );
}

function MfSection({ ctx }: { ctx: Ctx }) {
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<{ id: string; name: string; category: string; available: boolean }[] | null>(null);
  const [map, setMap] = useState<MfAccountMap>(ctx.company.mf_account_map ?? {});
  const st = ctx.mf?.status ?? "disconnected";
  const connected = st === "connected";
  const titles = [...new Set([...ACCOUNT_TITLES, ...ctx.payments.map((p) => p.account_title)])];

  async function connect() {
    setBusy(true);
    const r = await authedFetch("/api/mf/connect", { companyId: ctx.company.id });
    setBusy(false);
    if (r.ok && r.url && r.url.startsWith("https://api.biz.moneyforward.com/")) window.location.href = r.url;
    else ctx.toast(r.error ?? "連携を開始できませんでした", true);
  }
  async function disconnect() {
    if (!confirm("マネーフォワードとの連携を解除しますか？")) return;
    setBusy(true);
    const r = await authedFetch("/api/mf/disconnect", { companyId: ctx.company.id });
    setBusy(false);
    if (r.ok) { ctx.toast("連携を解除しました"); ctx.reload(); } else ctx.toast(r.error ?? "解除できませんでした", true);
  }
  async function loadAccounts() {
    setBusy(true);
    const r = await authedFetch("/api/mf/accounts", { companyId: ctx.company.id }) as { ok: boolean; error?: string; accounts?: typeof accounts };
    setBusy(false);
    if (r.ok && r.accounts) setAccounts(r.accounts); else ctx.toast(r.error ?? "勘定科目を取得できませんでした", true);
  }
  async function saveMap() {
    const { error } = await sb().from("companies").update({ mf_account_map: map }).eq("id", ctx.company.id);
    if (error) ctx.toast(error.message, true); else { ctx.toast("勘定科目の対応表を保存しました"); ctx.reloadOrg(); }
  }
  const opts = (accounts ?? []).filter((a) => a.available);
  const Sel = ({ value, onChange, label }: { value?: string; onChange: (v: string) => void; label: string }) => (
    <select className="inp" aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 320 }}>
      <option value="">未設定</option>
      {opts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.category ? `（${a.category}）` : ""}</option>)}
      {value && !opts.some((a) => a.id === value) && <option value={value}>設定済み（ID：{value.slice(0, 8)}…）</option>}
    </select>
  );

  return (
    <section className="card pad stack" style={{ gap: 14 }}>
      <h2 className="h2">マネーフォワード連携</h2>
      <div style={{ display: "grid", gridTemplateColumns: "160px minmax(0,1fr)", gap: "10px 14px", fontSize: 14 }}>
        <span className="muted">状態</span>
        <span><span className={"chip " + (connected ? "st-ok" : st === "error" ? "st-err" : "st-auto")}>{connected ? "連携中" : st === "error" ? "エラー" : "未連携"}</span>{ctx.mf?.office_name ? `　${ctx.mf.office_name}` : ""}</span>
        {ctx.mf?.last_error && <><span className="muted">エラー</span><span style={{ color: "#9B1C1C" }}>{ctx.mf.last_error}</span></>}
        <span className="muted">連携範囲</span><span>クラウド会計・クラウドBox（読み取り）</span>
      </div>
      {ctx.isOwner && (
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={connect}>{connected ? "連携し直す" : "マネーフォワードと連携する"}</button>
          {(connected || st === "error") && <button type="button" className="btn" disabled={busy} onClick={disconnect}>連携を解除</button>}
        </div>
      )}

      {connected && ctx.canApprove && (
        <div className="stack" style={{ gap: 12, paddingTop: 8, borderTop: "1px solid #EFEDE8" }}>
          <div className="row wrap" style={{ justifyContent: "space-between", gap: 8 }}>
            <strong>勘定科目の対応表</strong>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={loadAccounts}>{accounts ? "再読み込み" : "マネーフォワードの勘定科目を読み込む"}</button>
          </div>
          {accounts && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "160px minmax(0,1fr)", gap: "8px 14px", alignItems: "center", fontSize: 14 }}>
                <span className="lbl" style={{ gridColumn: "1 / -1" }}>借方</span>
                {titles.map((t) => <Fragment key={t}><span>{t}</span><Sel label={`${t}に対応する科目`} value={map.titles?.[t]} onChange={(v) => setMap((m) => ({ ...m, titles: { ...(m.titles ?? {}), [t]: v } }))} /></Fragment>)}
                <span className="lbl" style={{ gridColumn: "1 / -1", marginTop: 6 }}>貸方</span>
                {ctx.banks.map((b) => <Fragment key={b.id}><span>{b.bank_name} {b.branch_name ?? ""}</span><Sel label={`${b.bank_name}に対応する科目`} value={map.banks?.[b.id]} onChange={(v) => setMap((m) => ({ ...m, banks: { ...(m.banks ?? {}), [b.id]: v } }))} /></Fragment>)}
              </div>
              {ctx.isOwner && <button type="button" className="btn btn-primary" style={{ alignSelf: "flex-start" }} onClick={saveMap}>対応表を保存</button>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
