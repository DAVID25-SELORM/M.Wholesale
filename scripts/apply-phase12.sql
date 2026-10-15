-- Apply Phase 12 to the hosted database in ONE atomic paste: the Phase 12 migrations, verbatim, inside a single transaction.
-- Run it once in the Supabase SQL editor. If anything fails, nothing is changed.
begin;

-- ===== migration 20261021000100_phase12_permissions =====
-- Phase 12 / 01: permissions for deliveries, stock insight reports and the VAT report
--
--   deliveries.view      see delivery notes and pick lists
--   deliveries.create    prepare a delivery note for a posted invoice (this produces the pick list) and cancel it before dispatch
--   deliveries.dispatch  hand the goods to a driver, record proof of delivery, record a failed delivery
--   reports.stock        stock insight reports: reorder suggestions, slow-moving stock, stock likely to expire unsold
--   reports.tax          the VAT summary (output VAT on sales less input VAT on supplier invoices)

insert into public.permissions (code, module, action, description) values
  ('deliveries.view',     'deliveries', 'view',     'View delivery notes and pick lists'),
  ('deliveries.create',   'deliveries', 'create',   'Prepare and cancel delivery notes'),
  ('deliveries.dispatch', 'deliveries', 'dispatch', 'Dispatch goods and record delivery'),
  ('reports.stock',       'reports',    'stock',    'View stock insight reports'),
  ('reports.tax',         'reports',    'tax',      'View the VAT summary')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, code) as (values
  ('SUPER_ADMIN','deliveries.view'),('SUPER_ADMIN','deliveries.create'),('SUPER_ADMIN','deliveries.dispatch'),('SUPER_ADMIN','reports.stock'),('SUPER_ADMIN','reports.tax'),
  ('OWNER','deliveries.view'),('OWNER','deliveries.create'),('OWNER','deliveries.dispatch'),('OWNER','reports.stock'),('OWNER','reports.tax'),
  ('GENERAL_MANAGER','deliveries.view'),('GENERAL_MANAGER','deliveries.create'),('GENERAL_MANAGER','deliveries.dispatch'),('GENERAL_MANAGER','reports.stock'),('GENERAL_MANAGER','reports.tax'),
  ('SALES_MANAGER','deliveries.view'),('SALES_MANAGER','deliveries.create'),('SALES_MANAGER','reports.stock'),
  ('BRANCH_MANAGER','deliveries.view'),('BRANCH_MANAGER','deliveries.create'),('BRANCH_MANAGER','deliveries.dispatch'),('BRANCH_MANAGER','reports.stock'),
  ('SALES_REP','deliveries.view'),
  ('CASHIER','deliveries.view'),
  ('WAREHOUSE_MANAGER','deliveries.view'),('WAREHOUSE_MANAGER','deliveries.create'),('WAREHOUSE_MANAGER','deliveries.dispatch'),('WAREHOUSE_MANAGER','reports.stock'),
  ('WAREHOUSE_PICKER','deliveries.view'),('WAREHOUSE_PICKER','deliveries.create'),
  ('WAREHOUSE_PACKER','deliveries.view'),('WAREHOUSE_PACKER','deliveries.create'),
  ('DISPATCHER','deliveries.view'),('DISPATCHER','deliveries.dispatch'),
  ('PROCUREMENT_MANAGER','reports.stock'),('PROCUREMENT_OFFICER','reports.stock'),
  ('ACCOUNTS_MANAGER','deliveries.view'),('ACCOUNTS_MANAGER','reports.tax'),
  ('ACCOUNTS_OFFICER','reports.tax'),
  ('AUDITOR','deliveries.view'),('AUDITOR','reports.stock'),('AUDITOR','reports.tax'),
  ('READ_ONLY','deliveries.view'),('READ_ONLY','reports.stock')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;

-- ===== migration 20261021000200_deliveries_insights_vat =====
-- Phase 12 / 02: delivery notes and picking, stock insight reports, VAT summary
--
-- DELIVERY NOTE  Stock leaves the warehouse when an invoice is POSTED. A delivery note is the physical side: it is prepared for a posted invoice, which
--                produces the PICK LIST (where in the warehouse to find each batch: location, batch, expiry, quantity - taken from the batches the invoice
--                actually picked), then DISPATCHED with a driver and vehicle, and finally DELIVERED with the name of the person who received it, or recorded
--                as a FAILED delivery. One live delivery note per invoice (a failed or cancelled one can be replaced). Reversing an invoice cancels a
--                prepared note and is refused once the goods have left (take them back with a credit note instead).
-- STOCK INSIGHTS reorder suggestions (what is selling, how long stock lasts, what is already on order, how much to buy), slow-moving stock (stock that has
--                not sold for a long time, with its value) and stock likely to expire unsold (batch by batch, assuming earliest-expiry-first selling).
-- VAT SUMMARY    output VAT on posted invoices net of credit notes, per tax code, and input VAT on approved/paid supplier invoices, for a period.
--                This is a working summary for the VAT return, not a connection to the tax authority.

-- ---------------------------------------------------------------------------------------------------------
-- delivery notes
-- ---------------------------------------------------------------------------------------------------------
create table public.delivery_notes (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete restrict default private.current_organization_id(),
  note_number       text not null,
  sales_invoice_id  uuid not null,
  customer_id       uuid not null,
  branch_id         uuid not null,
  warehouse_id      uuid not null,
  status            text not null default 'PREPARED' check (status in ('PREPARED', 'DISPATCHED', 'DELIVERED', 'FAILED', 'CANCELLED')),
  delivery_address  text check (delivery_address is null or length(delivery_address) <= 300),
  contact_name      text check (contact_name is null or length(contact_name) <= 120),
  contact_phone     text check (contact_phone is null or length(contact_phone) <= 40),
  packages          integer not null default 1 check (packages between 0 and 10000),
  notes             text check (notes is null or length(notes) <= 500),
  driver_name       text check (driver_name is null or length(driver_name) <= 120),
  vehicle_number    text check (vehicle_number is null or length(vehicle_number) <= 40),
  prepared_by       uuid default auth.uid(),
  prepared_at       timestamptz not null default now(),
  dispatched_by     uuid,
  dispatched_at     timestamptz,
  delivered_at      timestamptz,
  received_by_name  text check (received_by_name is null or length(received_by_name) <= 120),
  status_reason     text check (status_reason is null or length(status_reason) <= 500),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint delivery_notes_invoice_fk foreign key (sales_invoice_id, organization_id) references public.sales_invoices (id, organization_id) on delete restrict,
  constraint delivery_notes_customer_fk foreign key (customer_id, organization_id) references public.customers (id, organization_id) on delete restrict,
  constraint delivery_notes_branch_fk foreign key (branch_id, organization_id) references public.branches (id, organization_id) on delete restrict,
  constraint delivery_notes_warehouse_fk foreign key (warehouse_id, organization_id) references public.warehouses (id, organization_id) on delete restrict,
  constraint delivery_notes_number_key unique (organization_id, note_number),
  constraint delivery_notes_id_org_key unique (id, organization_id),
  constraint delivery_notes_dispatched_complete check ((status in ('DISPATCHED', 'DELIVERED', 'FAILED')) = (dispatched_at is not null and driver_name is not null) or status in ('PREPARED', 'CANCELLED')),
  constraint delivery_notes_delivered_complete check ((status = 'DELIVERED') = (delivered_at is not null and received_by_name is not null))
);
create unique index delivery_notes_one_live_key on public.delivery_notes (sales_invoice_id) where status in ('PREPARED', 'DISPATCHED', 'DELIVERED');
create index delivery_notes_org_created_idx on public.delivery_notes (organization_id, created_at desc, id desc);
create index delivery_notes_branch_status_idx on public.delivery_notes (organization_id, branch_id, status, prepared_at desc);
create index delivery_notes_customer_idx on public.delivery_notes (customer_id, prepared_at desc);
create index delivery_notes_warehouse_idx on public.delivery_notes (warehouse_id);
create trigger delivery_notes_immutable before update on public.delivery_notes
  for each row execute function private.prevent_column_change('organization_id', 'note_number', 'sales_invoice_id', 'customer_id', 'branch_id', 'warehouse_id', 'prepared_by', 'prepared_at');
create trigger delivery_notes_set_updated_at before update on public.delivery_notes
  for each row execute function private.set_updated_at();
create trigger delivery_notes_audit after insert or update on public.delivery_notes
  for each row execute function private.audit_row_change('delivery_note');
create trigger delivery_notes_no_delete before delete on public.delivery_notes
  for each row execute function private.stock_block_mutation();

create function private.delivery_notes_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('DELIVERED', 'FAILED', 'CANCELLED') then
    raise exception 'a % delivery note cannot be changed', lower(old.status) using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger delivery_notes_lock before update on public.delivery_notes
  for each row execute function private.delivery_notes_lock();

alter table public.delivery_notes enable row level security;
revoke all on public.delivery_notes from public, anon, authenticated;
grant select on public.delivery_notes to authenticated;
create policy delivery_notes_select on public.delivery_notes for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('deliveries.view', branch_id));

