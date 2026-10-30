-- Platform records are deliberately outside the exposed schema. All access goes
-- through explicit, permission-checked RPCs; tenant operational RLS is unchanged.
alter table public.organizations add column archived_at timestamptz;
alter table private.platform_operators add column permissions text[] not null default array['overview','organizations','users','billing','support','settings','audit','operators'];
alter table private.platform_operators add column is_active boolean not null default true;
create or replace function private.is_platform_operator() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.platform_operators o join auth.users u on u.id=o.user_id
 where o.user_id=auth.uid() and o.is_active and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null)
$$;
create function private.require_platform(p_permission text) returns void
language plpgsql stable security definer set search_path='' as $$
begin
 if not private.is_platform_operator() or not exists(select 1 from private.platform_operators where user_id=auth.uid() and p_permission=any(permissions)) then
 raise exception 'Platform permission required: %',p_permission using errcode='42501'; end if;
end $$;

create table private.platform_audit (
 id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
 actor_id uuid references auth.users(id), organization_id uuid references public.organizations(id),
 action text not null, target_id uuid, result text not null default 'SUCCESS',
 metadata jsonb not null default '{}'
);
create index platform_audit_time_idx on private.platform_audit(created_at desc);
create index platform_audit_org_idx on private.platform_audit(organization_id,created_at desc);
create trigger platform_audit_immutable before update or delete on private.platform_audit for each row execute function private.stock_block_mutation();

create table private.platform_plans (
 id uuid primary key default gen_random_uuid(), name text not null unique check(length(btrim(name)) between 2 and 100),
 currency text not null check(currency ~ '^[A-Z]{3}$'), monthly_price numeric(18,2) not null check(monthly_price>=0 and monthly_price<1000000000),
 annual_price numeric(18,2) not null check(annual_price>=0 and annual_price<1000000000),
 user_limit integer not null check(user_limit>0), branch_limit integer not null check(branch_limit>0), warehouse_limit integer not null check(warehouse_limit>0),
 trial_days integer not null default 0 check(trial_days between 0 and 365), is_active boolean not null default true,
 created_at timestamptz not null default now()
);
create table private.platform_subscriptions (
 organization_id uuid primary key references public.organizations(id), plan_id uuid not null references private.platform_plans(id),
 cycle text not null check(cycle in ('MONTHLY','ANNUAL')), status text not null check(status in ('TRIAL','ACTIVE','CANCELLED')),
 starts_on date not null, ends_on date not null, updated_at timestamptz not null default now(), check(ends_on>=starts_on)
);
create table private.platform_tickets (
 id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id),
 subject text not null check(length(btrim(subject)) between 3 and 200), body text not null check(length(btrim(body)) between 3 and 4000),
 priority text not null check(priority in ('LOW','NORMAL','HIGH','URGENT')),
 status text not null default 'OPEN' check(status in ('OPEN','IN_PROGRESS','CLOSED')),
 assigned_to uuid references private.platform_operators(user_id), created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table private.platform_ticket_replies (
 id uuid primary key default gen_random_uuid(), ticket_id uuid not null references private.platform_tickets(id),
 body text not null check(length(btrim(body)) between 1 and 4000), created_by uuid not null references auth.users(id), created_at timestamptz not null default now()
);
create table private.platform_announcements (
 id uuid primary key default gen_random_uuid(), title text not null check(length(btrim(title)) between 3 and 200),
 body text not null check(length(btrim(body)) between 3 and 4000), created_by uuid not null references auth.users(id),
 published_at timestamptz not null default now(), expires_at timestamptz not null, check(expires_at>published_at)
);
create table private.platform_notification_reads (
 user_id uuid not null references auth.users(id), event_id uuid not null references private.platform_audit(id), read_at timestamptz not null default now(), primary key(user_id,event_id)
);
create table private.platform_preferences (
 singleton boolean primary key default true check(singleton), name text not null default 'Pharmacy Wholesale ERP' check(length(btrim(name)) between 2 and 100),
 support_email text not null default '', support_phone text not null default '', country text not null default 'GH' check(country ~ '^[A-Z]{2}$'),
 currency text not null default 'GHS' check(currency ~ '^[A-Z]{3}$'), timezone text not null default 'Africa/Accra', updated_at timestamptz not null default now()
);
insert into private.platform_preferences(singleton) values(true);
revoke all on private.platform_audit,private.platform_plans,private.platform_subscriptions,private.platform_tickets,private.platform_ticket_replies,private.platform_announcements,private.platform_notification_reads,private.platform_preferences from public,anon,authenticated;

