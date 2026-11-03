-- DrugXone integration foundation.
-- Credentials are never stored in the ERP database or exposed to the browser.
-- A trusted adapter owns the outbound token and calls the DrugXone partner API.
insert into public.permissions(code,module,action,description) values
 ('integrations.view','integrations','view','View external integration status and mappings'),
 ('integrations.manage','integrations','manage','Configure external integration mappings and state')
on conflict(code) do update set description=excluded.description;

insert into public.role_permissions(role_id,permission_id)
select r.id,p.id from public.roles r cross join public.permissions p
where r.organization_id is null and p.code in ('integrations.view','integrations.manage')
  and r.code in ('OWNER','SUPER_ADMIN')
on conflict do nothing;
insert into public.role_permissions(role_id,permission_id)
select r.id,p.id from public.roles r cross join public.permissions p
where r.organization_id is null and p.code='integrations.view'
  and r.code in ('GENERAL_MANAGER','AUDITOR','READ_ONLY')
on conflict do nothing;

create table public.drugxone_connections (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null default private.current_organization_id(),
 environment text not null default 'SANDBOX' check(environment in ('SANDBOX','PRODUCTION')),
 base_url text,
 external_business_id text,
 status text not null default 'DISCONNECTED' check(status in ('DISCONNECTED','READY','PAUSED','ERROR')),
 api_version text not null default 'v1' check(api_version ~ '^[A-Za-z0-9._-]{1,32}$'),
 last_catalog_sync_at timestamptz,
 last_order_sync_at timestamptz,
 last_success_at timestamptz,
 last_error_code text,
 last_error text check(last_error is null or length(last_error)<=500),
 created_at timestamptz not null default now(), created_by uuid default auth.uid(),
 updated_at timestamptz not null default now(), updated_by uuid not null default auth.uid(),
 unique(organization_id), unique(id,organization_id),
 foreign key(organization_id) references public.organizations(id),
 foreign key(created_by,organization_id) references public.profiles(id,organization_id),
 foreign key(updated_by,organization_id) references public.profiles(id,organization_id),
 check(status='DISCONNECTED' or (base_url is not null and external_business_id is not null)),
 check(base_url is null or (length(base_url) between 8 and 500 and base_url !~ '[?#[:space:]]' and base_url ~ '^https://[^/]+(/.*)?$')),
 check(external_business_id is null or length(btrim(external_business_id)) between 1 and 200)
);
create index drugxone_connections_status_idx on public.drugxone_connections(organization_id,status);
alter table public.drugxone_connections enable row level security;
revoke all on public.drugxone_connections from public,anon,authenticated;
grant select on public.drugxone_connections to authenticated;
create policy drugxone_connections_read on public.drugxone_connections for select to authenticated using(
 organization_id=(select private.current_organization_id()) and ((select private.has_permission_anywhere('integrations.view')) or (select private.has_permission_anywhere('integrations.manage')))
);
create trigger drugxone_connections_stamp before insert or update on public.drugxone_connections for each row execute function private.set_updated_at();
create trigger drugxone_connections_audit after insert or update on public.drugxone_connections for each row execute function private.audit_row_change('drugxone_connection');
create trigger drugxone_connections_no_delete before delete on public.drugxone_connections for each row execute function private.stock_block_mutation();

