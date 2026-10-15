-- Apply Phase 5 to the hosted database in ONE atomic paste: the Phase 5 migrations, verbatim, inside a single transaction.
-- Run it once in the Supabase SQL editor. If anything fails, nothing is changed.
begin;

-- ===== migration 20261014000100_transfers =====
-- Phase 5 / 02: in-transit transfers between warehouses
--
-- The instant TRANSFER document (Phase 2) stays for moves where the goods arrive immediately. A two-step transfer is for goods that travel:
--   DISPATCH  takes the stock out of the sending warehouse (ledger document TRANSFER_DISPATCH, movement TRANSFER_OUT). From that
--             moment it is on the road: in no warehouse's stock, and listed under the transfer as "outstanding".
--   RECEIVE   the receiving warehouse books what actually arrived (ledger document TRANSFER_RECEIPT, movement TRANSFER_IN), per batch,
--             in the condition found (AVAILABLE / QUARANTINE / DAMAGED / EXPIRED). It can be done in several deliveries.
--   Closing   what never arrives is written off with a stated reason ("closed short"); an unreceived transfer can instead be CANCELLED,
--             which returns the goods to where they were taken from.
-- The ledger invariant (balance = sum of movements) holds at every step: in-transit goods are simply a movement out with no movement in yet.

alter table public.stock_documents drop constraint stock_documents_document_type_check;
alter table public.stock_documents add constraint stock_documents_document_type_check
  check (document_type in ('OPENING', 'ADJUSTMENT', 'TRANSFER', 'STATUS_CHANGE', 'RECEIPT', 'RETURN', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIPT'));
alter table public.stock_documents drop constraint stock_documents_source_type_check;
alter table public.stock_documents add constraint stock_documents_source_type_check
  check (source_type is null or source_type in ('PURCHASE_ORDER', 'PURCHASE_RETURN', 'STOCK_COUNT', 'STOCK_TRANSFER'));

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
create or replace function private.post_stock(
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
  v_cost    numeric;
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
    when 'RETURN'        then 'purchasing.receive'   -- authorised by post_purchase_return(), not checked here
    when 'TRANSFER_DISPATCH' then 'inventory.transfer'   -- checked at the SENDING warehouse
    when 'TRANSFER_RECEIPT'  then 'inventory.transfer'   -- checked at the RECEIVING warehouse
  end;
  if v_perm is null then
    raise exception 'unknown document type' using errcode = '22023';
  end if;
  v_prefix := case p_document_type when 'OPENING' then 'OPN' when 'ADJUSTMENT' then 'ADJ'
                                   when 'TRANSFER' then 'TRF' when 'RECEIPT' then 'RCV' when 'RETURN' then 'RTN'
                                   when 'TRANSFER_DISPATCH' then 'DSP' when 'TRANSFER_RECEIPT' then 'TRC' else 'STS' end;

  select * into v_wh from public.warehouses w
   where w.id = p_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;
  if p_document_type not in ('RECEIPT', 'RETURN') and p_source_type is distinct from 'STOCK_COUNT' and not private.has_permission(v_perm, v_wh.branch_id) then
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
  elsif p_document_type = 'RETURN' then
    p_reason_code := 'RETURN_TO_SUPPLIER';
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
        v_cost := coalesce(nullif(v_line ->> 'unit_cost_base', '')::numeric,
                           nullif(v_line ->> 'unit_cost', '')::numeric / v_unit.factor_to_base);
        if v_cost is not null then
          if v_cost < 0 then
            raise exception 'line %: cost cannot be negative', v_n using errcode = '22023';
          end if;
          insert into public.batch_costs (batch_id, organization_id, unit_cost_base) values (v_batch.id, v_org, round(v_cost, 6));
        end if;
      elsif v_exp is not null and v_exp <> v_batch.expiry_date then
        raise exception 'line %: batch % already exists with expiry %', v_n, v_batch.batch_number, v_batch.expiry_date
          using errcode = '22023';
      end if;
      v_batch_id := v_batch.id;
    end if;

    -- expired stock can never be put (back) into sellable status
    if v_batch_id is not null and v_batch.expiry_date < v_today then
      if (p_document_type in ('OPENING', 'RECEIPT', 'TRANSFER_RECEIPT') and v_status = 'AVAILABLE')
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
    elsif p_document_type = 'TRANSFER_DISPATCH' then
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'TRANSFER_OUT', v_wh.id, v_loc, v_prod.id, v_batch_id,
                                         v_status, -v_qty, v_unit.id, v_entered);
    elsif p_document_type = 'TRANSFER_RECEIPT' then
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'TRANSFER_IN', v_wh.id, v_loc, v_prod.id, v_batch_id,
                                         v_status, v_qty, v_unit.id, v_entered);
    elsif p_document_type = 'RETURN' then
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'RETURN_OUT', v_wh.id, v_loc, v_prod.id, v_batch_id,
                                         v_status, -v_qty, v_unit.id, v_entered);
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