-- prepares the delivery note (and with it the pick list) for a posted invoice
create function public.prepare_delivery_note(
  p_invoice_id uuid, p_address text, p_contact_name text, p_contact_phone text, p_packages integer, p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_inv public.sales_invoices;
  v_id  uuid;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_inv from public.sales_invoices i where i.id = p_invoice_id and i.organization_id = v_org for update;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('deliveries.create', v_inv.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_inv.status <> 'POSTED' then
    raise exception 'only a posted invoice can be delivered (this one is %)', v_inv.status using errcode = '22023';
  end if;
  if exists (select 1 from public.delivery_notes d where d.sales_invoice_id = v_inv.id and d.status in ('PREPARED', 'DISPATCHED', 'DELIVERED')) then
    raise exception 'this invoice already has a delivery note' using errcode = '22023';
  end if;
  if p_packages is null or p_packages < 0 or p_packages > 10000 then
    raise exception 'the number of packages must be between 0 and 10000' using errcode = '22023';
  end if;
  if length(coalesce(p_address, '')) > 300 or length(coalesce(p_contact_name, '')) > 120 or length(coalesce(p_contact_phone, '')) > 40 or length(coalesce(p_notes, '')) > 500 then
    raise exception 'a delivery detail is too long' using errcode = '22023';
  end if;
  insert into public.delivery_notes (organization_id, note_number, sales_invoice_id, customer_id, branch_id, warehouse_id, delivery_address, contact_name, contact_phone, packages, notes)
  values (v_org, private.generate_document_number(v_org, null, 'DELIVERY_NOTE', 'DN'), v_inv.id, v_inv.customer_id, v_inv.branch_id, v_inv.warehouse_id,
          nullif(btrim(p_address), ''), nullif(btrim(p_contact_name), ''), nullif(btrim(p_contact_phone), ''), p_packages, nullif(btrim(p_notes), ''))
  returning id into v_id;
  return v_id;
end;
$$;

create function private.load_delivery_note(p_id uuid, p_permission text)
returns public.delivery_notes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_d   public.delivery_notes;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_d from public.delivery_notes d where d.id = p_id and d.organization_id = v_org for update;
  if not found then
    raise exception 'delivery note not found' using errcode = 'P0002';
  end if;
  if not private.has_permission(p_permission, v_d.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  return v_d;
end;
$$;

create function public.dispatch_delivery_note(p_id uuid, p_driver_name text, p_vehicle_number text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d   public.delivery_notes;
  v_inv text;
begin
  v_d := private.load_delivery_note(p_id, 'deliveries.dispatch');
  if v_d.status <> 'PREPARED' then
    raise exception 'only a prepared delivery note can be dispatched (this one is %)', v_d.status using errcode = '22023';
  end if;
  if p_driver_name is null or btrim(p_driver_name) = '' or length(p_driver_name) > 120 or length(coalesce(p_vehicle_number, '')) > 40 then
    raise exception 'enter the driver (and the vehicle number, up to 40 characters)' using errcode = '22023';
  end if;
  select i.status into v_inv from public.sales_invoices i where i.id = v_d.sales_invoice_id;
  if v_inv <> 'POSTED' then
    raise exception 'the invoice is %: the goods cannot be dispatched', lower(v_inv) using errcode = '22023';
  end if;
  update public.delivery_notes
     set status = 'DISPATCHED', driver_name = btrim(p_driver_name), vehicle_number = nullif(btrim(p_vehicle_number), ''), dispatched_by = auth.uid(), dispatched_at = now()
   where id = v_d.id;
end;
$$;

create function public.confirm_delivery(p_id uuid, p_received_by_name text, p_notes text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d public.delivery_notes;
begin
  v_d := private.load_delivery_note(p_id, 'deliveries.dispatch');
  if v_d.status <> 'DISPATCHED' then
    raise exception 'only a dispatched delivery can be confirmed (this one is %)', v_d.status using errcode = '22023';
  end if;
  if p_received_by_name is null or btrim(p_received_by_name) = '' or length(p_received_by_name) > 120 then
    raise exception 'enter the name of the person who received the goods' using errcode = '22023';
  end if;
  if p_notes is not null and length(p_notes) > 500 then
    raise exception 'notes are limited to 500 characters' using errcode = '22023';
  end if;
  update public.delivery_notes
     set status = 'DELIVERED', delivered_at = now(), received_by_name = btrim(p_received_by_name), status_reason = nullif(btrim(p_notes), '')
   where id = v_d.id;
end;
$$;

create function private.end_delivery_note(p_id uuid, p_reason text, p_new_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d public.delivery_notes;
begin
  v_d := private.load_delivery_note(p_id, case p_new_status when 'FAILED' then 'deliveries.dispatch' else 'deliveries.create' end);
  if (p_new_status = 'FAILED' and v_d.status <> 'DISPATCHED') or (p_new_status = 'CANCELLED' and v_d.status <> 'PREPARED') then
    raise exception 'a % delivery note cannot be %', lower(v_d.status), case p_new_status when 'FAILED' then 'marked as failed' else 'cancelled' end using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.delivery_notes set status = p_new_status, status_reason = btrim(p_reason) where id = v_d.id;
end;
$$;
create function public.fail_delivery(p_id uuid, p_reason text) returns void language sql security definer set search_path = ''
  as $$ select private.end_delivery_note(p_id, p_reason, 'FAILED') $$;
create function public.cancel_delivery_note(p_id uuid, p_reason text) returns void language sql security definer set search_path = ''
  as $$ select private.end_delivery_note(p_id, p_reason, 'CANCELLED') $$;

-- the pick list: where to find each batch, in walking order (picking sequence of the location, then earliest expiry)
create function public.delivery_pick_list(p_id uuid)
returns table (
  line_no integer, sku text, product_name text, line_quantity numeric, line_unit text, base_quantity numeric, base_unit text,
  batch_number text, expiry_date date, location_code text, picking_sequence integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_d   public.delivery_notes;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_d from public.delivery_notes d where d.id = p_id and d.organization_id = v_org;
  if not found or not private.has_permission('deliveries.view', v_d.branch_id) then
    raise exception 'delivery note not found' using errcode = 'P0002';
  end if;
  return query
  select l.line_no, p.sku::text, p.brand_name::text, l.quantity, lu.name::text, a.base_quantity, bu.name::text, ba.batch_number::text, ba.expiry_date, loc.code::text, loc.picking_sequence
  from public.sales_invoice_allocations a
  join public.sales_invoice_lines l on l.id = a.sales_invoice_line_id
  join public.products p on p.id = a.product_id
  join public.product_units pu on pu.id = l.product_unit_id
  join public.units_of_measure lu on lu.id = pu.unit_id
  join public.units_of_measure bu on bu.id = p.base_unit_id
  left join public.batches ba on ba.id = a.batch_id
  left join public.warehouse_locations loc on loc.id = a.location_id
  where a.sales_invoice_id = v_d.sales_invoice_id and a.organization_id = v_org
  order by loc.picking_sequence nulls last, loc.code nulls last, ba.expiry_date nulls last, l.line_no;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- reverse_sales_invoice(): a prepared delivery note is cancelled with it; goods already dispatched must come back as a credit note
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.reverse_sales_invoice(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.current_organization_id();
  v_inv     public.sales_invoices;
  v_today   date;
  v_receipt_ids uuid[];
  v_alloc   record;
  v_base    uuid;
  v_status  text;
  v_loc     uuid;
  v_lines   jsonb := '[]'::jsonb;
  v_stock   jsonb;
  v_released numeric := 0;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_inv from public.sales_invoices i where i.id = p_id and i.organization_id = v_org;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('sales.reverse', v_inv.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  -- payments first, then the invoice: the same order every other function locks in
  select array_agg(distinct a.receipt_id order by a.receipt_id) into v_receipt_ids
  from public.receipt_allocations a where a.sales_invoice_id = v_inv.id and not a.is_voided;
  if v_receipt_ids is not null then
    perform 1 from public.customer_receipts r where r.id = any (v_receipt_ids) order by r.id for update;
  end if;
  select * into v_inv from public.sales_invoices i where i.id = p_id for update;
  if v_inv.status <> 'POSTED' then
    raise exception 'only a posted invoice can be reversed (this one is %)', v_inv.status using errcode = '22023';
  end if;
  if exists (select 1 from public.delivery_notes d where d.sales_invoice_id = v_inv.id and d.status in ('DISPATCHED', 'DELIVERED')) then
    raise exception 'the goods of this invoice have already left (a delivery note is dispatched or delivered): take them back with a credit note instead' using errcode = '22023';
  end if;
  update public.delivery_notes set status = 'CANCELLED', status_reason = 'The invoice was reversed' where sales_invoice_id = v_inv.id and status = 'PREPARED';
  if v_inv.amount_credited > 0 or exists (select 1 from public.sales_credit_notes n where n.sales_invoice_id = v_inv.id and n.status = 'POSTED') then
    raise exception 'this invoice has credit notes: reverse them first' using errcode = '22023';
  end if;
  select (now() at time zone o.timezone)::date into v_today from public.organizations o where o.id = v_org;

  -- 1. the goods go back where they came from
  for v_alloc in
    select a.*, ba.expiry_date from public.sales_invoice_allocations a
    left join public.batches ba on ba.id = a.batch_id
    where a.sales_invoice_id = v_inv.id order by a.id
  loop
    select u.id into v_base from public.product_units u where u.product_id = v_alloc.product_id and u.is_base;
    v_status := case when v_alloc.expiry_date is not null and v_alloc.expiry_date < v_today then 'EXPIRED' else 'AVAILABLE' end;
    v_loc := case when exists (select 1 from public.warehouse_locations wl where wl.id = v_alloc.location_id and wl.warehouse_id = v_inv.warehouse_id and wl.is_active)
                  then v_alloc.location_id end;
    v_lines := v_lines || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'product_id', v_alloc.product_id, 'batch_id', v_alloc.batch_id, 'location_id', v_loc, 'status', v_status,
      'quantity', v_alloc.base_quantity, 'product_unit_id', v_base)));
  end loop;
  v_stock := private.post_stock('SALE_REVERSAL', v_inv.warehouse_id, v_lines, null, null, 'Reversal of ' || v_inv.invoice_number, 'SALES_INVOICE', v_inv.id);

  -- 2. what the customer paid on it becomes their credit again
  for v_alloc in
    select a.id, a.receipt_id, a.amount from public.receipt_allocations a where a.sales_invoice_id = v_inv.id and not a.is_voided order by a.receipt_id, a.id
  loop
    update public.customer_receipts set allocated_amount = allocated_amount - v_alloc.amount where id = v_alloc.receipt_id;
    update public.receipt_allocations set is_voided = true where id = v_alloc.id;
    v_released := v_released + v_alloc.amount;
  end loop;

  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.sales_invoices
     set amount_paid = 0, status = 'REVERSED', reversed_at = now(), reversed_by = auth.uid(), reversal_reason = btrim(p_reason),
         reversal_document_id = (v_stock ->> 'document_id')::uuid
   where id = v_inv.id;
  if v_inv.sales_order_id is not null then
    perform private.refresh_order_status(v_inv.sales_order_id);
  end if;
  return jsonb_build_object('invoice_number', v_inv.invoice_number, 'stock_document_number', v_stock ->> 'document_number', 'credit_released', v_released);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- stock insights
-- ---------------------------------------------------------------------------------------------------------
-- p_history_days: how far back sales are averaged. p_cover_days: how many days of sales a purchase should cover once it arrives.
create function public.reorder_suggestions(p_warehouse_id uuid default null, p_history_days integer default 90, p_cover_days integer default 30)
returns table (
  product_id uuid, sku text, product_name text, base_unit text, on_hand numeric, reserved numeric, free numeric, on_order numeric,
  avg_daily numeric, days_cover numeric, lead_time_days integer, target_stock numeric, suggested_qty numeric, supplier_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_today date := current_date;
begin
  if v_org is null or not private.has_permission_anywhere('reports.stock') then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if p_history_days is null or p_history_days not between 7 and 730 or p_cover_days is null or p_cover_days not between 1 and 365 then
    raise exception 'history must be 7-730 days and cover 1-365 days' using errcode = '22023';
  end if;
  return query
  with wh as (
    select w.id from public.warehouses w
    where w.organization_id = v_org and (p_warehouse_id is null or w.id = p_warehouse_id) and private.has_permission('reports.stock', w.branch_id)
  ),
  stock as (
    select sb.product_id, sb.warehouse_id, sum(sb.quantity) as q
    from public.stock_balances sb join wh on wh.id = sb.warehouse_id left join public.batches ba on ba.id = sb.batch_id
    where sb.organization_id = v_org and sb.stock_status = 'AVAILABLE' and (ba.id is null or ba.expiry_date >= v_today)
    group by sb.product_id, sb.warehouse_id
  ),
  sold as (
    select l.product_id, sum(l.base_quantity) as q
    from public.sales_invoice_lines l join public.sales_invoices i on i.id = l.sales_invoice_id join wh on wh.id = i.warehouse_id
    where i.organization_id = v_org and i.status = 'POSTED' and i.invoice_date > v_today - p_history_days
    group by l.product_id
  ),
  back as (
    select cl.product_id, sum(coalesce(cl.base_quantity, 0)) as q
    from public.sales_credit_note_lines cl join public.sales_credit_notes n on n.id = cl.credit_note_id and n.status = 'POSTED' join wh on wh.id = n.warehouse_id
    where n.organization_id = v_org and n.credit_date > v_today - p_history_days
    group by cl.product_id
  ),
  ordered as (
    select pl.product_id, sum(greatest(0, pl.ordered_base - pl.received_base)) as q
    from public.purchase_order_lines pl join public.purchase_orders po on po.id = pl.purchase_order_id and po.status in ('APPROVED', 'PARTIALLY_RECEIVED') join wh on wh.id = po.warehouse_id
    where po.organization_id = v_org
    group by pl.product_id
  ),
  per_product as (
    select p.id, p.sku, p.brand_name, bu.name as base_unit,
           coalesce((select sum(s.q) from stock s where s.product_id = p.id), 0) as on_hand,
           coalesce((select sum(private.reserved_quantity(v_org, s.warehouse_id, p.id)) from stock s where s.product_id = p.id), 0) as reserved,
           coalesce(o.q, 0) as on_order,
           greatest(0, coalesce(so.q, 0) - coalesce(b.q, 0)) / p_history_days as daily,
           (select min(sp.lead_time_days) from public.supplier_products sp where sp.product_id = p.id and sp.is_active and sp.is_preferred) as lead,
           (select s2.name from public.supplier_products sp join public.suppliers s2 on s2.id = sp.supplier_id where sp.product_id = p.id and sp.is_active and sp.is_preferred order by sp.last_cost_at desc nulls last limit 1) as supplier
    from public.products p
    join public.units_of_measure bu on bu.id = p.base_unit_id
    left join sold so on so.product_id = p.id
    left join back b on b.product_id = p.id
    left join ordered o on o.product_id = p.id
    where p.organization_id = v_org and p.is_active and so.q is not null
  )
  select pp.id, pp.sku::text, pp.brand_name::text, pp.base_unit::text, pp.on_hand, pp.reserved, greatest(0, pp.on_hand - pp.reserved), pp.on_order,
         round(pp.daily, 3),
         case when pp.daily > 0 then round(greatest(0, pp.on_hand - pp.reserved) / pp.daily, 1) end,
         coalesce(pp.lead, 7),
         ceil(pp.daily * (p_cover_days + coalesce(pp.lead, 7))),
         greatest(0, ceil(pp.daily * (p_cover_days + coalesce(pp.lead, 7)) - (greatest(0, pp.on_hand - pp.reserved) + pp.on_order))),
         pp.supplier::text
  from per_product pp
  where pp.daily > 0
  order by case when pp.daily > 0 then greatest(0, pp.on_hand - pp.reserved) / pp.daily end nulls last, pp.sku;
end;
$$;

-- sellable stock that has not sold for p_days (or ever): what is tied up, and its value where the caller may see costs
create function public.slow_moving_stock(p_days integer default 180)
returns table (
  product_id uuid, sku text, product_name text, base_unit text, on_hand numeric, stock_value numeric, last_sale_date date, days_since_sale integer, earliest_expiry date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_today date := current_date;
begin
  if v_org is null or not private.has_permission_anywhere('reports.stock') then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if p_days is null or p_days not between 30 and 1460 then
    raise exception 'choose between 30 and 1460 days' using errcode = '22023';
  end if;
  return query
  with held as (
    select sb.product_id, sum(sb.quantity) as q, min(ba.expiry_date) as exp,
           case when bool_and(private.has_permission('inventory.valuation', w.branch_id)) then sum(sb.quantity * coalesce(bc.unit_cost_base, 0)) end as val
    from public.stock_balances sb
    join public.warehouses w on w.id = sb.warehouse_id
    left join public.batches ba on ba.id = sb.batch_id
    left join public.batch_costs bc on bc.batch_id = sb.batch_id
    where sb.organization_id = v_org and sb.stock_status = 'AVAILABLE' and sb.quantity > 0 and (ba.id is null or ba.expiry_date >= v_today)
      and private.has_permission('reports.stock', w.branch_id)
    group by sb.product_id
  ),
  last_sale as (
    select l.product_id, max(i.invoice_date) as d
    from public.sales_invoice_lines l join public.sales_invoices i on i.id = l.sales_invoice_id
    where i.organization_id = v_org and i.status = 'POSTED'
    group by l.product_id
  )
  select p.id, p.sku::text, p.brand_name::text, bu.name::text, h.q, h.val, ls.d, case when ls.d is null then null else v_today - ls.d end, h.exp
  from held h
  join public.products p on p.id = h.product_id
  join public.units_of_measure bu on bu.id = p.base_unit_id
  left join last_sale ls on ls.product_id = p.id
  where ls.d is null or ls.d < v_today - p_days
  order by h.val desc nulls last, p.sku;
end;
$$;

-- batches that will probably NOT be sold before they expire, assuming the product sells at its recent pace and earliest-expiry stock goes first
create function public.expiry_risk(p_horizon_days integer default 180, p_history_days integer default 90, p_warehouse_id uuid default null)
returns table (
  product_id uuid, sku text, product_name text, batch_number text, expiry_date date, days_left integer, quantity numeric, avg_daily numeric,
  expected_sales numeric, at_risk_qty numeric, value_at_risk numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_today date := current_date;
begin
  if v_org is null or not private.has_permission_anywhere('reports.stock') then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if p_horizon_days is null or p_horizon_days not between 7 and 1095 or p_history_days is null or p_history_days not between 7 and 730 then
    raise exception 'horizon must be 7-1095 days and history 7-730 days' using errcode = '22023';
  end if;
  return query
  with wh as (
    select w.id, w.branch_id from public.warehouses w
    where w.organization_id = v_org and (p_warehouse_id is null or w.id = p_warehouse_id) and private.has_permission('reports.stock', w.branch_id)
  ),
  batches_held as (
    select sb.product_id, sb.batch_id, ba.batch_number, ba.expiry_date, sum(sb.quantity) as q,
           case when bool_and(private.has_permission('inventory.valuation', wh.branch_id)) then sum(sb.quantity * coalesce(bc.unit_cost_base, 0)) end as val
    from public.stock_balances sb
    join wh on wh.id = sb.warehouse_id
    join public.batches ba on ba.id = sb.batch_id
    left join public.batch_costs bc on bc.batch_id = sb.batch_id
    where sb.organization_id = v_org and sb.stock_status = 'AVAILABLE' and sb.quantity > 0
      and ba.expiry_date >= v_today and ba.expiry_date <= v_today + p_horizon_days
    group by sb.product_id, sb.batch_id, ba.batch_number, ba.expiry_date
  ),
  pace as (
    select l.product_id, greatest(0, sum(l.base_quantity)) / p_history_days as daily
    from public.sales_invoice_lines l join public.sales_invoices i on i.id = l.sales_invoice_id join wh on wh.id = i.warehouse_id
    where i.organization_id = v_org and i.status = 'POSTED' and i.invoice_date > v_today - p_history_days
    group by l.product_id
  ),
  stacked as (
    select b.*, coalesce(pc.daily, 0) as daily, b.expiry_date - v_today as dl,
           coalesce(sum(b.q) over (partition by b.product_id order by b.expiry_date, b.batch_id rows between unbounded preceding and 1 preceding), 0) as before_q
    from batches_held b left join pace pc on pc.product_id = b.product_id
  )
  select p.id, p.sku::text, p.brand_name::text, s.batch_number::text, s.expiry_date, s.dl::integer, s.q, round(s.daily, 3),
         least(s.q, greatest(0, s.daily * s.dl - s.before_q)),
         greatest(0, s.q - greatest(0, s.daily * s.dl - s.before_q)),
         case when s.val is not null and s.q > 0 then round(s.val * greatest(0, s.q - greatest(0, s.daily * s.dl - s.before_q)) / s.q, 2) end
  from stacked s
  join public.products p on p.id = s.product_id
  where s.q - greatest(0, s.daily * s.dl - s.before_q) > 0
  order by s.expiry_date, p.sku;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- VAT summary
-- ---------------------------------------------------------------------------------------------------------
create function public.vat_report(p_from date, p_to date, p_branch_id uuid default null)
returns table (section text, tax_code text, tax_name text, rate numeric, taxable numeric, tax numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
begin
  if v_org is null or not private.has_permission_anywhere('reports.tax') then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3660 then
    raise exception 'choose a valid date range of at most ten years' using errcode = '22023';
  end if;
  return query
  with sales as (
    select l.tax_code_id, l.tax_rate, l.line_net as net, l.line_tax as tax
    from public.sales_invoices i join public.sales_invoice_lines l on l.sales_invoice_id = i.id
    where i.organization_id = v_org and i.status = 'POSTED' and i.invoice_date between p_from and p_to
      and (p_branch_id is null or i.branch_id = p_branch_id) and private.has_permission('reports.tax', i.branch_id)
    union all
    select il.tax_code_id, il.tax_rate, -cl.line_net, -cl.line_tax
    from public.sales_credit_notes n
    join public.sales_credit_note_lines cl on cl.credit_note_id = n.id
    join public.sales_invoice_lines il on il.id = cl.invoice_line_id
    join public.sales_invoices i on i.id = n.sales_invoice_id
    where n.organization_id = v_org and n.status = 'POSTED' and n.credit_date between p_from and p_to
      and (p_branch_id is null or i.branch_id = p_branch_id) and private.has_permission('reports.tax', i.branch_id)
  )
  select 'OUTPUT'::text, coalesce(t.code::text, 'NONE'), coalesce(t.name::text, 'No tax code'), s.tax_rate, sum(s.net), sum(s.tax)
  from sales s left join public.tax_codes t on t.id = s.tax_code_id
  group by t.code, t.name, s.tax_rate
  union all
  select 'INPUT'::text, 'SUPPLIER', 'Supplier invoices (approved or paid)', null::numeric, coalesce(sum(si.subtotal), 0), coalesce(sum(si.tax_amount), 0)
  from public.supplier_invoices si
  where si.organization_id = v_org and si.status in ('APPROVED', 'PAID') and si.invoice_date between p_from and p_to
    and (p_branch_id is null or si.branch_id = p_branch_id) and private.has_permission('reports.tax', si.branch_id)
  having count(*) > 0
  order by 1 desc, 2;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- function privileges
-- ---------------------------------------------------------------------------------------------------------
revoke all on function private.delivery_notes_lock() from public, anon, authenticated;
revoke all on function private.load_delivery_note(uuid, text) from public, anon, authenticated;
revoke all on function private.end_delivery_note(uuid, text, text) from public, anon, authenticated;

revoke all on function public.prepare_delivery_note(uuid, text, text, text, integer, text) from public, anon;
revoke all on function public.dispatch_delivery_note(uuid, text, text) from public, anon;
revoke all on function public.confirm_delivery(uuid, text, text) from public, anon;
revoke all on function public.fail_delivery(uuid, text) from public, anon;
revoke all on function public.cancel_delivery_note(uuid, text) from public, anon;
revoke all on function public.delivery_pick_list(uuid) from public, anon;
revoke all on function public.reorder_suggestions(uuid, integer, integer) from public, anon;
revoke all on function public.slow_moving_stock(integer) from public, anon;
revoke all on function public.expiry_risk(integer, integer, uuid) from public, anon;
revoke all on function public.vat_report(date, date, uuid) from public, anon;
grant execute on function public.prepare_delivery_note(uuid, text, text, text, integer, text) to authenticated;
grant execute on function public.dispatch_delivery_note(uuid, text, text) to authenticated;
grant execute on function public.confirm_delivery(uuid, text, text) to authenticated;
grant execute on function public.fail_delivery(uuid, text) to authenticated;
grant execute on function public.cancel_delivery_note(uuid, text) to authenticated;
grant execute on function public.delivery_pick_list(uuid) to authenticated;
grant execute on function public.reorder_suggestions(uuid, integer, integer) to authenticated;
grant execute on function public.slow_moving_stock(integer) to authenticated;
grant execute on function public.expiry_risk(integer, integer, uuid) to authenticated;
grant execute on function public.vat_report(date, date, uuid) to authenticated;

commit;
