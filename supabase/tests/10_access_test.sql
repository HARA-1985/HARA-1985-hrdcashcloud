-- 3階層の権限と課金状態のテスト（既存スキーマ ＋ 今回のマイグレーション）
\set ON_ERROR_STOP on
create schema t;
grant usage on schema t to public;
create function t.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;
grant execute on function t.ok(boolean, text) to public;
create table t.ids (k text primary key, v uuid);
create table t.codes (code text);
grant all on t.ids, t.codes to public;
create function t.id(p text) returns uuid language sql stable as $$ select v from t.ids where k = p $$;
grant execute on function t.id(text) to public;

insert into auth.users(id, email) values
 ('00000000-0000-0000-0000-00000000000a', 'hara@hrd.example'),
 ('00000000-0000-0000-0000-00000000000f', 'firm@firm.example'),
 ('00000000-0000-0000-0000-0000000000f2', 'staff@firm.example'),
 ('00000000-0000-0000-0000-00000000000c', 'owner@company.example'),
 ('00000000-0000-0000-0000-0000000000c2', 'client@x.example'),
 ('00000000-0000-0000-0000-0000000000ee', 'other@other.example');
update public.profiles set is_hrd_staff = true where id = '00000000-0000-0000-0000-00000000000a';

-- ① HRD：自社（kind=hrd）を作り、既存の create_company で顧問先Hを作る
insert into public.companies(id, name, kind) values ('11111111-1111-1111-1111-111111111111', 'HRD総合事務所株式会社', 'hrd');
insert into public.memberships values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000a', 'owner');
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into t.ids values ('h', public.create_company('HRD顧問先H'));
select t.ok(public.access_status(t.id('h')) = 'covered_by_firm', 'HRDが追加した顧問先はHRDの契約でカバー');
reset role;

-- ② 会計事務所が登録し、顧問先Xを作る
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000f', false);
insert into t.ids values ('firm', public.register_account('accounting_firm', '原田会計事務所'));
select t.ok(public.access_status(t.id('firm')) = 'trial', '会計事務所は登録直後30日無料');
insert into t.ids values ('x', public.firm_create_client(t.id('firm'), '顧問先X株式会社'));
insert into public.payments(company_id, due_date, payee_name, amount, kind, source) values (t.id('x'), current_date, 'A', 1000, 'fixed', 'manual');
select t.ok((select count(*) from public.payments) = 1, '事務所は顧問先Xの支払予定を登録できる');
select t.ok((select count(*) from public.companies where id = t.id('h')) = 0, '事務所からHRDの顧問先は見えない');
do $$ begin
  update public.companies set trial_ends_at = now() + interval '10 years' where id = t.id('firm');
  raise exception 'FAIL: 試用期限を書き換えられた';
exception when insufficient_privilege then raise notice 'ok - 利用者は試用期限を書き換えられない'; end $$;
reset role;
insert into public.memberships values ((select v from t.ids where k='firm'), '00000000-0000-0000-0000-0000000000f2', 'member');
insert into t.codes select firm_code from public.companies where id = (select v from t.ids where k='firm');

-- ③ 企業が自分で登録
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
insert into t.ids values ('y', public.register_account('client', '自社Y株式会社'));
insert into public.payments(company_id, due_date, payee_name, amount, kind, source) values (t.id('y'), current_date, 'B', 500, 'fixed', 'manual');
select t.ok((select count(*) from public.payments) = 1, '企業Yは自社の支払予定だけ見える');
select t.ok((select count(*) from public.companies where kind = 'accounting_firm') = 0, '企業からは未接続の事務所は見えない');
insert into t.ids values ('y2', public.register_account('client', '2社目'));
select t.ok(public.access_status(t.id('y2')) = 'expired', '同じ人の2社目には無料期間が付かない');
do $$ begin
  insert into public.companies(name, kind) values ('直接作成', 'client');
  raise exception 'FAIL: 直接会社を作れた';
exception when insufficient_privilege then raise notice 'ok - 会社は登録RPC以外では作れない'; end $$;
select public.company_link_firm(t.id('y'), (select code from t.codes));
select t.ok((select count(*) from public.companies where kind = 'accounting_firm') = 1, '接続後は事務所が見える');
reset role;