-- ---------------------------------------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------------------------------------
create table public.stock_transfers (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete restrict,
  transfer_number      text not null,
  from_warehouse_id    uuid not null,
  to_warehouse_id      uuid not null,
  from_branch_id       uuid not null,
  to_branch_id         uuid not null,
  status               text not null default 'IN_TRANSIT'
                         check (status in ('IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED')),
  notes                text check (notes is null or length(notes) <= 500),
  status_reason        text check (status_reason is null or length(status_reason) <= 500),
  line_count           integer not null check (line_count > 0),
  dispatch_document_id uuid not null,
  dispatched_by        uuid default auth.uid(),
  dispatched_at        timestamptz not null default clock_timestamp(),
  updated_at           timestamptz not null default now(),
  constraint stock_transfers_from_wh_fk foreign key (from_warehouse_id, organization_id)
    references public.warehouses (id, organization_id) on delete restrict,
  constraint stock_transfers_to_wh_fk foreign key (to_warehouse_id, organization_id)
    references public.warehouses (id, organization_id) on delete restrict,
  constraint stock_transfers_from_branch_fk foreign key (from_branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint stock_transfers_to_branch_fk foreign key (to_branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint stock_transfers_dispatch_doc_fk foreign key (dispatch_document_id, organization_id)
    references public.stock_documents (id, organization_id) on delete restrict,
  constraint stock_transfers_number_key unique (organization_id, transfer_number),
  constraint stock_transfers_id_org_key unique (id, organization_id),
  constraint stock_transfers_distinct check (from_warehouse_id <> to_warehouse_id)
);
create index stock_transfers_org_dispatched_idx on public.stock_transfers (organization_id, dispatched_at desc, id desc);
create index stock_transfers_from_idx on public.stock_transfers (organization_id, from_branch_id, status);
create index stock_transfers_to_idx on public.stock_transfers (organization_id, to_branch_id, status);
create index stock_transfers_from_wh_idx on public.stock_transfers (from_warehouse_id);
create index stock_transfers_to_wh_idx on public.stock_transfers (to_warehouse_id);
create index stock_transfers_dispatch_doc_idx on public.stock_transfers (dispatch_document_id);

create trigger stock_transfers_immutable before update on public.stock_transfers
  for each row execute function private.prevent_column_change(
    'organization_id', 'transfer_number', 'from_warehouse_id', 'to_warehouse_id', 'from_branch_id', 'to_branch_id',
    'line_count', 'dispatch_document_id', 'dispatched_by', 'dispatched_at');
create trigger stock_transfers_no_delete before delete on public.stock_transfers
  for each row execute function private.stock_block_mutation();
create trigger stock_transfers_set_updated_at before update on public.stock_transfers
  for each row execute function private.set_updated_at();
create trigger stock_transfers_audit after insert or update on public.stock_transfers
  for each row execute function private.audit_row_change('stock_transfer');

create table public.stock_transfer_lines (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete restrict,
  stock_transfer_id uuid not null,
  from_branch_id    uuid not null,
  to_branch_id      uuid not null,
  line_no           integer not null check (line_no > 0),
  product_id        uuid not null,
  batch_id          uuid,
  product_unit_id   uuid not null,                  -- the pack level it was dispatched in
  source_location_id uuid references public.warehouse_locations (id) on delete restrict,
  source_status     text not null check (source_status in ('AVAILABLE', 'QUARANTINE', 'DAMAGED', 'EXPIRED')),
  dispatched_base   numeric(18, 3) not null check (dispatched_base > 0),
  received_base     numeric(18, 3) not null default 0 check (received_base >= 0),
  short_base        numeric(18, 3) not null default 0 check (short_base >= 0),      -- written off when the transfer was closed short
  returned_base     numeric(18, 3) not null default 0 check (returned_base >= 0),   -- sent back to the source when it was cancelled
  constraint stock_transfer_lines_transfer_fk foreign key (stock_transfer_id, organization_id)
    references public.stock_transfers (id, organization_id) on delete restrict,
  constraint stock_transfer_lines_product_fk foreign key (product_id, organization_id)
    references public.products (id, organization_id) on delete restrict,
  constraint stock_transfer_lines_batch_fk foreign key (batch_id, product_id, organization_id)
    references public.batches (id, product_id, organization_id) on delete restrict,
  constraint stock_transfer_lines_unit_fk foreign key (product_unit_id, product_id, organization_id)
    references public.product_units (id, product_id, organization_id) on delete restrict,
  constraint stock_transfer_lines_line_key unique (stock_transfer_id, line_no),
  constraint stock_transfer_lines_accounted check (received_base + short_base + returned_base <= dispatched_base)
);
create index stock_transfer_lines_product_idx on public.stock_transfer_lines (organization_id, product_id);
create index stock_transfer_lines_batch_idx on public.stock_transfer_lines (batch_id) where batch_id is not null;
create index stock_transfer_lines_unit_idx on public.stock_transfer_lines (product_unit_id);
create index stock_transfer_lines_location_idx on public.stock_transfer_lines (source_location_id) where source_location_id is not null;

create trigger stock_transfer_lines_immutable before update on public.stock_transfer_lines
  for each row execute function private.prevent_column_change(
    'organization_id', 'stock_transfer_id', 'from_branch_id', 'to_branch_id', 'line_no', 'product_id', 'batch_id',
    'product_unit_id', 'source_location_id', 'source_status', 'dispatched_base');
create trigger stock_transfer_lines_no_delete before delete on public.stock_transfer_lines
  for each row execute function private.stock_block_mutation();

alter table public.stock_transfers       enable row level security;
alter table public.stock_transfer_lines  enable row level security;
revoke all on public.stock_transfers, public.stock_transfer_lines from public, anon, authenticated;
grant select on public.stock_transfers, public.stock_transfer_lines to authenticated;

-- both ends see the transfer: the sender watches it leave, the receiver expects it
create policy stock_transfers_select on public.stock_transfers
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and (private.has_permission('inventory.view', from_branch_id) or private.has_permission('inventory.view', to_branch_id)));
create policy stock_transfer_lines_select on public.stock_transfer_lines
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and (private.has_permission('inventory.view', from_branch_id) or private.has_permission('inventory.view', to_branch_id)));

