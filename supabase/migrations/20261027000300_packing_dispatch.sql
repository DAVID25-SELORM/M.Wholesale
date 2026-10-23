-- Packing and dispatch handoff. No stock or financial movements are made here.
-- All mutations serialize on the fulfilment order; corrections void a package,
-- preserving its contents and audit evidence. Delivery retains its existing lifecycle.
insert into public.permissions(code,module,action,description) values
 ('packing.work','packing','work','Pack picked goods and seal orders'),
 ('packing.verify','packing','verify','Independently verify controlled packed medicines')
on conflict (code) do nothing;
insert into public.role_permissions(role_id,permission_id)
select r.id,p.id from public.roles r cross join public.permissions p
where r.organization_id is null and
 ((p.code='packing.work' and r.code in ('SUPER_ADMIN','OWNER','GENERAL_MANAGER','BRANCH_MANAGER','WAREHOUSE_MANAGER','WAREHOUSE_PACKER'))
 or (p.code='packing.verify' and r.code in ('SUPER_ADMIN','OWNER','GENERAL_MANAGER','BRANCH_MANAGER','WAREHOUSE_MANAGER')))
on conflict do nothing;

alter table public.fulfilment_orders add column packed_at timestamptz;
alter table public.fulfilment_orders add constraint fulfilment_orders_id_org_branch_key unique(id,organization_id,branch_id);
alter table public.pick_lines add constraint pick_lines_id_order_org_key unique(id,fulfilment_order_id,organization_id);

create table public.packages (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 fulfilment_order_id uuid not null, branch_id uuid not null,
 package_number text not null,
 kind text not null check(kind in ('CARTON','BAG','COOL_BOX')),
 cold_chain boolean not null default false, fragile boolean not null default false,
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 voided_at timestamptz, void_reason text,
 foreign key(fulfilment_order_id,organization_id,branch_id) references public.fulfilment_orders(id,organization_id,branch_id),
 foreign key(created_by,organization_id) references public.profiles(id,organization_id),
 unique(id,fulfilment_order_id,organization_id), unique(organization_id,package_number),
 check ((voided_at is null and void_reason is null) or (voided_at is not null and length(btrim(void_reason)) between 3 and 500))
);
create table public.package_lines (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 fulfilment_order_id uuid not null, branch_id uuid not null, package_id uuid not null, pick_line_id uuid not null,
 quantity numeric(18,3) not null check(quantity > 0 and quantity <> 'NaN'::numeric),
 packed_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 foreign key(fulfilment_order_id,organization_id,branch_id) references public.fulfilment_orders(id,organization_id,branch_id),
 foreign key(package_id,fulfilment_order_id,organization_id) references public.packages(id,fulfilment_order_id,organization_id),
 foreign key(pick_line_id,fulfilment_order_id,organization_id) references public.pick_lines(id,fulfilment_order_id,organization_id),
 foreign key(packed_by,organization_id) references public.profiles(id,organization_id)
);
create table public.packing_verifications (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 fulfilment_order_id uuid not null, branch_id uuid not null, pick_line_id uuid not null,
 verified_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 foreign key(fulfilment_order_id,organization_id,branch_id) references public.fulfilment_orders(id,organization_id,branch_id),
 foreign key(pick_line_id,fulfilment_order_id,organization_id) references public.pick_lines(id,fulfilment_order_id,organization_id),
 foreign key(verified_by,organization_id) references public.profiles(id,organization_id),
 unique(pick_line_id)
);
create index packages_order_idx on public.packages(organization_id,fulfilment_order_id);
create index package_lines_order_idx on public.package_lines(organization_id,fulfilment_order_id,pick_line_id);
create index packing_verifications_order_idx on public.packing_verifications(organization_id,fulfilment_order_id);

alter table public.packages enable row level security;
alter table public.package_lines enable row level security;
alter table public.packing_verifications enable row level security;
revoke all on public.packages,public.package_lines,public.packing_verifications from public,anon,authenticated;
grant select on public.packages,public.package_lines,public.packing_verifications to authenticated;
create policy packages_read on public.packages for select to authenticated using(organization_id=private.current_organization_id() and private.has_permission('fulfilment.view',branch_id));
create policy package_lines_read on public.package_lines for select to authenticated using(organization_id=private.current_organization_id() and private.has_permission('fulfilment.view',branch_id));
create policy packing_verifications_read on public.packing_verifications for select to authenticated using(organization_id=private.current_organization_id() and private.has_permission('fulfilment.view',branch_id));
create trigger packages_immutable before update on public.packages for each row execute function private.prevent_column_change('organization_id','fulfilment_order_id','branch_id','package_number','kind','cold_chain','fragile','created_by','created_at');
create trigger packages_no_delete before delete on public.packages for each row execute function private.stock_block_mutation();
create trigger package_lines_immutable before update or delete on public.package_lines for each row execute function private.stock_block_mutation();
create trigger packing_verifications_immutable before update or delete on public.packing_verifications for each row execute function private.stock_block_mutation();
create trigger packages_audit after insert or update on public.packages for each row execute function private.audit_row_change('package');
create trigger package_lines_audit after insert on public.package_lines for each row execute function private.audit_row_change('package_line');
create trigger packing_verifications_audit after insert on public.packing_verifications for each row execute function private.audit_row_change('packing_verification');