create table public.drugxone_product_mappings (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null default private.current_organization_id(),
 connection_id uuid not null,
 product_id uuid not null,
 external_product_id text,
 external_offer_id text not null,
 external_sku text,
 external_name text not null,
 status text not null default 'PENDING' check(status in ('PENDING','ACTIVE','PAUSED','ERROR')),
 last_synced_at timestamptz,
 last_error text check(last_error is null or length(last_error)<=500),
 created_at timestamptz not null default now(), created_by uuid not null default auth.uid(),
 updated_at timestamptz not null default now(), updated_by uuid not null default auth.uid(),
 unique(id,organization_id), unique(organization_id,product_id), unique(connection_id,external_offer_id),
 foreign key(organization_id) references public.organizations(id),
 foreign key(connection_id,organization_id) references public.drugxone_connections(id,organization_id),
 foreign key(product_id,organization_id) references public.products(id,organization_id),
 foreign key(created_by,organization_id) references public.profiles(id,organization_id),
 foreign key(updated_by,organization_id) references public.profiles(id,organization_id),
 check(length(btrim(external_offer_id)) between 1 and 200),
 check(external_product_id is null or length(btrim(external_product_id)) between 1 and 200),
 check(external_sku is null or length(btrim(external_sku)) between 1 and 120),
 check(length(btrim(external_name)) between 1 and 300)
);
create index drugxone_product_mappings_product_idx on public.drugxone_product_mappings(organization_id,product_id);
alter table public.drugxone_product_mappings enable row level security;
revoke all on public.drugxone_product_mappings from public,anon,authenticated;
grant select on public.drugxone_product_mappings to authenticated;
create policy drugxone_product_mappings_read on public.drugxone_product_mappings for select to authenticated using(
 organization_id=(select private.current_organization_id()) and ((select private.has_permission_anywhere('integrations.view')) or (select private.has_permission_anywhere('integrations.manage')))
);
create trigger drugxone_product_mappings_stamp before insert or update on public.drugxone_product_mappings for each row execute function private.set_updated_at();
create trigger drugxone_product_mappings_audit after insert or update on public.drugxone_product_mappings for each row execute function private.audit_row_change('drugxone_product_mapping');
create trigger drugxone_product_mappings_no_delete before delete on public.drugxone_product_mappings for each row execute function private.stock_block_mutation();

create table public.drugxone_order_mappings (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null default private.current_organization_id(),
 connection_id uuid not null,
 external_order_id text not null,
 sales_order_id uuid,
 external_status text,
 status text not null default 'RECEIVED' check(status in ('RECEIVED','IMPORTED','ACKNOWLEDGED','FAILED','CANCELLED')),
 last_event_at timestamptz,
 last_error text check(last_error is null or length(last_error)<=500),
 created_at timestamptz not null default now(), created_by uuid not null default auth.uid(),
 updated_at timestamptz not null default now(), updated_by uuid not null default auth.uid(),
 unique(id,organization_id), unique(connection_id,external_order_id),
 foreign key(organization_id) references public.organizations(id),
 foreign key(connection_id,organization_id) references public.drugxone_connections(id,organization_id),
 foreign key(sales_order_id,organization_id) references public.sales_orders(id,organization_id),
 foreign key(created_by,organization_id) references public.profiles(id,organization_id),
 foreign key(updated_by,organization_id) references public.profiles(id,organization_id),
 check(length(btrim(external_order_id)) between 1 and 200),
 check(external_status is null or length(btrim(external_status)) between 1 and 80)
);
create index drugxone_order_mappings_order_idx on public.drugxone_order_mappings(organization_id,sales_order_id);
alter table public.drugxone_order_mappings enable row level security;
revoke all on public.drugxone_order_mappings from public,anon,authenticated;
grant select on public.drugxone_order_mappings to authenticated;
create policy drugxone_order_mappings_read on public.drugxone_order_mappings for select to authenticated using(
 organization_id=(select private.current_organization_id()) and ((select private.has_permission_anywhere('integrations.view')) or (select private.has_permission_anywhere('integrations.manage')))
);
create trigger drugxone_order_mappings_stamp before insert or update on public.drugxone_order_mappings for each row execute function private.set_updated_at();
create trigger drugxone_order_mappings_audit after insert or update on public.drugxone_order_mappings for each row execute function private.audit_row_change('drugxone_order_mapping');
create trigger drugxone_order_mappings_no_delete before delete on public.drugxone_order_mappings for each row execute function private.stock_block_mutation();