-- ---------------------------------------------------------------------------------------------------------
-- dispatch
-- ---------------------------------------------------------------------------------------------------------
-- p_lines: [{ product_id, quantity, batch_id?, product_unit_id?, location_id?, status? }]  (stock is taken from that batch / location / status)
create function public.dispatch_transfer(
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid,
  p_lines jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org    uuid := private.current_organization_id();
  v_from   public.warehouses;
  v_to     public.warehouses;
  v_id     uuid := gen_random_uuid();
  v_stock  jsonb;
  v_doc    uuid;
  v_number text;
  v_n      integer;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_from from public.warehouses w where w.id = p_from_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'sending warehouse not found' using errcode = 'P0002';
  end if;
  select * into v_to from public.warehouses w where w.id = p_to_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'receiving warehouse not found' using errcode = 'P0002';
  end if;
  if v_from.id = v_to.id then
    raise exception 'sending and receiving warehouse must differ' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'add at least one line' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_lines);

  v_stock := private.post_stock('TRANSFER_DISPATCH', v_from.id, p_lines, null, null, p_notes, 'STOCK_TRANSFER', v_id);
  v_doc := (v_stock ->> 'document_id')::uuid;
  v_number := private.generate_document_number(v_org, null, 'STOCK_TRANSFER', 'TRN');

  insert into public.stock_transfers (
    id, organization_id, transfer_number, from_warehouse_id, to_warehouse_id, from_branch_id, to_branch_id, notes,
    line_count, dispatch_document_id)
  values (v_id, v_org, v_number, v_from.id, v_to.id, v_from.branch_id, v_to.branch_id, nullif(btrim(p_notes), ''), v_n, v_doc);

  insert into public.stock_transfer_lines (
    organization_id, stock_transfer_id, from_branch_id, to_branch_id, line_no, product_id, batch_id, product_unit_id,
    source_location_id, source_status, dispatched_base)
  select v_org, v_id, v_from.branch_id, v_to.branch_id, m.line_no, m.product_id, m.batch_id, m.entered_unit_id,
         m.location_id, m.stock_status, -m.quantity
  from public.stock_movements m
  where m.document_id = v_doc;

  return jsonb_build_object('stock_transfer_id', v_id, 'transfer_number', v_number,
                            'stock_document_number', v_stock ->> 'document_number');
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- receive (one or several deliveries)
-- ---------------------------------------------------------------------------------------------------------
-- p_lines: [{ line_id, quantity, product_unit_id?, status?, location_id? }]  quantity in the BASE unit unless product_unit_id names a pack level;
--   status = condition found (default AVAILABLE)
create function public.receive_transfer(p_id uuid, p_lines jsonb, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_t     public.stock_transfers;
  v_l     public.stock_transfer_lines;
  v_unit  public.product_units;
  v_line  jsonb;
  v_n     integer := 0;
  v_qty   numeric;
  v_base  numeric;
  v_out   numeric;
  v_status text;
  v_stock_lines jsonb := '[]'::jsonb;
  v_stock jsonb;
  v_open  integer;
  v_new   text;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_t from public.stock_transfers t where t.id = p_id and t.organization_id = v_org for update;
  if not found then
    raise exception 'transfer not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.transfer', v_t.to_branch_id) then
    raise exception 'insufficient privilege for the receiving warehouse' using errcode = '42501';
  end if;
  if v_t.status not in ('IN_TRANSIT', 'PARTIALLY_RECEIVED') then
    raise exception 'goods can only be received while the transfer is on its way (this one is %)', v_t.status using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'enter at least one received line' using errcode = '22023';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'line %: invalid line', v_n using errcode = '22023';
    end if;
    select * into v_l from public.stock_transfer_lines l
     where l.id = nullif(v_line ->> 'line_id', '')::uuid and l.stock_transfer_id = v_t.id for update;
    if not found then
      raise exception 'line %: not a line of this transfer', v_n using errcode = 'P0002';
    end if;
    if jsonb_typeof(v_line -> 'quantity') is distinct from 'number' or (v_line ->> 'quantity')::numeric <= 0 then
      raise exception 'line %: quantity must be a positive number', v_n using errcode = '22023';
    end if;
    v_qty := (v_line ->> 'quantity')::numeric;
    -- the quantity is in the BASE unit unless a pack level is named (never silently in the pack it was dispatched in)
    select * into v_unit from public.product_units u
     where (u.id = nullif(v_line ->> 'product_unit_id', '')::uuid or (nullif(v_line ->> 'product_unit_id', '') is null and u.is_base))
       and u.product_id = v_l.product_id and u.organization_id = v_org and u.is_active;
    if not found then
      raise exception 'line %: that pack level does not belong to the product', v_n using errcode = 'P0002';
    end if;
    v_base := v_qty * v_unit.factor_to_base;
    if v_base <> round(v_base, 3) or v_base >= 1000000000000 then
      raise exception 'line %: quantity is not a valid amount in the base unit', v_n using errcode = '22023';
    end if;
    v_out := v_l.dispatched_base - v_l.received_base - v_l.short_base - v_l.returned_base;
    if v_base > v_out then
      raise exception 'line %: only % is still on its way for this line', v_n, v_out using errcode = '22023';
    end if;
    update public.stock_transfer_lines set received_base = received_base + v_base where id = v_l.id;

    v_status := upper(coalesce(nullif(v_line ->> 'status', ''), 'AVAILABLE'));
    if v_status not in ('AVAILABLE', 'QUARANTINE', 'DAMAGED', 'EXPIRED') then
      raise exception 'line %: invalid condition', v_n using errcode = '22023';
    end if;
    v_stock_lines := v_stock_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_l.product_id, 'batch_id', v_l.batch_id, 'product_unit_id', v_unit.id, 'quantity', v_qty,
      'status', v_status, 'location_id', v_line -> 'location_id'));
  end loop;

  v_stock := private.post_stock('TRANSFER_RECEIPT', v_t.to_warehouse_id, v_stock_lines, null, null, p_notes, 'STOCK_TRANSFER', v_t.id);

  select count(*) filter (where l.dispatched_base - l.received_base - l.short_base - l.returned_base > 0) into v_open
    from public.stock_transfer_lines l where l.stock_transfer_id = v_t.id;
  v_new := case when v_open = 0 then 'RECEIVED' else 'PARTIALLY_RECEIVED' end;
  update public.stock_transfers set status = v_new where id = v_t.id;

  return jsonb_build_object('transfer_status', v_new, 'stock_document_number', v_stock ->> 'document_number');
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- closing and cancelling
-- ---------------------------------------------------------------------------------------------------------
-- Whatever has not arrived is written off. Needs inventory.adjust for the SENDING warehouse (it is a stock loss).
create function public.close_transfer(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_t   public.stock_transfers;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_t from public.stock_transfers t where t.id = p_id and t.organization_id = v_org for update;
  if not found then
    raise exception 'transfer not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.adjust', v_t.from_branch_id) then
    raise exception 'insufficient privilege to write off goods lost in transit' using errcode = '42501';
  end if;
  if v_t.status not in ('IN_TRANSIT', 'PARTIALLY_RECEIVED') then
    raise exception 'only a transfer that is still on its way can be closed (this one is %)', v_t.status using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.stock_transfer_lines l
     set short_base = l.dispatched_base - l.received_base - l.returned_base
   where l.stock_transfer_id = v_t.id and l.dispatched_base - l.received_base - l.short_base - l.returned_base > 0;
  update public.stock_transfers set status = 'CLOSED', status_reason = btrim(p_reason) where id = v_t.id;
