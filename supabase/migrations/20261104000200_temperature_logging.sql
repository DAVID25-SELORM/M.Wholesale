-- Cold-chain temperature logging and excursion decisions.
-- Readings are append-only evidence against a cold-chain package. A reading outside the
-- allowed range for the strictest storage condition among the packed goods opens an
-- excursion; a different person with temperature.decide must accept or reject the goods.
-- An open or rejected excursion blocks dispatch of its (non-voided) package. No stock or
-- financial movement is made here. Every table is organization- and branch-scoped.
insert into public.permissions(code,module,action,description) values
 ('temperature.view','temperature','view','View cold-chain temperature readings and excursions'),
 ('temperature.record','temperature','record','Record cold-chain temperature readings'),
 ('temperature.decide','temperature','decide','Accept or reject goods after a temperature excursion')
on conflict (code) do nothing;
insert into public.role_permissions(role_id,permission_id)
select r.id,p.id from public.roles r cross join public.permissions p
where r.organization_id is null and
 ((p.code='temperature.view' and r.code in ('SUPER_ADMIN','OWNER','GENERAL_MANAGER','BRANCH_MANAGER','WAREHOUSE_MANAGER','WAREHOUSE_PACKER','DISPATCHER','DRIVER','PHARMACIST','AUDITOR'))
 or (p.code='temperature.record' and r.code in ('SUPER_ADMIN','OWNER','GENERAL_MANAGER','BRANCH_MANAGER','WAREHOUSE_MANAGER','WAREHOUSE_PACKER','DISPATCHER','DRIVER'))
 or (p.code='temperature.decide' and r.code in ('SUPER_ADMIN','OWNER','GENERAL_MANAGER','BRANCH_MANAGER','WAREHOUSE_MANAGER','PHARMACIST')))
on conflict do nothing;

create function private.temperature_limits(p_condition text)
returns table(min_c numeric,max_c numeric) language sql immutable set search_path='' as $$
 select case p_condition when 'FROZEN' then -25::numeric when 'REFRIGERATED' then 2 when 'COOL' then 8 else 15 end,
        case p_condition when 'FROZEN' then -15::numeric when 'REFRIGERATED' then 8 when 'COOL' then 15 else 30 end
$$;
revoke all on function private.temperature_limits(text) from public,anon,authenticated;

create table public.temperature_readings (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 branch_id uuid not null, fulfilment_order_id uuid not null, package_id uuid not null,
 stage text not null check(stage in ('PACKING','DISPATCH','TRANSIT','DELIVERY')),
 temperature_c numeric(5,1) not null check(temperature_c between -60 and 60),
 storage_condition text not null check(storage_condition in ('AMBIENT','COOL','REFRIGERATED','FROZEN')),
 limit_min_c numeric(5,1) not null, limit_max_c numeric(5,1) not null,
 within_range boolean not null,
 note text check(note is null or length(btrim(note)) between 1 and 500),
 recorded_by uuid not null default auth.uid(), recorded_at timestamptz not null default now(),
 foreign key(fulfilment_order_id,organization_id,branch_id) references public.fulfilment_orders(id,organization_id,branch_id),
 foreign key(package_id,fulfilment_order_id,organization_id) references public.packages(id,fulfilment_order_id,organization_id),
 foreign key(recorded_by,organization_id) references public.profiles(id,organization_id),
 unique(id,organization_id)
);
create table public.temperature_excursions (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 branch_id uuid not null, fulfilment_order_id uuid not null, package_id uuid not null, reading_id uuid not null,
 status text not null default 'OPEN' check(status in ('OPEN','RESOLVED')),
 decision text check(decision in ('ACCEPT_USE','REJECT_GOODS')),
 decision_reason text check(decision_reason is null or length(btrim(decision_reason)) between 10 and 500),
 decided_by uuid, decided_at timestamptz,
 created_at timestamptz not null default now(),
 foreign key(fulfilment_order_id,organization_id,branch_id) references public.fulfilment_orders(id,organization_id,branch_id),
 foreign key(package_id,fulfilment_order_id,organization_id) references public.packages(id,fulfilment_order_id,organization_id),
 foreign key(reading_id,organization_id) references public.temperature_readings(id,organization_id),
 foreign key(decided_by,organization_id) references public.profiles(id,organization_id),
 unique(reading_id), unique(id,organization_id),
 check((status='OPEN' and decision is null and decision_reason is null and decided_by is null and decided_at is null)
    or (status='RESOLVED' and decision is not null and decision_reason is not null and decided_by is not null and decided_at is not null))
);
create index temperature_readings_pkg_idx on public.temperature_readings(organization_id,package_id,recorded_at desc);
create index temperature_excursions_open_idx on public.temperature_excursions(organization_id,branch_id,status);

