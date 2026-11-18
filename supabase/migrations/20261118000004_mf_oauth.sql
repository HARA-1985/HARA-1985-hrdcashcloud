-- マネーフォワード連携：トークンは Supabase Vault で暗号化保存し、サーバー（service_role）からのみ扱う

-- 平文の列は使わない（初版で作ったが未使用）
alter table private.mf_tokens drop column if exists access_token;
alter table private.mf_tokens drop column if exists refresh_token;
alter table private.mf_tokens add column if not exists access_secret_id uuid;
alter table private.mf_tokens add column if not exists refresh_secret_id uuid;
alter table private.mf_tokens add column if not exists scope text;
alter table private.mf_tokens add column if not exists refresh_lock_until timestamptz;

alter table public.mf_connections add column if not exists office_code text;
alter table public.mf_connections add column if not exists connected_by uuid references auth.users(id);
alter table public.mf_connections add column if not exists last_error text;

-- 勘定科目の対応表（この会社のMF勘定科目ID）
alter table public.companies add column if not exists mf_account_map jsonb not null default '{}'::jsonb;

-- 仕訳連携の状態（二重登録防止）
alter table public.payments add column if not exists mf_sync_status text not null default 'none'
  check (mf_sync_status in ('none','syncing','done','error'));
alter table public.payments add column if not exists mf_sync_error text;
alter table public.payments add column if not exists mf_synced_at timestamptz;

-- ===== service_role 専用の関数（画面からは呼べない） =====
create or replace function public.mf_token_save(cid uuid, p_access text, p_refresh text, p_expires_at timestamptz, p_scope text)
returns void language plpgsql security definer set search_path = '' as $$
declare a_id uuid; r_id uuid;
begin
  select access_secret_id, refresh_secret_id into a_id, r_id from private.mf_tokens where company_id = cid for update;
  if a_id is null then
    a_id := vault.create_secret(p_access, 'mf_access_' || cid::text, 'MF access token');
  else
    perform vault.update_secret(a_id, p_access);
  end if;
  if r_id is null then
    r_id := vault.create_secret(p_refresh, 'mf_refresh_' || cid::text, 'MF refresh token');
  else
    perform vault.update_secret(r_id, p_refresh);
  end if;
  insert into private.mf_tokens(company_id, access_secret_id, refresh_secret_id, expires_at, scope, refresh_lock_until, updated_at)
  values (cid, a_id, r_id, p_expires_at, p_scope, null, now())
  on conflict (company_id) do update set access_secret_id = excluded.access_secret_id, refresh_secret_id = excluded.refresh_secret_id,
    expires_at = excluded.expires_at, scope = excluded.scope, refresh_lock_until = null, updated_at = now();
end $$;

create or replace function public.mf_token_get(cid uuid)
returns table(access_token text, refresh_token text, expires_at timestamptz, scope text)
language sql security definer set search_path = '' as $$
  select a.decrypted_secret, r.decrypted_secret, t.expires_at, t.scope
  from private.mf_tokens t
  left join vault.decrypted_secrets a on a.id = t.access_secret_id
  left join vault.decrypted_secrets r on r.id = t.refresh_secret_id
  where t.company_id = cid;
$$;

-- リフレッシュは1回限り有効なので、同時に2つ走らないようロックを取る
create or replace function public.mf_token_lock(cid uuid, seconds int default 20)
returns boolean language plpgsql security definer set search_path = '' as $$
declare ok boolean;
begin
  update private.mf_tokens set refresh_lock_until = now() + make_interval(secs => seconds)
  where company_id = cid and (refresh_lock_until is null or refresh_lock_until < now())
  returning true into ok;
  return coalesce(ok, false);
end $$;

create or replace function public.mf_token_delete(cid uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare a_id uuid; r_id uuid;
begin
  select access_secret_id, refresh_secret_id into a_id, r_id from private.mf_tokens where company_id = cid;
  delete from vault.secrets where id in (a_id, r_id);
  delete from private.mf_tokens where company_id = cid;
end $$;

-- 仕訳登録の二重実行を防ぐ（none/error → syncing に変えられたときだけ true）
create or replace function public.mf_payment_claim(pid uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare ok boolean;
begin
  update public.payments set mf_sync_status = 'syncing', mf_sync_error = null
  where id = pid and mf_sync_status in ('none','error') returning true into ok;
  return coalesce(ok, false);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.mf_token_save(uuid,text,text,timestamptz,text)', 'public.mf_token_get(uuid)', 'public.mf_token_lock(uuid,int)',
    'public.mf_token_delete(uuid)', 'public.mf_payment_claim(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- 画面側からの直接更新で連携状態を書き換えられないようにする
create or replace function private.payments_mf_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and (
     new.mf_sync_status is distinct from old.mf_sync_status or new.mf_journal_id is distinct from old.mf_journal_id
     or new.mf_synced_at is distinct from old.mf_synced_at or new.mf_sync_error is distinct from old.mf_sync_error) then
    raise exception 'マネーフォワード連携の状態は変更できません';
  end if;
  return new;
end $$;
drop trigger if exists payments_mf_guard on public.payments;
create trigger payments_mf_guard before update on public.payments
  for each row execute function private.payments_mf_guard();