create table public.drugxone_sync_events (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null default private.current_organization_id(),
 connection_id uuid not null,
 direction text not null check(direction in ('ERP_TO_DRUGXONE','DRUGXONE_TO_ERP')),
 entity_type text not null check(entity_type in ('CATALOGUE','ORDER','ORDER_STATUS')),
 entity_id uuid,
 external_id text,
 idempotency_key text not null,
 payload_hash text not null check(payload_hash ~ '^[0-9a-fA-F]{32,128}$'),
 payload jsonb not null default '{}'::jsonb check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=262144),
 status text not null default 'QUEUED' check(status in ('QUEUED','PROCESSING','SUCCEEDED','FAILED','DEAD_LETTER')),
 attempts integer not null default 0 check(attempts>=0 and attempts<=100),
 next_attempt_at timestamptz not null default now(),
 last_error_code text,
 last_error text check(last_error is null or length(last_error)<=500),
 created_at timestamptz not null default now(), created_by uuid default auth.uid(),
 processed_at timestamptz,
 unique(organization_id,idempotency_key), unique(id,organization_id),
 foreign key(organization_id) references public.organizations(id),
 foreign key(connection_id,organization_id) references public.drugxone_connections(id,organization_id),
 foreign key(created_by,organization_id) references public.profiles(id,organization_id),
 check(external_id is null or length(btrim(external_id)) between 1 and 200),
 check(length(btrim(idempotency_key)) between 8 and 200)
);
create index drugxone_sync_events_queue_idx on public.drugxone_sync_events(organization_id,status,next_attempt_at,created_at);
alter table public.drugxone_sync_events enable row level security;
revoke all on public.drugxone_sync_events from public,anon,authenticated;
grant select on public.drugxone_sync_events to authenticated;
create policy drugxone_sync_events_read on public.drugxone_sync_events for select to authenticated using(
 organization_id=(select private.current_organization_id()) and ((select private.has_permission_anywhere('integrations.view')) or (select private.has_permission_anywhere('integrations.manage')))
);
create trigger drugxone_sync_events_audit after insert or update on public.drugxone_sync_events for each row execute function private.audit_row_change('drugxone_sync_event');
create trigger drugxone_sync_events_no_delete before delete on public.drugxone_sync_events for each row execute function private.stock_block_mutation();

create function public.drugxone_connection_read() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare org uuid:=private.current_organization_id(); result jsonb;
begin
 if org is null or not private.has_permission_anywhere('integrations.view') and not private.has_permission_anywhere('integrations.manage') then raise exception 'Integration view permission required' using errcode='42501'; end if;
 select jsonb_build_object('id',c.id,'environment',c.environment,'base_url',c.base_url,'external_business_id',c.external_business_id,'status',c.status,'api_version',c.api_version,'last_catalog_sync_at',c.last_catalog_sync_at,'last_order_sync_at',c.last_order_sync_at,'last_success_at',c.last_success_at,'last_error_code',c.last_error) into result from public.drugxone_connections c where c.organization_id=org;
 return coalesce(result,jsonb_build_object('status','DISCONNECTED'));
end $$;

