-- Apply Phase 3 (purchasing) to the hosted database in ONE atomic paste: both migrations, verbatim, inside a single transaction.
-- Run it once in the Supabase SQL editor. If anything fails, nothing is changed.
begin;

-- ===== migration 20261012000100_purchasing_permissions =====
-- Phase 3 / 01: permissions for purchasing
--
-- Purchasing is BRANCH-scoped: a purchase order belongs to the branch of the warehouse it delivers to, and a
-- permission only applies to orders of the branches it was granted for (organization-wide grants cover all).
-- Separation of duties: the person who prepares an order is not the person who approves it (see the migration).

insert into public.permissions (code, module, action, description) values
  ('purchasing.view',    'purchasing', 'view',    'View purchase orders and goods received'),
  ('purchasing.create',  'purchasing', 'create',  'Create, edit and submit purchase orders'),
  ('purchasing.approve', 'purchasing', 'approve', 'Approve, reject, cancel and close purchase orders'),
  ('purchasing.receive', 'purchasing', 'receive', 'Receive goods against approved purchase orders')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, pattern) as (values
  ('SUPER_ADMIN',         'purchasing.%'),
  ('OWNER',               'purchasing.%'),
  ('GENERAL_MANAGER',     'purchasing.%'),
  ('PROCUREMENT_MANAGER', 'purchasing.view'),  ('PROCUREMENT_MANAGER', 'purchasing.create'),
  ('PROCUREMENT_MANAGER', 'purchasing.approve'),
  ('PROCUREMENT_OFFICER', 'purchasing.view'),  ('PROCUREMENT_OFFICER', 'purchasing.create'),
  ('WAREHOUSE_MANAGER',   'purchasing.view'),  ('WAREHOUSE_MANAGER',   'purchasing.receive'),
  ('BRANCH_MANAGER',      'purchasing.view'),  ('BRANCH_MANAGER',      'purchasing.create'),
  ('PHARMACIST',          'purchasing.view'),
  ('ACCOUNTS_MANAGER',    'purchasing.view'),  ('ACCOUNTS_OFFICER',    'purchasing.view'),
  ('AUDITOR',             'purchasing.view'),  ('READ_ONLY',           'purchasing.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code like m.pattern
on conflict do nothing;

-- ===== migration 20261012000200_purchasing =====
-- Phase 3 / 02: purchasing - purchase orders (with approval) and goods received into the stock ledger
--
-- Flow:   DRAFT -> SUBMITTED -> APPROVED -> PARTIALLY_RECEIVED -> RECEIVED          (CANCELLED / CLOSED are the exits)
--   * Orders and their lines are written ONLY by the functions below (clients have SELECT only).
--   * Separation of duties: whoever prepared an order cannot approve it, unless nobody else holds purchasing.approve.
--   * An order cannot be approved while its supplier is inactive or its regulatory licence has expired.
--   * Goods are received against an APPROVED order and are posted to the stock ledger in the same transaction
--     (batch + expiry required for batch-tracked products). Goods that are doubtful on arrival can be received straight
--     into QUARANTINE or DAMAGED. Receiving more than was ordered is refused (amend the order instead).
--   * Receipts are immutable: a mistake is corrected with a stock adjustment, not by editing the receipt.
-- Amounts are in the order currency and EXCLUDE tax (VAT/levies arrive with invoicing).

-- ---------------------------------------------------------------------------------------------------------
-- the ledger learns about receipts
-- ---------------------------------------------------------------------------------------------------------
alter table public.stock_documents
  add column source_type text check (source_type is null or source_type in ('PURCHASE_ORDER')),
  add column source_id   uuid,
  add constraint stock_documents_source_pair check ((source_type is null) = (source_id is null));

alter table public.stock_documents drop constraint stock_documents_document_type_check;
alter table public.stock_documents add constraint stock_documents_document_type_check
  check (document_type in ('OPENING', 'ADJUSTMENT', 'TRANSFER', 'STATUS_CHANGE', 'RECEIPT'));

alter table public.stock_documents drop constraint stock_documents_reason_code_check;
alter table public.stock_documents add constraint stock_documents_reason_code_check
  check (reason_code is null or reason_code in
    ('OPENING', 'RECEIPT', 'COUNT_VARIANCE', 'DAMAGE', 'EXPIRY_WRITE_OFF', 'THEFT_LOSS', 'FOUND', 'RETURN_TO_STOCK',
     'QUALITY_HOLD', 'QUALITY_RELEASE', 'RECALL', 'REORGANISATION', 'OTHER'));

alter table public.stock_movements drop constraint stock_movements_movement_type_check;
alter table public.stock_movements add constraint stock_movements_movement_type_check
  check (movement_type in ('OPENING', 'RECEIPT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER_OUT', 'TRANSFER_IN',
                           'STATUS_OUT', 'STATUS_IN'));
alter table public.stock_movements drop constraint stock_movements_sign;
alter table public.stock_movements add constraint stock_movements_sign check (
  quantity <> 0 and (
    (movement_type in ('OPENING', 'RECEIPT', 'ADJUSTMENT_IN', 'TRANSFER_IN', 'STATUS_IN') and quantity > 0) or
    (movement_type in ('ADJUSTMENT_OUT', 'TRANSFER_OUT', 'STATUS_OUT') and quantity < 0)));

-- The posting engine moves to a private function so that receiving goods (purchasing.receive) can reuse it without
-- the caller needing any inventory.* permission. The public function stays what it was and refuses RECEIPT.
-- p_lines: array of objects (the engine behind post_stock_document() and receive_goods())
--   product_id        uuid     required
--   quantity          number   required, > 0, in the unit below
--   product_unit_id   uuid     optional (pack the quantity is expressed in); default = base unit
--   batch_id          uuid     an existing batch ... or
--   batch_number      text     ... a batch number (+ expiry_date, + optional manufacture_date, to create it)
--   location_id       uuid     optional (location inside p_warehouse_id)
--   status            text     stock status the line starts from; default AVAILABLE
--   direction         text     ADJUSTMENT only: 'IN' or 'OUT'
--   to_status         text     STATUS_CHANGE only
--   to_location_id    uuid     TRANSFER (in the destination warehouse) / STATUS_CHANGE (same warehouse), optional
create function private.post_stock(
  p_document_type text,
  p_warehouse_id uuid,
  p_lines jsonb,
  p_to_warehouse_id uuid default null,
  p_reason_code text default null,
  p_notes text default null,
  p_source_type text default null,
  p_source_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.current_organization_id();
  v_perm    text;
  v_prefix  text;
  v_wh      public.warehouses;
  v_to_wh   public.warehouses;
  v_doc     public.stock_documents;
  v_number  text;
  v_today   date;
  v_line    jsonb;
  v_n       integer;
  v_prod    public.products;
  v_unit    public.product_units;
  v_batch   public.batches;
  v_entered numeric;
  v_qty     numeric;
  v_status  text;
  v_to_status text;
  v_dir     text;
  v_loc     uuid;
  v_to_loc  uuid;
  v_bnum    text;
  v_exp     date;
  v_mfg     date;
  v_batch_id uuid;
  v_can_create boolean;
  v_short_sku text;
  v_short_batch text;
  v_short_status text;
  v_short_on_hand numeric;
  v_short_wanted numeric;
  v_d       record;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  v_perm := case p_document_type
    when 'OPENING'       then 'inventory.opening_stock'
    when 'ADJUSTMENT'    then 'inventory.adjust'
    when 'TRANSFER'      then 'inventory.transfer'
    when 'STATUS_CHANGE' then 'inventory.quarantine'
    when 'RECEIPT'       then 'purchasing.receive'   -- authorised by receive_goods(), not checked here
  end;
  if v_perm is null then
    raise exception 'unknown document type' using errcode = '22023';
  end if;
  v_prefix := case p_document_type when 'OPENING' then 'OPN' when 'ADJUSTMENT' then 'ADJ'
                                   when 'TRANSFER' then 'TRF' when 'RECEIPT' then 'RCV' else 'STS' end;

  select * into v_wh from public.warehouses w
   where w.id = p_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;
  if p_document_type <> 'RECEIPT' and not private.has_permission(v_perm, v_wh.branch_id) then
    raise exception 'insufficient privilege for this warehouse' using errcode = '42501';
  end if;

  if p_document_type = 'TRANSFER' then
    select * into v_to_wh from public.warehouses w
     where w.id = p_to_warehouse_id and w.organization_id = v_org and w.is_active;
    if not found then
      raise exception 'destination warehouse not found' using errcode = 'P0002';
    end if;
    if v_to_wh.id = v_wh.id then
      raise exception 'source and destination warehouse must differ' using errcode = '22023';
    end if;
  elsif p_to_warehouse_id is not null then
    raise exception 'destination warehouse only applies to transfers' using errcode = '22023';
  end if;

  if p_document_type = 'ADJUSTMENT' and (p_reason_code is null or p_reason_code in ('OPENING')) then
    raise exception 'a reason is required for an adjustment' using errcode = '22023';
  end if;
  if p_document_type in ('OPENING', 'RECEIPT') then
    p_reason_code := p_document_type;
  end if;
  if p_notes is not null and length(p_notes) > 500 then
    raise exception 'notes are limited to 500 characters' using errcode = '22023';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'at least one line is required' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'a document is limited to 200 lines' using errcode = '22023';
  end if;

  select (now() at time zone o.timezone)::date into v_today from public.organizations o where o.id = v_org;

  -- one sequence per organization (not per branch): document numbers are unique across the whole organization
  v_number := private.generate_document_number(v_org, null, 'STOCK_' || p_document_type, v_prefix);
  insert into public.stock_documents (
    organization_id, document_number, document_type, branch_id, warehouse_id, to_warehouse_id, reason_code, notes,
    line_count, source_type, source_id)
  values (v_org, v_number, p_document_type, v_wh.branch_id, v_wh.id, v_to_wh.id, p_reason_code,
          nullif(btrim(p_notes), ''), jsonb_array_length(p_lines), p_source_type, p_source_id)
  returning * into v_doc;

  v_n := 0;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'line %: invalid line', v_n using errcode = '22023';
    end if;

    -- product
    select * into v_prod from public.products p
     where p.id = nullif(v_line ->> 'product_id', '')::uuid and p.organization_id = v_org and p.is_active;
    if not found then
      raise exception 'line %: product not found or inactive', v_n using errcode = 'P0002';
    end if;

    -- quantity (entered in a pack level, stored in base units)
    if jsonb_typeof(v_line -> 'quantity') is distinct from 'number' or (v_line ->> 'quantity')::numeric <= 0 then
      raise exception 'line %: quantity must be a positive number', v_n using errcode = '22023';
    end if;
    v_entered := (v_line ->> 'quantity')::numeric;
    if nullif(v_line ->> 'product_unit_id', '') is null then
      select * into v_unit from public.product_units u where u.product_id = v_prod.id and u.is_base;
    else
      select * into v_unit from public.product_units u
       where u.id = (v_line ->> 'product_unit_id')::uuid and u.product_id = v_prod.id
         and u.organization_id = v_org and u.is_active;
    end if;
    if not found then
      raise exception 'line %: unit does not belong to this product', v_n using errcode = 'P0002';
    end if;
    v_qty := v_entered * v_unit.factor_to_base;
    if v_qty <> round(v_qty, 3) or v_qty <= 0 or v_qty >= 1000000000000 then
      raise exception 'line %: quantity is not a valid amount in the base unit', v_n using errcode = '22023';
    end if;

    -- status / locations
    v_status := coalesce(nullif(v_line ->> 'status', ''), 'AVAILABLE');
    if v_status not in ('AVAILABLE', 'QUARANTINE', 'DAMAGED', 'EXPIRED') then
      raise exception 'line %: invalid stock status', v_n using errcode = '22023';
    end if;
    v_loc := nullif(v_line ->> 'location_id', '')::uuid;
    if v_loc is not null and not exists (
         select 1 from public.warehouse_locations l
          where l.id = v_loc and l.warehouse_id = v_wh.id and l.organization_id = v_org and l.is_active) then
      raise exception 'line %: location not found in this warehouse', v_n using errcode = 'P0002';
    end if;
    v_to_loc := nullif(v_line ->> 'to_location_id', '')::uuid;
    if v_to_loc is not null and not exists (
         select 1 from public.warehouse_locations l
          where l.id = v_to_loc
            and l.warehouse_id = case p_document_type when 'TRANSFER' then v_to_wh.id else v_wh.id end
            and l.organization_id = v_org and l.is_active) then
      raise exception 'line %: destination location not found', v_n using errcode = 'P0002';
    end if;

    v_dir := upper(coalesce(v_line ->> 'direction', ''));
    if p_document_type = 'ADJUSTMENT' and v_dir not in ('IN', 'OUT') then
      raise exception 'line %: direction must be IN or OUT', v_n using errcode = '22023';
    end if;
    v_to_status := upper(coalesce(v_line ->> 'to_status', ''));
    if p_document_type = 'STATUS_CHANGE' then
      if v_to_status not in ('AVAILABLE', 'QUARANTINE', 'DAMAGED', 'EXPIRED') then
        raise exception 'line %: invalid target status', v_n using errcode = '22023';
      end if;
      if v_to_status = v_status and v_to_loc is not distinct from v_loc then
        raise exception 'line %: nothing to change (same status and location)', v_n using errcode = '22023';
      end if;
    end if;

    -- batch: existing (by id or number) or, for stock coming IN, created on the fly
    v_bnum := nullif(btrim(coalesce(v_line ->> 'batch_number', '')), '');
    v_exp := nullif(v_line ->> 'expiry_date', '')::date;
    v_mfg := nullif(v_line ->> 'manufacture_date', '')::date;
    v_can_create := p_document_type in ('OPENING', 'RECEIPT') or (p_document_type = 'ADJUSTMENT' and v_dir = 'IN');
    v_batch_id := null;

    if not v_prod.track_batches then
      if v_bnum is not null or nullif(v_line ->> 'batch_id', '') is not null then
        raise exception 'line %: this product is not batch-tracked', v_n using errcode = '22023';
      end if;
    else
      v_batch := null;
      if nullif(v_line ->> 'batch_id', '') is not null then
        select * into v_batch from public.batches b
         where b.id = (v_line ->> 'batch_id')::uuid and b.product_id = v_prod.id and b.organization_id = v_org;
      elsif v_bnum is not null then
        select * into v_batch from public.batches b
         where b.product_id = v_prod.id and b.organization_id = v_org and upper(btrim(b.batch_number)) = upper(v_bnum);
      else
        raise exception 'line %: batch is required for this product', v_n using errcode = '22023';
      end if;

      if v_batch.id is null then
        if not v_can_create or v_bnum is null then
          raise exception 'line %: batch not found', v_n using errcode = 'P0002';
        end if;
        if v_exp is null then
          raise exception 'line %: expiry date is required for a new batch', v_n using errcode = '22023';
        end if;
        insert into public.batches (organization_id, product_id, batch_number, manufacture_date, expiry_date)
        values (v_org, v_prod.id, v_bnum, v_mfg, v_exp)
        returning * into v_batch;
      elsif v_exp is not null and v_exp <> v_batch.expiry_date then
        raise exception 'line %: batch % already exists with expiry %', v_n, v_batch.batch_number, v_batch.expiry_date
          using errcode = '22023';
      end if;
      v_batch_id := v_batch.id;
    end if;

    -- expired stock can never be put (back) into sellable status
    if v_batch_id is not null and v_batch.expiry_date < v_today then
      if (p_document_type in ('OPENING', 'RECEIPT') and v_status = 'AVAILABLE')
         or (p_document_type = 'ADJUSTMENT' and v_dir = 'IN' and v_status = 'AVAILABLE')
         or (p_document_type = 'STATUS_CHANGE' and v_to_status = 'AVAILABLE') then
        raise exception 'line %: batch % expired on % and cannot be AVAILABLE', v_n, v_batch.batch_number, v_batch.expiry_date
          using errcode = '22023';
      end if;
    end if;

    -- the ledger lines
    if p_document_type in ('OPENING', 'RECEIPT') then
      perform private.add_stock_movement(v_org, v_doc.id, v_n, p_document_type, v_wh.id, v_loc, v_prod.id, v_batch_id,
                                         v_status, v_qty, v_unit.id, v_entered);
    elsif p_document_type = 'ADJUSTMENT' then
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'ADJUSTMENT_' || v_dir, v_wh.id, v_loc, v_prod.id,
                                         v_batch_id, v_status, case when v_dir = 'IN' then v_qty else -v_qty end,
                                         v_unit.id, v_entered);
    elsif p_document_type = 'TRANSFER' then
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'TRANSFER_OUT', v_wh.id, v_loc, v_prod.id, v_batch_id,
                                         v_status, -v_qty, v_unit.id, v_entered);
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'TRANSFER_IN', v_to_wh.id, v_to_loc, v_prod.id,
                                         v_batch_id, v_status, v_qty, v_unit.id, v_entered);
    else
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'STATUS_OUT', v_wh.id, v_loc, v_prod.id, v_batch_id,
                                         v_status, -v_qty, v_unit.id, v_entered);
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'STATUS_IN', v_wh.id, v_to_loc, v_prod.id, v_batch_id,
                                         v_to_status, v_qty, v_unit.id, v_entered);
    end if;
  end loop;

  -- friendly message before the CHECK constraint would reject it
  select p.sku, b.batch_number, d.stock_status, coalesce(sb.quantity, 0), -d.delta
    into v_short_sku, v_short_batch, v_short_status, v_short_on_hand, v_short_wanted
  from (
    select m.warehouse_id, m.location_id, m.product_id, m.batch_id, m.stock_status, sum(m.quantity) as delta
    from public.stock_movements m
    where m.document_id = v_doc.id
    group by m.warehouse_id, m.location_id, m.product_id, m.batch_id, m.stock_status
    having sum(m.quantity) < 0
  ) d
  join public.products p on p.id = d.product_id
  left join public.batches b on b.id = d.batch_id
  left join public.stock_balances sb
    on sb.organization_id = v_org and sb.warehouse_id = d.warehouse_id
   and sb.location_id is not distinct from d.location_id and sb.product_id = d.product_id
   and sb.batch_id is not distinct from d.batch_id and sb.stock_status = d.stock_status
  where coalesce(sb.quantity, 0) + d.delta < 0
  limit 1;
  if v_short_sku is not null then
    raise exception 'insufficient stock: % % [%] has % available, % requested',
      v_short_sku, coalesce('batch ' || v_short_batch, ''), v_short_status, v_short_on_hand, v_short_wanted
      using errcode = '23514';
  end if;

  -- apply to the balances in a fixed key order (concurrent postings cannot deadlock each other)
  for v_d in
    select m.warehouse_id, m.location_id, m.product_id, m.batch_id, m.stock_status, sum(m.quantity) as delta
    from public.stock_movements m
    where m.document_id = v_doc.id
    group by m.warehouse_id, m.location_id, m.product_id, m.batch_id, m.stock_status
    order by m.warehouse_id, m.product_id, m.batch_id nulls first, m.location_id nulls first, m.stock_status
  loop
    for i in 1..2 loop
      begin
        update public.stock_balances sb
           set quantity = sb.quantity + v_d.delta, updated_at = now()
         where sb.organization_id = v_org and sb.warehouse_id = v_d.warehouse_id
           and sb.location_id is not distinct from v_d.location_id and sb.product_id = v_d.product_id
           and sb.batch_id is not distinct from v_d.batch_id and sb.stock_status = v_d.stock_status;
        if found then
          exit;
        end if;
        insert into public.stock_balances (organization_id, warehouse_id, location_id, product_id, batch_id,
                                           stock_status, quantity)
        values (v_org, v_d.warehouse_id, v_d.location_id, v_d.product_id, v_d.batch_id, v_d.stock_status, v_d.delta);
        exit;
      exception
        when unique_violation then
          if i = 2 then raise; end if;   -- a concurrent posting created the row: go round and update it
        when check_violation then
          raise exception 'insufficient stock (changed while posting) - please retry' using errcode = '23514';
      end;
    end loop;
  end loop;

  perform private.write_audit(
    v_org, 'stock.' || lower(p_document_type) || '_posted', 'stock_document', v_doc.id::text, v_wh.branch_id,
    null,
    jsonb_build_object('document_number', v_number, 'document_type', p_document_type, 'lines', v_doc.line_count,
                       'warehouse_id', v_wh.id, 'to_warehouse_id', v_to_wh.id, 'reason_code', p_reason_code),
    null, nullif(btrim(p_notes), ''));

  return jsonb_build_object('document_id', v_doc.id, 'document_number', v_number);
