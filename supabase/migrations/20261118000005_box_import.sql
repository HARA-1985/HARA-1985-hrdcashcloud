-- クラウドBoxからの取り込み：同じBoxファイルを二重に取り込まない
alter table public.documents add column if not exists source text not null default 'upload' check (source in ('upload','mf_box'));
create unique index if not exists documents_company_box_file on public.documents(company_id, mf_box_file_id) where mf_box_file_id is not null;