-- Enforce organization-management permission on the pre-existing onboarding RPC,
-- retaining service-role operator automation and its original idempotency.
do $$ declare d text; begin
 d:=pg_get_functiondef('public.onboard_tenant(uuid,uuid,text,text,text,text,text,text)'::regprocedure);
 if position('declare existing' in d)=0 then raise exception 'Unexpected onboarding definition'; end if;
 d:=replace(d,'begin','begin
 if auth.role() = ''authenticated'' then perform private.require_platform(''organizations''); end if;');
 execute d;
end $$;

create function private.audit_platform_change() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into private.platform_audit(actor_id,organization_id,action,target_id)
 values(auth.uid(),new.organization_id,'organization.created',new.organization_id);
 return new;
end $$;
create trigger platform_onboarding_audit after insert on private.tenant_onboarding_requests for each row execute function private.audit_platform_change();

create function public.platform_read(p_section text,p_search text default '',p_page integer default 0,p_from date default current_date-365,p_to date default current_date,p_id uuid default null,p_filter text default 'ALL')
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rows jsonb; n bigint; perm text;
begin
 perm:=case p_section when 'overview' then 'overview' when 'organizations' then 'organizations' when 'organization' then 'organizations' when 'owners' then 'organizations' when 'users' then 'users' when 'operators' then 'operators' when 'plans' then 'billing' when 'subscriptions' then 'billing' when 'tickets' then 'support' when 'ticket' then 'support' when 'announcements' then 'support' when 'settings' then 'settings' when 'audit' then 'audit' when 'notifications' then 'audit' when 'access' then 'overview' end;
 if perm is null then raise exception 'Unknown platform section' using errcode='22023'; end if;
 if p_section='access' then
 if not private.is_platform_operator() then raise exception 'Platform access required' using errcode='42501'; end if;
 return (select jsonb_build_object('permissions',permissions,'platform_name',(select name from private.platform_preferences)) from private.platform_operators where user_id=auth.uid()); end if;
 perform private.require_platform(perm);
 if p_page is null or p_page<0 or p_page>100000 or p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 or length(coalesce(p_search,''))>200 then raise exception 'Invalid filter' using errcode='22023'; end if;
 if p_section='overview' then
 return jsonb_build_object(
 'organizations',(select count(*) from public.organizations),
 'active',(select count(*) from public.organizations where is_active and archived_at is null),
 'suspended',(select count(*) from public.organizations where not is_active and archived_at is null),
 'users',(select count(*) from public.profiles),
 'subscriptions',(select count(*) from private.platform_subscriptions where status='ACTIVE' and current_date between starts_on and ends_on),
 'growth',(select coalesce(jsonb_agg(x order by x.month),'[]') from (select to_char(created_at,'YYYY-MM') as month,count(*) organizations from public.organizations where created_at>=p_from and created_at<p_to+1 group by 1) x),
 'user_growth',(select coalesce(jsonb_agg(x order by x.month),'[]') from (select to_char(created_at,'YYYY-MM') as month,count(*) users from public.profiles where created_at>=p_from and created_at<p_to+1 group by 1) x),
 'countries',(select coalesce(jsonb_agg(x),'[]') from (select country,count(*) organizations from public.organizations group by country) x));
 elsif p_section='organizations' then
 if p_filter not in ('ALL','ACTIVE','SUSPENDED','ARCHIVED') then raise exception 'Invalid organization status'; end if;
 select count(*) into n from public.organizations o where o.name ilike '%'||coalesce(p_search,'')||'%' and (p_filter='ALL' or (p_filter='ACTIVE' and o.is_active and o.archived_at is null) or (p_filter='SUSPENDED' and not o.is_active and o.archived_at is null) or (p_filter='ARCHIVED' and o.archived_at is not null));
 select coalesce(jsonb_agg(x),'[]') into rows from (select o.id,o.name,o.country,o.currency_code,o.created_at,o.is_active,o.archived_at,
 (select string_agg(p.email,', ') from public.profiles p where p.organization_id=o.id and exists(select 1 from public.user_roles ur join public.roles r on r.id=ur.role_id where ur.user_id=p.id and r.code='OWNER')) owner_email,
 (select pl.name from private.platform_subscriptions s join private.platform_plans pl on pl.id=s.plan_id where s.organization_id=o.id) plan
 from public.organizations o where o.name ilike '%'||coalesce(p_search,'')||'%' and (p_filter='ALL' or (p_filter='ACTIVE' and o.is_active and o.archived_at is null) or (p_filter='SUSPENDED' and not o.is_active and o.archived_at is null) or (p_filter='ARCHIVED' and o.archived_at is not null)) order by o.created_at desc,o.id limit 25 offset p_page*25) x;
 elsif p_section='organization' then
 return jsonb_build_object('profile',(select to_jsonb(o) from public.organizations o where id=p_id),
 'users',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.first_name||' '||p.last_name,'email',p.email,'active',p.is_active)),'[]') from public.profiles p where organization_id=p_id),
 'branches',(select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'name',b.name,'active',b.is_active)),'[]') from public.branches b where organization_id=p_id),
 'warehouses',(select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'active',w.is_active)),'[]') from public.warehouses w where organization_id=p_id),
 'subscription',(select to_jsonb(s) from private.platform_subscriptions s where organization_id=p_id));
 elsif p_section='owners' then
 -- Exact email lookup avoids exposing the entire Auth directory during onboarding.
 select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'email',u.email,'verified',nullif(to_jsonb(u)->>'email_confirmed_at','') is not null)),'[]') into rows from auth.users u where lower(u.email)=lower(btrim(p_search)) and not exists(select 1 from public.profiles p where p.id=u.id);
 elsif p_section='users' then
 select count(*) into n from public.profiles p where concat_ws(' ',p.first_name,p.last_name,p.email) ilike '%'||coalesce(p_search,'')||'%';
 select coalesce(jsonb_agg(x),'[]') into rows from (select p.id,p.first_name||' '||p.last_name name,p.email,p.is_active,p.organization_id,o.name organization,p.created_at,
 (select string_agg(r.name,', ') from public.user_roles ur join public.roles r on r.id=ur.role_id where ur.user_id=p.id) roles
 from public.profiles p join public.organizations o on o.id=p.organization_id where concat_ws(' ',p.first_name,p.last_name,p.email) ilike '%'||coalesce(p_search,'')||'%' order by p.created_at desc,p.id limit 25 offset p_page*25) x;
 elsif p_section='operators' then
 select count(*) into n from private.platform_operators;
 select coalesce(jsonb_agg(x),'[]') into rows from (select o.user_id id,u.email,o.permissions,o.is_active from private.platform_operators o join auth.users u on u.id=o.user_id order by o.created_at,o.user_id limit 25 offset p_page*25) x;
 elsif p_section='plans' then
 select count(*) into n from private.platform_plans;
 select coalesce(jsonb_agg(x),'[]') into rows from (select * from private.platform_plans order by name,id limit 25 offset p_page*25) x;
 elsif p_section='subscriptions' then
 select count(*) into n from private.platform_subscriptions;
 select coalesce(jsonb_agg(x),'[]') into rows from (select s.*,o.name organization,p.name plan,p.currency,p.monthly_price,p.annual_price from private.platform_subscriptions s join public.organizations o on o.id=s.organization_id join private.platform_plans p on p.id=s.plan_id order by s.updated_at desc limit 25 offset p_page*25) x;
 elsif p_section='tickets' then
 select count(*) into n from private.platform_tickets where subject ilike '%'||coalesce(p_search,'')||'%';
 select coalesce(jsonb_agg(x),'[]') into rows from (select t.* from private.platform_tickets t where subject ilike '%'||coalesce(p_search,'')||'%' order by updated_at desc,id limit 25 offset p_page*25) x;
 elsif p_section='ticket' then
 return jsonb_build_object('ticket',(select to_jsonb(t) from private.platform_tickets t where id=p_id),'replies',(select coalesce(jsonb_agg(r order by r.created_at),'[]') from private.platform_ticket_replies r where ticket_id=p_id));
 elsif p_section='announcements' then
 select count(*) into n from private.platform_announcements;
 select coalesce(jsonb_agg(x),'[]') into rows from (select * from private.platform_announcements order by published_at desc,id limit 25 offset p_page*25) x;
 elsif p_section='settings' then
 return (select to_jsonb(s) from private.platform_preferences s);
 elsif p_section in ('audit','notifications') then
 select count(*) into n from private.platform_audit where created_at>=p_from and created_at<p_to+1 and action ilike '%'||coalesce(p_search,'')||'%';
 select coalesce(jsonb_agg(x),'[]') into rows from (select a.*,exists(select 1 from private.platform_notification_reads r where r.user_id=auth.uid() and r.event_id=a.id) is_read from private.platform_audit a where created_at>=p_from and created_at<p_to+1 and action ilike '%'||coalesce(p_search,'')||'%' order by created_at desc,id limit 25 offset p_page*25) x;
 end if;
 return jsonb_build_object('rows',coalesce(rows,'[]'),'total',coalesce(n,jsonb_array_length(coalesce(rows,'[]'))));
