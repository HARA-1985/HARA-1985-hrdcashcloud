-- HRD資金繰りクラウド：コアスキーマ
create schema if not exists private;

-- ===== profiles =====
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  email text,
  is_hrd_staff boolean not null default false,
  created_at timestamptz not null default now()
);

-- ===== companies（HRD自身・顧問先） =====
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_kana text,
  kind text not null default 'client' check (kind in ('hrd','client')),
  mf_plan text,
  created_at timestamptz not null default now()
);

create table public.memberships (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','approver','member','viewer')),
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)
);

-- ===== 権限判定（RLSから呼ぶ） =====
create or replace function private.is_hrd_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.is_hrd_staff from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function private.has_role(cid uuid, roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_hrd_staff() or exists (
    select 1 from public.memberships m
    where m.company_id = cid and m.user_id = auth.uid() and m.role = any(roles));
$$;

create or replace function private.can_read(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(cid, array['owner','approver','member','viewer']);
$$;

create or replace function private.can_write(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(cid, array['owner','approver','member']);
$$;

grant usage on schema private to authenticated;
grant execute on all functions in schema private to authenticated;

-- ===== 振込元口座 =====
create table public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_name text not null,
  bank_code char(4),
  bank_kana text,
  branch_code char(3),
  branch_name text,
  branch_kana text,
  account_type text not null default '1' check (account_type in ('1','2','4','9')),
  account_number varchar(7),
  holder_kana text,
  client_code varchar(10),
  created_at timestamptz not null default now()
);

-- ===== 支払先 =====
create table public.payees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  name_kana text,
  bank_code char(4),
  bank_kana text,
  branch_code char(3),
  branch_kana text,
  account_type text check (account_type in ('1','2','4','9')),
  account_number varchar(7),
  invoice_reg_no text,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

-- ===== 証憑（原本はマネーフォワード クラウドBoxに保管） =====
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  doc_type text not null check (doc_type in ('invoice','receipt','card_statement','other')),
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  temp_path text,                 -- Storage(inbox)の一時パス。Box保存を確認したら削除
  mf_box_file_id text,
  mf_box_status text not null default 'pending' check (mf_box_status in ('pending','stored','failed')),
  folder_month date,              -- 支払月（月初日）
  account_title text,             -- 勘定科目フォルダ
  ocr jsonb,
  uploaded_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- ===== 支払予定 =====
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  due_date date not null,
  payee_id uuid references public.payees(id) on delete set null,
  payee_name text not null,
  item text,
  amount bigint not null check (amount >= 0),
  kind text not null check (kind in ('fixed','spot')),
  source text not null check (source in ('invoice','expense','card','manual')),
  bank_account_id uuid references public.bank_accounts(id) on delete set null,
  account_title text not null default '未払金',
  status text not null default 'pending' check (status in ('pending','approved','auto_debit','paid','cancelled')),
  document_id uuid references public.documents(id) on delete set null,
  mf_journal_id text,
  created_by uuid references auth.users(id) default auth.uid(),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payments_company_due on public.payments(company_id, due_date);

-- ===== カード明細（マネーフォワード経由で取得） =====
create table public.card_transactions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  card_name text not null,
  used_on date not null,
  merchant text not null,
  amount bigint not null,
  suggested_account text,
  receipt_document_id uuid references public.documents(id) on delete set null,
  external_id text,
  synced_at timestamptz not null default now(),
  unique (company_id, external_id)
);

-- ===== MF連携状態（トークンは private スキーマ。画面からは見えない） =====
create table public.mf_connections (
  company_id uuid primary key references public.companies(id) on delete cascade,
  status text not null default 'disconnected' check (status in ('disconnected','connected','error')),
  office_name text,
  scopes text[],
  connected_at timestamptz,
  last_synced_at timestamptz
);
create table private.mf_tokens (
  company_id uuid primary key references public.companies(id) on delete cascade,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
revoke all on private.mf_tokens from anon, authenticated;

-- ===== FBデータ作成ログ（ファイル本体は保存しない） =====
create table public.fb_exports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_account_id uuid references public.bank_accounts(id),
  transfer_date date not null,
  record_count int not null,
  total_amount bigint not null,
  payment_ids uuid[] not null,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- ===== 監査ログ =====
create table public.audit_logs (
  id bigint generated always as identity primary key,
  company_id uuid,
  actor uuid,
  action text not null,
  table_name text not null,
  record_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index audit_company_time on public.audit_logs(company_id, created_at desc);

-- ===== 初期管理者の許可リスト =====
create table private.bootstrap_emails (email text primary key);
insert into private.bootstrap_emails(email) values ('harada@jasmylab.com');
