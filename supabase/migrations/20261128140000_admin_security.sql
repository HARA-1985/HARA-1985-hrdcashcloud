-- =====================================================================
-- 管理機能・セキュリティの強化
--   1. HRD総合事務所を「会計事務所」としても運用（事務所コードの発行・顧問先の管理）
--   2. マスターアカウント accounting@cpa-hara.com
--   3. アカウントの利用停止／無料扱い（HRD管理者が設定）
--   4. 最後のオーナーの削除・降格を防ぐ
--   5. 顧問関係・サブスク・招待の変更を操作ログに記録
--   6. 2段階認証を設定した HRD 管理者は、2段階認証済みのログインでのみ管理者権限が有効
--   7. HRD管理者向けの一覧・設定 RPC
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. HRD総合事務所にも事務所コード
-- ---------------------------------------------------------------------
alter table public.companies drop constraint if exists companies_firm_code_kind;
alter table public.companies
  add constraint companies_firm_code_kind check (firm_code is null or kind in ('accounting_firm', 'hrd'));
update public.companies set firm_code = private.new_firm_code() where kind = 'hrd' and firm_code is null;

-- 会計事務所・HRD を作ったときは自動で事務所コードを付ける（bootstrap() で HRD が作られた場合も）
create or replace function private.assign_firm_code()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.kind in ('accounting_firm', 'hrd') and new.firm_code is null then
    new.firm_code := private.new_firm_code();
  end if;
  return new;
end $$;
drop trigger if exists assign_firm_code on public.companies;
create trigger assign_firm_code before insert on public.companies
  for each row execute function private.assign_firm_code();