-- 部外者
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ee', false);
select t.ok((select count(*) from public.companies) = 0, '部外者は会社を何も見られない');
select t.ok((select count(*) from public.payments) = 0, '部外者は支払予定を見られない');
do $$ begin
  perform public.admin_list_accounts();
  raise exception 'FAIL: 部外者が管理者一覧を取得できた';
exception when insufficient_privilege then raise notice 'ok - 部外者は管理者機能を使えない'; end $$;
do $$ begin
  perform public.firm_create_client(t.id('firm'), '乗っ取り');
  raise exception 'FAIL: 部外者が顧問先を作れた';
exception when insufficient_privilege then raise notice 'ok - 部外者は他事務所の顧問先を作れない'; end $$;
reset role;

-- 事務所スタッフ（member）
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f2', false);
select t.ok((select count(*) from public.my_companies where kind = 'client') = 2, '事務所スタッフは顧問先X・Yの2社を見られる');
select t.ok((select count(*) from public.payments) = 2, '事務所スタッフは顧問先2社の支払予定を見られる');
do $$ begin
  perform public.firm_create_client(t.id('firm'), '勝手に作成');
  raise exception 'FAIL: member が顧問先を作れた';
exception when insufficient_privilege then raise notice 'ok - 事務所の一般メンバーは顧問先を登録できない'; end $$;
reset role;

-- 招待：事務所オーナーが顧問先Xの担当者を招待
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000f', false);
create temp table tok as select public.create_invitation(t.id('x'), 'client@x.example', 'approver') as token;
grant select on tok to public;
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ee', false);
do $$ begin
  perform public.accept_invitation((select token from tok));
  raise exception 'FAIL: 別人が招待を受けられた';
exception when raise_exception then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok - 招待されたメール以外の人は招待を受けられない';
end $$;
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', false);
select public.accept_invitation((select token from tok));
select t.ok((select count(*) from public.payments) = 1, '招待された顧問先担当者はXのデータを使える');
select t.ok(public.access_status(t.id('x')) = 'covered_by_firm', '顧問先Xは「事務所の契約でカバー」');
reset role;

-- 30日経過
update public.companies set trial_ends_at = now() - interval '1 day' where id in (
  (select v from t.ids where k='firm'), (select v from t.ids where k='y'));
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000f', false);
select t.ok(public.access_status(t.id('firm')) = 'expired', '30日後、事務所は期限切れ');
select t.ok((select count(*) from public.payments) = 0, '期限切れの事務所は顧問先データを使えない');
select t.ok((select count(*) from public.companies where id = t.id('firm')) = 1, '期限切れでも自社は見える（課金画面へ進める）');
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', false);
select t.ok((select count(*) from public.payments) = 0, '事務所が期限切れなら顧問先Xの担当者も使えない');
reset role;

-- サブスク登録（Webhook = service role）
set role service_role;
insert into public.subscriptions(company_id, plan_code, status, current_period_end)
values ((select v from t.ids where k='firm'), 'firm_monthly', 'active', now() + interval '30 days');
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', false);
select t.ok((select count(*) from public.payments) = 1, '事務所がサブスク登録すると顧問先Xも再び使える');
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select t.ok(public.access_status(t.id('y')) = 'covered_by_firm', '企業Yは自社が期限切れでも事務所の契約で使える');
do $$ begin
  insert into public.subscriptions(company_id, status) values (t.id('y'), 'active');
  raise exception 'FAIL: 利用者がサブスクを書き込めた';
exception when insufficient_privilege then raise notice 'ok - 利用者はサブスク状態を書き込めない'; end $$;
select public.unlink_firm_client(t.id('firm'), t.id('y'));
select t.ok(public.access_status(t.id('y')) = 'expired', '顧問関係を解除すると企業Yは期限切れに戻る');
select t.ok((select count(*) from public.payments) = 0, '期限切れの企業Yは支払予定を使えない');
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000f', false);
select t.ok((select count(*) from public.companies where id = t.id('y')) = 0, '解除後、事務所から企業Yは見えない');
reset role;

