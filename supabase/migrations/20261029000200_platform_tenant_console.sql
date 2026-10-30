create table private.platform_operators (
 user_id uuid primary key references auth.users(id),
 created_at timestamptz not null default now()
);
revoke all on private.platform_operators from public,anon,authenticated;
create function private.is_platform_operator() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.platform_operators o join auth.users u on u.id=o.user_id
 where o.user_id=auth.uid() and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null)
$$;
revoke all on function private.is_platform_operator() from public,anon,authenticated;
create function public.platform_operator_access() returns boolean
language sql stable security definer set search_path='' as $$ select private.is_platform_operator() $$;
revoke all on function public.platform_operator_access() from public,anon;
grant execute on function public.platform_operator_access() to authenticated;

alter table private.tenant_onboarding_requests add column requested_by uuid references auth.users(id) default auth.uid();
do $$
declare definition text;
begin
 definition:=pg_get_functiondef('public.onboard_tenant(uuid,uuid,text,text,text,text,text,text)'::regprocedure);
 if position('if auth.role() is distinct from' in definition)=0 then raise exception 'Unexpected onboarding definition'; end if;
 definition:=replace(definition,'if auth.role() is distinct from', 'if not private.is_platform_operator() and auth.role() is distinct from');
 execute definition;
 -- The internal provisioning routine repeats the authorization check. Its
 -- execute grant remains service-role-only; browsers use onboard_tenant.
 definition:=pg_get_functiondef('public.provision_organization(uuid,text,text,text,text,text,text,text,text,text)'::regprocedure);
 if position('if auth.role() is distinct from' in definition)=0 then raise exception 'Unexpected provisioning definition'; end if;
 definition:=replace(definition,'if auth.role() is distinct from', 'if not private.is_platform_operator() and auth.role() is distinct from');
 execute definition;
end $$;
grant execute on function public.onboard_tenant(uuid,uuid,text,text,text,text,text,text) to authenticated;

create function public.platform_tenants(p_page integer default 0)
returns table(id uuid,name text,is_active boolean,currency_code text,country text,created_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
begin
 if not private.is_platform_operator() then raise exception 'Platform operator access required' using errcode='42501'; end if;
 if p_page is null or p_page<0 or p_page>100000 then raise exception 'Invalid page' using errcode='22023'; end if;
 return query select o.id,o.name,o.is_active,o.currency_code,o.country,o.created_at from public.organizations o order by o.created_at desc,o.id limit 25 offset p_page*25;
end $$;
revoke all on function public.platform_tenants(integer) from public,anon;
grant execute on function public.platform_tenants(integer) to authenticated;