create or replace function public.company_link_firm(p_company uuid, p_firm_code text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_firm uuid;
begin
  if not private.is_hrd_staff() and not exists (
    select 1 from public.memberships where company_id = p_company and user_id = v_uid and role = 'owner') then
    raise exception '企業のオーナーのみ操作できます' using errcode = '42501';
  end if;
  if (select kind from public.companies where id = p_company) <> 'client' then
    raise exception '顧問先としてつなげられるのは企業アカウントのみです';
  end if;
  select id into v_firm from public.companies
   where kind in ('accounting_firm', 'hrd') and firm_code = upper(btrim(p_firm_code)) and suspended_at is null;
  if v_firm is null then raise exception '事務所コードが見つかりません'; end if;
  insert into public.firm_clients (firm_id, company_id, linked_by) values (v_firm, p_company, v_uid)
  on conflict (firm_id, company_id) do update set status = 'active', linked_by = excluded.linked_by;
  return v_firm;
end $$;

create or replace function public.firm_rotate_code(p_firm uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_code text := private.new_firm_code();
begin
  perform private.require_uid();
  if not private.has_role(p_firm, array['owner']) then raise exception '権限がありません' using errcode = '42501'; end if;
  update public.companies set firm_code = v_code where id = p_firm and kind in ('accounting_firm', 'hrd');
  return v_code;
end $$;

-- ---------------------------------------------------------------------
-- 2. マスターアカウント（初回ログイン時に bootstrap() で HRD管理者になる）
-- ---------------------------------------------------------------------
insert into private.bootstrap_emails (email) values ('accounting@cpa-hara.com') on conflict do nothing;
do $$
declare v_uid uuid; v_hrd uuid;
begin
  select id into v_uid from auth.users where lower(email) = 'accounting@cpa-hara.com' limit 1;
  if v_uid is null then return; end if;
  update public.profiles set is_hrd_staff = true where id = v_uid;
  select id into v_hrd from public.companies where kind = 'hrd' order by created_at limit 1;
  if v_hrd is not null then
    insert into public.memberships (company_id, user_id, role) values (v_hrd, v_uid, 'owner')
    on conflict (company_id, user_id) do update set role = 'owner';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. 利用停止／無料扱い
-- ---------------------------------------------------------------------
alter table public.companies
  add column if not exists suspended_at     timestamptz,
  add column if not exists suspended_reason text,
  add column if not exists billing_exempt   boolean not null default false;

create or replace function private.has_own_access(cid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
           select 1 from public.companies c
           where c.id = cid and c.suspended_at is null
             and (c.kind = 'hrd' or c.billing_exempt or c.trial_ends_at > now()))
      or exists (
           select 1 from public.subscriptions s
           join public.companies c on c.id = s.company_id and c.suspended_at is null
           where s.company_id = cid and s.status in ('trialing', 'active', 'past_due')
             and (s.current_period_end is null or s.current_period_end > now() - interval '3 days'));
$$;

-- 停止中の会社は、会計事務所の契約があっても使えない
create or replace function private.has_access(cid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.companies c where c.id = cid and c.suspended_at is null)
     and (private.has_own_access(cid)
          or exists (select 1 from public.firm_clients fc
                     where fc.company_id = cid and fc.status = 'active' and private.has_own_access(fc.firm_id)));
$$;

-- 画面表示用に 'suspended'（利用停止中）を追加
create or replace function public.access_status(p_company uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare c public.companies;
begin
  if not private.can_view(p_company) then raise exception '権限がありません' using errcode = '42501'; end if;
  select * into c from public.companies where id = p_company;
  if c.suspended_at is not null then return 'suspended'; end if;
  if c.kind = 'hrd' then return 'active'; end if;
  if c.billing_exempt or exists (select 1 from public.subscriptions s where s.company_id = p_company
             and s.status in ('trialing', 'active', 'past_due')
             and (s.current_period_end is null or s.current_period_end > now() - interval '3 days')) then
    return 'active';
  elsif private.has_access(p_company) and exists (select 1 from public.firm_clients fc
             where fc.company_id = p_company and fc.status = 'active' and private.has_own_access(fc.firm_id)) then
    return 'covered_by_firm';
  elsif c.trial_ends_at > now() then
    return 'trial';
  end if;
  return 'expired';
end $$;

-- ---------------------------------------------------------------------
-- 4. 最後のオーナーを消さない
-- ---------------------------------------------------------------------
create or replace function private.keep_last_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner')
     and exists (select 1 from public.companies where id = old.company_id)  -- 会社ごと削除するときは対象外
     and not exists (select 1 from public.memberships
                     where company_id = old.company_id and role = 'owner' and user_id <> old.user_id) then
    raise exception 'オーナーが1人もいなくなるため、この操作はできません。先に別のメンバーをオーナーにしてください';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists keep_last_owner on public.memberships;
create trigger keep_last_owner before update or delete on public.memberships
  for each row execute function private.keep_last_owner();

-- ---------------------------------------------------------------------
-- 5. 操作ログ
-- ---------------------------------------------------------------------
drop trigger if exists audit_firm_clients on public.firm_clients;
create trigger audit_firm_clients after insert or update or delete on public.firm_clients
  for each row execute function private.audit();
drop trigger if exists audit_subscriptions on public.subscriptions;
create trigger audit_subscriptions after insert or update or delete on public.subscriptions
  for each row execute function private.audit();
drop trigger if exists audit_invitations on public.invitations;
create trigger audit_invitations after insert or update or delete on public.invitations
  for each row execute function private.audit();

-- ---------------------------------------------------------------------
-- 6. 2段階認証（TOTP）を設定した HRD 管理者は、2段階認証済みのセッションでのみ管理者
-- ---------------------------------------------------------------------
create or replace function private.is_hrd_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select p.is_hrd_staff from public.profiles p where p.id = auth.uid()), false)
     and (
       not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
       or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
     );
$$;

-- ---------------------------------------------------------------------
-- 7. HRD管理者向け RPC
-- ---------------------------------------------------------------------
drop function if exists public.admin_list_accounts();
create function public.admin_list_accounts()
returns table (id uuid, kind text, name text, created_at timestamptz, trial_ends_at timestamptz,
               member_count bigint, client_count bigint, firm_names text, subscription_status text,
               current_period_end timestamptz, has_access boolean, suspended_at timestamptz,
               suspended_reason text, billing_exempt boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_hrd_staff() then raise exception 'HRD管理者のみ' using errcode = '42501'; end if;
  return query
  select c.id, c.kind, c.name, c.created_at, c.trial_ends_at,
         (select count(*) from public.memberships m where m.company_id = c.id),
         (select count(*) from public.firm_clients fc where fc.firm_id = c.id and fc.status = 'active'),
         (select string_agg(f.name, '、' order by f.name) from public.firm_clients fc
            join public.companies f on f.id = fc.firm_id where fc.company_id = c.id and fc.status = 'active'),
         s.status, s.current_period_end, private.has_access(c.id),
         c.suspended_at, c.suspended_reason, c.billing_exempt
  from public.companies c left join public.subscriptions s on s.company_id = c.id
  order by case c.kind when 'hrd' then 0 when 'accounting_firm' then 1 else 2 end, c.created_at desc;
end $$;

create or replace function public.admin_set_suspended(p_company uuid, p_suspended boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_hrd_staff() then raise exception 'HRD管理者のみ' using errcode = '42501'; end if;
  if (select kind from public.companies where id = p_company) = 'hrd' then raise exception 'HRD総合事務所は停止できません'; end if;
  update public.companies
     set suspended_at = case when p_suspended then now() end,
         suspended_reason = case when p_suspended then nullif(btrim(p_reason), '') end
   where id = p_company;
end $$;

create or replace function public.admin_set_billing_exempt(p_company uuid, p_exempt boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_hrd_staff() then raise exception 'HRD管理者のみ' using errcode = '42501'; end if;
  update public.companies set billing_exempt = p_exempt where id = p_company;
end $$;

create or replace function public.admin_list_users()
returns table (id uuid, email text, display_name text, is_hrd_staff boolean, created_at timestamptz,
               last_sign_in_at timestamptz, mfa_enabled boolean, companies text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_hrd_staff() then raise exception 'HRD管理者のみ' using errcode = '42501'; end if;
  return query
  select u.id, u.email::text, p.display_name, coalesce(p.is_hrd_staff, false), u.created_at, u.last_sign_in_at,
         exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified'),
         (select string_agg(c.name || '（' || m.role || '）', '、' order by c.name)
            from public.memberships m join public.companies c on c.id = m.company_id where m.user_id = u.id)
  from auth.users u left join public.profiles p on p.id = u.id
  order by u.created_at desc;
end $$;

create or replace function public.admin_set_hrd_staff(p_user uuid, p_value boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_hrd_staff() then raise exception 'HRD管理者のみ' using errcode = '42501'; end if;
  if p_user = auth.uid() and not p_value then raise exception '自分自身の管理者権限は外せません'; end if;
  update public.profiles set is_hrd_staff = p_value where id = p_user;
  insert into public.audit_logs(company_id, actor, action, table_name, record_id, detail)
  values (null, auth.uid(), 'update', 'profiles', p_user, jsonb_build_object('is_hrd_staff', p_value));
end $$;

create or replace function public.admin_audit_logs(p_limit integer default 200)
returns table (id bigint, created_at timestamptz, company_name text, actor_email text, action text, table_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_hrd_staff() then raise exception 'HRD管理者のみ' using errcode = '42501'; end if;
  return query
  select l.id, l.created_at, c.name, u.email::text, l.action, l.table_name
  from public.audit_logs l
  left join public.companies c on c.id = l.company_id
  left join auth.users u on u.id = l.actor
  order by l.created_at desc
  limit least(greatest(p_limit, 1), 1000);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.admin_list_accounts()',
    'public.admin_set_suspended(uuid, boolean, text)',
    'public.admin_set_billing_exempt(uuid, boolean)',
    'public.admin_list_users()',
    'public.admin_set_hrd_staff(uuid, boolean)',
    'public.admin_audit_logs(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- サーバーAPI用の役割判定：停止中の会社は、会計事務所経由でも使えない
create or replace function public.svc_company_role(p_company uuid, p_user uuid)
returns table (role text, usable boolean)
language sql stable security definer set search_path = '' as $$
  with cand as (
    select m.role, private.has_access(p_company) as ok
      from public.memberships m
     where m.company_id = p_company and m.user_id = p_user
    union all
    select m.role, (private.has_own_access(fc.firm_id)
                    and exists (select 1 from public.companies c where c.id = p_company and c.suspended_at is null)) as ok
      from public.firm_clients fc
      join public.memberships m on m.company_id = fc.firm_id and m.user_id = p_user
     where fc.company_id = p_company and fc.status = 'active'
  )
  select c.role, c.ok from cand c
   order by c.ok desc, array_position(array['owner', 'approver', 'member', 'viewer'], c.role)
   limit 1;
$$;
revoke all on function public.svc_company_role(uuid, uuid) from public, anon, authenticated;
grant execute on function public.svc_company_role(uuid, uuid) to service_role;

-- 停止中の会社は、会計事務所経由のメンバーにも権限を与えない
create or replace function private.has_role(cid uuid, roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_hrd_staff()
      or (
        private.has_access(cid)
        and exists (select 1 from public.memberships m
                    where m.company_id = cid and m.user_id = auth.uid() and m.role = any(roles))
      )
      or (
        exists (select 1 from public.companies c where c.id = cid and c.suspended_at is null)
        and exists (
          select 1 from public.firm_clients fc
          join public.memberships m on m.company_id = fc.firm_id and m.user_id = auth.uid()
          where fc.company_id = cid and fc.status = 'active'
            and m.role = any(roles)
            and private.has_own_access(fc.firm_id))
      );
$$;