-- ① HRD管理者
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select t.ok((select count(*) from public.admin_list_accounts()) = 6, 'HRD管理者は全アカウントを一覧できる');
select t.ok((select count(*) from public.payments) = 2, 'HRD管理者は全社のデータを見られる');
select public.admin_extend_trial(t.id('y'), 14);
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select t.ok(public.access_status(t.id('y')) = 'trial', 'HRDが無料期間を延長すると企業Yは再び試用中');
select t.ok((select count(*) from public.payments) = 1, '延長後、企業Yは支払予定を使える');
reset role;


-- サーバーAPI用の役割判定
select t.ok((select role from public.svc_company_role(t.id('x'), '00000000-0000-0000-0000-0000000000f2')) = 'member', 'API：事務所スタッフは顧問先Xで member');
select t.ok((select usable from public.svc_company_role(t.id('x'), '00000000-0000-0000-0000-0000000000f2')), 'API：事務所が契約中なので顧問先Xを使える');
select t.ok((select role from public.svc_company_role(t.id('x'), '00000000-0000-0000-0000-0000000000c2')) = 'approver', 'API：招待された担当者は顧問先Xで approver');
select t.ok((select count(*) from public.svc_company_role(t.id('x'), '00000000-0000-0000-0000-0000000000ee')) = 0, 'API：部外者には役割がない');
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ee', false);
do $$ begin
  perform public.svc_company_role(t.id('x'), auth.uid());
  raise exception 'FAIL: ログインユーザーが service 用関数を呼べた';
exception when insufficient_privilege then raise notice 'ok - service 用の関数はログインユーザーから呼べない'; end $$;
reset role;


-- ===== 管理機能・セキュリティ（20261128140000） =====
create table t.hrdcode as select firm_code as code from public.companies where kind = 'hrd';
grant select on t.hrdcode to public;
select t.ok((select code from t.hrdcode) is not null, 'HRD総合事務所にも事務所コードがある');
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
insert into t.ids values ('y3', public.register_account('client', '3社目'));
select public.company_link_firm(t.id('y3'), (select code from t.hrdcode));
select t.ok(public.access_status(t.id('y3')) = 'covered_by_firm', '企業はHRDの事務所コードでHRDの顧問先になれる（以後HRDの契約でカバー）');
do $$ begin
  perform public.company_link_firm(t.id('firm'), (select code from t.hrdcode));
  raise exception 'FAIL: 会計事務所を顧問先にできた';
exception when insufficient_privilege or raise_exception then
  if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok - 会計事務所アカウントは顧問先としてつなげない'; end $$;
reset role;

-- 利用停止
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select public.admin_set_suspended(t.id('x'), true, '不正利用の疑い');
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', false);
select t.ok(public.access_status(t.id('x')) = 'suspended', '停止中の会社は「利用停止」と表示');
select t.ok((select count(*) from public.payments where company_id = t.id('x')) = 0, '停止中の会社は事務所の契約があってもデータを使えない');
reset role;
select t.ok((select usable from public.svc_company_role(t.id('x'), '00000000-0000-0000-0000-0000000000f2')) is not true, 'API：停止中の会社は事務所スタッフも使えない');
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select public.admin_set_suspended(t.id('x'), false);
select public.admin_set_billing_exempt(t.id('y2'), true);
select t.ok((select count(*) from public.admin_list_users()) = 6, 'HRD管理者は全ユーザーを一覧できる');
select t.ok((select count(*) from public.admin_audit_logs(50)) > 0, 'HRD管理者は全体の操作ログを見られる');
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select t.ok(public.access_status(t.id('y2')) = 'active', '無料扱いにした会社は契約中と同じく使える');
reset role;

-- 最後のオーナー
do $$ begin
  delete from public.memberships where company_id = t.id('y2') and role = 'owner';
  raise exception 'FAIL: 最後のオーナーを削除できた';
exception when raise_exception then
  if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok - 最後のオーナーは削除・降格できない'; end $$;
select t.ok((select count(*) from public.firm_clients) > 0 and (select count(*) from public.audit_logs where table_name = 'firm_clients') > 0, '顧問関係の変更が操作ログに残る');