end;
$$;

create or replace function public.post_stock_document(
  p_document_type text,
  p_warehouse_id uuid,
  p_lines jsonb,
  p_to_warehouse_id uuid default null,
  p_reason_code text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_document_type = 'RECEIPT' then
    raise exception 'goods are received against a purchase order' using errcode = '42501';
  end if;
  return private.post_stock(p_document_type, p_warehouse_id, p_lines, p_to_warehouse_id, p_reason_code, p_notes);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- purchase orders
-- ---------------------------------------------------------------------------------------------------------
create table public.purchase_orders (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete restrict
                       default private.current_organization_id(),
  po_number          text not null,
  supplier_id        uuid not null,
  branch_id          uuid not null,
  warehouse_id       uuid not null,
  status             text not null default 'DRAFT'
                       check (status in ('DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED')),
  order_date         date not null default current_date,
  expected_date      date,
  currency_code      text not null check (currency_code ~ '^[A-Z]{3}$'),
  payment_terms_days integer not null default 30 check (payment_terms_days between 0 and 365),
  notes              text check (notes is null or length(notes) <= 1000),
  total_amount       numeric(18, 2) not null default 0 check (total_amount >= 0),
  status_reason      text check (status_reason is null or length(status_reason) <= 500),
  created_by         uuid default auth.uid(),
  submitted_at       timestamptz,
  approved_by        uuid,
  approved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint purchase_orders_supplier_fk foreign key (supplier_id, organization_id)
    references public.suppliers (id, organization_id) on delete restrict,
  constraint purchase_orders_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint purchase_orders_warehouse_fk foreign key (warehouse_id, organization_id)
    references public.warehouses (id, organization_id) on delete restrict,
  constraint purchase_orders_number_key unique (organization_id, po_number),
  constraint purchase_orders_id_org_key unique (id, organization_id)
);
create index purchase_orders_org_created_idx on public.purchase_orders (organization_id, created_at desc, id desc);
create index purchase_orders_branch_status_idx on public.purchase_orders (organization_id, branch_id, status);
create index purchase_orders_supplier_idx on public.purchase_orders (supplier_id);
create index purchase_orders_warehouse_idx on public.purchase_orders (warehouse_id);

create trigger purchase_orders_immutable before update on public.purchase_orders
  for each row execute function private.prevent_column_change('organization_id', 'po_number');
create trigger purchase_orders_set_updated_at before update on public.purchase_orders
  for each row execute function private.set_updated_at();
create trigger purchase_orders_audit after insert or update or delete on public.purchase_orders
  for each row execute function private.audit_row_change('purchase_order');

create table public.purchase_order_lines (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete restrict
                      default private.current_organization_id(),
  purchase_order_id uuid not null,
  branch_id         uuid not null,
  line_no           integer not null check (line_no > 0),
  product_id        uuid not null,
  product_unit_id   uuid not null,
  quantity_ordered  numeric(18, 3) not null check (quantity_ordered > 0),   -- in the pack level of product_unit_id
  unit_cost         numeric(18, 4) not null check (unit_cost >= 0),         -- per pack, order currency, ex-tax
  ordered_base      numeric(18, 3) not null check (ordered_base > 0),
  received_base     numeric(18, 3) not null default 0 check (received_base >= 0),
  line_total        numeric(18, 2) generated always as (round(quantity_ordered * unit_cost, 2)) stored,
  constraint purchase_order_lines_po_fk foreign key (purchase_order_id, organization_id)
    references public.purchase_orders (id, organization_id) on delete restrict,
  constraint purchase_order_lines_product_fk foreign key (product_id, organization_id)
    references public.products (id, organization_id) on delete restrict,
  constraint purchase_order_lines_unit_fk foreign key (product_unit_id, product_id, organization_id)
    references public.product_units (id, product_id, organization_id) on delete restrict,
  constraint purchase_order_lines_line_key unique (purchase_order_id, line_no),
  constraint purchase_order_lines_id_org_key unique (id, organization_id),
  constraint purchase_order_lines_received_cap check (received_base <= ordered_base)
);
create index purchase_order_lines_product_idx on public.purchase_order_lines (organization_id, product_id);
create index purchase_order_lines_unit_idx on public.purchase_order_lines (product_unit_id);

-- ---------------------------------------------------------------------------------------------------------
-- goods received (immutable)
-- ---------------------------------------------------------------------------------------------------------
create table public.goods_receipts (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete restrict,
  grn_number        text not null,
  purchase_order_id uuid not null,
  supplier_id       uuid not null,
  branch_id         uuid not null,
  warehouse_id      uuid not null,
  stock_document_id uuid not null,
  delivery_note     text check (delivery_note is null or length(delivery_note) <= 120),
  notes             text check (notes is null or length(notes) <= 500),
  line_count        integer not null check (line_count > 0),
  received_by       uuid default auth.uid(),
  received_at       timestamptz not null default clock_timestamp(),
  constraint goods_receipts_po_fk foreign key (purchase_order_id, organization_id)
    references public.purchase_orders (id, organization_id) on delete restrict,
  constraint goods_receipts_supplier_fk foreign key (supplier_id, organization_id)
    references public.suppliers (id, organization_id) on delete restrict,
  constraint goods_receipts_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint goods_receipts_warehouse_fk foreign key (warehouse_id, organization_id)
    references public.warehouses (id, organization_id) on delete restrict,
  constraint goods_receipts_stock_document_fk foreign key (stock_document_id, organization_id)
    references public.stock_documents (id, organization_id) on delete restrict,
  constraint goods_receipts_number_key unique (organization_id, grn_number),
  constraint goods_receipts_id_org_key unique (id, organization_id)
);
create index goods_receipts_org_received_idx on public.goods_receipts (organization_id, received_at desc, id desc);
create index goods_receipts_po_idx on public.goods_receipts (purchase_order_id);
create index goods_receipts_branch_idx on public.goods_receipts (organization_id, branch_id, received_at desc);
create index goods_receipts_supplier_idx on public.goods_receipts (supplier_id);
create index goods_receipts_warehouse_idx on public.goods_receipts (warehouse_id);
create index goods_receipts_stock_document_idx on public.goods_receipts (stock_document_id);

create table public.goods_receipt_lines (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete restrict,
  goods_receipt_id  uuid not null,
  branch_id         uuid not null,
  line_no           integer not null check (line_no > 0),
  po_line_id        uuid not null,
  product_id        uuid not null,
  batch_id          uuid,
  product_unit_id   uuid not null,
  quantity_received numeric(18, 3) not null check (quantity_received > 0),   -- as entered, in product_unit_id
  received_base     numeric(18, 3) not null check (received_base > 0),
  unit_cost_base    numeric(18, 6) not null check (unit_cost_base >= 0),     -- cost per BASE unit at the time of receipt
  stock_status      text not null check (stock_status in ('AVAILABLE', 'QUARANTINE', 'DAMAGED')),
  location_id       uuid references public.warehouse_locations (id) on delete restrict,
  constraint goods_receipt_lines_gr_fk foreign key (goods_receipt_id, organization_id)
    references public.goods_receipts (id, organization_id) on delete restrict,
  constraint goods_receipt_lines_po_line_fk foreign key (po_line_id, organization_id)
    references public.purchase_order_lines (id, organization_id) on delete restrict,
  constraint goods_receipt_lines_product_fk foreign key (product_id, organization_id)
    references public.products (id, organization_id) on delete restrict,
  constraint goods_receipt_lines_batch_fk foreign key (batch_id, product_id, organization_id)
    references public.batches (id, product_id, organization_id) on delete restrict,
  constraint goods_receipt_lines_unit_fk foreign key (product_unit_id, product_id, organization_id)
    references public.product_units (id, product_id, organization_id) on delete restrict
);
create index goods_receipt_lines_gr_idx on public.goods_receipt_lines (goods_receipt_id, line_no);
create index goods_receipt_lines_po_line_idx on public.goods_receipt_lines (po_line_id);
create index goods_receipt_lines_product_idx on public.goods_receipt_lines (organization_id, product_id);
create index goods_receipt_lines_batch_idx on public.goods_receipt_lines (batch_id) where batch_id is not null;
create index goods_receipt_lines_unit_idx on public.goods_receipt_lines (product_unit_id);
create index goods_receipt_lines_location_idx on public.goods_receipt_lines (location_id) where location_id is not null;

create trigger goods_receipts_append_only before update or delete on public.goods_receipts
  for each row execute function private.stock_block_mutation();
create trigger goods_receipts_no_truncate before truncate on public.goods_receipts
  for each statement execute function private.stock_block_mutation();
create trigger goods_receipt_lines_append_only before update or delete on public.goods_receipt_lines
  for each row execute function private.stock_block_mutation();
create trigger goods_receipt_lines_no_truncate before truncate on public.goods_receipt_lines
  for each statement execute function private.stock_block_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- RLS and grants: read only; all writes go through the functions below
-- ---------------------------------------------------------------------------------------------------------
alter table public.purchase_orders       enable row level security;
alter table public.purchase_order_lines  enable row level security;
alter table public.goods_receipts        enable row level security;
alter table public.goods_receipt_lines   enable row level security;
revoke all on public.purchase_orders, public.purchase_order_lines, public.goods_receipts, public.goods_receipt_lines
  from public, anon, authenticated;
grant select on public.purchase_orders, public.purchase_order_lines, public.goods_receipts, public.goods_receipt_lines
  to authenticated;

create policy purchase_orders_select on public.purchase_orders
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('purchasing.view', branch_id));
create policy purchase_order_lines_select on public.purchase_order_lines
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('purchasing.view', branch_id));
create policy goods_receipts_select on public.goods_receipts
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('purchasing.view', branch_id));
create policy goods_receipt_lines_select on public.goods_receipt_lines
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('purchasing.view', branch_id));

