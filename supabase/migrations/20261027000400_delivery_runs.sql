-- Phase 17d. Physical delivery only: no stock or financial postings.
create or replace function private.numbered_documents()
returns table(document_type text,default_prefix text) language sql immutable set search_path='' as $$
 select * from (values
 ('SALES_QUOTATION','QUO'),('SALES_ORDER','SO'),('SALES_INVOICE','INV'),('CREDIT_NOTE','CRN'),('CUSTOMER_RECEIPT','RCP'),('CUSTOMER_REFUND','RFD'),
 ('DELIVERY_NOTE','DN'),('POS_SESSION','SHF'),('PURCHASE_ORDER','PO'),('GOODS_RECEIPT','GRN'),('PURCHASE_RETURN','PRN'),('SUPPLIER_INVOICE','SIN'),
 ('STOCK_TRANSFER','TRN'),('STOCK_COUNT','CNT'),('JOURNAL','JV'),('CONTROLLED_ADJUSTMENT','CDA'),('FULFILMENT_ORDER','FO'),('PACKAGE','PK'),('DELIVERY_RUN','RUN')
 ) d(document_type,default_prefix)
$$;
insert into public.permissions(code,module,action,description) values
 ('runs.view','runs','view','View branch delivery runs'),
 ('runs.manage','runs','manage','Plan, load and dispatch branch delivery runs'),
 ('runs.drive','runs','drive','View and record outcomes for personally assigned runs') on conflict do nothing;
insert into public.role_permissions(role_id,permission_id)
select r.id,p.id from public.roles r cross join public.permissions p where r.organization_id is null and
 ((r.code in ('SUPER_ADMIN','OWNER','GENERAL_MANAGER','BRANCH_MANAGER','WAREHOUSE_MANAGER','DISPATCHER') and p.code in ('runs.view','runs.manage'))
 or (r.code in ('SUPER_ADMIN','OWNER') and p.code='runs.drive')
 or (r.code='AUDITOR' and p.code='runs.view') or (r.code='DRIVER' and p.code='runs.drive')) on conflict do nothing;

alter table public.drivers add constraint drivers_id_org_branch_key unique(id,organization_id,branch_id);
alter table public.vehicles add constraint vehicles_id_org_branch_key unique(id,organization_id,branch_id);
alter table public.delivery_notes add constraint delivery_notes_id_org_branch_key unique(id,organization_id,branch_id);
create table public.delivery_runs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 branch_id uuid not null, run_number text not null, run_date date not null, driver_id uuid not null, vehicle_id uuid not null,
 status text not null default 'PLANNED' check(status in ('PLANNED','LOADING','ON_ROAD','COMPLETED','CANCELLED')),
 created_at timestamptz not null default now(), created_by uuid not null default auth.uid(),
 dispatched_at timestamptz, completed_at timestamptz, cancel_reason text,
 foreign key(branch_id,organization_id) references public.branches(id,organization_id),
 foreign key(driver_id,organization_id,branch_id) references public.drivers(id,organization_id,branch_id),
 foreign key(vehicle_id,organization_id,branch_id) references public.vehicles(id,organization_id,branch_id),
 foreign key(created_by,organization_id) references public.profiles(id,organization_id),
 unique(id,organization_id,branch_id), unique(organization_id,run_number)
);
create unique index delivery_runs_driver_busy on public.delivery_runs(driver_id) where status in ('PLANNED','LOADING','ON_ROAD');
create unique index delivery_runs_vehicle_busy on public.delivery_runs(vehicle_id) where status in ('PLANNED','LOADING','ON_ROAD');
create index delivery_runs_queue on public.delivery_runs(organization_id,branch_id,run_date,status);
create table public.delivery_run_stops (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 branch_id uuid not null, run_id uuid not null, delivery_note_id uuid not null, position integer not null check(position>0),
 status text not null default 'PENDING' check(status in ('PENDING','DELIVERED','FAILED','REMOVED')),
 package_count integer not null check(package_count>0), weight_kg numeric(10,2) not null check(weight_kg>0 and weight_kg<>'NaN'::numeric),
 cold_chain boolean not null, loaded_at timestamptz, loaded_by uuid, outcome_at timestamptz, outcome_by uuid,
 receiver_name text, reason text, returned_at timestamptz, returned_by uuid,
 created_at timestamptz not null default now(),
 foreign key(run_id,organization_id,branch_id) references public.delivery_runs(id,organization_id,branch_id),
 foreign key(delivery_note_id,organization_id,branch_id) references public.delivery_notes(id,organization_id,branch_id),
 foreign key(loaded_by,organization_id) references public.profiles(id,organization_id),
 foreign key(outcome_by,organization_id) references public.profiles(id,organization_id),
 foreign key(returned_by,organization_id) references public.profiles(id,organization_id),
 check(receiver_name is null or length(receiver_name) between 1 and 120), check(reason is null or length(reason) between 3 and 500)
);
create unique index delivery_run_stops_note on public.delivery_run_stops(delivery_note_id) where status<>'REMOVED';
create unique index delivery_run_stops_position on public.delivery_run_stops(run_id,position) where status<>'REMOVED';
create index delivery_run_stops_run on public.delivery_run_stops(organization_id,run_id);