-- 2段階認証
insert into auth.mfa_factors(user_id, status) values ('00000000-0000-0000-0000-00000000000a', 'verified');
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select set_config('request.jwt.claims', '{"aal":"aal1"}', false);
select t.ok((select count(*) from public.payments) = 0, '2段階認証を設定したHRD管理者は、未認証のセッションでは管理者権限が無効');
do $$ begin
  perform public.admin_list_accounts();
  raise exception 'FAIL: 未認証で管理機能を使えた';
exception when insufficient_privilege then raise notice 'ok - 未認証のセッションでは管理機能を使えない'; end $$;
select set_config('request.jwt.claims', '{"aal":"aal2"}', false);
select t.ok((select count(*) from public.payments) >= 2, '2段階認証済みのセッションでは管理者権限が有効');
select set_config('request.jwt.claims', '', false);
reset role;


-- ===== アカウント一覧・予算（20261128150000） =====
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000f', false);
select t.ok((select count(*) from public.managed_members() where company_id = t.id('x')) >= 1, 'アカウント一覧：事務所オーナーは顧問先Xのメンバーも管理できる');
select t.ok(exists (select 1 from public.managed_members() where company_id = t.id('firm')), 'アカウント一覧：事務所オーナーは自事務所のメンバーを管理できる');
update public.memberships set role = 'member' where company_id = t.id('x') and user_id = '00000000-0000-0000-0000-0000000000c2';
select t.ok((select role from public.memberships where company_id = t.id('x') and user_id = '00000000-0000-0000-0000-0000000000c2') = 'member', '事務所オーナーは顧問先メンバーの権限を変更できる');
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f2', false);
select t.ok((select count(*) from public.managed_members()) = 0, 'アカウント一覧：一般メンバーには管理対象がない');
-- 事務所スタッフ（member）が顧問先Xの予算を作る
reset role;
create temp table bud (id uuid); grant all on bud to public;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f2', false);
with z as (insert into public.budgets(company_id, fiscal_year, name) values (t.id('x'), 2026, '当初予算') returning id) insert into bud select id from z;
select t.ok(public.budget_replace_lines((select id from bud), '[{"cf_item":"仕入支払","payee_name":"A社","month":"2026-04-15","amount":100000},{"cf_item":"仕入支払","payee_name":"A社","month":"2026-04-01","amount":50000},{"cf_item":"人件費","payee_name":"","month":"2026-05-01","amount":300000}]'::jsonb) = 2, '予算明細を一括保存できる（同じ月・相手先は合算）');
select t.ok((select amount from public.budget_lines where payee_name = 'A社') = 150000, '予算明細の月は月初にそろえて合算される');
do $$ begin
  perform public.budget_set_status((select id from bud), true);
  raise exception 'FAIL: 担当者が予算を承認できた';
exception when insufficient_privilege then raise notice 'ok - 担当者は予算を承認できない'; end $$;
do $$ begin
  update public.budgets set status = 'approved' where id = (select id from bud);
  raise exception 'FAIL: 予算の承認状態を直接書き換えられた';
exception when raise_exception then
  if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok - 予算の承認状態は直接書き換えられない'; end $$;
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000f', false);
select public.budget_set_status((select id from bud), true);
select t.ok((select status from public.budgets where id = (select id from bud)) = 'approved', '事務所オーナーは顧問先の予算を承認できる');
do $$ begin
  perform public.budget_replace_lines((select id from bud), '[]'::jsonb);
  raise exception 'FAIL: 承認済み予算を変更できた';
exception when raise_exception then
  if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok - 承認済みの予算は変更できない'; end $$;
reset role;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ee', false);
select t.ok((select count(*) from public.budgets) = 0 and (select count(*) from public.budget_lines) = 0, '部外者は予算を見られない');
do $$ begin
  insert into public.budgets(company_id, fiscal_year) values (t.id('x'), 2027);
  raise exception 'FAIL: 部外者が予算を作れた';
exception when insufficient_privilege then raise notice 'ok - 部外者は予算を作れない'; end $$;
reset role;

\echo '=== ALL TESTS PASSED ==='