end;
$$;

-- Nothing received yet: bring the goods back to where they were taken from (same batch, location and status).
create function public.cancel_transfer(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_t     public.stock_transfers;
  v_lines jsonb;
  v_stock jsonb;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_t from public.stock_transfers t where t.id = p_id and t.organization_id = v_org for update;
  if not found then
    raise exception 'transfer not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.transfer', v_t.from_branch_id) then
    raise exception 'insufficient privilege for the sending warehouse' using errcode = '42501';
  end if;
  if v_t.status <> 'IN_TRANSIT' then
    raise exception 'only a transfer with nothing received yet can be cancelled (this one is %)', v_t.status using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;

  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'product_id', l.product_id, 'batch_id', l.batch_id, 'quantity', l.dispatched_base,
           'product_unit_id', (select u.id from public.product_units u where u.product_id = l.product_id and u.is_base),
           'location_id', l.source_location_id, 'status', l.source_status)) order by l.line_no)
    into v_lines
  from public.stock_transfer_lines l where l.stock_transfer_id = v_t.id;

  v_stock := private.post_stock('TRANSFER_RECEIPT', v_t.from_warehouse_id, v_lines, null, null,
                                'Transfer ' || v_t.transfer_number || ' cancelled', 'STOCK_TRANSFER', v_t.id);
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.stock_transfer_lines set returned_base = dispatched_base where stock_transfer_id = v_t.id;
  update public.stock_transfers set status = 'CANCELLED', status_reason = btrim(p_reason) where id = v_t.id;
  return jsonb_build_object('stock_document_number', v_stock ->> 'document_number');
