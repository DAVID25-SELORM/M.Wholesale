-- Phase 17b: picking (fulfilment orders, pick lines, short-pick flags)
--
-- Second stage of Advanced Warehouse Operations (docs/phase17/WAREHOUSE_OPERATIONS_DESIGN.md). A POSTED wholesale invoice is released to the warehouse as a
-- FULFILMENT ORDER; its batch allocations become PICK LINES in walking order; a picker claims the order, confirms every line (in full, or short with a reason),
-- and the order becomes PICKED. Picking records the physical work only: the stock ledger was reduced when the invoice was posted, so nothing here creates a
-- stock movement, and no invoice, price or amount is ever touched.
--
-- Tenant rules as everywhere: organization_id on every row, composite foreign keys, row-level security by organization and branch, NO direct write grants (every
-- change goes through the functions below, which take the organization from the session and check the permission for the order's branch), audit on every change,
-- and no deletes. A short pick opens an exception that a supervisor must resolve before the order can be PICKED (stage 17e adds substitution and holding).

-- ---------------------------------------------------------------------------------------------------------
-- permissions
-- ---------------------------------------------------------------------------------------------------------
insert into public.permissions (code, module, action, description) values
  ('fulfilment.view',    'fulfilment', 'view',    'See the picking queue, fulfilment orders and pick lists'),
  ('fulfilment.release', 'fulfilment', 'release', 'Release a posted invoice to the warehouse for picking, and cancel an order that has not been packed'),
  ('picking.work',       'picking',    'work',    'Claim fulfilment orders and confirm pick lines'),
  ('picking.assign',     'picking',    'assign',  'Assign pickers, reset pick lines and resolve short picks')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, code) as (values
  ('SUPER_ADMIN','fulfilment.view'),('SUPER_ADMIN','fulfilment.release'),('SUPER_ADMIN','picking.work'),('SUPER_ADMIN','picking.assign'),
  ('OWNER','fulfilment.view'),('OWNER','fulfilment.release'),('OWNER','picking.work'),('OWNER','picking.assign'),
  ('GENERAL_MANAGER','fulfilment.view'),('GENERAL_MANAGER','fulfilment.release'),('GENERAL_MANAGER','picking.work'),('GENERAL_MANAGER','picking.assign'),
  ('BRANCH_MANAGER','fulfilment.view'),('BRANCH_MANAGER','fulfilment.release'),('BRANCH_MANAGER','picking.work'),('BRANCH_MANAGER','picking.assign'),
  ('WAREHOUSE_MANAGER','fulfilment.view'),('WAREHOUSE_MANAGER','fulfilment.release'),('WAREHOUSE_MANAGER','picking.work'),('WAREHOUSE_MANAGER','picking.assign'),
  ('WAREHOUSE_PICKER','fulfilment.view'),('WAREHOUSE_PICKER','picking.work'),
  ('WAREHOUSE_PACKER','fulfilment.view'),
  ('DISPATCHER','fulfilment.view'),('DISPATCHER','fulfilment.release'),
  ('AUDITOR','fulfilment.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;

-- the sales team that raises the invoices may also release them to the warehouse
insert into public.role_permissions (role_id, permission_id)
select r.id, rel.id
from public.roles r
cross join public.permissions rel
where r.organization_id is null and r.code in ('SALES_MANAGER', 'SALES_REP') and rel.code = 'fulfilment.release'
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------------
-- fulfilment orders
-- ---------------------------------------------------------------------------------------------------------
create table public.fulfilment_orders (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete restrict default private.current_organization_id(),
  order_number        text not null,
  sales_invoice_id    uuid not null,
  branch_id           uuid not null,
  warehouse_id        uuid not null,
  customer_id         uuid not null,
  status              text not null default 'RELEASED'
                        check (status in ('RELEASED', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'READY', 'CANCELLED')),
  priority            smallint not null default 2 check (priority between 1 and 3),   -- 1 urgent, 2 normal, 3 low
  required_by         date,
  picker_id           uuid,
  notes               text check (notes is null or length(notes) <= 500),
  released_by         uuid default auth.uid(),
  released_at         timestamptz not null default now(),
  picking_started_at  timestamptz,
  picked_at           timestamptz,
  cancelled_at        timestamptz,
  cancel_reason       text check (cancel_reason is null or length(cancel_reason) <= 500),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint fulfilment_orders_invoice_fk foreign key (sales_invoice_id, organization_id) references public.sales_invoices (id, organization_id) on delete restrict,
  constraint fulfilment_orders_branch_fk foreign key (branch_id, organization_id) references public.branches (id, organization_id) on delete restrict,
  constraint fulfilment_orders_warehouse_fk foreign key (warehouse_id, organization_id) references public.warehouses (id, organization_id) on delete restrict,
  constraint fulfilment_orders_customer_fk foreign key (customer_id, organization_id) references public.customers (id, organization_id) on delete restrict,
  constraint fulfilment_orders_picker_fk foreign key (picker_id, organization_id) references public.profiles (id, organization_id) on delete restrict,
  constraint fulfilment_orders_number_key unique (organization_id, order_number),
  constraint fulfilment_orders_id_org_key unique (id, organization_id),
  constraint fulfilment_orders_cancel_complete check ((status = 'CANCELLED') = (cancelled_at is not null and cancel_reason is not null))
);
-- one LIVE order per invoice: a cancelled one can be replaced by a new release
create unique index fulfilment_orders_live_invoice_key on public.fulfilment_orders (sales_invoice_id) where status <> 'CANCELLED';
create index fulfilment_orders_queue_idx on public.fulfilment_orders (organization_id, branch_id, status, priority, released_at);
create index fulfilment_orders_picker_idx on public.fulfilment_orders (picker_id) where picker_id is not null;

create trigger fulfilment_orders_immutable before update on public.fulfilment_orders
  for each row execute function private.prevent_column_change('organization_id', 'order_number', 'sales_invoice_id', 'branch_id', 'warehouse_id', 'customer_id', 'released_by', 'released_at', 'created_at');
create trigger fulfilment_orders_set_updated_at before update on public.fulfilment_orders
  for each row execute function private.set_updated_at();
create trigger fulfilment_orders_audit after insert or update on public.fulfilment_orders
  for each row execute function private.audit_row_change('fulfilment_order');
create trigger fulfilment_orders_no_delete before delete on public.fulfilment_orders
  for each row execute function private.stock_block_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- pick lines: one per invoice allocation (product, batch and location are copied at release and never change)
-- ---------------------------------------------------------------------------------------------------------
create table public.pick_lines (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete restrict default private.current_organization_id(),
  fulfilment_order_id  uuid not null,
  branch_id            uuid not null,
  allocation_id        uuid not null references public.sales_invoice_allocations (id) on delete restrict,
  line_no              integer not null,
  product_id           uuid not null,
  batch_id             uuid,
  location_id          uuid references public.warehouse_locations (id) on delete restrict,
  expected_quantity    numeric(18, 3) not null check (expected_quantity > 0),     -- base units
  picked_quantity      numeric(18, 3) check (picked_quantity is null or picked_quantity >= 0),
  status               text not null default 'PENDING' check (status in ('PENDING', 'PICKED', 'SHORT')),
  short_reason         text check (short_reason in ('NOT_FOUND', 'DAMAGED', 'EXPIRED', 'OTHER')),
  short_note           text check (short_note is null or length(short_note) <= 300),
  picked_by            uuid,
  picked_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint pick_lines_order_fk foreign key (fulfilment_order_id, organization_id) references public.fulfilment_orders (id, organization_id) on delete restrict,
  constraint pick_lines_branch_fk foreign key (branch_id, organization_id) references public.branches (id, organization_id) on delete restrict,
  constraint pick_lines_batch_fk foreign key (batch_id, product_id, organization_id) references public.batches (id, product_id, organization_id) on delete restrict,
  constraint pick_lines_picker_fk foreign key (picked_by, organization_id) references public.profiles (id, organization_id) on delete restrict,
  constraint pick_lines_allocation_key unique (fulfilment_order_id, allocation_id),
  constraint pick_lines_id_org_key unique (id, organization_id),
  -- the quantity can never exceed what was allocated, and a short line says why
  constraint pick_lines_quantity_cap check (picked_quantity is null or picked_quantity <= expected_quantity),
  constraint pick_lines_state check (
    (status = 'PENDING' and picked_quantity is null and picked_by is null and picked_at is null and short_reason is null)
    or (status = 'PICKED' and picked_quantity = expected_quantity and picked_by is not null and picked_at is not null and short_reason is null)
    or (status = 'SHORT' and picked_quantity < expected_quantity and picked_by is not null and picked_at is not null and short_reason is not null))
);
create index pick_lines_order_idx on public.pick_lines (fulfilment_order_id, line_no);
create index pick_lines_branch_idx on public.pick_lines (organization_id, branch_id);
create trigger pick_lines_immutable before update on public.pick_lines
  for each row execute function private.prevent_column_change('organization_id', 'fulfilment_order_id', 'branch_id', 'allocation_id', 'line_no', 'product_id', 'batch_id', 'location_id', 'expected_quantity', 'created_at');
create trigger pick_lines_set_updated_at before update on public.pick_lines
  for each row execute function private.set_updated_at();
create trigger pick_lines_audit after insert or update on public.pick_lines
  for each row execute function private.audit_row_change('pick_line');
create trigger pick_lines_no_delete before delete on public.pick_lines
  for each row execute function private.stock_block_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- fulfilment exceptions: a short pick waits here for a supervisor
-- ---------------------------------------------------------------------------------------------------------
create table public.fulfilment_exceptions (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete restrict default private.current_organization_id(),
  fulfilment_order_id  uuid not null,
  pick_line_id         uuid not null,
  branch_id            uuid not null,
  kind                 text not null default 'SHORT' check (kind in ('SHORT')),
  short_quantity       numeric(18, 3) not null check (short_quantity > 0),
  reason               text not null,
  status               text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED')),
  decision             text check (decision in ('ACCEPT_SHORT', 'WITHDRAWN')),   -- WITHDRAWN: the line was reset before anyone acted on the exception
  resolution_reason    text check (resolution_reason is null or length(resolution_reason) <= 500),
  raised_by            uuid default auth.uid(),
  raised_at            timestamptz not null default now(),
  resolved_by          uuid,
  resolved_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint fulfilment_exceptions_order_fk foreign key (fulfilment_order_id, organization_id) references public.fulfilment_orders (id, organization_id) on delete restrict,
  constraint fulfilment_exceptions_line_fk foreign key (pick_line_id, organization_id) references public.pick_lines (id, organization_id) on delete restrict,
  constraint fulfilment_exceptions_branch_fk foreign key (branch_id, organization_id) references public.branches (id, organization_id) on delete restrict,
  constraint fulfilment_exceptions_resolved check ((status = 'RESOLVED') = (decision is not null and resolution_reason is not null and resolved_by is not null and resolved_at is not null))
);
create unique index fulfilment_exceptions_open_line_key on public.fulfilment_exceptions (pick_line_id) where status = 'OPEN';
create index fulfilment_exceptions_order_idx on public.fulfilment_exceptions (fulfilment_order_id, status);
create trigger fulfilment_exceptions_immutable before update on public.fulfilment_exceptions
  for each row execute function private.prevent_column_change('organization_id', 'fulfilment_order_id', 'pick_line_id', 'branch_id', 'kind', 'short_quantity', 'reason', 'raised_by', 'raised_at', 'created_at');
create trigger fulfilment_exceptions_set_updated_at before update on public.fulfilment_exceptions
  for each row execute function private.set_updated_at();
create trigger fulfilment_exceptions_audit after insert or update on public.fulfilment_exceptions
  for each row execute function private.audit_row_change('fulfilment_exception');
create trigger fulfilment_exceptions_no_delete before delete on public.fulfilment_exceptions
  for each row execute function private.stock_block_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- row-level security: read by organization and branch; no write grants at all (every change is a function below)
-- ---------------------------------------------------------------------------------------------------------
alter table public.fulfilment_orders enable row level security;
alter table public.pick_lines enable row level security;
alter table public.fulfilment_exceptions enable row level security;
revoke all on public.fulfilment_orders, public.pick_lines, public.fulfilment_exceptions from public, anon, authenticated;
grant select on public.fulfilment_orders, public.pick_lines, public.fulfilment_exceptions to authenticated;

create policy fulfilment_orders_select on public.fulfilment_orders for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and ((select private.has_permission('fulfilment.view')) or branch_id in (select private.permitted_branches('fulfilment.view'))));
create policy pick_lines_select on public.pick_lines for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and ((select private.has_permission('fulfilment.view')) or branch_id in (select private.permitted_branches('fulfilment.view'))));
create policy fulfilment_exceptions_select on public.fulfilment_exceptions for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and ((select private.has_permission('fulfilment.view')) or branch_id in (select private.permitted_branches('fulfilment.view'))));