end $$;

create function public.platform_write(p_action text,p_data jsonb,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare target uuid; org uuid; perm text; o public.organizations; p public.profiles; grants text[];
begin
 perm:=case when p_action in ('organization.update','organization.suspend','organization.reactivate','organization.archive') then 'organizations'
 when p_action in ('user.activate','user.deactivate') then 'users' when p_action in ('plan.save','subscription.save') then 'billing'
 when p_action in ('ticket.create','ticket.update','ticket.reply','announcement.create') then 'support' when p_action='settings.save' then 'settings'
 when p_action='notification.read' then 'audit' when p_action='operator.save' then 'operators' end;
 if perm is null then raise exception 'Unknown platform action' using errcode='22023'; end if;
 perform private.require_platform(perm);
 if p_reason is null or length(btrim(p_reason)) not between 3 and 500 or jsonb_typeof(p_data) is distinct from 'object' then raise exception 'Provide valid details and a reason (3 to 500 characters)' using errcode='22023'; end if;
 target:=nullif(p_data->>'id','')::uuid;
 if p_action='operator.save' then
 perform pg_catalog.pg_advisory_xact_lock(90123456);
 select u.id into target from auth.users u where lower(u.email)=lower(btrim(p_data->>'email')) and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null;
 if target is null then raise exception 'Verified authentication account not found' using errcode='22023'; end if;
 if target=auth.uid() then raise exception 'Another platform administrator must change your access' using errcode='42501'; end if;
 if jsonb_typeof(p_data->'permissions') is distinct from 'array' then raise exception 'Select platform permissions' using errcode='22023'; end if;
 select array_agg(distinct v) into grants from jsonb_array_elements_text(p_data->'permissions') v;
 if grants is null or not grants <@ array['overview','organizations','users','billing','support','settings','audit','operators'] then raise exception 'Invalid platform permissions' using errcode='22023'; end if;
 insert into private.platform_operators(user_id,permissions,is_active) values(target,grants,coalesce((p_data->>'is_active')::boolean,true)) on conflict(user_id) do update set permissions=excluded.permissions,is_active=excluded.is_active;
 elsif p_action like 'organization.%' then
 select * into o from public.organizations where id=target for update;
 if not found then raise exception 'Organization not found' using errcode='P0002'; end if;
 org:=o.id;
 if p_action='organization.update' then
 if length(btrim(coalesce(p_data->>'name',''))) not between 2 and 200 then raise exception 'Organization name is required' using errcode='22023'; end if;
 update public.organizations set name=btrim(p_data->>'name'),email=nullif(btrim(p_data->>'email'),''),phone=nullif(btrim(p_data->>'phone'),''),address=nullif(btrim(p_data->>'address'),'') where id=target;
 else
 if o.archived_at is not null then raise exception 'Archived organizations cannot be reactivated' using errcode='22023'; end if;
 update public.organizations set is_active=(p_action='organization.reactivate'),archived_at=case when p_action='organization.archive' then now() else null end where id=target;
 end if;
 elsif p_action in ('user.activate','user.deactivate') then
 select * into p from public.profiles where id=target for update;
 if not found then raise exception 'User not found' using errcode='P0002'; end if;
 if target=auth.uid() or exists(select 1 from private.platform_operators where user_id=target and is_active) then raise exception 'Manage platform operator access separately' using errcode='22023'; end if;
 org:=p.organization_id;
 if p_action='user.deactivate' and exists(select 1 from public.user_roles ur join public.roles r on r.id=ur.role_id where ur.user_id=target and r.code='OWNER') then raise exception 'Owner access requires a dedicated ownership transfer' using errcode='22023'; end if;
 update public.profiles set is_active=(p_action='user.activate') where id=target;
 elsif p_action='plan.save' then
 target:=coalesce(target,gen_random_uuid());
 insert into private.platform_plans(id,name,currency,monthly_price,annual_price,user_limit,branch_limit,warehouse_limit,trial_days,is_active)
 values(target,btrim(p_data->>'name'),p_data->>'currency',(p_data->>'monthly_price')::numeric,(p_data->>'annual_price')::numeric,(p_data->>'user_limit')::integer,(p_data->>'branch_limit')::integer,(p_data->>'warehouse_limit')::integer,coalesce((p_data->>'trial_days')::integer,0),coalesce((p_data->>'is_active')::boolean,true))
 on conflict(id) do update set name=excluded.name,currency=excluded.currency,monthly_price=excluded.monthly_price,annual_price=excluded.annual_price,user_limit=excluded.user_limit,branch_limit=excluded.branch_limit,warehouse_limit=excluded.warehouse_limit,trial_days=excluded.trial_days,is_active=excluded.is_active;
 elsif p_action='subscription.save' then
 org:=(p_data->>'organization_id')::uuid; target:=org;
 perform 1 from public.organizations where id=org and archived_at is null for update;
 if not found then raise exception 'Organization not found or archived' using errcode='22023'; end if;
 if not exists(select 1 from private.platform_plans where id=(p_data->>'plan_id')::uuid and is_active) then raise exception 'Active plan required' using errcode='22023'; end if;
 insert into private.platform_subscriptions(organization_id,plan_id,cycle,status,starts_on,ends_on) values(org,(p_data->>'plan_id')::uuid,p_data->>'cycle',p_data->>'status',(p_data->>'starts_on')::date,(p_data->>'ends_on')::date)
 on conflict(organization_id) do update set plan_id=excluded.plan_id,cycle=excluded.cycle,status=excluded.status,starts_on=excluded.starts_on,ends_on=excluded.ends_on,updated_at=now();
 elsif p_action='ticket.create' then
 org:=nullif(p_data->>'organization_id','')::uuid;
 insert into private.platform_tickets(organization_id,subject,body,priority,created_by) values(org,btrim(p_data->>'subject'),btrim(p_data->>'body'),p_data->>'priority',auth.uid()) returning id into target;
 elsif p_action in ('ticket.update','ticket.reply') then
 select organization_id into org from private.platform_tickets where id=target for update;
 if not found then raise exception 'Ticket not found' using errcode='P0002'; end if;
 if p_action='ticket.reply' then
 insert into private.platform_ticket_replies(ticket_id,body,created_by) values(target,btrim(p_data->>'body'),auth.uid());
 else
 update private.platform_tickets set status=p_data->>'status',priority=p_data->>'priority',assigned_to=nullif(p_data->>'assigned_to','')::uuid where id=target;
 end if;
 update private.platform_tickets set updated_at=now() where id=target;
 elsif p_action='announcement.create' then
 insert into private.platform_announcements(title,body,created_by,expires_at) values(btrim(p_data->>'title'),btrim(p_data->>'body'),auth.uid(),(p_data->>'expires_at')::timestamptz) returning id into target;
 elsif p_action='settings.save' then
 if not exists(select 1 from pg_catalog.pg_timezone_names where name=p_data->>'timezone') then raise exception 'Invalid timezone' using errcode='22023'; end if;
 if length(coalesce(p_data->>'support_email',''))>254 or length(coalesce(p_data->>'support_phone',''))>50 then raise exception 'Contact details too long' using errcode='22023'; end if;
 update private.platform_preferences set name=btrim(p_data->>'name'),support_email=btrim(p_data->>'support_email'),support_phone=btrim(p_data->>'support_phone'),country=p_data->>'country',currency=p_data->>'currency',timezone=p_data->>'timezone',updated_at=now();
 elsif p_action='notification.read' then
 insert into private.platform_notification_reads(user_id,event_id) values(auth.uid(),target) on conflict do nothing;
 return target;
 end if;
 -- Reasons only: never store submitted payloads, credentials, or Auth tokens.
 insert into private.platform_audit(actor_id,organization_id,action,target_id,metadata) values(auth.uid(),org,p_action,target,jsonb_build_object('reason',btrim(p_reason)));
 return target;
end $$;
revoke all on function private.require_platform(text),private.audit_platform_change() from public,anon,authenticated;
revoke all on function public.platform_read(text,text,integer,date,date,uuid,text),public.platform_write(text,jsonb,text) from public,anon;
grant execute on function public.platform_read(text,text,integer,date,date,uuid,text),public.platform_write(text,jsonb,text) to authenticated;

create or replace function public.platform_tenants(p_page integer default 0)
returns table(id uuid,name text,is_active boolean,currency_code text,country text,created_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_platform('organizations');
 if p_page is null or p_page<0 or p_page>100000 then raise exception 'Invalid page' using errcode='22023'; end if;
 return query select o.id,o.name,o.is_active,o.currency_code,o.country,o.created_at from public.organizations o order by o.created_at desc,o.id limit 25 offset p_page*25;
end $$;