end;
$$;

revoke all on function public.dispatch_transfer(uuid, uuid, jsonb, text) from public, anon;
revoke all on function public.receive_transfer(uuid, jsonb, text) from public, anon;
revoke all on function public.close_transfer(uuid, text) from public, anon;
revoke all on function public.cancel_transfer(uuid, text) from public, anon;
grant execute on function public.dispatch_transfer(uuid, uuid, jsonb, text) to authenticated;
grant execute on function public.receive_transfer(uuid, jsonb, text) to authenticated;
grant execute on function public.close_transfer(uuid, text) to authenticated;
grant execute on function public.cancel_transfer(uuid, text) to authenticated;

-- ===== migration 20261014000200_imports =====
-- Phase 5 / 03: bulk import of products and suppliers (Excel / CSV files are read in the browser; these functions do the writing)
--
-- Both functions take up to 500 rows at a time and return one result per row. Every row is processed in its own sub-transaction, so a bad row
-- never spoils the good ones, and a DRY RUN (p_dry_run = true, the default) runs the real code on each row and then undoes it, so what
-- "Check file" reports is exactly what "Import" will do.
--   * Create-only: a row whose SKU / supplier code already exists is reported as EXISTS and left unchanged.
--   * Everything is created through the normal tables, so every constraint, trigger and audit entry applies as usual.
--   * Needs products.create (products) or suppliers.create (suppliers) for the WHOLE organization: catalogue data is shared master data.

create function private.parse_bool(p_text text, p_default boolean)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := lower(btrim(coalesce(p_text, '')));
begin
  if v = '' then return p_default; end if;
  if v in ('y', 'yes', 'true', '1') then return true; end if;
  if v in ('n', 'no', 'false', '0') then return false; end if;
  raise exception '"%" is not yes or no', p_text using errcode = '22023';
end;
$$;