alter table public.temperature_readings enable row level security;
alter table public.temperature_excursions enable row level security;
revoke all on public.temperature_readings,public.temperature_excursions from public,anon,authenticated;
grant select on public.temperature_readings,public.temperature_excursions to authenticated;
create policy temperature_readings_read on public.temperature_readings for select to authenticated using(
 organization_id=(select private.current_organization_id()) and ((select private.has_permission('temperature.view')) or branch_id in (select private.permitted_branches('temperature.view'))));
create policy temperature_excursions_read on public.temperature_excursions for select to authenticated using(
 organization_id=(select private.current_organization_id()) and ((select private.has_permission('temperature.view')) or branch_id in (select private.permitted_branches('temperature.view'))));
create trigger temperature_readings_immutable before update or delete on public.temperature_readings for each row execute function private.stock_block_mutation();
create trigger temperature_excursions_no_delete before delete on public.temperature_excursions for each row execute function private.stock_block_mutation();
create trigger temperature_excursions_identity before update on public.temperature_excursions for each row execute function private.prevent_column_change('organization_id','branch_id','fulfilment_order_id','package_id','reading_id','created_at');
create trigger temperature_readings_audit after insert on public.temperature_readings for each row execute function private.audit_row_change('temperature_reading');
create trigger temperature_excursions_audit after insert or update on public.temperature_excursions for each row execute function private.audit_row_change('temperature_excursion');

create function private.load_temperature_order(p_id uuid,p_permission text)
returns public.fulfilment_orders language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders; v_org uuid:=private.current_organization_id();
begin
 if v_org is null then raise exception 'insufficient privilege' using errcode='42501'; end if;
 select * into o from public.fulfilment_orders where id=p_id and organization_id=v_org for update;
 if not found or not private.has_permission('temperature.view',o.branch_id) then raise exception 'fulfilment order not found' using errcode='P0002'; end if;
 if not private.has_permission(p_permission,o.branch_id) then raise exception 'insufficient privilege for this branch' using errcode='42501'; end if;
 return o;
end $$;
revoke all on function private.load_temperature_order(uuid,text) from public,anon,authenticated;