create function private.can_read_run(p_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.delivery_runs r join public.drivers d on d.id=r.driver_id and d.organization_id=r.organization_id
 where r.id=p_id and r.organization_id=private.current_organization_id() and
 (private.has_permission('runs.view',r.branch_id) or (private.has_permission('runs.drive',r.branch_id) and d.profile_id=auth.uid() and d.is_active)))
$$;
revoke all on function private.can_read_run(uuid) from public,anon,authenticated;
alter table public.delivery_runs enable row level security;
alter table public.delivery_run_stops enable row level security;
revoke all on public.delivery_runs,public.delivery_run_stops from public,anon,authenticated;
grant select on public.delivery_runs,public.delivery_run_stops to authenticated;
create policy delivery_runs_read on public.delivery_runs for select to authenticated using(organization_id=(select private.current_organization_id()) and (((select private.has_permission('runs.view')) and (branch_id in (select private.permitted_branches('runs.view')) or (select private.has_permission('runs.view')))) or ((select private.has_permission('runs.drive')) and branch_id in (select private.permitted_branches('runs.drive')) and exists(select 1 from public.drivers d where d.id=driver_id and d.organization_id=organization_id and d.profile_id=auth.uid() and d.is_active))));
create policy delivery_run_stops_read on public.delivery_run_stops for select to authenticated using(organization_id=(select private.current_organization_id()) and exists(select 1 from public.delivery_runs r where r.id=run_id and r.organization_id=organization_id and (((select private.has_permission('runs.view')) and (r.branch_id in (select private.permitted_branches('runs.view')) or (select private.has_permission('runs.view')))) or ((select private.has_permission('runs.drive')) and r.branch_id in (select private.permitted_branches('runs.drive')) and exists(select 1 from public.drivers d where d.id=r.driver_id and d.organization_id=r.organization_id and d.profile_id=auth.uid() and d.is_active)))));
create trigger delivery_runs_immutable before update on public.delivery_runs for each row execute function private.prevent_column_change('organization_id','branch_id','run_number','run_date','driver_id','vehicle_id','created_at','created_by');
create trigger delivery_run_stops_immutable before update on public.delivery_run_stops for each row execute function private.prevent_column_change('organization_id','branch_id','run_id','delivery_note_id','package_count','weight_kg','cold_chain','created_at');
create trigger delivery_runs_no_delete before delete on public.delivery_runs for each row execute function private.stock_block_mutation();
create trigger delivery_run_stops_no_delete before delete on public.delivery_run_stops for each row execute function private.stock_block_mutation();
create trigger delivery_runs_audit after insert or update on public.delivery_runs for each row execute function private.audit_row_change('delivery_run');
create trigger delivery_run_stops_audit after insert or update on public.delivery_run_stops for each row execute function private.audit_row_change('delivery_run_stop');

create function private.load_run(p_id uuid,p_manage boolean default true) returns public.delivery_runs language plpgsql security definer set search_path='' as $$
declare r public.delivery_runs;
begin
 select * into r from public.delivery_runs where id=p_id and organization_id=private.current_organization_id() for update;
 if not found or not private.can_read_run(p_id) then raise exception 'Run not found' using errcode='P0002'; end if;
 if p_manage and not private.has_permission('runs.manage',r.branch_id) then raise exception 'Run management permission required' using errcode='42501'; end if;
 return r;
end $$;

