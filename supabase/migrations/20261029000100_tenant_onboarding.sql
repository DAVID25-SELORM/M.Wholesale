-- Operator-only onboarding. Ordinary organization owners cannot create tenants.
create table private.tenant_onboarding_requests (
 request_id uuid primary key,
 owner_user_id uuid not null unique references auth.users(id),
 organization_id uuid not null unique references public.organizations(id),
 parameters jsonb not null,
 created_at timestamptz not null default now()
);
revoke all on private.tenant_onboarding_requests from public,anon,authenticated;

create function public.onboard_tenant(p_request_id uuid,p_owner_user_id uuid,p_first_name text,p_last_name text,p_name text,p_currency text default 'GHS',p_timezone text default 'Africa/Accra',p_country text default 'GH')
returns uuid language plpgsql security definer set search_path='' as $$
declare existing private.tenant_onboarding_requests; params jsonb; result uuid;
begin
 if auth.role() is distinct from 'service_role' and session_user not in ('postgres','supabase_admin') then raise exception 'Platform operator access required' using errcode='42501'; end if;
 if p_request_id is null or p_owner_user_id is null or p_name is null or length(btrim(p_name)) not between 2 and 200
 or p_first_name is null or length(btrim(p_first_name)) not between 1 and 100 or p_last_name is null or length(btrim(p_last_name)) not between 1 and 100 then raise exception 'Request ID, owner ID, organization and owner names are required' using errcode='22023'; end if;
 if p_currency is null or p_currency !~ '^[A-Z]{3}$' or p_country is null or p_country !~ '^[A-Z]{2}$' or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone) then raise exception 'Invalid currency, country or timezone' using errcode='22023'; end if;
 params:=jsonb_build_object('owner',p_owner_user_id,'first',btrim(p_first_name),'last',btrim(p_last_name),'name',btrim(p_name),'currency',p_currency,'timezone',p_timezone,'country',p_country);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,0));
 select * into existing from private.tenant_onboarding_requests where request_id=p_request_id;
 if found then
  if existing.parameters<>params then raise exception 'This request ID was used with different details' using errcode='22023'; end if;
  return existing.organization_id;
 end if;
 perform 1 from auth.users where id=p_owner_user_id for update;
 if not found then raise exception 'Create the owner authentication account first' using errcode='P0002'; end if;
 if not exists(select 1 from auth.users u where u.id=p_owner_user_id and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null) then raise exception 'Owner must verify their email before onboarding' using errcode='22023'; end if;
 if exists(select 1 from public.profiles where id=p_owner_user_id) then raise exception 'Owner already belongs to an organization; use a separate owner account' using errcode='22023'; end if;
 result:=public.provision_organization(p_owner_user_id,btrim(p_first_name),btrim(p_last_name),btrim(p_name),'HQ','Head Office',null,p_currency,p_timezone,p_country);
 insert into private.tenant_onboarding_requests(request_id,owner_user_id,organization_id,parameters) values(p_request_id,p_owner_user_id,result,params);
 return result;
end $$;
revoke all on function public.onboard_tenant(uuid,uuid,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.onboard_tenant(uuid,uuid,text,text,text,text,text,text) to service_role;
