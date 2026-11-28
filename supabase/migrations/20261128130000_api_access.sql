-- サーバーAPI（service role）用：ユーザーがその会社で持つ役割と、今使えるか（無料期間・サブスク）
--   直接の所属、または会計事務所経由の所属のうち、強いほうの役割を返す
create or replace function public.svc_company_role(p_company uuid, p_user uuid)
returns table (role text, usable boolean)
language sql stable security definer set search_path = '' as $$
  with cand as (
    select m.role, private.has_access(p_company) as ok
      from public.memberships m
     where m.company_id = p_company and m.user_id = p_user
    union all
    select m.role, private.has_own_access(fc.firm_id) as ok
      from public.firm_clients fc
      join public.memberships m on m.company_id = fc.firm_id and m.user_id = p_user
     where fc.company_id = p_company and fc.status = 'active'
  )
  select c.role, c.ok
    from cand c
   order by c.ok desc, array_position(array['owner', 'approver', 'member', 'viewer'], c.role)
   limit 1;
$$;
revoke all on function public.svc_company_role(uuid, uuid) from public, anon, authenticated;
grant execute on function public.svc_company_role(uuid, uuid) to service_role;

-- 既存データの引き継ぎ：この仕組みより前に HRD が登録していた企業は、HRD の顧問先としてつなぐ
-- （HRD の顧問先は課金なしで使い続けられる）
do $$
declare hrd uuid;
begin
  select id into hrd from public.companies where kind = 'hrd' order by created_at limit 1;
  if hrd is null then return; end if;
  update public.companies set managed_by_firm_id = hrd
   where kind = 'client' and managed_by_firm_id is null and created_by is null;
  insert into public.firm_clients (firm_id, company_id, status)
  select hrd, c.id, 'active' from public.companies c
   where c.kind = 'client' and c.managed_by_firm_id = hrd
  on conflict (firm_id, company_id) do nothing;
end $$;