create function private.check_run_fleet(p_branch uuid,p_driver uuid,p_vehicle uuid,p_date date) returns void language plpgsql security definer set search_path='' as $$
declare d public.drivers; v public.vehicles; v_day date := greatest(p_date,current_date);
begin
 select * into d from public.drivers where id=p_driver and organization_id=private.current_organization_id() and branch_id=p_branch for share;
 if not found or not d.is_active or nullif(btrim(d.licence_number),'') is null or d.licence_expiry is null or d.licence_expiry<v_day then
 raise exception 'Choose an active branch driver with a valid licence for the run date' using errcode='22023'; end if;
 select * into v from public.vehicles where id=p_vehicle and organization_id=private.current_organization_id() and branch_id=p_branch for share;
 if not found or not v.is_active or v.insurance_expiry is null or v.roadworthy_expiry is null or v.insurance_expiry<v_day or v.roadworthy_expiry<v_day
 or coalesce(v.capacity_packages,0)<=0 or coalesce(v.capacity_kg,0)<=0 then
 raise exception 'Choose an active branch vehicle with valid insurance, roadworthiness and both capacities' using errcode='22023'; end if;
end $$;

create function public.create_delivery_run(p_branch_id uuid,p_driver_id uuid,p_vehicle_id uuid,p_date date) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 if private.current_organization_id() is null or not private.has_permission('runs.manage',p_branch_id) or not exists(select 1 from public.branches where id=p_branch_id and organization_id=private.current_organization_id() and is_active) then
 raise exception 'Insufficient branch permission' using errcode='42501'; end if;
 if p_date is null or p_date<current_date then raise exception 'Choose today or a future run date' using errcode='22023'; end if;
 perform private.check_run_fleet(p_branch_id,p_driver_id,p_vehicle_id,p_date);
 insert into public.delivery_runs(organization_id,branch_id,run_number,run_date,driver_id,vehicle_id)
 values(private.current_organization_id(),p_branch_id,private.generate_document_number(private.current_organization_id(),null,'DELIVERY_RUN','RUN'),p_date,p_driver_id,p_vehicle_id) returning id into v_id;
 return v_id;
end $$;

create function public.add_run_stop(p_run_id uuid,p_note_id uuid,p_weight_kg numeric) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.delivery_runs; d public.delivery_notes; o public.fulfilment_orders; v public.vehicles; v_id uuid; n integer; cold boolean; inv uuid;
begin
 select sales_invoice_id into inv from public.delivery_notes where id=p_note_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Delivery note not found' using errcode='P0002'; end if;
 perform 1 from public.sales_invoices where id=inv and organization_id=private.current_organization_id() for update;
 r := private.load_run(p_run_id);
 if r.status<>'PLANNED' then raise exception 'Only planned runs accept stops' using errcode='22023'; end if;
 select * into d from public.delivery_notes where id=p_note_id and organization_id=r.organization_id and branch_id=r.branch_id for update;
 if not found or d.status<>'PREPARED' then raise exception 'Choose a prepared delivery from this branch' using errcode='22023'; end if;
 select * into o from public.fulfilment_orders where sales_invoice_id=d.sales_invoice_id and organization_id=r.organization_id and status in ('PACKED','READY') for update;
 if not found then raise exception 'Seal packing before adding a delivery to a run' using errcode='22023'; end if;
 if exists(select 1 from public.delivery_run_stops s join public.delivery_notes dn on dn.id=s.delivery_note_id and dn.organization_id=s.organization_id
 where dn.sales_invoice_id=inv and s.organization_id=r.organization_id and s.status='FAILED' and s.returned_at is null) then
 raise exception 'Check failed goods back into the warehouse before redelivery' using errcode='22023'; end if;
 select count(*),coalesce(bool_or(cold_chain),false) into n,cold from public.packages where fulfilment_order_id=o.id and organization_id=r.organization_id and voided_at is null;
 if n=0 or p_weight_kg is null or p_weight_kg<=0 or p_weight_kg='NaN'::numeric or p_weight_kg<>round(p_weight_kg,2) then raise exception 'Enter positive load weight with at most two decimals' using errcode='22023'; end if;
 perform private.check_run_fleet(r.branch_id,r.driver_id,r.vehicle_id,r.run_date);
 select * into v from public.vehicles where id=r.vehicle_id and organization_id=r.organization_id;
 if n+(select coalesce(sum(package_count),0) from public.delivery_run_stops where run_id=r.id and organization_id=r.organization_id and status<>'REMOVED')>v.capacity_packages
 or p_weight_kg+(select coalesce(sum(weight_kg),0) from public.delivery_run_stops where run_id=r.id and organization_id=r.organization_id and status<>'REMOVED')>v.capacity_kg
 or (cold and not v.refrigerated) then raise exception 'Vehicle capacity or refrigeration requirement exceeded' using errcode='22023'; end if;
 insert into public.delivery_run_stops(organization_id,branch_id,run_id,delivery_note_id,position,package_count,weight_kg,cold_chain)
 values(r.organization_id,r.branch_id,r.id,d.id,(select coalesce(max(position),0)+1 from public.delivery_run_stops where run_id=r.id),n,p_weight_kg,cold) returning id into v_id;
 return v_id;