-- Turns a database error into something a person filling in a spreadsheet can act on.
create function private.friendly_error(p_state text, p_constraint text, p_message text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_constraint = 'product_barcodes_org_barcode_key' then 'that barcode is already used by another product'
    when p_constraint = 'suppliers_org_name_key' then 'a supplier with that name already exists'
    when p_constraint = 'suppliers_org_code_key' then 'that supplier code is already used'
    when p_constraint = 'products_org_sku_key' then 'that SKU already exists'
    when p_constraint = 'products_identity_required' then 'a medicine needs a generic name, dosage form and strength'
    when p_constraint = 'products_org_brand_idx' then 'a product with that name already exists'
    when p_state in ('22007', '22008') then 'a date is not valid (use YYYY-MM-DD)'
    when p_state = '22P02' then 'a number or value is not valid'
    when p_state = '22003' then 'a number is out of range'
    when p_state = '23502' then 'a required value is missing'
    else p_message
  end
$$;

-- ---------------------------------------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------------------------------------
-- row keys (all text): sku*, brand_name*, base_unit*, product_class, generic_name, dosage_form, strength, manufacturer, category,
--   pack_unit, pack_size, pack2_unit, pack2_size, barcode, storage, requires_prescription, track_batches, fda_registration_number, aliases ("a; b; c")
create function public.import_products(p_rows jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.current_organization_id();
  v_out     jsonb := '[]'::jsonb;
  v_row     jsonb;
  v_n       integer := 0;
  v_seen    text[] := '{}';
  v_sku     text;
  v_status  text;
  v_msg     text;
  v_class   text;
  v_generic text;
  v_form    text;
  v_strength text;
  v_form_id uuid;
  v_form_code text;
  v_ident   uuid;
  v_mfr_name text;
  v_mfr     uuid;
  v_cat_name text;
  v_cat     uuid;
  v_rx      boolean;
  v_base    uuid;
  v_pid     uuid;
  v_pack    uuid;
  v_unit    uuid;
  v_size    numeric;
  v_barcode text;
  v_target  uuid;
  v_alias   text;
  v_code    text;
  v_i       integer;
  v_constraint text;
  v_created integer := 0;
  v_exists  integer := 0;
  v_errors  integer := 0;
begin
  if v_org is null or not private.has_permission('products.create') then
    raise exception 'insufficient privilege to import products' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'no rows to import' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'import at most 500 rows at a time' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1;
    v_status := null; v_msg := null;
    v_sku := upper(btrim(coalesce(v_row ->> 'sku', '')));
    begin
      if jsonb_typeof(v_row) <> 'object' then
        raise exception 'this row is not valid';
      end if;
      if v_sku !~ '^[A-Z0-9][A-Z0-9._-]{0,63}$' then
        raise exception 'the SKU is missing or not valid (letters, numbers and . _ - only, up to 64 characters)';
      end if;
      if v_sku = any (v_seen) then
        raise exception 'the same SKU appears more than once in this file';
      end if;
      v_seen := v_seen || v_sku;

      if exists (select 1 from public.products p where p.organization_id = v_org and p.sku = v_sku) then
        v_status := 'EXISTS';
        v_msg := 'already in the catalogue - left unchanged';
      else
        if btrim(coalesce(v_row ->> 'brand_name', '')) = '' then
          raise exception 'the product name is missing';
        end if;
        v_class := upper(btrim(coalesce(nullif(v_row ->> 'product_class', ''), 'POM')));
        if v_class not in ('POM', 'P', 'GSL', 'CONTROLLED', 'MEDICAL_DEVICE', 'CONSUMABLE', 'SUPPLEMENT', 'COSMETIC', 'OTHER') then
          raise exception 'unknown class "%" (use POM, P, GSL, CONTROLLED, MEDICAL_DEVICE, CONSUMABLE, SUPPLEMENT, COSMETIC or OTHER)', v_class;
        end if;

        -- base unit
        select u.id into v_base from public.units_of_measure u
         where u.is_active and (u.code = upper(btrim(coalesce(v_row ->> 'base_unit', ''))) or lower(u.name) = lower(btrim(coalesce(v_row ->> 'base_unit', ''))));
        if v_base is null then
          raise exception 'the base unit "%" is not recognised (for example TABLET, CAPSULE, BOTTLE, PIECE)', coalesce(v_row ->> 'base_unit', '');
        end if;

        -- identity (generic + form + strength)
        v_generic := btrim(coalesce(v_row ->> 'generic_name', ''));
        v_form := btrim(coalesce(v_row ->> 'dosage_form', ''));
        v_strength := btrim(coalesce(v_row ->> 'strength', ''));
        v_ident := null;
        if v_class in ('POM', 'P', 'GSL', 'CONTROLLED') and (v_generic = '' or v_form = '' or v_strength = '') then
          raise exception 'a medicine needs a generic name, a dosage form and a strength';
        end if;
        if (v_generic <> '' or v_form <> '' or v_strength <> '') then
          if v_generic = '' or v_form = '' or v_strength = '' then
            raise exception 'give the generic name, dosage form and strength together (or none of them)';
          end if;
          select d.id, d.code into v_form_id, v_form_code from public.dosage_forms d
           where d.is_active and (d.code = upper(v_form) or lower(d.name) = lower(v_form));
          if v_form_id is null then
            raise exception 'the dosage form "%" is not recognised (for example TABLET, CAPSULE, SYRUP, INJECTION)', v_form;
          end if;
          select i.id into v_ident from public.product_identities i
           where i.organization_id = v_org
             and i.identity_key = private.normalize_text(v_generic) || '|' || v_form_code || '|' || private.normalize_text(v_strength);
          if v_ident is null then
            insert into public.product_identities (organization_id, generic_name, dosage_form_id, strength_text)
            values (v_org, v_generic, v_form_id, v_strength) returning id into v_ident;
          end if;
        end if;

        -- manufacturer and category are found by name, or created
        v_mfr := null;
        v_mfr_name := btrim(coalesce(v_row ->> 'manufacturer', ''));
        if v_mfr_name <> '' then
          select m.id into v_mfr from public.manufacturers m where m.organization_id = v_org and lower(m.name) = lower(v_mfr_name);
          if v_mfr is null then
            insert into public.manufacturers (organization_id, name) values (v_org, v_mfr_name) returning id into v_mfr;
          end if;
        end if;
        v_cat := null;
        v_cat_name := btrim(coalesce(v_row ->> 'category', ''));
        if v_cat_name <> '' then
          select c.id into v_cat from public.product_categories c
           where c.organization_id = v_org and (lower(c.name) = lower(v_cat_name) or c.code = upper(v_cat_name));
          if v_cat is null then
            v_code := left(trim(both '-' from regexp_replace(upper(v_cat_name), '[^A-Z0-9]+', '-', 'g')), 28);
            if v_code = '' then
              raise exception 'the category name is not valid';
            end if;
            v_i := 1;
            while exists (select 1 from public.product_categories c where c.organization_id = v_org and c.code = v_code) loop
              v_i := v_i + 1;
              v_code := left(trim(both '-' from regexp_replace(upper(v_cat_name), '[^A-Z0-9]+', '-', 'g')), 26) || '-' || v_i;
            end loop;
            insert into public.product_categories (organization_id, code, name) values (v_org, v_code, v_cat_name) returning id into v_cat;
          end if;
        end if;

        if upper(btrim(coalesce(nullif(v_row ->> 'storage', ''), 'AMBIENT'))) not in ('AMBIENT', 'COOL', 'REFRIGERATED', 'FROZEN') then
          raise exception 'storage must be AMBIENT, COOL, REFRIGERATED or FROZEN';
        end if;

        v_rx := private.parse_bool(v_row ->> 'requires_prescription', false);   -- always validated, whatever the class
        v_rx := v_rx or v_class in ('POM', 'CONTROLLED');
        insert into public.products (
          organization_id, sku, identity_id, brand_name, manufacturer_id, category_id, product_class, storage_condition,
          requires_prescription, is_controlled, fda_registration_number, base_unit_id, track_batches)
        values (
          v_org, v_sku, v_ident, btrim(v_row ->> 'brand_name'), v_mfr, v_cat, v_class,
          upper(btrim(coalesce(nullif(v_row ->> 'storage', ''), 'AMBIENT'))),
          v_rx,
          v_class = 'CONTROLLED', nullif(btrim(coalesce(v_row ->> 'fda_registration_number', '')), ''), v_base,
          private.parse_bool(v_row ->> 'track_batches', true))
        returning id into v_pid;

        -- pack levels (the base unit row was created with the product)
        v_target := (select u.id from public.product_units u where u.product_id = v_pid and u.is_base);
        for v_i in 1..2 loop
          v_unit := null;
          if btrim(coalesce(v_row ->> case v_i when 1 then 'pack_unit' else 'pack2_unit' end, '')) <> '' then
            select u.id into v_unit from public.units_of_measure u
             where u.is_active
               and (u.code = upper(btrim(v_row ->> case v_i when 1 then 'pack_unit' else 'pack2_unit' end))
                    or lower(u.name) = lower(btrim(v_row ->> case v_i when 1 then 'pack_unit' else 'pack2_unit' end)));
            if v_unit is null then
              raise exception 'the pack unit "%" is not recognised (for example BOX, CARTON, STRIP)', v_row ->> case v_i when 1 then 'pack_unit' else 'pack2_unit' end;
            end if;
            if v_unit = v_base then
              raise exception 'the pack unit must differ from the base unit';
            end if;
            begin
              v_size := (v_row ->> case v_i when 1 then 'pack_size' else 'pack2_size' end)::numeric;
            exception when others then
              raise exception 'the pack size must be a number';
            end;
            if v_size is null or v_size <= 1 then
              raise exception 'the pack size must be a number greater than 1 (how many base units it holds)';
            end if;
            insert into public.product_units (organization_id, product_id, unit_id, factor_to_base)
            values (v_org, v_pid, v_unit, v_size) returning id into v_pack;
            if v_i = 1 then
              v_target := v_pack;
            end if;
          end if;
        end loop;

        -- barcode: on the first pack level, or the base unit when there is none
        v_barcode := btrim(coalesce(v_row ->> 'barcode', ''));
        if v_barcode <> '' then
          insert into public.product_barcodes (organization_id, product_id, product_unit_id, barcode, barcode_type)
          values (v_org, v_pid, v_target, v_barcode, case when v_barcode ~ '^([0-9]{8}|[0-9]{12,14})$' then 'GTIN' else 'INTERNAL' end);
        end if;

        -- aliases: "name one; name two"
        for v_alias in select btrim(a) from unnest(string_to_array(coalesce(v_row ->> 'aliases', ''), ';')) as a loop
          if v_alias <> '' then
            insert into public.product_aliases (organization_id, alias, product_id, source)
            values (v_org, v_alias, v_pid, 'IMPORT') on conflict do nothing;
          end if;
        end loop;

        v_status := case when p_dry_run then 'VALID' else 'CREATED' end;
        if p_dry_run then
          raise exception using errcode = 'DRYRN', message = 'dry run';
        end if;
      end if;
    exception
      when sqlstate 'DRYRN' then
        null;                                   -- the row was fine; its changes are undone by this block
      when others then
        get stacked diagnostics v_constraint = constraint_name;
        v_status := 'ERROR';
        v_msg := private.friendly_error(sqlstate, v_constraint, sqlerrm);
    end;
    if v_status = 'CREATED' then v_created := v_created + 1;
    elsif v_status = 'EXISTS' then v_exists := v_exists + 1;
    elsif v_status = 'ERROR' then v_errors := v_errors + 1;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('row', v_n, 'key', v_sku, 'status', v_status, 'message', v_msg));
  end loop;

  if not p_dry_run then
    perform private.write_audit(v_org, 'product.imported', 'product_import', null, null, null,
      jsonb_build_object('rows', v_n, 'created', v_created, 'existing', v_exists, 'errors', v_errors), null, null);
  end if;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- suppliers
-- ---------------------------------------------------------------------------------------------------------
-- row keys (all text): code*, name*, supplier_type, registration_number, tax_number, licence_number, licence_expiry (YYYY-MM-DD),
--   payment_terms_days, currency_code, contact_name, phone, email, address, city, region, country (2 letters), notes
create function public.import_suppliers(p_rows jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org    uuid := private.current_organization_id();
  v_out    jsonb := '[]'::jsonb;
  v_row    jsonb;
  v_n      integer := 0;
  v_seen   text[] := '{}';
  v_code   text;
  v_status text;
  v_msg    text;
  v_type   text;
  v_constraint text;
  v_created integer := 0;
  v_exists  integer := 0;
  v_errors  integer := 0;
begin
  if v_org is null or not private.has_permission('suppliers.create') then
    raise exception 'insufficient privilege to import suppliers' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'no rows to import' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'import at most 500 rows at a time' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1;
    v_status := null; v_msg := null;
    v_code := upper(btrim(coalesce(v_row ->> 'code', '')));
    begin
      if jsonb_typeof(v_row) <> 'object' then
        raise exception 'this row is not valid';
      end if;
      if v_code !~ '^[A-Z0-9][A-Z0-9_-]{0,31}$' then
        raise exception 'the supplier code is missing or not valid (letters, numbers, - and _ only, up to 32)';
      end if;
      if v_code = any (v_seen) then
        raise exception 'the same supplier code appears more than once in this file';
      end if;
      v_seen := v_seen || v_code;

      if exists (select 1 from public.suppliers s where s.organization_id = v_org and s.code = v_code) then
        v_status := 'EXISTS';
        v_msg := 'already on file - left unchanged';
      else
        if btrim(coalesce(v_row ->> 'name', '')) = '' then
          raise exception 'the supplier name is missing';
        end if;
        v_type := upper(btrim(coalesce(nullif(v_row ->> 'supplier_type', ''), 'DISTRIBUTOR')));
        if v_type not in ('MANUFACTURER', 'IMPORTER', 'DISTRIBUTOR', 'WHOLESALER', 'OTHER') then
          raise exception 'unknown supplier type "%" (use MANUFACTURER, IMPORTER, DISTRIBUTOR, WHOLESALER or OTHER)', v_type;
        end if;
        insert into public.suppliers (
          organization_id, code, name, supplier_type, registration_number, tax_number, licence_number, licence_expiry,
          payment_terms_days, currency_code, contact_name, phone, email, address, city, region, country, notes)
        values (
          v_org, v_code, btrim(v_row ->> 'name'), v_type,
          nullif(btrim(coalesce(v_row ->> 'registration_number', '')), ''), nullif(btrim(coalesce(v_row ->> 'tax_number', '')), ''),
          nullif(btrim(coalesce(v_row ->> 'licence_number', '')), ''), nullif(btrim(coalesce(v_row ->> 'licence_expiry', '')), '')::date,
          coalesce(nullif(btrim(coalesce(v_row ->> 'payment_terms_days', '')), '')::integer, 30),
          nullif(upper(btrim(coalesce(v_row ->> 'currency_code', ''))), ''), nullif(btrim(coalesce(v_row ->> 'contact_name', '')), ''),
          nullif(btrim(coalesce(v_row ->> 'phone', '')), ''), nullif(btrim(coalesce(v_row ->> 'email', '')), ''),
          nullif(btrim(coalesce(v_row ->> 'address', '')), ''), nullif(btrim(coalesce(v_row ->> 'city', '')), ''),
          nullif(btrim(coalesce(v_row ->> 'region', '')), ''), nullif(upper(btrim(coalesce(v_row ->> 'country', ''))), ''),
          nullif(btrim(coalesce(v_row ->> 'notes', '')), ''));
        v_status := case when p_dry_run then 'VALID' else 'CREATED' end;
        if p_dry_run then
          raise exception using errcode = 'DRYRN', message = 'dry run';
        end if;
      end if;
    exception
      when sqlstate 'DRYRN' then
        null;
      when others then
        get stacked diagnostics v_constraint = constraint_name;
        v_status := 'ERROR';
        v_msg := private.friendly_error(sqlstate, v_constraint, sqlerrm);
    end;
    if v_status = 'CREATED' then v_created := v_created + 1;
    elsif v_status = 'EXISTS' then v_exists := v_exists + 1;
    elsif v_status = 'ERROR' then v_errors := v_errors + 1;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('row', v_n, 'key', v_code, 'status', v_status, 'message', v_msg));
  end loop;

  if not p_dry_run then
    perform private.write_audit(v_org, 'supplier.imported', 'supplier_import', null, null, null,
      jsonb_build_object('rows', v_n, 'created', v_created, 'existing', v_exists, 'errors', v_errors), null, null);
  end if;
  return v_out;
end;
$$;

revoke all on function private.parse_bool(text, boolean) from public, anon, authenticated;
revoke all on function private.friendly_error(text, text, text) from public, anon, authenticated;
revoke all on function public.import_products(jsonb, boolean) from public, anon;
revoke all on function public.import_suppliers(jsonb, boolean) from public, anon;
grant execute on function public.import_products(jsonb, boolean) to authenticated;
grant execute on function public.import_suppliers(jsonb, boolean) to authenticated;

commit;
