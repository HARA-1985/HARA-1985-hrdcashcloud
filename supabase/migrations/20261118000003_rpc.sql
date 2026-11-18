-- HRD資金繰りクラウド：初期設定・サンプルデータ用の関数

-- 許可リストのメールでログインした人を HRD 管理者にし、HRD自身の会社を用意する（何度呼んでも同じ結果）
create or replace function public.bootstrap() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare em text; hrd uuid;
begin
  select email into em from auth.users where id = auth.uid();
  if em is null or not exists (select 1 from private.bootstrap_emails b where lower(b.email) = lower(em)) then
    return jsonb_build_object('hrd_staff', private.is_hrd_staff());
  end if;
  update public.profiles set is_hrd_staff = true where id = auth.uid();
  select id into hrd from public.companies where kind = 'hrd' limit 1;
  if hrd is null then
    insert into public.companies(name, name_kana, kind, mf_plan)
    values ('HRD総合事務所株式会社', 'HRDｿｳｺﾞｳｼﾞﾑｼﾖ(ｶ', 'hrd', 'スモールビジネス') returning id into hrd;
    insert into public.memberships(company_id, user_id, role) values (hrd, auth.uid(), 'owner');
    insert into public.mf_connections(company_id) values (hrd);
  end if;
  return jsonb_build_object('hrd_staff', true, 'hrd_company', hrd);
end $$;
revoke all on function public.bootstrap() from public, anon;
grant execute on function public.bootstrap() to authenticated;

-- 顧問先の追加（HRD管理者のみ）
create or replace function public.create_company(p_name text, p_kana text default null, p_plan text default 'スモールビジネス') returns uuid
language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  if not private.is_hrd_staff() then raise exception 'HRD管理者のみ顧問先を追加できます'; end if;
  insert into public.companies(name, name_kana, kind, mf_plan) values (p_name, p_kana, 'client', p_plan) returning id into cid;
  insert into public.mf_connections(company_id) values (cid);
  return cid;
end $$;
revoke all on function public.create_company(text, text, text) from public, anon;
grant execute on function public.create_company(text, text, text) to authenticated;

