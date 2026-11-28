-- =====================================================================
-- アカウント一覧と権限管理／予算（入力・予算実績比較・次年度予算案）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. アカウント一覧：自分がオーナーとして管理できる会社のメンバー（HRD管理者は全社）
--    会計事務所のオーナーは、顧問先のメンバーも管理できる
-- ---------------------------------------------------------------------
create or replace function public.managed_members()
returns table (company_id uuid, company_name text, company_kind text, firm_name text,
               user_id uuid, email text, display_name text, role text,
               created_at timestamptz, last_sign_in_at timestamptz, mfa_enabled boolean)
language sql stable security definer set search_path = '' as $$
  select c.id, c.name, c.kind,
         (select string_agg(f.name, '、') from public.firm_clients fc join public.companies f on f.id = fc.firm_id
           where fc.company_id = c.id and fc.status = 'active'),
         m.user_id, u.email::text, p.display_name, m.role, m.created_at, u.last_sign_in_at,
         exists (select 1 from auth.mfa_factors x where x.user_id = m.user_id and x.status = 'verified')
    from public.companies c
    join public.memberships m on m.company_id = c.id
    join auth.users u on u.id = m.user_id
    left join public.profiles p on p.id = m.user_id
   where private.has_role(c.id, array['owner'])
   order by case c.kind when 'hrd' then 0 when 'accounting_firm' then 1 else 2 end, c.name,
            array_position(array['owner', 'approver', 'member', 'viewer'], m.role), u.email;
$$;
revoke all on function public.managed_members() from public, anon;
grant execute on function public.managed_members() to authenticated;

-- 会社の一覧（アカウント管理画面の招待先の選択肢）
create or replace function public.managed_companies()
returns table (id uuid, name text, kind text)
language sql stable security definer set search_path = '' as $$
  select c.id, c.name, c.kind from public.companies c
   where private.has_role(c.id, array['owner'])
   order by case c.kind when 'hrd' then 0 when 'accounting_firm' then 1 else 2 end, c.name;
$$;
revoke all on function public.managed_companies() from public, anon;
grant execute on function public.managed_companies() to authenticated;

-- ---------------------------------------------------------------------
-- 2. 予算
-- ---------------------------------------------------------------------
alter table public.companies
  add column if not exists fiscal_start_month integer not null default 4 check (fiscal_start_month between 1 and 12);
grant update (fiscal_start_month) on public.companies to authenticated;

create table if not exists public.budgets (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  fiscal_year integer not null check (fiscal_year between 2000 and 2100),  -- 期首の年（例：2026 = 2026年4月期首）
  name        text not null default '当初予算' check (char_length(name) between 1 and 100),
  status      text not null default 'draft' check (status in ('draft', 'approved')),
  note        text,
  source      jsonb not null default '{}'::jsonb,  -- 作成方法（過去実績から作成したときの条件など）
  created_by  uuid default auth.uid() references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, fiscal_year, name)
);
create index if not exists budgets_company_idx on public.budgets(company_id, fiscal_year);

