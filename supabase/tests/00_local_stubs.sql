-- ローカル検証専用：Supabase の auth / vault / ロールを最小限まねる（本番には適用しない）
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), secret text, name text, description text);
create function vault.create_secret(p_secret text, p_name text, p_desc text) returns uuid language sql as $$
  insert into vault.secrets(secret, name, description) values (p_secret, p_name, p_desc) returning id
$$;
create function vault.update_secret(p_id uuid, p_secret text) returns void language sql as $$
  update vault.secrets set secret = p_secret where id = p_id
$$;
create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;

create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select string_to_array(name, '/')
$$;

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
alter table auth.users add column if not exists created_at timestamptz default now(), add column if not exists last_sign_in_at timestamptz;
create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade, status text not null default 'unverified');