-- サンプルデータ投入（動作確認用・オーナー/HRD管理者のみ。支払予定が空の会社にだけ入る）
create or replace function public.seed_demo(cid uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare b1 uuid; b2 uuid; b3 uuid; m date := date_trunc('month', current_date)::date; n int;
begin
  if not private.has_role(cid, array['owner']) then raise exception '権限がありません'; end if;
  if exists (select 1 from public.payments where company_id = cid) then return 0; end if;

  insert into public.bank_accounts(company_id, bank_name, bank_code, bank_kana, branch_code, branch_name, branch_kana, account_type, account_number, holder_kana, client_code)
    values (cid, '北洋銀行', '0501', 'ﾎｸﾖｳ', '001', '本店', 'ﾎﾝﾃﾝ', '1', '0000001', 'ｻﾝﾌﾟﾙ(ｶ', '0000000001') returning id into b1;
  insert into public.bank_accounts(company_id, bank_name, bank_code, bank_kana, branch_code, branch_name, branch_kana, account_type, account_number, holder_kana, client_code)
    values (cid, '三井住友銀行', '0009', 'ﾐﾂｲｽﾐﾄﾓ', '001', '本店', 'ﾎﾝﾃﾝ', '1', '0000002', 'ｻﾝﾌﾟﾙ(ｶ', '0000000002') returning id into b2;
  insert into public.bank_accounts(company_id, bank_name, bank_code, bank_kana, branch_code, branch_name, branch_kana, account_type, account_number, holder_kana, client_code)
    values (cid, 'GMOあおぞらネット銀行', '0310', 'GMOｱｵｿﾞﾗﾈﾂﾄ', '101', '法人営業部', 'ﾎｳｼﾞﾝｴｲｷﾞﾖｳ', '1', '0000003', 'ｻﾝﾌﾟﾙ(ｶ', '0000000003') returning id into b3;

  insert into public.payees(company_id, name, name_kana, bank_code, bank_kana, branch_code, branch_kana, account_type, account_number) values
    (cid, '札幌中央ビル管理（サンプル）', 'ｻﾂﾎﾟﾛﾁﾕｳｵｳﾋﾞﾙｶﾝﾘ', '0005', 'ﾐﾂﾋﾞｼUFJ', '100', 'ｻﾂﾎﾟﾛ', '1', '1111111'),
    (cid, '北日本リース（サンプル）', 'ｷﾀﾆﾎﾝﾘ-ｽ', '0501', 'ﾎｸﾖｳ', '200', 'ｻﾂﾎﾟﾛｴｷﾏｴ', '1', '2222222'),
    (cid, 'スタジオ・アオ（サンプル）', 'ｽﾀｼﾞｵｱｵ', '0001', 'ﾐｽﾞﾎ', '300', 'ｼﾌﾞﾔ', '1', '3333333'),
    (cid, 'ペイロール北（サンプル）', 'ﾍﾟｲﾛ-ﾙｷﾀ', '0501', 'ﾎｸﾖｳ', '110', 'ｵｵﾄﾞｵﾘ', '1', '4444444'),
    (cid, '北栄商事（サンプル）', 'ﾎｸｴｲｼﾖｳｼﾞ', '0116', 'ﾎﾂｶｲﾄﾞｳ', '120', 'ﾎﾝﾃﾝ', '1', '5555555');

  insert into public.payments(company_id, due_date, payee_name, item, amount, kind, source, bank_account_id, account_title, status) values
    (cid, m + 19, '札幌中央ビル管理（サンプル）', '事務所賃料', 330000, 'fixed', 'invoice', b1, '未払金', 'pending'),
    (cid, m + 19, '北日本リース（サンプル）', '複合機リース料', 16500, 'fixed', 'invoice', b1, '未払金', 'pending'),
    (cid, m + 24, 'スタジオ・アオ（サンプル）', '外注デザイン費', 264000, 'spot', 'invoice', b2, '買掛金', 'pending'),
    (cid, m + 24, 'ペイロール北（サンプル）', '給与計算代行', 88000, 'fixed', 'invoice', b1, '未払金', 'pending'),
    (cid, m + 25, '法人カードA', '前月利用分 引落', 412870, 'fixed', 'card', b2, '未払金', 'auto_debit'),
    (cid, (m + interval '1 month' - interval '1 day')::date, '北栄商事（サンプル）', '前月締 仕入代金', 1078000, 'fixed', 'invoice', b3, '買掛金', 'pending'),
    (cid, (m + interval '1 month')::date + 4, 'サンプルメディア', '広告運用費', 165000, 'spot', 'invoice', b3, '買掛金', 'pending'),
    (cid, (m + interval '1 month')::date + 9, '税務署', '源泉所得税', 72300, 'fixed', 'manual', b1, '預り金', 'pending');

  update public.payments x set payee_id = p.id from public.payees p
    where x.company_id = cid and p.company_id = cid and p.name = x.payee_name;

  insert into public.card_transactions(company_id, card_name, used_on, merchant, amount, suggested_account, external_id) values
    (cid, '法人カードA', current_date - 1, 'AWS', 48210, '通信費', 'demo-1'),
    (cid, '法人カードA', current_date - 2, 'JR北海道', 1290, '旅費交通費', 'demo-2'),
    (cid, '法人カードB', current_date - 3, 'Google Workspace', 13600, '通信費', 'demo-3'),
    (cid, '法人カードA', current_date - 4, 'ヨドバシカメラ', 21780, '消耗品費', 'demo-4');

  select count(*) into n from public.payments where company_id = cid;
  return n;
end $$;
revoke all on function public.seed_demo(uuid) from public, anon;
grant execute on function public.seed_demo(uuid) to authenticated;