create table if not exists public.budget_lines (
  id         uuid primary key default gen_random_uuid(),
  budget_id  uuid not null references public.budgets(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  cf_item    text not null check (char_length(cf_item) between 1 and 50),
  payee_name text not null default '' check (char_length(payee_name) <= 200),  -- '' は区分全体（相手先を特定しない分）
  month      date not null check (extract(day from month) = 1),
  amount     bigint not null default 0 check (amount >= 0),
  unique (budget_id, cf_item, payee_name, month)
);
create index if not exists budget_lines_budget_idx on public.budget_lines(budget_id);

-- 明細の会社は予算と同じ／承認済みの予算は変更できない
create or replace function private.budget_lines_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare b public.budgets;
begin
  select * into b from public.budgets where id = coalesce(new.budget_id, old.budget_id);
  if b.id is null then return coalesce(new, old); end if;  -- 予算ごと削除中
  if b.status = 'approved' then raise exception '承認済みの予算は変更できません。先に承認を取り消してください'; end if;
  if tg_op <> 'DELETE' then new.company_id := b.company_id; end if;
  return coalesce(new, old);
end $$;
drop trigger if exists budget_lines_guard on public.budget_lines;
create trigger budget_lines_guard before insert or update or delete on public.budget_lines
  for each row execute function private.budget_lines_guard();

-- 承認状態・作成者は RPC でのみ変更
create or replace function private.budgets_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and (new.status is distinct from old.status or new.approved_by is distinct from old.approved_by
     or new.approved_at is distinct from old.approved_at) and coalesce(current_setting('app.budget_status_change', true), '') <> 'on' then
    raise exception '予算の承認は「承認する」ボタンから行ってください';
  end if;
  if tg_op = 'UPDATE' and old.status = 'approved' and new.status = 'approved'
     and (new.name is distinct from old.name or new.fiscal_year is distinct from old.fiscal_year) then
    raise exception '承認済みの予算は変更できません';
  end if;
  if tg_op = 'INSERT' then new.status := 'draft'; new.approved_by := null; new.approved_at := null; end if;
  return new;
end $$;
drop trigger if exists budgets_guard on public.budgets;
create trigger budgets_guard before insert or update on public.budgets
  for each row execute function private.budgets_guard();

alter table public.budgets      enable row level security;
alter table public.budget_lines enable row level security;

drop policy if exists "budgets read" on public.budgets;
create policy "budgets read" on public.budgets for select to authenticated using (private.can_read(company_id));
drop policy if exists "budgets insert" on public.budgets;
create policy "budgets insert" on public.budgets for insert to authenticated with check (private.can_write(company_id));
drop policy if exists "budgets update" on public.budgets;
create policy "budgets update" on public.budgets for update to authenticated
  using (private.can_write(company_id)) with check (private.can_write(company_id));
drop policy if exists "budgets delete" on public.budgets;
create policy "budgets delete" on public.budgets for delete to authenticated
  using (private.has_role(company_id, array['owner']) and status = 'draft');

drop policy if exists "budget_lines read" on public.budget_lines;
create policy "budget_lines read" on public.budget_lines for select to authenticated using (private.can_read(company_id));
drop policy if exists "budget_lines write" on public.budget_lines;
create policy "budget_lines write" on public.budget_lines for all to authenticated
  using (private.can_write(company_id)) with check (private.can_write(company_id));
revoke all on public.budgets, public.budget_lines from anon;

-- 明細の一括保存（画面の表をまるごと置き換える）
--   p_lines: [{"cf_item":"仕入支払","payee_name":"A社","month":"2026-04-01","amount":100000}, ...]
create or replace function public.budget_replace_lines(p_budget uuid, p_lines jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare b public.budgets; n integer;
begin
  select * into b from public.budgets where id = p_budget;
  if b.id is null or not private.can_write(b.company_id) then raise exception '権限がありません' using errcode = '42501'; end if;
  if b.status = 'approved' then raise exception '承認済みの予算は変更できません。先に承認を取り消してください'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 20000 then raise exception '明細の形式が正しくありません'; end if;
  delete from public.budget_lines where budget_id = p_budget;
  insert into public.budget_lines (budget_id, company_id, cf_item, payee_name, month, amount)
  select p_budget, b.company_id, btrim(x ->> 'cf_item'), coalesce(btrim(x ->> 'payee_name'), ''),
         date_trunc('month', (x ->> 'month')::date)::date, sum(greatest(0, round((x ->> 'amount')::numeric)))::bigint
    from jsonb_array_elements(p_lines) x
   where coalesce(btrim(x ->> 'cf_item'), '') <> '' and (x ->> 'amount')::numeric > 0
   group by 1, 2, 3, 4, 5;
  get diagnostics n = row_count;
  update public.budgets set updated_at = now() where id = p_budget;
  insert into public.audit_logs(company_id, actor, action, table_name, record_id, detail)
  values (b.company_id, auth.uid(), 'update', 'budgets', p_budget, jsonb_build_object('lines', n));
  return n;
end $$;

-- 承認／承認の取り消し（オーナー・承認者）
create or replace function public.budget_set_status(p_budget uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.budgets;
begin
  select * into b from public.budgets where id = p_budget;
  if b.id is null or not private.has_role(b.company_id, array['owner', 'approver']) then
    raise exception '予算を承認する権限がありません（オーナー・承認者のみ）' using errcode = '42501';
  end if;
  perform set_config('app.budget_status_change', 'on', true);
  update public.budgets
     set status = case when p_approved then 'approved' else 'draft' end,
         approved_by = case when p_approved then auth.uid() end,
         approved_at = case when p_approved then now() end
   where id = p_budget;
  perform set_config('app.budget_status_change', 'off', true);
  insert into public.audit_logs(company_id, actor, action, table_name, record_id, detail)
  values (b.company_id, auth.uid(), 'update', 'budgets', p_budget, jsonb_build_object('approved', p_approved));
end $$;

revoke all on function public.budget_replace_lines(uuid, jsonb) from public, anon;
revoke all on function public.budget_set_status(uuid, boolean) from public, anon;
grant execute on function public.budget_replace_lines(uuid, jsonb) to authenticated;
grant execute on function public.budget_set_status(uuid, boolean) to authenticated;

drop trigger if exists audit_budgets on public.budgets;
create trigger audit_budgets after insert or delete on public.budgets
  for each row execute function private.audit();