create function public.drugxone_set_connection(p_environment text,p_base_url text,p_external_business_id text,p_status text,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare org uuid:=private.current_organization_id(); result uuid; v_url text:=nullif(btrim(p_base_url),''); v_business text:=nullif(btrim(p_external_business_id),'');
begin
 if org is null or not private.has_permission_anywhere('integrations.manage') then raise exception 'Integration management permission required' using errcode='42501'; end if;
 if p_environment not in ('SANDBOX','PRODUCTION') or p_status not in ('DISCONNECTED','READY','PAUSED') then raise exception 'Invalid DrugXone connection state' using errcode='22023'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 5 and 500 then raise exception 'Give a connection change reason (5 to 500 characters)' using errcode='22023'; end if;
 if p_status<>'DISCONNECTED' and (v_url is null or v_business is null) then raise exception 'A ready connection needs a base URL and external business ID' using errcode='22023'; end if;
 insert into public.drugxone_connections(organization_id,environment,base_url,external_business_id,status,created_by,updated_by)
 values(org,p_environment,v_url,v_business,p_status,auth.uid(),auth.uid())
 on conflict(organization_id) do update set environment=excluded.environment,base_url=excluded.base_url,external_business_id=excluded.external_business_id,status=excluded.status,last_error_code=null,last_error=null,updated_by=auth.uid()
 returning id into result;
 return result;
end $$;

create function public.drugxone_set_product_mapping(p_product_id uuid,p_external_product_id text,p_external_offer_id text,p_external_sku text,p_external_name text,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare org uuid:=private.current_organization_id(); c public.drugxone_connections; result uuid;
begin
 if org is null or not private.has_permission_anywhere('integrations.manage') then raise exception 'Integration management permission required' using errcode='42501'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 5 and 500 then raise exception 'Give a mapping reason (5 to 500 characters)' using errcode='22023'; end if;
 select * into c from public.drugxone_connections where organization_id=org and status in ('READY','PAUSED') for update;
 if not found then raise exception 'A ready DrugXone connection is required' using errcode='22023'; end if;
 if not exists(select 1 from public.products where id=p_product_id and organization_id=org and is_active) then raise exception 'Active ERP product not found' using errcode='P0002'; end if;
 insert into public.drugxone_product_mappings(organization_id,connection_id,product_id,external_product_id,external_offer_id,external_sku,external_name,status)
 values(org,c.id,p_product_id,nullif(btrim(p_external_product_id),''),btrim(p_external_offer_id),nullif(btrim(p_external_sku),''),btrim(p_external_name),'PENDING')
 on conflict(organization_id,product_id) do update set external_product_id=excluded.external_product_id,external_offer_id=excluded.external_offer_id,external_sku=excluded.external_sku,external_name=excluded.external_name,status='PENDING',last_error=null
 returning id into result;
 return result;
end $$;

create function public.drugxone_sync_queue(p_page integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare org uuid:=private.current_organization_id(); result jsonb; rows jsonb; total bigint;
begin
 if org is null or not private.has_permission_anywhere('integrations.view') and not private.has_permission_anywhere('integrations.manage') then raise exception 'Integration view permission required' using errcode='42501'; end if;
 if p_page is null or p_page<0 or p_page>100000 then raise exception 'Invalid page' using errcode='22023'; end if;
 select count(*) into total from public.drugxone_sync_events where organization_id=org;
 select coalesce(jsonb_agg(x),'[]') into rows from (select id,direction,entity_type,entity_id,external_id,idempotency_key,status,attempts,next_attempt_at,last_error_code,last_error,created_at,processed_at from public.drugxone_sync_events where organization_id=org order by created_at desc,id desc limit 25 offset p_page*25) x;
 return jsonb_build_object('rows',rows,'total',total);
end $$;

create function private.drugxone_enqueue_event(p_organization_id uuid,p_connection_id uuid,p_direction text,p_entity_type text,p_entity_id uuid,p_external_id text,p_idempotency_key text,p_payload_hash text,p_payload jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
 if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Sync payload must be an object' using errcode='22023'; end if;
 select e.id into result from public.drugxone_sync_events e where e.organization_id=p_organization_id and e.idempotency_key=btrim(p_idempotency_key) for update;
 if result is not null then
   if (select e.payload_hash from public.drugxone_sync_events e where e.id=result)<>p_payload_hash then raise exception 'The idempotency key was reused with a different payload' using errcode='22023'; end if;
   return result;
 end if;
 insert into public.drugxone_sync_events(organization_id,connection_id,direction,entity_type,entity_id,external_id,idempotency_key,payload_hash,payload,created_by)
 values(p_organization_id,p_connection_id,p_direction,p_entity_type,p_entity_id,nullif(btrim(p_external_id),''),btrim(p_idempotency_key),p_payload_hash,p_payload,auth.uid())
 returning id into result;
 return result;
end $$;

revoke all on function public.drugxone_connection_read(),public.drugxone_set_connection(text,text,text,text,text),public.drugxone_set_product_mapping(uuid,text,text,text,text,text),public.drugxone_sync_queue(integer) from public,anon;
grant execute on function public.drugxone_connection_read(),public.drugxone_set_connection(text,text,text,text,text),public.drugxone_set_product_mapping(uuid,text,text,text,text,text),public.drugxone_sync_queue(integer) to authenticated;
revoke all on function private.drugxone_enqueue_event(uuid,uuid,text,text,uuid,text,text,text,jsonb) from public,anon,authenticated;