-- ---------------------------------------------------------------------------------------------------------
-- helpers (private)
-- ---------------------------------------------------------------------------------------------------------
-- Loads and row-locks an order of the caller's organization.
create function private.po_load(p_id uuid)
returns public.purchase_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.purchase_orders;
begin
  select * into v from public.purchase_orders po
   where po.id = p_id and po.organization_id = private.current_organization_id()
   for update;
  if not found then
    raise exception 'purchase order not found' using errcode = 'P0002';
  end if;
  return v;
end;
$$;

-- Does somebody other than the caller hold purchasing.approve for this branch?
create function private.other_approver_exists(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.profiles pr on pr.id = ur.user_id and pr.is_active
    join public.roles r on r.id = ur.role_id and r.is_active
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions pm on pm.id = rp.permission_id
    where ur.organization_id = private.current_organization_id()
      and ur.user_id <> auth.uid()
      and pm.code = 'purchasing.approve'
      and (ur.branch_id is null or ur.branch_id = p_branch_id)
  )
$$;

-- ---------------------------------------------------------------------------------------------------------
-- order lifecycle
-- ---------------------------------------------------------------------------------------------------------
-- p_lines: [{ product_id, quantity, unit_cost, product_unit_id? }]; creates a DRAFT (p_id null) or replaces the lines of one.
create function public.save_purchase_order(
  p_id uuid,
  p_supplier_id uuid,
  p_warehouse_id uuid,
  p_expected_date date,
  p_notes text,
  p_lines jsonb,
  p_payment_terms_days integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org      uuid := private.current_organization_id();
  v_wh       public.warehouses;
  v_sup      public.suppliers;
  v_po       public.purchase_orders;
  v_currency text;
  v_terms    integer;
  v_line     jsonb;
  v_n        integer := 0;
  v_prod     public.products;
  v_unit     public.product_units;
  v_qty      numeric;
  v_cost     numeric;
  v_base     numeric;
  v_seen     text[] := '{}';
  v_key      text;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  select * into v_wh from public.warehouses w where w.id = p_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'delivery warehouse not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('purchasing.create', v_wh.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;

  select * into v_sup from public.suppliers s where s.id = p_supplier_id and s.organization_id = v_org and s.is_active;
  if not found then
    raise exception 'supplier not found or inactive' using errcode = 'P0002';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'add at least one line' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 100 then
    raise exception 'an order is limited to 100 lines' using errcode = '22023';
  end if;
  if p_notes is not null and length(p_notes) > 1000 then
    raise exception 'notes are limited to 1000 characters' using errcode = '22023';
  end if;

  v_currency := coalesce(v_sup.currency_code, (select o.currency_code from public.organizations o where o.id = v_org));
  v_terms := coalesce(p_payment_terms_days, v_sup.payment_terms_days);
  if v_terms < 0 or v_terms > 365 then
    raise exception 'payment terms must be 0-365 days' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.purchase_orders (
      organization_id, po_number, supplier_id, branch_id, warehouse_id, expected_date, currency_code,
      payment_terms_days, notes)
    values (v_org, private.generate_document_number(v_org, null, 'PURCHASE_ORDER', 'PO'), v_sup.id, v_wh.branch_id,
            v_wh.id, p_expected_date, v_currency, v_terms, nullif(btrim(p_notes), ''))
    returning * into v_po;
  else
    v_po := private.po_load(p_id);
    if v_po.status <> 'DRAFT' then
      raise exception 'only a draft order can be edited (this one is %)', v_po.status using errcode = '22023';
    end if;
    if not private.has_permission('purchasing.create', v_po.branch_id) then
      raise exception 'insufficient privilege for this branch' using errcode = '42501';
    end if;
    update public.purchase_orders
       set supplier_id = v_sup.id, branch_id = v_wh.branch_id, warehouse_id = v_wh.id, expected_date = p_expected_date,
           currency_code = v_currency, payment_terms_days = v_terms, notes = nullif(btrim(p_notes), ''),
           status_reason = null
     where id = v_po.id;
    delete from public.purchase_order_lines where purchase_order_id = v_po.id;
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'line %: invalid line', v_n using errcode = '22023';
    end if;

    select * into v_prod from public.products p
     where p.id = nullif(v_line ->> 'product_id', '')::uuid and p.organization_id = v_org and p.is_active;
    if not found then
      raise exception 'line %: product not found or inactive', v_n using errcode = 'P0002';
    end if;

    if nullif(v_line ->> 'product_unit_id', '') is null then
      select * into v_unit from public.product_units u where u.product_id = v_prod.id and u.is_base;
    else
      select * into v_unit from public.product_units u
       where u.id = (v_line ->> 'product_unit_id')::uuid and u.product_id = v_prod.id and u.organization_id = v_org
         and u.is_active and u.is_purchasable;
    end if;
    if not found then
      raise exception 'line %: that pack level cannot be purchased for this product', v_n using errcode = 'P0002';
    end if;

    if jsonb_typeof(v_line -> 'quantity') is distinct from 'number' or (v_line ->> 'quantity')::numeric <= 0 then
      raise exception 'line %: quantity must be a positive number', v_n using errcode = '22023';
    end if;
    if jsonb_typeof(v_line -> 'unit_cost') is distinct from 'number' or (v_line ->> 'unit_cost')::numeric < 0 then
      raise exception 'line %: cost must be 0 or more', v_n using errcode = '22023';
    end if;
    v_qty := (v_line ->> 'quantity')::numeric;
    v_cost := (v_line ->> 'unit_cost')::numeric;
    if v_qty <> round(v_qty, 3) or v_cost <> round(v_cost, 4) or v_cost >= 100000000000 then
      raise exception 'line %: too many decimals in quantity or cost', v_n using errcode = '22023';
    end if;
    v_base := v_qty * v_unit.factor_to_base;
    if v_base <> round(v_base, 3) or v_base >= 1000000000000 then
      raise exception 'line %: quantity is not a valid amount in the base unit', v_n using errcode = '22023';
    end if;

    v_key := v_prod.id::text || '|' || v_unit.id::text;
    if v_key = any (v_seen) then
      raise exception 'line %: this product and pack level is already on the order', v_n using errcode = '22023';
    end if;
    v_seen := v_seen || v_key;

    insert into public.purchase_order_lines (
      organization_id, purchase_order_id, branch_id, line_no, product_id, product_unit_id, quantity_ordered, unit_cost,
      ordered_base)
    values (v_org, v_po.id, v_wh.branch_id, v_n, v_prod.id, v_unit.id, v_qty, v_cost, v_base);
  end loop;

  update public.purchase_orders po
     set total_amount = (select coalesce(sum(l.line_total), 0) from public.purchase_order_lines l where l.purchase_order_id = po.id)
   where po.id = v_po.id;

  return v_po.id;
end;
$$;

create function public.submit_purchase_order(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po public.purchase_orders;
begin
  if private.current_organization_id() is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  v_po := private.po_load(p_id);
  if not private.has_permission('purchasing.create', v_po.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_po.status <> 'DRAFT' then
    raise exception 'only a draft can be submitted (this one is %)', v_po.status using errcode = '22023';
  end if;
  if not exists (select 1 from public.purchase_order_lines l where l.purchase_order_id = v_po.id) then
    raise exception 'add at least one line before submitting' using errcode = '22023';
  end if;
  update public.purchase_orders set status = 'SUBMITTED', submitted_at = now(), status_reason = null where id = v_po.id;
end;
$$;

create function public.approve_purchase_order(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po    public.purchase_orders;
  v_sup   public.suppliers;
  v_today date;
begin
  if private.current_organization_id() is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  v_po := private.po_load(p_id);
  if not private.has_permission('purchasing.approve', v_po.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_po.status <> 'SUBMITTED' then
    raise exception 'only a submitted order can be approved (this one is %)', v_po.status using errcode = '22023';
  end if;
  if v_po.created_by = auth.uid() and private.other_approver_exists(v_po.branch_id) then
    raise exception 'an order you prepared must be approved by someone else' using errcode = '42501';
  end if;

  select * into v_sup from public.suppliers s where s.id = v_po.supplier_id;
  select (now() at time zone o.timezone)::date into v_today from public.organizations o where o.id = v_po.organization_id;
  if not v_sup.is_active then
    raise exception 'the supplier is inactive' using errcode = '22023';
  end if;
  if v_sup.licence_expiry is not null and v_sup.licence_expiry < v_today then
    raise exception 'the supplier''s licence expired on % - update it before ordering', v_sup.licence_expiry
      using errcode = '22023';
  end if;

  update public.purchase_orders
     set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), status_reason = null
   where id = v_po.id;
end;
$$;

create function public.reject_purchase_order(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po public.purchase_orders;
begin
  if private.current_organization_id() is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  v_po := private.po_load(p_id);
  if not private.has_permission('purchasing.approve', v_po.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_po.status <> 'SUBMITTED' then
    raise exception 'only a submitted order can be sent back (this one is %)', v_po.status using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.purchase_orders set status = 'DRAFT', status_reason = btrim(p_reason) where id = v_po.id;
end;
$$;

create function public.cancel_purchase_order(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po public.purchase_orders;
begin
  if private.current_organization_id() is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  v_po := private.po_load(p_id);
  if v_po.status not in ('DRAFT', 'SUBMITTED', 'APPROVED') then
    raise exception 'an order that is % cannot be cancelled', v_po.status using errcode = '22023';
  end if;
  if not private.has_permission(case when v_po.status = 'DRAFT' then 'purchasing.create' else 'purchasing.approve' end,
                                v_po.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.purchase_orders set status = 'CANCELLED', status_reason = btrim(p_reason) where id = v_po.id;
end;
$$;

-- The supplier will not deliver the rest: stop expecting it.
create function public.close_purchase_order(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po public.purchase_orders;
begin
  if private.current_organization_id() is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  v_po := private.po_load(p_id);
  if not private.has_permission('purchasing.approve', v_po.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_po.status <> 'PARTIALLY_RECEIVED' then
    raise exception 'only a partially received order can be closed (this one is %)', v_po.status using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.purchase_orders set status = 'CLOSED', status_reason = btrim(p_reason) where id = v_po.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- receiving goods
-- ---------------------------------------------------------------------------------------------------------
-- p_lines: [{ po_line_id, quantity, batch_number?, expiry_date?, manufacture_date?, location_id?, status?, product_unit_id? }]
--   quantity is in product_unit_id (default: the pack level the line was ordered in); status AVAILABLE | QUARANTINE | DAMAGED.
create function public.receive_goods(
  p_purchase_order_id uuid,
  p_lines jsonb,
  p_delivery_note text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.current_organization_id();
  v_po      public.purchase_orders;
  v_pol     public.purchase_order_lines;
  v_unit    public.product_units;
  v_line    jsonb;
  v_n       integer := 0;
  v_qty     numeric;
  v_base    numeric;
  v_status  text;
  v_stock_lines jsonb := '[]'::jsonb;
  v_stock   jsonb;
  v_doc_id  uuid;
  v_grn_id  uuid := gen_random_uuid();
  v_number  text;
  v_open    integer;
  v_new_status text;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  v_po := private.po_load(p_purchase_order_id);
  if not private.has_permission('purchasing.receive', v_po.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_po.status not in ('APPROVED', 'PARTIALLY_RECEIVED') then
    raise exception 'goods can only be received against an approved order (this one is %)', v_po.status
      using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'enter at least one received line' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'a receipt is limited to 200 lines' using errcode = '22023';
  end if;
  if (p_delivery_note is not null and length(p_delivery_note) > 120) or (p_notes is not null and length(p_notes) > 500) then
    raise exception 'delivery note is limited to 120 and notes to 500 characters' using errcode = '22023';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'line %: invalid line', v_n using errcode = '22023';
    end if;

    select * into v_pol from public.purchase_order_lines l
     where l.id = nullif(v_line ->> 'po_line_id', '')::uuid and l.purchase_order_id = v_po.id
     for update;
    if not found then
      raise exception 'line %: not a line of this order', v_n using errcode = 'P0002';
    end if;

    if jsonb_typeof(v_line -> 'quantity') is distinct from 'number' or (v_line ->> 'quantity')::numeric <= 0 then
      raise exception 'line %: quantity must be a positive number', v_n using errcode = '22023';
    end if;
    v_qty := (v_line ->> 'quantity')::numeric;

    select * into v_unit from public.product_units u
     where u.id = coalesce(nullif(v_line ->> 'product_unit_id', '')::uuid, v_pol.product_unit_id)
       and u.product_id = v_pol.product_id and u.organization_id = v_org and u.is_active;
    if not found then
      raise exception 'line %: that pack level does not belong to the product', v_n using errcode = 'P0002';
    end if;
    v_base := v_qty * v_unit.factor_to_base;
    if v_base <> round(v_base, 3) or v_base >= 1000000000000 then
      raise exception 'line %: quantity is not a valid amount in the base unit', v_n using errcode = '22023';
    end if;

    if v_pol.received_base + v_base > v_pol.ordered_base then
      raise exception 'line %: receiving this would exceed the ordered quantity (% of % already received)',
        v_n, v_pol.received_base, v_pol.ordered_base using errcode = '22023';
    end if;
    update public.purchase_order_lines set received_base = received_base + v_base where id = v_pol.id;

    v_status := upper(coalesce(nullif(v_line ->> 'status', ''), 'AVAILABLE'));
    if v_status not in ('AVAILABLE', 'QUARANTINE', 'DAMAGED') then
      raise exception 'line %: goods can be received as AVAILABLE, QUARANTINE or DAMAGED', v_n using errcode = '22023';
    end if;

    v_stock_lines := v_stock_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_pol.product_id, 'product_unit_id', v_unit.id, 'quantity', v_qty,
      'batch_number', v_line -> 'batch_number', 'expiry_date', v_line -> 'expiry_date',
      'manufacture_date', v_line -> 'manufacture_date', 'location_id', v_line -> 'location_id', 'status', v_status));
  end loop;

  v_stock := private.post_stock('RECEIPT', v_po.warehouse_id, v_stock_lines, null, 'RECEIPT', p_notes,
                                'PURCHASE_ORDER', v_po.id);
  v_doc_id := (v_stock ->> 'document_id')::uuid;

  v_number := private.generate_document_number(v_org, null, 'GOODS_RECEIPT', 'GRN');
  insert into public.goods_receipts (
    id, organization_id, grn_number, purchase_order_id, supplier_id, branch_id, warehouse_id, stock_document_id,
    delivery_note, notes, line_count)
  values (v_grn_id, v_org, v_number, v_po.id, v_po.supplier_id, v_po.branch_id, v_po.warehouse_id, v_doc_id,
          nullif(btrim(p_delivery_note), ''), nullif(btrim(p_notes), ''), v_n);

  insert into public.goods_receipt_lines (
    organization_id, goods_receipt_id, branch_id, line_no, po_line_id, product_id, batch_id, product_unit_id,
    quantity_received, received_base, unit_cost_base, stock_status, location_id)
  select v_org, v_grn_id, v_po.branch_id, m.line_no, pol.id, m.product_id, m.batch_id, m.entered_unit_id,
         m.entered_quantity, m.quantity, round(pol.unit_cost * pol.quantity_ordered / pol.ordered_base, 6),
         m.stock_status, m.location_id
  from public.stock_movements m
  join jsonb_array_elements(p_lines) with ordinality as l(value, ord) on l.ord = m.line_no
  join public.purchase_order_lines pol on pol.id = (l.value ->> 'po_line_id')::uuid
  where m.document_id = v_doc_id;

  select count(*) filter (where l.received_base < l.ordered_base) into v_open
    from public.purchase_order_lines l where l.purchase_order_id = v_po.id;
  v_new_status := case when v_open = 0 then 'RECEIVED' else 'PARTIALLY_RECEIVED' end;
  update public.purchase_orders set status = v_new_status where id = v_po.id;

  perform private.write_audit(
    v_org, 'goods_receipt.posted', 'goods_receipt', v_grn_id::text, v_po.branch_id, null,
    jsonb_build_object('grn_number', v_number, 'po_number', v_po.po_number, 'lines', v_n,
                       'stock_document_id', v_doc_id, 'order_status', v_new_status),
    null, nullif(btrim(p_notes), ''));

  return jsonb_build_object('goods_receipt_id', v_grn_id, 'grn_number', v_number,
                            'stock_document_number', v_stock ->> 'document_number', 'order_status', v_new_status);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- function privileges
-- ---------------------------------------------------------------------------------------------------------
revoke all on function private.po_load(uuid) from public, anon, authenticated;
revoke all on function private.other_approver_exists(uuid) from public, anon, authenticated;
revoke all on function private.post_stock(text, uuid, jsonb, uuid, text, text, text, uuid) from public, anon, authenticated;

revoke all on function public.save_purchase_order(uuid, uuid, uuid, date, text, jsonb, integer) from public, anon;
revoke all on function public.submit_purchase_order(uuid) from public, anon;
revoke all on function public.approve_purchase_order(uuid) from public, anon;
revoke all on function public.reject_purchase_order(uuid, text) from public, anon;
revoke all on function public.cancel_purchase_order(uuid, text) from public, anon;
revoke all on function public.close_purchase_order(uuid, text) from public, anon;
revoke all on function public.receive_goods(uuid, jsonb, text, text) from public, anon;
grant execute on function public.save_purchase_order(uuid, uuid, uuid, date, text, jsonb, integer) to authenticated;
grant execute on function public.submit_purchase_order(uuid) to authenticated;
grant execute on function public.approve_purchase_order(uuid) to authenticated;
grant execute on function public.reject_purchase_order(uuid, text) to authenticated;
grant execute on function public.cancel_purchase_order(uuid, text) to authenticated;
grant execute on function public.close_purchase_order(uuid, text) to authenticated;
grant execute on function public.receive_goods(uuid, jsonb, text, text) to authenticated;

commit;