end $$;

create function public.remove_run_stop(p_id uuid,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare r public.delivery_runs; s public.delivery_run_stops;
begin
 select * into s from public.delivery_run_stops where id=p_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Stop not found' using errcode='P0002'; end if;
 r := private.load_run(s.run_id);
 if r.status<>'PLANNED' or p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Remove stops only while planned, with a reason' using errcode='22023'; end if;
 update public.delivery_run_stops set status='REMOVED',reason=btrim(p_reason) where id=s.id and organization_id=r.organization_id and status='PENDING';
 if not found then raise exception 'Stop already removed' using errcode='22023'; end if;
end $$;

create function public.reorder_run_stops(p_id uuid,p_stops uuid[]) returns void language plpgsql security definer set search_path='' as $$
declare r public.delivery_runs := private.load_run(p_id); n integer; v_offset integer;
begin
 select count(*),coalesce(max(position),0)+1 into n,v_offset from public.delivery_run_stops where run_id=r.id and organization_id=r.organization_id and status<>'REMOVED';
 if r.status<>'PLANNED' or p_stops is null or cardinality(p_stops)<>n or (select count(distinct x) from unnest(p_stops) x)<>n
 or exists(select 1 from unnest(p_stops) x where not exists(select 1 from public.delivery_run_stops where id=x and run_id=r.id and organization_id=r.organization_id and status<>'REMOVED')) then
 raise exception 'Supply every active stop exactly once on a planned run' using errcode='22023'; end if;
 update public.delivery_run_stops set position=position+v_offset where run_id=r.id and organization_id=r.organization_id and status<>'REMOVED';
 update public.delivery_run_stops s set position=x.pos from unnest(p_stops) with ordinality x(id,pos) where s.id=x.id and s.run_id=r.id and s.organization_id=r.organization_id;
end $$;

create function public.start_run_loading(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare r public.delivery_runs := private.load_run(p_id);
begin
 if r.status<>'PLANNED' or not exists(select 1 from public.delivery_run_stops where run_id=r.id and organization_id=r.organization_id and status='PENDING') then raise exception 'Add stops to a planned run first' using errcode='22023'; end if;
 perform private.check_run_fleet(r.branch_id,r.driver_id,r.vehicle_id,r.run_date);
 update public.delivery_runs set status='LOADING' where id=r.id and organization_id=r.organization_id;
end $$;

create function public.load_run_stop(p_id uuid,p_packages integer) returns void language plpgsql security definer set search_path='' as $$
declare r public.delivery_runs; s public.delivery_run_stops;
begin
 select * into s from public.delivery_run_stops where id=p_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Stop not found' using errcode='P0002'; end if;
 r := private.load_run(s.run_id);
 if r.status<>'LOADING' or s.status<>'PENDING' or p_packages is distinct from s.package_count then raise exception 'Confirm the exact package count during loading' using errcode='22023'; end if;
 update public.delivery_run_stops set loaded_at=now(),loaded_by=auth.uid() where id=s.id and organization_id=r.organization_id and loaded_at is null;
 if not found then raise exception 'Stop already loaded' using errcode='22023'; end if;
end $$;

-- Attached notes cannot bypass run controls through legacy delivery RPCs.
create function private.guard_run_note() returns trigger language plpgsql security definer set search_path='' as $$
declare s public.delivery_run_stops; r public.delivery_runs;
begin
 select * into s from public.delivery_run_stops where delivery_note_id=new.id and organization_id=new.organization_id and status<>'REMOVED';
 if not found then return new; end if;
 select * into r from public.delivery_runs where id=s.run_id and organization_id=s.organization_id;
 if new.status is distinct from old.status and not
 ((new.status='DISPATCHED' and r.status='ON_ROAD' and s.loaded_at is not null)
 or (new.status in ('DELIVERED','FAILED') and r.status='ON_ROAD' and s.status=new.status)) then
 raise exception 'Use delivery run controls for this delivery note' using errcode='22023'; end if;
 return new;
end $$;
create trigger delivery_notes_run_guard before update on public.delivery_notes for each row execute function private.guard_run_note();

create function public.dispatch_delivery_run(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare r public.delivery_runs; v public.vehicles; d public.drivers; s record; n integer;
begin
 -- Invoice locks first, consistently ordered, before run/note/fulfilment locks.
 if not private.can_read_run(p_id) then raise exception 'Run not found' using errcode='P0002'; end if;
 perform i.id from public.sales_invoices i join public.delivery_notes dn on dn.sales_invoice_id=i.id and dn.organization_id=i.organization_id
 join public.delivery_run_stops st on st.delivery_note_id=dn.id and st.organization_id=dn.organization_id
 where st.run_id=p_id and st.organization_id=private.current_organization_id() and st.status='PENDING' order by i.id for update of i;
 r := private.load_run(p_id);
 if r.status<>'LOADING' then raise exception 'Run must be loading' using errcode='22023'; end if;
 perform private.check_run_fleet(r.branch_id,r.driver_id,r.vehicle_id,r.run_date);
 select * into v from public.vehicles where id=r.vehicle_id and organization_id=r.organization_id;
 select * into d from public.drivers where id=r.driver_id and organization_id=r.organization_id;
 select count(*) into n from public.delivery_run_stops where run_id=r.id and organization_id=r.organization_id and status='PENDING';
 if n=0 or exists(select 1 from public.delivery_run_stops where run_id=r.id and organization_id=r.organization_id and status='PENDING' and loaded_at is null) then raise exception 'Confirm all package loads first' using errcode='22023'; end if;
 if (select sum(package_count)>v.capacity_packages or sum(weight_kg)>v.capacity_kg or (bool_or(cold_chain) and not v.refrigerated) from public.delivery_run_stops where run_id=r.id and organization_id=r.organization_id and status='PENDING') then raise exception 'Vehicle capacity or refrigeration requirement exceeded' using errcode='22023'; end if;
 update public.delivery_runs set status='ON_ROAD',dispatched_at=now() where id=r.id and organization_id=r.organization_id;
 for s in select dn.id,i.status as invoice_status,dn.status as note_status from public.delivery_run_stops st
 join public.delivery_notes dn on dn.id=st.delivery_note_id and dn.organization_id=st.organization_id
 join public.sales_invoices i on i.id=dn.sales_invoice_id and i.organization_id=dn.organization_id
 where st.run_id=r.id and st.organization_id=r.organization_id and st.status='PENDING' order by dn.id for update of dn loop
   if s.invoice_status<>'POSTED' or s.note_status<>'PREPARED' then raise exception 'Every stop needs a prepared note and posted invoice' using errcode='22023'; end if;
   update public.delivery_notes set status='DISPATCHED',driver_name=d.name,vehicle_number=v.registration_number,dispatched_by=auth.uid(),dispatched_at=now() where id=s.id and organization_id=r.organization_id;
 end loop;
end $$;

create function public.record_run_outcome(p_id uuid,p_delivered boolean,p_receiver text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare r public.delivery_runs; s public.delivery_run_stops; v_status text;
begin
 select * into s from public.delivery_run_stops where id=p_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Stop not found' using errcode='P0002'; end if;
 r := private.load_run(s.run_id,false);
 if not private.has_permission('runs.manage',r.branch_id) and not (private.has_permission('runs.drive',r.branch_id) and exists(select 1 from public.drivers where id=r.driver_id and organization_id=r.organization_id and profile_id=auth.uid() and is_active)) then raise exception 'Only a dispatcher or the assigned driver can record outcomes' using errcode='42501'; end if;
 select * into s from public.delivery_run_stops where id=p_id and organization_id=r.organization_id for update;
 if r.status<>'ON_ROAD' or s.status<>'PENDING' or p_delivered is null then raise exception 'Record each on-road stop once' using errcode='22023'; end if;
 if p_delivered and (p_receiver is null or length(btrim(p_receiver)) not between 1 and 120) then raise exception 'Enter the receiver name' using errcode='22023'; end if;
 if (not p_delivered and (p_reason is null or length(btrim(p_reason)) not between 3 and 500)) or length(coalesce(p_reason,''))>500 then raise exception 'Give a failure reason (3 to 500 characters)' using errcode='22023'; end if;
 v_status := case when p_delivered then 'DELIVERED' else 'FAILED' end;
 update public.delivery_run_stops set status=v_status,receiver_name=case when p_delivered then btrim(p_receiver) end,reason=case when length(btrim(coalesce(p_reason,'')))>=3 then btrim(p_reason) end,outcome_at=now(),outcome_by=auth.uid() where id=s.id and organization_id=r.organization_id;
 update public.delivery_notes set status=v_status,received_by_name=case when p_delivered then btrim(p_receiver) end,delivered_at=case when p_delivered then now() end,status_reason=nullif(btrim(p_reason),'') where id=s.delivery_note_id and organization_id=r.organization_id and status='DISPATCHED';
 if not found then raise exception 'Delivery is no longer dispatched' using errcode='22023'; end if;
 if not exists(select 1 from public.delivery_run_stops where run_id=r.id and organization_id=r.organization_id and status='PENDING') then
 update public.delivery_runs set status='COMPLETED',completed_at=now() where id=r.id and organization_id=r.organization_id; end if;
end $$;

create function public.return_run_stop(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare r public.delivery_runs; s public.delivery_run_stops;
begin
 select * into s from public.delivery_run_stops where id=p_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Stop not found' using errcode='P0002'; end if;
 r := private.load_run(s.run_id);
 update public.delivery_run_stops set returned_at=now(),returned_by=auth.uid() where id=s.id and organization_id=r.organization_id and status='FAILED' and returned_at is null;
 if not found then raise exception 'Only failed, unreturned deliveries can be checked in' using errcode='22023'; end if;
end $$;

create function public.cancel_delivery_run(p_id uuid,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare r public.delivery_runs := private.load_run(p_id);
begin
 if r.status not in ('PLANNED','LOADING') or p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Cancel only before dispatch, with a reason' using errcode='22023'; end if;
 update public.delivery_run_stops set status='REMOVED',reason=btrim(p_reason) where run_id=r.id and organization_id=r.organization_id and status='PENDING';
 update public.delivery_runs set status='CANCELLED',cancel_reason=btrim(p_reason) where id=r.id and organization_id=r.organization_id;
end $$;

create function public.delivery_run_list() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(x) order by x.run_date desc,x.run_number),'[]'::jsonb) from
 (select r.*,d.name as driver_name,v.registration_number as vehicle_number,v.capacity_packages,v.capacity_kg,v.refrigerated,
 (select count(*) from public.delivery_run_stops s where s.run_id=r.id and s.organization_id=r.organization_id and s.status<>'REMOVED') as stop_count
 from public.delivery_runs r join public.drivers d on d.id=r.driver_id and d.organization_id=r.organization_id join public.vehicles v on v.id=r.vehicle_id and v.organization_id=r.organization_id
 where r.organization_id=private.current_organization_id() and private.can_read_run(r.id)) x
$$;
create function public.delivery_run_detail(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not private.can_read_run(p_id) then raise exception 'Run not found' using errcode='P0002'; end if;
 return coalesce((select jsonb_agg(to_jsonb(x) order by x.position) from
 (select s.*,dn.note_number,dn.delivery_address,dn.contact_name,dn.contact_phone,dn.notes,c.name as customer_name,i.invoice_number,i.balance_due,i.currency_code
 from public.delivery_run_stops s join public.delivery_notes dn on dn.id=s.delivery_note_id and dn.organization_id=s.organization_id
 join public.customers c on c.id=dn.customer_id and c.organization_id=dn.organization_id join public.sales_invoices i on i.id=dn.sales_invoice_id and i.organization_id=dn.organization_id
 where s.run_id=p_id and s.organization_id=private.current_organization_id()) x),'[]'::jsonb);
end $$;
create function public.run_planning_options(p_branch_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if private.current_organization_id() is null or not private.has_permission('runs.manage',p_branch_id) or not exists(select 1 from public.branches where id=p_branch_id and organization_id=private.current_organization_id()) then raise exception 'Insufficient branch permission' using errcode='42501'; end if;
 return jsonb_build_object(
 'drivers',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'licence_expiry',licence_expiry)) from public.drivers where organization_id=private.current_organization_id() and branch_id=p_branch_id and is_active),'[]'::jsonb),
 'vehicles',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',registration_number,'capacity_packages',capacity_packages,'capacity_kg',capacity_kg,'refrigerated',refrigerated)) from public.vehicles where organization_id=private.current_organization_id() and branch_id=p_branch_id and is_active),'[]'::jsonb),
 'notes',coalesce((select jsonb_agg(jsonb_build_object('id',dn.id,'name',dn.note_number||' · '||c.name,'packages',(select count(*) from public.packages pk where pk.fulfilment_order_id=o.id and pk.organization_id=o.organization_id and pk.voided_at is null)))
 from public.delivery_notes dn join public.fulfilment_orders o on o.sales_invoice_id=dn.sales_invoice_id and o.organization_id=dn.organization_id and o.status in ('PACKED','READY')
 join public.customers c on c.id=dn.customer_id and c.organization_id=dn.organization_id
 where dn.organization_id=private.current_organization_id() and dn.branch_id=p_branch_id and dn.status='PREPARED'
 and not exists(select 1 from public.delivery_run_stops s where s.delivery_note_id=dn.id and s.organization_id=dn.organization_id and s.status<>'REMOVED')),'[]'::jsonb));
end $$;

-- Linking driver access requires staff administration as well as fleet management.
create function public.link_driver_profile(p_driver_id uuid,p_profile_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare d public.drivers;
begin
 select * into d from public.drivers where id=p_driver_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Driver not found' using errcode='P0002'; end if;
 if not private.has_permission('fleet.manage',d.branch_id) or not private.has_permission('roles.assign') then raise exception 'Fleet and role assignment permissions required' using errcode='42501'; end if;
 if p_profile_id is not null and not exists(select 1 from public.profiles where id=p_profile_id and organization_id=d.organization_id and is_active) then raise exception 'Active organization user required' using errcode='22023'; end if;
 update public.drivers set profile_id=p_profile_id where id=d.id and organization_id=d.organization_id;
end $$;

revoke insert(profile_id),update(profile_id) on public.drivers from authenticated;
create function public.driver_profile_options(p_driver_id uuid) returns table(id uuid,name text) language plpgsql stable security definer set search_path='' as $$
declare d public.drivers;
begin
 select * into d from public.drivers where drivers.id=p_driver_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Driver not found' using errcode='P0002'; end if;
 if not private.has_permission('fleet.manage',d.branch_id) or not private.has_permission('roles.assign') then raise exception 'Fleet and role assignment permissions required' using errcode='42501'; end if;
 return query select p.id,coalesce(p.display_name,p.first_name||' '||p.last_name)::text from public.profiles p where p.organization_id=d.organization_id and p.is_active order by 2;
end $$;
revoke all on function public.driver_profile_options(uuid) from public,anon;
grant execute on function public.driver_profile_options(uuid) to authenticated;

revoke all on function private.load_run(uuid,boolean),private.check_run_fleet(uuid,uuid,uuid,date),private.guard_run_note() from public,anon,authenticated;
revoke all on function public.create_delivery_run(uuid,uuid,uuid,date),public.add_run_stop(uuid,uuid,numeric),public.remove_run_stop(uuid,text),public.reorder_run_stops(uuid,uuid[]),public.start_run_loading(uuid),public.load_run_stop(uuid,integer),public.dispatch_delivery_run(uuid),public.record_run_outcome(uuid,boolean,text,text),public.return_run_stop(uuid),public.cancel_delivery_run(uuid,text),public.delivery_run_list(),public.delivery_run_detail(uuid),public.run_planning_options(uuid),public.link_driver_profile(uuid,uuid) from public,anon;
grant execute on function public.create_delivery_run(uuid,uuid,uuid,date),public.add_run_stop(uuid,uuid,numeric),public.remove_run_stop(uuid,text),public.reorder_run_stops(uuid,uuid[]),public.start_run_loading(uuid),public.load_run_stop(uuid,integer),public.dispatch_delivery_run(uuid),public.record_run_outcome(uuid,boolean,text,text),public.return_run_stop(uuid),public.cancel_delivery_run(uuid,text),public.delivery_run_list(),public.delivery_run_detail(uuid),public.run_planning_options(uuid),public.link_driver_profile(uuid,uuid) to authenticated;