create function public.record_temperature_reading(p_package_id uuid,p_stage text,p_temperature numeric,p_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare pk public.packages; o public.fulfilment_orders; v_cond text; v_min numeric; v_max numeric; v_ok boolean; v_reading uuid; v_exc uuid; v_temp numeric;
begin
 select * into pk from public.packages where id=p_package_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Package not found' using errcode='P0002'; end if;
 o:=private.load_temperature_order(pk.fulfilment_order_id,'temperature.record');
 select * into pk from public.packages where id=p_package_id and organization_id=o.organization_id;
 if o.status='CANCELLED' or pk.voided_at is not null then raise exception 'This package is not active' using errcode='22023'; end if;
 if not pk.cold_chain then raise exception 'Temperature is recorded only for cold-chain packages' using errcode='22023'; end if;
 if p_stage is null or p_stage not in ('PACKING','DISPATCH','TRANSIT','DELIVERY') then raise exception 'Choose a valid stage' using errcode='22023'; end if;
 if p_temperature is null or p_temperature='NaN'::numeric or p_temperature not between -60 and 60 then raise exception 'Enter a temperature between -60 and 60 degrees C' using errcode='22023'; end if;
 if p_note is not null and length(btrim(p_note)) not between 1 and 500 then raise exception 'The note must be 1 to 500 characters' using errcode='22023'; end if;
 select (array['AMBIENT','COOL','REFRIGERATED','FROZEN'])[max(case pr.storage_condition when 'FROZEN' then 4 when 'REFRIGERATED' then 3 when 'COOL' then 2 else 1 end)] into v_cond
 from public.package_lines l join public.pick_lines pl on pl.id=l.pick_line_id and pl.organization_id=l.organization_id
 join public.products pr on pr.id=pl.product_id and pr.organization_id=pl.organization_id
 where l.package_id=pk.id and l.organization_id=o.organization_id;
 if v_cond is null then raise exception 'Pack goods into the package before recording its temperature' using errcode='22023'; end if;
 select min_c,max_c into v_min,v_max from private.temperature_limits(v_cond);
 v_temp:=round(p_temperature,1);
 v_ok:=v_temp between v_min and v_max;
 insert into public.temperature_readings(organization_id,branch_id,fulfilment_order_id,package_id,stage,temperature_c,storage_condition,limit_min_c,limit_max_c,within_range,note)
 values(o.organization_id,o.branch_id,o.id,pk.id,p_stage,v_temp,v_cond,v_min,v_max,v_ok,nullif(btrim(p_note),'')) returning id into v_reading;
 if not v_ok then
   insert into public.temperature_excursions(organization_id,branch_id,fulfilment_order_id,package_id,reading_id)
   values(o.organization_id,o.branch_id,o.id,pk.id,v_reading) returning id into v_exc;
 end if;
 return jsonb_build_object('reading_id',v_reading,'within_range',v_ok,'excursion_id',v_exc,'limit_min_c',v_min,'limit_max_c',v_max,'storage_condition',v_cond);
end $$;

create function public.resolve_temperature_excursion(p_excursion_id uuid,p_decision text,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare x public.temperature_excursions; o public.fulfilment_orders; v_recorder uuid;
begin
 select * into x from public.temperature_excursions where id=p_excursion_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Excursion not found' using errcode='P0002'; end if;
 o:=private.load_temperature_order(x.fulfilment_order_id,'temperature.decide');
 select * into x from public.temperature_excursions where id=p_excursion_id and organization_id=o.organization_id for update;
 if x.status<>'OPEN' then raise exception 'This excursion has already been decided' using errcode='22023'; end if;
 if p_decision is null or p_decision not in ('ACCEPT_USE','REJECT_GOODS') then raise exception 'Choose to accept the goods for use or reject them' using errcode='22023'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 10 and 500 then raise exception 'Give a reason (10 to 500 characters)' using errcode='22023'; end if;
 select recorded_by into v_recorder from public.temperature_readings where id=x.reading_id and organization_id=x.organization_id;
 if v_recorder=auth.uid() then raise exception 'A different person must decide on an excursion you recorded' using errcode='42501'; end if;
 update public.temperature_excursions set status='RESOLVED',decision=p_decision,decision_reason=btrim(p_reason),decided_by=auth.uid(),decided_at=now()
 where id=x.id and organization_id=x.organization_id;
end $$;

-- Cold-chain packages the temperature screen works with: not voided, order not cancelled,
-- still being prepared or delivered, or carrying an undecided excursion.
create function public.cold_chain_packages()
returns table(package_id uuid,package_number text,fulfilment_order_id uuid,order_number text,customer_name text,order_status text,
 latest_temperature_c numeric,latest_within_range boolean,latest_stage text,latest_recorded_at timestamptz,open_excursions integer,rejected_excursions integer)
language plpgsql stable security definer set search_path='' as $$
#variable_conflict use_column
declare v_org uuid:=private.current_organization_id();
begin
 if v_org is null then raise exception 'insufficient privilege' using errcode='42501'; end if;
 return query
 select pk.id,pk.package_number,o.id,o.order_number,c.name::text,o.status,
  lr.temperature_c,lr.within_range,lr.stage,lr.recorded_at,
  (select count(*)::integer from public.temperature_excursions x where x.package_id=pk.id and x.organization_id=v_org and x.status='OPEN'),
  (select count(*)::integer from public.temperature_excursions x where x.package_id=pk.id and x.organization_id=v_org and x.decision='REJECT_GOODS')
 from public.packages pk
 join public.fulfilment_orders o on o.id=pk.fulfilment_order_id and o.organization_id=pk.organization_id
 join public.customers c on c.id=o.customer_id and c.organization_id=o.organization_id
 left join lateral (select r.temperature_c,r.within_range,r.stage,r.recorded_at from public.temperature_readings r where r.package_id=pk.id and r.organization_id=v_org order by r.recorded_at desc,r.id limit 1) lr on true
 where pk.organization_id=v_org and pk.cold_chain and pk.voided_at is null and o.status<>'CANCELLED'
  and private.has_permission('temperature.view',o.branch_id)
  and (o.status in ('PACKING','PACKED','READY') or exists(select 1 from public.temperature_excursions x where x.package_id=pk.id and x.organization_id=v_org and x.status='OPEN'))
 order by o.order_number,pk.package_number;
end $$;

-- An undecided or rejected excursion on an active package stops the delivery leaving the warehouse.
create function private.block_dispatch_on_excursion() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.fulfilment_orders o join public.temperature_excursions x on x.fulfilment_order_id=o.id and x.organization_id=o.organization_id
   join public.packages pk on pk.id=x.package_id and pk.organization_id=x.organization_id and pk.voided_at is null
   where o.sales_invoice_id=new.sales_invoice_id and o.organization_id=new.organization_id and o.status<>'CANCELLED'
   and (x.status='OPEN' or x.decision='REJECT_GOODS')) then
   raise exception 'A cold-chain temperature excursion has not been cleared; dispatch is blocked' using errcode='22023';
 end if;
 return new;
end $$;
revoke all on function private.block_dispatch_on_excursion() from public,anon,authenticated;
create trigger delivery_notes_temperature_guard before update of status on public.delivery_notes
for each row when(new.status='DISPATCHED' and old.status is distinct from 'DISPATCHED') execute function private.block_dispatch_on_excursion();

revoke all on function public.record_temperature_reading(uuid,text,numeric,text),public.resolve_temperature_excursion(uuid,text,text),public.cold_chain_packages() from public,anon;
grant execute on function public.record_temperature_reading(uuid,text,numeric,text),public.resolve_temperature_excursion(uuid,text,text),public.cold_chain_packages() to authenticated;