create function public.start_packing(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders := private.load_fulfilment_order(p_id,'packing.work');
begin
 if o.status <> 'PICKED' then raise exception 'Only picked orders can start packing' using errcode='22023'; end if;
 update public.fulfilment_orders set status='PACKING' where id=o.id and organization_id=o.organization_id;
end $$;

create function public.create_package(p_id uuid,p_kind text,p_cold_chain boolean default false,p_fragile boolean default false)
returns uuid language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders := private.load_fulfilment_order(p_id,'packing.work'); v_id uuid;
begin
 if o.status <> 'PACKING' then raise exception 'Order must be packing' using errcode='22023'; end if;
 insert into public.packages(organization_id,fulfilment_order_id,branch_id,package_number,kind,cold_chain,fragile)
 values(o.organization_id,o.id,o.branch_id,private.generate_document_number(o.organization_id,null,'PACKAGE','PK'),p_kind,p_cold_chain,p_fragile) returning id into v_id;
 return v_id;
end $$;

create function public.pack_line(p_package_id uuid,p_line_id uuid,p_quantity numeric) returns void language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders; pk public.packages; l public.pick_lines; v_total numeric;
begin
 select * into pk from public.packages where id=p_package_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Package not found' using errcode='P0002'; end if;
 o := private.load_fulfilment_order(pk.fulfilment_order_id,'packing.work');
 select * into pk from public.packages where id=p_package_id and organization_id=o.organization_id;
 if o.status <> 'PACKING' or pk.voided_at is not null then raise exception 'Package is not open for packing' using errcode='22023'; end if;
 select * into l from public.pick_lines where id=p_line_id and fulfilment_order_id=o.id and organization_id=o.organization_id;
 if not found then raise exception 'Pick line not found' using errcode='P0002'; end if;
 if exists(select 1 from public.packing_verifications where pick_line_id=l.id and organization_id=o.organization_id) then raise exception 'Verified contents cannot change' using errcode='22023'; end if;
 select coalesce(sum(pl.quantity),0) into v_total from public.package_lines pl join public.packages p on p.id=pl.package_id and p.organization_id=pl.organization_id
 where pl.pick_line_id=l.id and pl.organization_id=o.organization_id and p.voided_at is null;
 if p_quantity is null or p_quantity='NaN'::numeric or p_quantity<=0 or p_quantity<>round(p_quantity,3) or l.picked_quantity is null or v_total+p_quantity>l.picked_quantity then
 raise exception 'Quantity must be positive, at most three decimals, and cannot exceed the unpacked picked quantity' using errcode='22023'; end if;
 insert into public.package_lines(organization_id,fulfilment_order_id,branch_id,package_id,pick_line_id,quantity)
 values(o.organization_id,o.id,o.branch_id,pk.id,l.id,p_quantity);
end $$;

create function public.void_package(p_id uuid,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders; pk public.packages;
begin
 select * into pk from public.packages where id=p_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Package not found' using errcode='P0002'; end if;
 o := private.load_fulfilment_order(pk.fulfilment_order_id,'packing.work');
 if o.status <> 'PACKING' then raise exception 'Only unsealed packages can be voided' using errcode='22023'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Give a reason (3 to 500 characters)' using errcode='22023'; end if;
 if exists(select 1 from public.package_lines l join public.packing_verifications v on v.pick_line_id=l.pick_line_id and v.organization_id=l.organization_id where l.package_id=p_id and l.organization_id=o.organization_id) then
 raise exception 'Verified contents cannot change' using errcode='22023'; end if;
 update public.packages set voided_at=now(),void_reason=btrim(p_reason) where id=p_id and organization_id=o.organization_id and voided_at is null;
 if not found then raise exception 'Package already voided' using errcode='22023'; end if;
end $$;

create function public.verify_packed_line(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders; l public.pick_lines; v_total numeric;
begin
 select * into l from public.pick_lines where id=p_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Pick line not found' using errcode='P0002'; end if;
 o := private.load_fulfilment_order(l.fulfilment_order_id,'packing.verify');
 if o.status <> 'PACKING' then raise exception 'Order must be packing' using errcode='22023'; end if;
 if l.picked_by=auth.uid() or exists(select 1 from public.package_lines pl join public.packages pk on pk.id=pl.package_id and pk.organization_id=pl.organization_id
 where pl.pick_line_id=l.id and pl.organization_id=o.organization_id and pk.voided_at is null and pl.packed_by=auth.uid()) then
 raise exception 'A different person must verify picked and packed goods' using errcode='42501'; end if;
 select coalesce(sum(pl.quantity),0) into v_total from public.package_lines pl join public.packages pk on pk.id=pl.package_id and pk.organization_id=pl.organization_id
 where pl.pick_line_id=l.id and pl.organization_id=o.organization_id and pk.voided_at is null;
 if l.picked_quantity is null or l.picked_quantity<=0 or v_total<>l.picked_quantity then raise exception 'Pack the full picked quantity before verification' using errcode='22023'; end if;
 insert into public.packing_verifications(organization_id,fulfilment_order_id,branch_id,pick_line_id) values(o.organization_id,o.id,o.branch_id,l.id);
end $$;

create function public.finish_packing(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders := private.load_fulfilment_order(p_id,'packing.work');
begin
 if o.status <> 'PACKING' then raise exception 'Order must be packing' using errcode='22023'; end if;
 if not exists(select 1 from public.packages where fulfilment_order_id=o.id and organization_id=o.organization_id and voided_at is null)
 or exists(select 1 from public.packages p where p.fulfilment_order_id=o.id and p.organization_id=o.organization_id and p.voided_at is null and not exists(select 1 from public.package_lines pl where pl.package_id=p.id and pl.organization_id=p.organization_id)) then
 raise exception 'Add contents to every package; void empty packages' using errcode='22023'; end if;
 if exists(select 1 from public.pick_lines l where l.fulfilment_order_id=o.id and l.organization_id=o.organization_id and (l.picked_quantity is null or l.picked_quantity <>
 (select coalesce(sum(pl.quantity),0) from public.package_lines pl join public.packages p on p.id=pl.package_id and p.organization_id=pl.organization_id where pl.pick_line_id=l.id and pl.organization_id=o.organization_id and p.voided_at is null))) then
 raise exception 'Every picked quantity must be packed exactly' using errcode='22023'; end if;
 if exists(select 1 from public.fulfilment_exceptions where fulfilment_order_id=o.id and organization_id=o.organization_id and status='OPEN') then raise exception 'Resolve short picks first' using errcode='22023'; end if;
 if exists(select 1 from public.pick_lines l join public.products p on p.id=l.product_id and p.organization_id=l.organization_id
 where l.fulfilment_order_id=o.id and l.organization_id=o.organization_id and p.is_controlled and l.picked_quantity>0
 and not exists(select 1 from public.packing_verifications v where v.pick_line_id=l.id and v.organization_id=o.organization_id)) then
 raise exception 'Controlled medicines require independent verification' using errcode='22023'; end if;
 update public.fulfilment_orders set status='PACKED',packed_at=now() where id=o.id and organization_id=o.organization_id;
end $$;

-- A single read model; reads never lock or expose another organization/branch.
create function public.packing_detail(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare o public.fulfilment_orders;
begin
 select * into o from public.fulfilment_orders where id=p_id and organization_id=private.current_organization_id();
 if not found or not private.has_permission('fulfilment.view',o.branch_id) then raise exception 'Order not found' using errcode='P0002'; end if;
 return jsonb_build_object('packages',coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at,p.id) from public.packages p where p.fulfilment_order_id=o.id and p.organization_id=o.organization_id),'[]'::jsonb),
 'contents',coalesce((select jsonb_agg(to_jsonb(l)) from public.package_lines l where l.fulfilment_order_id=o.id and l.organization_id=o.organization_id),'[]'::jsonb),
 'lines',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'product_name',p.brand_name,'controlled',p.is_controlled,'verified',exists(select 1 from public.packing_verifications v where v.pick_line_id=l.id and v.organization_id=o.organization_id))) from public.pick_lines l join public.products p on p.id=l.product_id and p.organization_id=l.organization_id where l.fulfilment_order_id=o.id and l.organization_id=o.organization_id),'[]'::jsonb));
