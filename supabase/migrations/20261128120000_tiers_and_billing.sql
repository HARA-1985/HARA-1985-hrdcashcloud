-- =====================================================================
-- HRD資金繰りクラウド：3階層（HRD／会計事務所／企業）と 30日無料 → サブスク
-- 既存スキーマ（companies / memberships / profiles.is_hrd_staff / private.has_role …）を拡張する。
--
--   ① HRD総合事務所（システム管理者）: profiles.is_hrd_staff = true（既存）
--   ② 会計事務所アカウント           : companies.kind = 'accounting_firm'（追加）
--   ③ 企業アカウント                 : companies.kind = 'client'（既存）
--   会計事務所 ⇔ 顧問先              : firm_clients（追加）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. companies の拡張
-- ---------------------------------------------------------------------
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.companies'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%kind%'
  loop
    execute format('alter table public.companies drop constraint %I', c);
  end loop;
end $$;

alter table public.companies
  add constraint companies_kind_check check (kind in ('hrd', 'accounting_firm', 'client'));

alter table public.companies
  add column if not exists trial_ends_at      timestamptz not null default (now() + interval '30 days'),
  add column if not exists firm_code          text unique,
  add column if not exists managed_by_firm_id uuid references public.companies(id) on delete set null,
  add column if not exists created_by         uuid references auth.users(id) on delete set null;

alter table public.companies drop constraint if exists companies_firm_code_kind;
alter table public.companies
  add constraint companies_firm_code_kind check (firm_code is null or kind = 'accounting_firm');

