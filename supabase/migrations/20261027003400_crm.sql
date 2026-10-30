-- Tenant-scoped CRM planning and visit records. No stock or financial postings.
insert into public.permissions(code,module,action,description) values
 ('crm.view','crm','view','Read territories, representatives, visits and targets'),
 ('crm.manage','crm','manage','Manage CRM planning and visit records') on conflict do nothing;
insert into public.role_permissions(role_id,permission_id)
select r.id,p.id from public.roles r cross join public.permissions p
where r.organization_id is null and r.code in ('SUPER_ADMIN','OWNER','GENERAL_MANAGER','SALES_MANAGER') and p.code in ('crm.view','crm.manage') on conflict do nothing;

create table public.crm_territories (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 name text not null check(length(btrim(name)) between 2 and 120), area text not null check(length(btrim(area)) between 2 and 1000), is_active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,organization_id), unique(organization_id,name)
);
create table public.crm_representatives (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 profile_id uuid not null, territory_id uuid not null, is_active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,organization_id), unique(organization_id,profile_id),
 foreign key(profile_id,organization_id) references public.profiles(id,organization_id), foreign key(territory_id,organization_id) references public.crm_territories(id,organization_id)
);
create table public.crm_visits (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 representative_id uuid not null, customer_id uuid not null, visit_date date not null,
 outcome text not null check(outcome in ('COMPLETED','NO_CONTACT','FOLLOW_UP')), notes text not null check(length(btrim(notes)) between 3 and 2000), follow_up_date date,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,organization_id),
 check(follow_up_date is null or follow_up_date>=visit_date),
 foreign key(representative_id,organization_id) references public.crm_representatives(id,organization_id), foreign key(customer_id,organization_id) references public.customers(id,organization_id)
);
create table public.crm_targets (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 representative_id uuid not null, period_start date not null, period_end date not null, sales_target numeric(18,2) not null check(sales_target>0 and sales_target<1000000000000),
 notes text not null default '' check(length(notes)<=2000), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,organization_id),
 check(period_end>=period_start), unique(organization_id,representative_id,period_start,period_end),
 foreign key(representative_id,organization_id) references public.crm_representatives(id,organization_id)
);
do $$ declare t text; begin
 foreach t in array array['crm_territories','crm_representatives','crm_visits','crm_targets'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy crm_read on public.%I for select to authenticated using(organization_id=(select private.current_organization_id()) and (select private.has_permission(''crm.view'') or private.has_permission(''crm.manage'')))',t);
  execute format('create trigger crm_audit after insert or update on public.%I for each row execute function private.audit_row_change(''crm'')',t);
  execute format('create trigger crm_no_delete before delete on public.%I for each row execute function private.stock_block_mutation()',t);
  execute format('create index on public.%I(organization_id,created_at desc,id)',t);
 end loop;
end $$;

create function public.save_crm_record(p_kind text,p_id uuid,p_data jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare org uuid:=private.current_organization_id(); result uuid; rep uuid; territory uuid; profile uuid; customer uuid;
begin
 if not private.has_permission('crm.manage') then raise exception 'CRM management permission required' using errcode='42501'; end if;
 if p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Record fields required' using errcode='22023'; end if;
 if p_kind='territories' then
  if p_id is null then
   insert into public.crm_territories(name,area,is_active) values(btrim(p_data->>'name'),btrim(p_data->>'area'),coalesce((p_data->>'is_active')::boolean,true)) returning id into result;
  else
   update public.crm_territories set name=btrim(p_data->>'name'),area=btrim(p_data->>'area'),is_active=(p_data->>'is_active')::boolean,updated_at=now() where id=p_id and organization_id=org returning id into result;
  end if;
 elsif p_kind='representatives' then
  profile:=(p_data->>'profile_id')::uuid; territory:=(p_data->>'territory_id')::uuid;
  if not exists(select 1 from public.profiles where id=profile and organization_id=org and is_active) or not exists(select 1 from public.crm_territories where id=territory and organization_id=org and is_active) then raise exception 'Choose an active staff member and territory' using errcode='22023'; end if;
  if p_id is null then
   insert into public.crm_representatives(profile_id,territory_id,is_active) values(profile,territory,coalesce((p_data->>'is_active')::boolean,true)) returning id into result;
  else
   update public.crm_representatives set profile_id=profile,territory_id=territory,is_active=(p_data->>'is_active')::boolean,updated_at=now() where id=p_id and organization_id=org returning id into result;
  end if;
 elsif p_kind in ('visits','targets') then
  rep:=(p_data->>'representative_id')::uuid;
  if not exists(select 1 from public.crm_representatives where id=rep and organization_id=org and is_active) then raise exception 'Choose an active representative' using errcode='22023'; end if;
  if p_kind='visits' then
   customer:=(p_data->>'customer_id')::uuid;
   if not exists(select 1 from public.customers where id=customer and organization_id=org and is_active) then raise exception 'Choose an active customer' using errcode='22023'; end if;
   if (p_data->>'visit_date')::date>current_date then raise exception 'Visit date cannot be in the future' using errcode='22023'; end if;
   if p_id is null then
    insert into public.crm_visits(representative_id,customer_id,visit_date,outcome,notes,follow_up_date) values(rep,customer,(p_data->>'visit_date')::date,p_data->>'outcome',btrim(p_data->>'notes'),nullif(p_data->>'follow_up_date','')::date) returning id into result;
   else
    update public.crm_visits set representative_id=rep,customer_id=customer,visit_date=(p_data->>'visit_date')::date,outcome=p_data->>'outcome',notes=btrim(p_data->>'notes'),follow_up_date=nullif(p_data->>'follow_up_date','')::date,updated_at=now() where id=p_id and organization_id=org returning id into result;
   end if;
  else
   if p_id is null then
    insert into public.crm_targets(representative_id,period_start,period_end,sales_target,notes) values(rep,(p_data->>'period_start')::date,(p_data->>'period_end')::date,(p_data->>'sales_target')::numeric,coalesce(p_data->>'notes','')) returning id into result;
   else
    update public.crm_targets set representative_id=rep,period_start=(p_data->>'period_start')::date,period_end=(p_data->>'period_end')::date,sales_target=(p_data->>'sales_target')::numeric,notes=coalesce(p_data->>'notes',''),updated_at=now() where id=p_id and organization_id=org returning id into result;
   end if;
  end if;
 else raise exception 'Unknown CRM record type' using errcode='22023'; end if;
 if result is null then raise exception 'CRM record not found' using errcode='P0002'; end if;
 return result;
end $$;

create function public.crm_workspace(p_kind text,p_page integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare org uuid:=private.current_organization_id(); tbl text; rows jsonb;
begin
 if not (private.has_permission('crm.view') or private.has_permission('crm.manage')) then raise exception 'CRM permission required' using errcode='42501'; end if;
 if p_page is null or p_page<0 or p_page>100000 then raise exception 'Invalid page' using errcode='22023'; end if;
 tbl:=case p_kind when 'territories' then 'crm_territories' when 'representatives' then 'crm_representatives' when 'visits' then 'crm_visits' when 'targets' then 'crm_targets' end;
 if tbl is null then raise exception 'Unknown CRM record type' using errcode='22023'; end if;
 execute format('select coalesce(jsonb_agg(to_jsonb(r)),''[]'') from (select * from public.%I where organization_id=$1 order by created_at desc,id limit 25 offset $2) r',tbl) into rows using org,p_page*25;
 return jsonb_build_object('rows',rows,
 'territories',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',name)),'[]') from public.crm_territories where organization_id=org and is_active),
 'profiles',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',first_name||' '||last_name)),'[]') from public.profiles where organization_id=org and is_active),
 'customers',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',code||' / '||name)),'[]') from public.customers where organization_id=org and is_active),
 'representatives',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'label',p.first_name||' '||p.last_name)),'[]') from public.crm_representatives r join public.profiles p on p.id=r.profile_id and p.organization_id=r.organization_id where r.organization_id=org and r.is_active));
end $$;
revoke all on function public.save_crm_record(text,uuid,jsonb),public.crm_workspace(text,integer) from public,anon;
grant execute on function public.save_crm_record(text,uuid,jsonb),public.crm_workspace(text,integer) to authenticated;