end $$;

-- Preparing delivery for a fulfilment order derives package count from sealed packages.
-- Locks invoice before order to match invoice reversal's lock order.
create function public.prepare_packed_delivery(p_id uuid,p_address text,p_contact_name text,p_contact_phone text,p_notes text) returns uuid language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders; v_id uuid; v_count integer; v_invoice uuid;
begin
 select sales_invoice_id into v_invoice from public.fulfilment_orders where id=p_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Order not found' using errcode='P0002'; end if;
 perform 1 from public.sales_invoices where id=v_invoice and organization_id=private.current_organization_id() for update;
 o := private.load_fulfilment_order(p_id,'deliveries.create');
 if o.status not in ('PACKED','READY') then raise exception 'Seal packing before preparing delivery' using errcode='22023'; end if;
 select count(*) into v_count from public.packages where fulfilment_order_id=o.id and organization_id=o.organization_id and voided_at is null;
 v_id := public.prepare_delivery_note(o.sales_invoice_id,p_address,p_contact_name,p_contact_phone,v_count,p_notes);
 update public.fulfilment_orders set status='READY' where id=o.id and organization_id=o.organization_id;
 return v_id;
end $$;

-- Enforce packing even when someone calls the older delivery RPC directly.
create function private.guard_packed_dispatch() returns trigger language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders; v_count integer;
begin
 select * into o from public.fulfilment_orders where sales_invoice_id=new.sales_invoice_id and organization_id=new.organization_id and status<>'CANCELLED' for update;
 if found then
   if o.status not in ('PACKED','READY') then raise exception 'Finish packing before dispatch' using errcode='22023'; end if;
   select count(*) into v_count from public.packages where fulfilment_order_id=o.id and organization_id=o.organization_id and voided_at is null;
   new.packages := v_count;
   update public.fulfilment_orders set status='READY' where id=o.id and organization_id=o.organization_id;
 end if;
 return new;