-- ---------------------------------------------------------------------
-- 2. 会計事務所 ⇔ 顧問先
--    firm_id は 'accounting_firm' または 'hrd'（HRD自身の顧問先）
-- ---------------------------------------------------------------------
create table if not exists public.firm_clients (
  firm_id    uuid not null references public.companies(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  status     text not null default 'active' check (status in ('active', 'revoked')),
  linked_by  uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (firm_id, company_id)
);
create index if not exists firm_clients_company_idx on public.firm_clients(company_id);

create or replace function private.firm_clients_check()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (select kind from public.companies where id = new.firm_id) not in ('accounting_firm', 'hrd') then
    raise exception 'firm_id は会計事務所である必要があります';
  end if;
  if (select kind from public.companies where id = new.company_id) <> 'client' then
    raise exception 'company_id は企業である必要があります';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists firm_clients_check on public.firm_clients;
create trigger firm_clients_check before insert or update on public.firm_clients
  for each row execute function private.firm_clients_check();

-- ---------------------------------------------------------------------
-- 3. 料金表とサブスク（サブスク状態は Stripe Webhook = service role だけが書く）
-- ---------------------------------------------------------------------
create table if not exists public.plans (
  code                   text primary key,
  company_kind           text not null check (company_kind in ('accounting_firm', 'client')),
  name                   text not null,
  monthly_price_jpy      integer not null check (monthly_price_jpy >= 0),
  per_client_price_jpy   integer not null default 0 check (per_client_price_jpy >= 0),
  stripe_price_id        text,
  stripe_client_price_id text,
  is_active              boolean not null default true,
  sort_order             integer not null default 0,
  created_at             timestamptz not null default now()
);
insert into public.plans (code, company_kind, name, monthly_price_jpy, per_client_price_jpy, sort_order) values
  ('client_monthly', 'client',          '企業プラン',       980,  0,   10),
  ('firm_monthly',   'accounting_firm', '会計事務所プラン', 2980, 300, 20)
on conflict (code) do nothing;

create table if not exists public.subscriptions (
  company_id             uuid primary key references public.companies(id) on delete cascade,
  plan_code              text references public.plans(code),
  status                 text not null default 'incomplete' check (status in
                           ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  client_quantity        integer not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4. 招待（トークンはハッシュで保存）
-- ---------------------------------------------------------------------
create table if not exists public.invitations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  email       text not null,
  role        text not null default 'member' check (role in ('approver', 'member', 'viewer')),
  token_hash  text not null unique,
  invited_by  uuid references auth.users(id) on delete set null,
  expires_at  timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists invitations_company_idx on public.invitations(company_id);

-- =====================================================================
-- 5. 利用可否と権限
-- =====================================================================

-- 自社の試用・サブスクで使えるか（HRD自身は常に可）
create or replace function private.has_own_access(cid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.companies c where c.id = cid and (c.kind = 'hrd' or c.trial_ends_at > now()))
      or exists (
        select 1 from public.subscriptions s
        where s.company_id = cid and s.status in ('trialing', 'active', 'past_due')
          and (s.current_period_end is null or s.current_period_end > now() - interval '3 days'));
$$;

-- 会社として使えるか（自社分 ＋ つながっている会計事務所の契約）
create or replace function private.has_access(cid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_own_access(cid)
      or exists (
        select 1 from public.firm_clients fc
        where fc.company_id = cid and fc.status = 'active' and private.has_own_access(fc.firm_id));
$$;

-- 会社を「見られる」か（課金状態は問わない：期限切れでも課金画面へ進めるように）
create or replace function private.can_view(cid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_hrd_staff()
      or exists (select 1 from public.memberships m where m.company_id = cid and m.user_id = auth.uid())
      or exists (
        select 1 from public.firm_clients fc
        join public.memberships m on m.company_id = fc.firm_id and m.user_id = auth.uid()
        where fc.company_id = cid and fc.status = 'active');
$$;

-- 既存の has_role を拡張：会計事務所のメンバーは顧問先で同じ役割を持つ／課金状態で利用を制御
--   can_read / can_write はこの関数を呼ぶので、支払予定などの業務テーブルにも自動で効く
create or replace function private.has_role(cid uuid, roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_hrd_staff()
      or (
        private.has_access(cid)
        and exists (select 1 from public.memberships m
                    where m.company_id = cid and m.user_id = auth.uid() and m.role = any(roles))
      )
      or exists (
        select 1 from public.firm_clients fc
        join public.memberships m on m.company_id = fc.firm_id and m.user_id = auth.uid()
        where fc.company_id = cid and fc.status = 'active'
          and m.role = any(roles)
          and private.has_own_access(fc.firm_id)
      );
$$;

-- =====================================================================
-- 6. RLS
-- =====================================================================
-- 会社と所属は「見る」だけなら期限切れでも可
-- 企業のメンバーは、つながっている会計事務所の名前も見られる（事務所のメンバー一覧などは見えない）
create or replace function private.is_my_firm(cid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.firm_clients fc
    join public.memberships m on m.company_id = fc.company_id and m.user_id = auth.uid()
    where fc.firm_id = cid and fc.status = 'active');
$$;

drop policy if exists "company read" on public.companies;
create policy "company read" on public.companies for select to authenticated
  using (private.can_view(id) or private.is_my_firm(id));

drop policy if exists "membership read" on public.memberships;
create policy "membership read" on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or private.can_view(company_id));

drop policy if exists "mf read" on public.mf_connections;
create policy "mf read" on public.mf_connections for select to authenticated using (private.can_view(company_id));

-- 会社の作成は RPC 経由のみ（register_account / firm_create_client / create_company）
-- 既存の "company insert"（HRD管理者のみ）はそのまま
-- 試用期限・事務所コード・管理元は利用者が直接書き換えられないようにする
revoke update on public.companies from authenticated, anon;
grant update (name, name_kana, mf_plan, mf_account_map) on public.companies to authenticated;

alter table public.firm_clients  enable row level security;
alter table public.plans         enable row level security;
alter table public.subscriptions enable row level security;
alter table public.invitations   enable row level security;

drop policy if exists "firm_clients read" on public.firm_clients;
create policy "firm_clients read" on public.firm_clients for select to authenticated
  using (private.is_hrd_staff()
         or exists (select 1 from public.memberships m where m.user_id = (select auth.uid())
                    and m.company_id in (firm_clients.firm_id, firm_clients.company_id)));
revoke insert, update, delete on public.firm_clients from authenticated, anon;

drop policy if exists "plans read" on public.plans;
create policy "plans read" on public.plans for select to anon, authenticated using (is_active or private.is_hrd_staff());
revoke insert, update, delete on public.plans from authenticated, anon;

drop policy if exists "subscriptions read" on public.subscriptions;
create policy "subscriptions read" on public.subscriptions for select to authenticated
  using (private.is_hrd_staff()
         or exists (select 1 from public.memberships m where m.company_id = subscriptions.company_id and m.user_id = (select auth.uid())));
revoke all on public.subscriptions from anon;
revoke insert, update, delete on public.subscriptions from authenticated;

drop policy if exists "invitations read" on public.invitations;
create policy "invitations read" on public.invitations for select to authenticated
  using (private.has_role(company_id, array['owner']));
revoke all on public.invitations from anon;
revoke insert, update, delete on public.invitations from authenticated;

revoke all on public.firm_clients from anon;

-- =====================================================================
-- 7. 操作（RPC）
-- =====================================================================
create or replace function private.require_uid()
returns uuid language plpgsql stable set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'ログインが必要です' using errcode = '42501'; end if;
  return auth.uid();
end $$;

create or replace function private.new_firm_code()
returns text language sql volatile set search_path = '' as $$
  select upper(substr(encode(extensions.gen_random_bytes(6), 'hex'), 1, 10));
$$;

-- ② ③ 新規登録：会計事務所 or 企業を作成（作成者が owner、30日無料）
--   同じ人が同じ種別を作り直した場合は無料期間なし（試用の使い回し防止）
create or replace function public.register_account(p_kind text, p_name text, p_kana text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_used boolean;
  v_id uuid;
begin
  if p_kind not in ('accounting_firm', 'client') then raise exception '種別が不正です'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception '名称を入力してください'; end if;

  select exists (select 1 from public.companies c
                 where c.created_by = v_uid and c.kind = p_kind and c.managed_by_firm_id is null)
    into v_used;

  insert into public.companies (name, name_kana, kind, created_by, trial_ends_at, firm_code)
  values (btrim(p_name), p_kana, p_kind, v_uid,
          case when v_used then now() else now() + interval '30 days' end,
          case when p_kind = 'accounting_firm' then private.new_firm_code() end)
  returning id into v_id;

  insert into public.memberships (company_id, user_id, role) values (v_id, v_uid, 'owner');
  insert into public.mf_connections (company_id) values (v_id) on conflict do nothing;
  return v_id;
end $$;

-- ② 会計事務所：顧問先を登録（事務所の契約でカバーするため顧問先自体の無料期間はなし）
create or replace function public.firm_create_client(p_firm uuid, p_name text, p_kana text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_id uuid;
begin
  if (select kind from public.companies where id = p_firm) not in ('accounting_firm', 'hrd') then
    raise exception '会計事務所ではありません';
  end if;
  if not private.has_role(p_firm, array['owner', 'approver']) then
    raise exception '顧問先を登録する権限がありません' using errcode = '42501';
  end if;

  insert into public.companies (name, name_kana, kind, managed_by_firm_id, created_by, trial_ends_at)
  values (btrim(p_name), p_kana, 'client', p_firm, v_uid, now())
  returning id into v_id;
  insert into public.firm_clients (firm_id, company_id, linked_by) values (p_firm, v_id, v_uid);
  insert into public.mf_connections (company_id) values (v_id) on conflict do nothing;
  return v_id;
end $$;

-- 既存の create_company（HRD管理者が顧問先を追加）も HRD の顧問先としてつなぐ
create or replace function public.create_company(p_name text, p_kana text default null, p_plan text default 'スモールビジネス')
returns uuid language plpgsql security definer set search_path = '' as $$
declare cid uuid; hrd uuid;
begin
  if not private.is_hrd_staff() then raise exception 'HRD管理者のみ顧問先を追加できます'; end if;
  select id into hrd from public.companies where kind = 'hrd' limit 1;
  insert into public.companies(name, name_kana, kind, mf_plan, managed_by_firm_id, created_by, trial_ends_at)
  values (p_name, p_kana, 'client', p_plan, hrd, auth.uid(), case when hrd is null then now() + interval '30 days' else now() end)
  returning id into cid;
  if hrd is not null then
    insert into public.firm_clients(firm_id, company_id, linked_by) values (hrd, cid, auth.uid());
  end if;
  insert into public.mf_connections(company_id) values (cid);
  return cid;
end $$;

-- ③ 企業：会計事務所の招待コードでつながる
create or replace function public.company_link_firm(p_company uuid, p_firm_code text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_firm uuid;
begin
  if not private.is_hrd_staff() and not exists (
    select 1 from public.memberships where company_id = p_company and user_id = v_uid and role = 'owner') then
    raise exception '企業のオーナーのみ操作できます' using errcode = '42501';
  end if;
  select id into v_firm from public.companies where kind = 'accounting_firm' and firm_code = upper(btrim(p_firm_code));
  if v_firm is null then raise exception '事務所コードが見つかりません'; end if;
  insert into public.firm_clients (firm_id, company_id, linked_by) values (v_firm, p_company, v_uid)
  on conflict (firm_id, company_id) do update set status = 'active', linked_by = excluded.linked_by;
  return v_firm;
end $$;

-- 顧問関係の解除（企業オーナー／事務所オーナー／HRD）
create or replace function public.unlink_firm_client(p_firm uuid, p_company uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  if not (private.is_hrd_staff() or exists (
    select 1 from public.memberships where user_id = v_uid and role = 'owner' and company_id in (p_firm, p_company))) then
    raise exception '権限がありません' using errcode = '42501';
  end if;
  update public.firm_clients set status = 'revoked' where firm_id = p_firm and company_id = p_company;
end $$;

-- 事務所コードの再発行
create or replace function public.firm_rotate_code(p_firm uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_code text := private.new_firm_code();
begin
  perform private.require_uid();
  if not private.has_role(p_firm, array['owner']) then raise exception '権限がありません' using errcode = '42501'; end if;
  update public.companies set firm_code = v_code where id = p_firm and kind = 'accounting_firm';
  return v_code;
end $$;

-- 招待の作成（オーナー。事務所オーナーは顧問先へも招待できる）。トークンは1回だけ返す
create or replace function public.create_invitation(p_company uuid, p_email text, p_role text default 'member')
returns text language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_token text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not private.has_role(p_company, array['owner']) then raise exception '招待する権限がありません' using errcode = '42501'; end if;
  if p_role not in ('approver', 'member', 'viewer') then raise exception '役割が不正です'; end if;
  insert into public.invitations (company_id, email, role, token_hash, invited_by)
  values (p_company, lower(btrim(p_email)), p_role, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_uid);
  return v_token;
end $$;

create or replace function public.accept_invitation(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid(); v_email text; v_inv public.invitations;
begin
  select email into v_email from auth.users where id = v_uid;
  select * into v_inv from public.invitations
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and accepted_at is null and expires_at > now();
  if v_inv.id is null then raise exception '招待が見つからないか、期限が切れています'; end if;
  if lower(v_inv.email) <> lower(v_email) then raise exception '招待されたメールアドレスでログインしてください'; end if;
  insert into public.memberships (company_id, user_id, role) values (v_inv.company_id, v_uid, v_inv.role)
  on conflict (company_id, user_id) do nothing;
  update public.invitations set accepted_at = now() where id = v_inv.id;
  return v_inv.company_id;
end $$;

-- 画面表示用：'active'（サブスク） / 'trial' / 'covered_by_firm' / 'expired'
create or replace function public.access_status(p_company uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_view(p_company) then raise exception '権限がありません' using errcode = '42501'; end if;
  if (select kind from public.companies where id = p_company) = 'hrd' then return 'active'; end if;
  if exists (select 1 from public.subscriptions s where s.company_id = p_company
             and s.status in ('trialing', 'active', 'past_due')
             and (s.current_period_end is null or s.current_period_end > now() - interval '3 days')) then
    return 'active';
  elsif exists (select 1 from public.companies c where c.id = p_company and c.trial_ends_at > now()) then
    return 'trial';
  elsif private.has_access(p_company) then
    return 'covered_by_firm';
  end if;
  return 'expired';
end $$;

-- 権限判定を画面・Edge Function から使う
create or replace function public.is_company_owner(p_company uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_hrd_staff() or exists (
    select 1 from public.memberships where company_id = p_company and user_id = auth.uid() and role = 'owner');
$$;

-- ① HRD管理者：全アカウント一覧と無料期間の延長
create or replace function public.admin_list_accounts()
returns table (id uuid, kind text, name text, created_at timestamptz, trial_ends_at timestamptz,
               member_count bigint, client_count bigint, subscription_status text,
               current_period_end timestamptz, has_access boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_hrd_staff() then raise exception 'HRD管理者のみ' using errcode = '42501'; end if;
  return query
  select c.id, c.kind, c.name, c.created_at, c.trial_ends_at,
         (select count(*) from public.memberships m where m.company_id = c.id),
         (select count(*) from public.firm_clients fc where fc.firm_id = c.id and fc.status = 'active'),
         s.status, s.current_period_end, private.has_access(c.id)
  from public.companies c left join public.subscriptions s on s.company_id = c.id
  order by c.created_at desc;
end $$;

create or replace function public.admin_extend_trial(p_company uuid, p_days integer)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v timestamptz;
begin
  if not private.is_hrd_staff() then raise exception 'HRD管理者のみ' using errcode = '42501'; end if;
  update public.companies set trial_ends_at = greatest(trial_ends_at, now()) + make_interval(days => p_days)
   where id = p_company returning trial_ends_at into v;
  return v;
end $$;

-- 自分が使える会社の一覧（会社切り替えメニュー用）
create or replace view public.my_companies with (security_invoker = true) as
select c.id, c.name, c.kind, c.trial_ends_at, c.managed_by_firm_id,
       exists (select 1 from public.memberships m where m.company_id = c.id and m.user_id = auth.uid()) as is_member,
       private.has_access(c.id) as usable
from public.companies c;
grant select on public.my_companies to authenticated;
revoke all on public.my_companies from anon;

-- 実行権限
do $$
declare f text;
begin
  foreach f in array array[
    'public.register_account(text, text, text)',
    'public.firm_create_client(uuid, text, text)',
    'public.company_link_firm(uuid, text)',
    'public.unlink_firm_client(uuid, uuid)',
    'public.firm_rotate_code(uuid)',
    'public.create_invitation(uuid, text, text)',
    'public.accept_invitation(text)',
    'public.access_status(uuid)',
    'public.is_company_owner(uuid)',
    'public.admin_list_accounts()',
    'public.admin_extend_trial(uuid, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- RLS とビューから呼ばれる関数（ログインユーザーが実行できる必要がある）
grant execute on function private.can_view(uuid), private.has_access(uuid), private.has_own_access(uuid), private.is_my_firm(uuid)
  to authenticated, service_role;
