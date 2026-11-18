-- HRD資金繰りクラウド：アクセス制御・統制・監査
alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.memberships enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.payees enable row level security;
alter table public.documents enable row level security;
alter table public.payments enable row level security;
alter table public.card_transactions enable row level security;
alter table public.mf_connections enable row level security;
alter table public.fb_exports enable row level security;
alter table public.audit_logs enable row level security;

-- profiles：本人のみ編集可。is_hrd_staff は本人が変えられない
create policy "profile read" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.is_hrd_staff()
    or exists (select 1 from public.memberships m1 join public.memberships m2 on m1.company_id = m2.company_id
               where m1.user_id = (select auth.uid()) and m2.user_id = profiles.id));
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;
create policy "profile update" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- companies
create policy "company read" on public.companies for select to authenticated using (private.can_read(id));
create policy "company insert" on public.companies for insert to authenticated with check (private.is_hrd_staff());
create policy "company update" on public.companies for update to authenticated
  using (private.has_role(id, array['owner'])) with check (private.has_role(id, array['owner']));

-- memberships
create policy "membership read" on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or private.can_read(company_id));
create policy "membership insert" on public.memberships for insert to authenticated
  with check (private.has_role(company_id, array['owner']));
create policy "membership update" on public.memberships for update to authenticated
  using (private.has_role(company_id, array['owner'])) with check (private.has_role(company_id, array['owner']));
create policy "membership delete" on public.memberships for delete to authenticated
  using (private.has_role(company_id, array['owner']));

-- 業務テーブル：閲覧=全ロール／登録・編集=viewer以外／削除=owner
do $$
declare t text;
begin
  foreach t in array array['payees','documents','payments','card_transactions'] loop
    execute format('create policy "%1$s read" on public.%1$s for select to authenticated using (private.can_read(company_id))', t);
    execute format('create policy "%1$s insert" on public.%1$s for insert to authenticated with check (private.can_write(company_id))', t);
    execute format('create policy "%1$s update" on public.%1$s for update to authenticated using (private.can_write(company_id)) with check (private.can_write(company_id))', t);
    execute format('create policy "%1$s delete" on public.%1$s for delete to authenticated using (private.has_role(company_id, array[''owner'']))', t);
  end loop;
end $$;

-- 振込元口座：閲覧=全ロール／登録・編集・削除=owner
create policy "bank read" on public.bank_accounts for select to authenticated using (private.can_read(company_id));
create policy "bank insert" on public.bank_accounts for insert to authenticated with check (private.has_role(company_id, array['owner']));
create policy "bank update" on public.bank_accounts for update to authenticated
  using (private.has_role(company_id, array['owner'])) with check (private.has_role(company_id, array['owner']));
create policy "bank delete" on public.bank_accounts for delete to authenticated using (private.has_role(company_id, array['owner']));

create policy "mf read" on public.mf_connections for select to authenticated using (private.can_read(company_id));

-- FBデータ：作成は承認者・オーナーのみ
create policy "fb read" on public.fb_exports for select to authenticated using (private.can_read(company_id));
create policy "fb insert" on public.fb_exports for insert to authenticated
  with check (private.has_role(company_id, array['owner','approver']));

create policy "audit read" on public.audit_logs for select to authenticated using (private.can_read(company_id));

-- ===== 新規ユーザー → profile =====
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)), new.email);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ===== 承認の統制 =====
create or replace function private.payments_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if new.status = 'approved' then new.status := 'pending'; end if;
    new.approved_by := null; new.approved_at := null;
    return new;
  end if;
  -- 承認済みの重要項目が変わったら承認を取り消す
  if old.status = 'approved' and (new.amount <> old.amount or new.due_date <> old.due_date
      or new.payee_name <> old.payee_name or new.bank_account_id is distinct from old.bank_account_id) then
    new.status := 'pending';
  end if;
  if new.status = 'approved' and old.status <> 'approved' then
    if not private.has_role(new.company_id, array['owner','approver']) then
      raise exception '承認権限がありません';
    end if;
    new.approved_by := auth.uid(); new.approved_at := now();
  elsif new.status in ('pending','cancelled','auto_debit') then
    new.approved_by := null; new.approved_at := null;
  end if;
  return new;
end $$;
create trigger payments_guard before insert or update on public.payments
  for each row execute function private.payments_guard();

-- ===== 監査ログ（自動記録） =====
create or replace function private.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare rec jsonb; cid uuid;
begin
  rec := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  cid := case when tg_table_name = 'companies' then (rec->>'id')::uuid else nullif(rec->>'company_id', '')::uuid end;
  insert into public.audit_logs(company_id, actor, action, table_name, record_id, detail)
  values (cid, auth.uid(), lower(tg_op), tg_table_name,
    case when tg_table_name = 'memberships' then null else nullif(rec->>'id', '')::uuid end,
    case when tg_op = 'UPDATE' then jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new)) else rec end);
  return null;
end $$;
do $$
declare t text;
begin
  foreach t in array array['payments','documents','bank_accounts','payees','fb_exports','memberships','companies'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$s for each row execute function private.audit()', t);
  end loop;
end $$;

-- ===== Storage：アップロード直後の一時置き場（非公開・20MBまで） =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('inbox', 'inbox', false, 20971520, array['application/pdf','image/jpeg','image/png','image/heic','image/webp'])
on conflict (id) do nothing;

create policy "inbox read" on storage.objects for select to authenticated
  using (bucket_id = 'inbox' and private.can_read(((storage.foldername(name))[1])::uuid));
create policy "inbox upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'inbox' and private.can_write(((storage.foldername(name))[1])::uuid));
create policy "inbox delete" on storage.objects for delete to authenticated
  using (bucket_id = 'inbox' and private.can_write(((storage.foldername(name))[1])::uuid));