end $$;
create trigger delivery_notes_packing_guard before update of status on public.delivery_notes for each row when(new.status='DISPATCHED' and old.status='PREPARED') execute function private.guard_packed_dispatch();

-- Invoice -> delivery -> fulfilment is also the reversal lock order. Re-read all
-- state after locking, so reversal and dispatch cannot both succeed.
create or replace function public.dispatch_delivery_note(p_id uuid,p_driver_name text,p_vehicle_number text)
returns void language plpgsql security definer set search_path='' as $$
declare d public.delivery_notes; v_invoice uuid; v_status text;
begin
 select sales_invoice_id into v_invoice from public.delivery_notes where id=p_id and organization_id=private.current_organization_id();
 if not found then raise exception 'delivery note not found' using errcode='P0002'; end if;
 select status into v_status from public.sales_invoices where id=v_invoice and organization_id=private.current_organization_id() for update;
 d := private.load_delivery_note(p_id,'deliveries.dispatch');
 if d.status<>'PREPARED' then raise exception 'only a prepared delivery note can be dispatched (this one is %)',d.status using errcode='22023'; end if;
 if v_status<>'POSTED' then raise exception 'the invoice is %: the goods cannot be dispatched',lower(v_status) using errcode='22023'; end if;
 if p_driver_name is null or btrim(p_driver_name)='' or length(p_driver_name)>120 or length(coalesce(p_vehicle_number,''))>40 then
 raise exception 'enter the driver (and the vehicle number, up to 40 characters)' using errcode='22023'; end if;
 update public.delivery_notes set status='DISPATCHED',driver_name=btrim(p_driver_name),vehicle_number=nullif(btrim(p_vehicle_number),''),dispatched_by=auth.uid(),dispatched_at=now()
 where id=d.id and organization_id=d.organization_id;
end $$;

create function public.packed_dispatch_queue() returns setof public.fulfilment_orders
language sql stable security definer set search_path='' as $$
 select o.* from public.fulfilment_orders o
 where o.organization_id=private.current_organization_id() and private.has_permission('fulfilment.view',o.branch_id)
 and o.status in ('PACKED','READY') and not exists(
 select 1 from public.delivery_notes d where d.sales_invoice_id=o.sales_invoice_id and d.organization_id=o.organization_id and d.status in ('DISPATCHED','DELIVERED'))
 order by o.priority,o.required_by nulls last,o.released_at
$$;
revoke all on function public.packed_dispatch_queue() from public,anon;
grant execute on function public.packed_dispatch_queue() to authenticated;

revoke all on function private.guard_packed_dispatch() from public,anon,authenticated;
revoke all on function public.start_packing(uuid),public.create_package(uuid,text,boolean,boolean),public.pack_line(uuid,uuid,numeric),public.void_package(uuid,text),public.verify_packed_line(uuid),public.finish_packing(uuid),public.packing_detail(uuid),public.prepare_packed_delivery(uuid,text,text,text,text) from public,anon;
grant execute on function public.start_packing(uuid),public.create_package(uuid,text,boolean,boolean),public.pack_line(uuid,uuid,numeric),public.void_package(uuid,text),public.verify_packed_line(uuid),public.finish_packing(uuid),public.packing_detail(uuid),public.prepare_packed_delivery(uuid,text,text,text,text) to authenticated;