-- ---------------------------------------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------------------------------------
-- load and lock an order of the caller's organization; the caller must hold the permission for its branch
create function private.load_fulfilment_order(p_id uuid, p_permission text)
returns public.fulfilment_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_o   public.fulfilment_orders;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_o from public.fulfilment_orders o where o.id = p_id and o.organization_id = v_org for update;
  if not found or not private.has_permission('fulfilment.view', v_o.branch_id) then
    raise exception 'fulfilment order not found' using errcode = 'P0002';
  end if;
  if not private.has_permission(p_permission, v_o.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  return v_o;
end;
$$;

-- an order is PICKED once every line is confirmed and no short pick is waiting for a supervisor
create function private.settle_fulfilment_order(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o    public.fulfilment_orders;
  v_open integer;
begin
  select * into v_o from public.fulfilment_orders where id = p_id for update;
  if v_o.status not in ('PICKING', 'PICKED') then
    return v_o.status;
  end if;
  select count(*) into v_open from public.pick_lines l
  where l.fulfilment_order_id = p_id and (l.status = 'PENDING' or exists (select 1 from public.fulfilment_exceptions e where e.pick_line_id = l.id and e.status = 'OPEN'));
  if v_open = 0 and v_o.status = 'PICKING' then
    update public.fulfilment_orders set status = 'PICKED', picked_at = now() where id = p_id;
    return 'PICKED';
  elsif v_open > 0 and v_o.status = 'PICKED' then
    update public.fulfilment_orders set status = 'PICKING', picked_at = null where id = p_id;
    return 'PICKING';
  end if;
  return v_o.status;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- release_to_warehouse: a posted invoice becomes a fulfilment order with pick lines
-- ---------------------------------------------------------------------------------------------------------
create function public.release_to_warehouse(p_invoice_id uuid, p_priority smallint default 2, p_required_by date default null, p_notes text default null)
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
  if not private.has_permission('fulfilment.release', v_inv.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_inv.status <> 'POSTED' then
    raise exception 'only a posted invoice can be released to the warehouse (this one is %)', v_inv.status using errcode = '22023';
  end if;
  if exists (select 1 from public.fulfilment_orders o where o.sales_invoice_id = v_inv.id and o.status <> 'CANCELLED') then
    raise exception 'this invoice has already been released to the warehouse' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sales_invoice_allocations a where a.sales_invoice_id = v_inv.id and a.organization_id = v_org) then
    raise exception 'this invoice has no stock to pick' using errcode = '22023';
  end if;
  if p_priority is null or p_priority not between 1 and 3 then
    raise exception 'priority must be 1 (urgent), 2 (normal) or 3 (low)' using errcode = '22023';
  end if;
  if length(coalesce(p_notes, '')) > 500 then
    raise exception 'the note is too long' using errcode = '22023';
  end if;
  insert into public.fulfilment_orders (organization_id, order_number, sales_invoice_id, branch_id, warehouse_id, customer_id, priority, required_by, notes)
  values (v_org, private.generate_document_number(v_org, null, 'FULFILMENT_ORDER', 'FO'), v_inv.id, v_inv.branch_id, v_inv.warehouse_id, v_inv.customer_id,
          p_priority, p_required_by, nullif(btrim(p_notes), ''))
  returning id into v_id;
  -- pick lines in walking order, numbered 1..n
  insert into public.pick_lines (organization_id, fulfilment_order_id, branch_id, allocation_id, line_no, product_id, batch_id, location_id, expected_quantity)
  select v_org, v_id, v_inv.branch_id, s.id, row_number() over (order by s.picking_sequence nulls last, s.loc_code nulls last, s.expiry_date nulls last, s.id), s.product_id, s.batch_id, s.location_id, s.base_quantity
  from (
    select a.id, a.product_id, a.batch_id, a.location_id, a.base_quantity, loc.picking_sequence, loc.code as loc_code, ba.expiry_date
    from public.sales_invoice_allocations a
    left join public.warehouse_locations loc on loc.id = a.location_id
    left join public.batches ba on ba.id = a.batch_id
    where a.sales_invoice_id = v_inv.id and a.organization_id = v_org
  ) s;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- claim / give back / assign
-- ---------------------------------------------------------------------------------------------------------
create function public.claim_fulfilment_order(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o public.fulfilment_orders := private.load_fulfilment_order(p_id, 'picking.work');
begin
  if v_o.status not in ('RELEASED', 'PICKING') then
    raise exception 'this order is % and cannot be picked', v_o.status using errcode = '22023';
  end if;
  if v_o.picker_id is not null and v_o.picker_id <> auth.uid() then
    raise exception 'this order is already being picked by someone else' using errcode = '22023';
  end if;
  update public.fulfilment_orders set picker_id = auth.uid(), status = 'PICKING', picking_started_at = coalesce(picking_started_at, now()) where id = p_id;
end;
$$;

create function public.release_fulfilment_claim(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o public.fulfilment_orders := private.load_fulfilment_order(p_id, 'picking.work');
  v_started boolean;
begin
  if v_o.status not in ('RELEASED', 'PICKING') then
    raise exception 'this order is % and has no picker to release', v_o.status using errcode = '22023';
  end if;
  if v_o.picker_id is distinct from auth.uid() and not private.has_permission('picking.assign', v_o.branch_id) then
    raise exception 'only the picker or a supervisor can give this order back' using errcode = '42501';
  end if;
  select exists (select 1 from public.pick_lines l where l.fulfilment_order_id = p_id and l.status <> 'PENDING') into v_started;
  update public.fulfilment_orders set picker_id = null, status = case when v_started then 'PICKING' else 'RELEASED' end where id = p_id;
end;
$$;

create function public.assign_picker(p_id uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o public.fulfilment_orders := private.load_fulfilment_order(p_id, 'picking.assign');
begin
  if v_o.status not in ('RELEASED', 'PICKING') then
    raise exception 'this order is % and cannot be assigned', v_o.status using errcode = '22023';
  end if;
  if p_user is not null and not exists (
    select 1 from public.profiles pr
    join public.user_roles ur on ur.user_id = pr.id and ur.organization_id = pr.organization_id and (ur.branch_id is null or ur.branch_id = v_o.branch_id)
    join public.roles r on r.id = ur.role_id and r.is_active
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions pm on pm.id = rp.permission_id and pm.code = 'picking.work'
    where pr.id = p_user and pr.organization_id = v_o.organization_id and pr.is_active
  ) then
    raise exception 'that person cannot pick for this branch' using errcode = '22023';
  end if;
  update public.fulfilment_orders set picker_id = p_user,
    status = case when p_user is not null then 'PICKING' when exists (select 1 from public.pick_lines l where l.fulfilment_order_id = p_id and l.status <> 'PENDING') then 'PICKING' else 'RELEASED' end,
    picking_started_at = case when p_user is not null then coalesce(picking_started_at, now()) else picking_started_at end
  where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- confirm_pick_line: in full, or short with a reason (a short pick opens an exception for a supervisor)
-- ---------------------------------------------------------------------------------------------------------
create function public.confirm_pick_line(
  p_line_id uuid, p_quantity numeric, p_short_reason text default null, p_short_note text default null,
  p_scanned_batch text default null, p_scanned_barcode text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid := private.current_organization_id();
  v_l    public.pick_lines;
  v_o    public.fulfilment_orders;
  v_batch text;
  v_status text;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_l from public.pick_lines l where l.id = p_line_id and l.organization_id = v_org;
  if not found then
    raise exception 'pick line not found' using errcode = 'P0002';
  end if;
  v_o := private.load_fulfilment_order(v_l.fulfilment_order_id, 'picking.work');
  select * into v_l from public.pick_lines l where l.id = p_line_id for update;
  if v_o.status <> 'PICKING' then
    raise exception 'this order is % (claim it before picking)', v_o.status using errcode = '22023';
  end if;
  if v_o.picker_id is distinct from auth.uid() and not private.has_permission('picking.assign', v_o.branch_id) then
    raise exception 'this order is assigned to someone else' using errcode = '42501';
  end if;
  if v_l.status <> 'PENDING' then
    raise exception 'this line has already been confirmed' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity < 0 or p_quantity > v_l.expected_quantity then
    raise exception 'the quantity must be from 0 to %', v_l.expected_quantity using errcode = '22023';
  end if;
  if p_scanned_batch is not null and btrim(p_scanned_batch) <> '' then
    select ba.batch_number into v_batch from public.batches ba where ba.id = v_l.batch_id;
    if v_batch is null or upper(btrim(p_scanned_batch)) <> upper(v_batch) then
      raise exception 'wrong batch: this line is for batch %', coalesce(v_batch, '(none)') using errcode = '22023';
    end if;
  end if;
  if p_scanned_barcode is not null and btrim(p_scanned_barcode) <> '' then
    if not exists (select 1 from public.product_barcodes b where b.organization_id = v_org and b.product_id = v_l.product_id and b.is_active and b.barcode = btrim(p_scanned_barcode)) then
      raise exception 'the scanned barcode does not belong to this product' using errcode = '22023';
    end if;
  end if;
  if p_quantity = v_l.expected_quantity then
    update public.pick_lines set status = 'PICKED', picked_quantity = p_quantity, picked_by = auth.uid(), picked_at = now() where id = p_line_id;
  else
    if p_short_reason is null or p_short_reason not in ('NOT_FOUND', 'DAMAGED', 'EXPIRED', 'OTHER') then
      raise exception 'a short pick needs a reason (not found, damaged, expired or other)' using errcode = '22023';
    end if;
    if length(coalesce(p_short_note, '')) > 300 then
      raise exception 'the note is too long' using errcode = '22023';
    end if;
    if p_short_reason = 'OTHER' and length(btrim(coalesce(p_short_note, ''))) < 3 then
      raise exception 'explain the reason in the note' using errcode = '22023';
    end if;
    update public.pick_lines set status = 'SHORT', picked_quantity = p_quantity, short_reason = p_short_reason, short_note = nullif(btrim(p_short_note), ''),
      picked_by = auth.uid(), picked_at = now() where id = p_line_id;
    insert into public.fulfilment_exceptions (organization_id, fulfilment_order_id, pick_line_id, branch_id, kind, short_quantity, reason)
    values (v_org, v_o.id, v_l.id, v_o.branch_id, 'SHORT', v_l.expected_quantity - p_quantity, p_short_reason);
  end if;
  v_status := private.settle_fulfilment_order(v_o.id);
  return jsonb_build_object('order_status', v_status, 'pending', (select count(*) from public.pick_lines l where l.fulfilment_order_id = v_o.id and l.status = 'PENDING'));
end;
$$;

-- a supervisor puts a confirmed line back to pending (wrong confirmation); an open short exception on it is withdrawn by resolving it as such
create function public.reset_pick_line(p_line_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_l   public.pick_lines;
  v_o   public.fulfilment_orders;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_l from public.pick_lines l where l.id = p_line_id and l.organization_id = v_org;
  if not found then
    raise exception 'pick line not found' using errcode = 'P0002';
  end if;
  v_o := private.load_fulfilment_order(v_l.fulfilment_order_id, 'picking.assign');
  if v_o.status not in ('PICKING', 'PICKED') then
    raise exception 'this order is % and its lines can no longer be reset', v_o.status using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 or length(p_reason) > 500 then
    raise exception 'give a reason (3 to 500 characters)' using errcode = '22023';
  end if;
  select * into v_l from public.pick_lines l where l.id = p_line_id for update;
  if v_l.status = 'PENDING' then
    raise exception 'this line has not been confirmed' using errcode = '22023';
  end if;
  if exists (select 1 from public.fulfilment_exceptions e where e.pick_line_id = p_line_id and e.decision = 'ACCEPT_SHORT') then
    raise exception 'this short pick was already resolved and cannot be reset' using errcode = '22023';
  end if;
  -- the exception raised by the short confirmation is withdrawn with it: nobody had acted on it
  update public.fulfilment_exceptions set status = 'RESOLVED', decision = 'WITHDRAWN', resolution_reason = btrim(p_reason), resolved_by = auth.uid(), resolved_at = now() where pick_line_id = p_line_id and status = 'OPEN';
  update public.pick_lines set status = 'PENDING', picked_quantity = null, short_reason = null, short_note = null, picked_by = null, picked_at = null where id = p_line_id;
  perform private.write_audit(v_org, 'pick_line.reset', 'pick_line', p_line_id::text, v_o.branch_id, null, null, null, btrim(p_reason));
  perform private.settle_fulfilment_order(v_o.id);
end;
$$;

-- a supervisor accepts a short pick: the line stays short, the invoice is not touched (a credit note, if due, is raised in the usual way)
create function public.resolve_short_pick(p_exception_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_e   public.fulfilment_exceptions;
  v_o   public.fulfilment_orders;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_e from public.fulfilment_exceptions e where e.id = p_exception_id and e.organization_id = v_org;
  if not found then
    raise exception 'exception not found' using errcode = 'P0002';
  end if;
  v_o := private.load_fulfilment_order(v_e.fulfilment_order_id, 'picking.assign');
  if v_e.status <> 'OPEN' then
    raise exception 'this short pick has already been resolved' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 or length(p_reason) > 500 then
    raise exception 'give a reason (3 to 500 characters)' using errcode = '22023';
  end if;
  update public.fulfilment_exceptions set status = 'RESOLVED', decision = 'ACCEPT_SHORT', resolution_reason = btrim(p_reason), resolved_by = auth.uid(), resolved_at = now() where id = p_exception_id;
  return private.settle_fulfilment_order(v_o.id);
end;
$$;

-- an order that has not been packed can be cancelled (the invoice and the stock ledger are not affected); the invoice can be released again
create function public.cancel_fulfilment_order(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o public.fulfilment_orders := private.load_fulfilment_order(p_id, 'fulfilment.release');
begin
  if v_o.status not in ('RELEASED', 'PICKING', 'PICKED') then
    raise exception 'this order is % and can no longer be cancelled here', v_o.status using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 or length(p_reason) > 500 then
    raise exception 'give a reason (3 to 500 characters)' using errcode = '22023';
  end if;
  update public.fulfilment_orders set status = 'CANCELLED', cancelled_at = now(), cancel_reason = btrim(p_reason), picker_id = null where id = p_id;
end;
$$;

-- reversing an invoice cancels its live fulfilment order (a trigger, so the reversal function itself is not touched)
create function private.cancel_fulfilment_on_reversal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.fulfilment_orders set status = 'CANCELLED', cancelled_at = now(), cancel_reason = 'The invoice was reversed', picker_id = null
  where sales_invoice_id = new.id and organization_id = new.organization_id and status not in ('CANCELLED');
  return null;
end;
$$;
create trigger sales_invoices_cancel_fulfilment after update of status on public.sales_invoices
  for each row when (new.status = 'REVERSED' and old.status is distinct from 'REVERSED') execute function private.cancel_fulfilment_on_reversal();

-- ---------------------------------------------------------------------------------------------------------
-- reading: the queue, and one order's pick list
-- ---------------------------------------------------------------------------------------------------------
create function public.fulfilment_queue(p_status text default null, p_mine boolean default false)
returns table (
  id uuid, order_number text, status text, priority smallint, required_by date, released_at timestamptz, branch_id uuid, branch_name text, warehouse_name text,
  invoice_id uuid, invoice_number text, customer_name text, picker_id uuid, picker_name text, line_count integer, lines_done integer, open_exceptions integer)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.order_number, o.status, o.priority, o.required_by, o.released_at, o.branch_id, b.name::text, w.name::text,
         o.sales_invoice_id, i.invoice_number, c.name::text, o.picker_id, coalesce(pr.display_name, btrim(pr.first_name || ' ' || pr.last_name))::text,
         (select count(*)::integer from public.pick_lines l where l.fulfilment_order_id = o.id),
         (select count(*)::integer from public.pick_lines l where l.fulfilment_order_id = o.id and l.status <> 'PENDING'),
         (select count(*)::integer from public.fulfilment_exceptions e where e.fulfilment_order_id = o.id and e.status = 'OPEN')
  from public.fulfilment_orders o
  join public.branches b on b.id = o.branch_id
  join public.warehouses w on w.id = o.warehouse_id
  join public.sales_invoices i on i.id = o.sales_invoice_id
  join public.customers c on c.id = o.customer_id
  left join public.profiles pr on pr.id = o.picker_id
  where o.organization_id = private.current_organization_id()
    and (private.has_permission('fulfilment.view', o.branch_id))
    and (p_status is null or o.status = p_status)
    and (not coalesce(p_mine, false) or o.picker_id = auth.uid())
  order by o.priority, o.required_by nulls last, o.released_at
$$;

create function public.fulfilment_pick_list(p_id uuid)
returns table (
  line_id uuid, line_no integer, status text, sku text, product_name text, expected_quantity numeric, picked_quantity numeric, base_unit text, batch_number text,
  expiry_date date, location_code text, picking_sequence integer, short_reason text, short_note text, exception_id uuid, exception_status text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_org uuid := private.current_organization_id();
  v_o   public.fulfilment_orders;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_o from public.fulfilment_orders o where o.id = p_id and o.organization_id = v_org;
  if not found or not private.has_permission('fulfilment.view', v_o.branch_id) then
    raise exception 'fulfilment order not found' using errcode = 'P0002';
  end if;
  return query
  select l.id, l.line_no, l.status, p.sku::text, p.brand_name::text, l.expected_quantity, l.picked_quantity, bu.name::text, ba.batch_number::text, ba.expiry_date,
         loc.code::text, loc.picking_sequence, l.short_reason, l.short_note, e.id, e.status
  from public.pick_lines l
  join public.products p on p.id = l.product_id
  join public.units_of_measure bu on bu.id = p.base_unit_id
  left join public.batches ba on ba.id = l.batch_id
  left join public.warehouse_locations loc on loc.id = l.location_id
  left join lateral (select x.id, x.status from public.fulfilment_exceptions x where x.pick_line_id = l.id and x.decision is distinct from 'WITHDRAWN' order by x.raised_at desc limit 1) e on true
  where l.fulfilment_order_id = p_id and l.organization_id = v_org
  order by l.line_no;
end;
$$;

-- people who can be assigned as pickers for a branch (name only)
create function public.picker_options(p_branch_id uuid)
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct pr.id, coalesce(pr.display_name, btrim(pr.first_name || ' ' || pr.last_name))::text
  from public.profiles pr
  join public.user_roles ur on ur.user_id = pr.id and ur.organization_id = pr.organization_id and (ur.branch_id is null or ur.branch_id = p_branch_id)
  join public.roles r on r.id = ur.role_id and r.is_active
  join public.role_permissions rp on rp.role_id = r.id
  join public.permissions pm on pm.id = rp.permission_id and pm.code = 'picking.work'
  where pr.organization_id = private.current_organization_id() and pr.is_active and private.has_permission('picking.assign', p_branch_id)
    and exists (select 1 from public.branches br where br.id = p_branch_id and br.organization_id = pr.organization_id)
$$;

-- ---------------------------------------------------------------------------------------------------------
-- execute rights: only signed-in users; the private helpers are not callable from the app
-- ---------------------------------------------------------------------------------------------------------
revoke all on function private.load_fulfilment_order(uuid, text), private.settle_fulfilment_order(uuid), private.cancel_fulfilment_on_reversal() from public, anon, authenticated;
revoke all on function
  public.release_to_warehouse(uuid, smallint, date, text), public.claim_fulfilment_order(uuid), public.release_fulfilment_claim(uuid), public.assign_picker(uuid, uuid),
  public.confirm_pick_line(uuid, numeric, text, text, text, text), public.reset_pick_line(uuid, text), public.resolve_short_pick(uuid, text),
  public.cancel_fulfilment_order(uuid, text), public.fulfilment_queue(text, boolean), public.fulfilment_pick_list(uuid), public.picker_options(uuid)
  from public, anon;
grant execute on function
  public.release_to_warehouse(uuid, smallint, date, text), public.claim_fulfilment_order(uuid), public.release_fulfilment_claim(uuid), public.assign_picker(uuid, uuid),
  public.confirm_pick_line(uuid, numeric, text, text, text, text), public.reset_pick_line(uuid, text), public.resolve_short_pick(uuid, text),
  public.cancel_fulfilment_order(uuid, text), public.fulfilment_queue(text, boolean), public.fulfilment_pick_list(uuid), public.picker_options(uuid)
  to authenticated;
