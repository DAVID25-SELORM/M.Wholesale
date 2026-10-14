-- Phase 4 / 02: batch costs, stock valuation, and the ledger learns about purchase returns
--
--   * batch_costs: what a batch cost per BASE unit. Written once, when the batch is created (by a receipt, opening stock or an
--     adjustment that carries a cost). Kept apart from `batches` so that cost is visible only with inventory.valuation, while
--     batches stay readable by everyone who can see stock.
--   * stock_valuation(): quantity x batch cost, per product. Stock whose batch has no cost is reported as "uncosted" rather
--     than silently valued at zero.
--   * RETURN documents: goods sent back to a supplier leave stock through the same ledger (movement RETURN_OUT).

-- ---------------------------------------------------------------------------------------------------------
-- batch costs
-- ---------------------------------------------------------------------------------------------------------
create table public.batch_costs (
  batch_id        uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  unit_cost_base  numeric(18, 6) not null check (unit_cost_base >= 0),
  created_at      timestamptz not null default now(),
  constraint batch_costs_batch_fk foreign key (batch_id, organization_id)
    references public.batches (id, organization_id) on delete restrict
);
create index batch_costs_org_idx on public.batch_costs (organization_id);

create trigger batch_costs_append_only before update or delete on public.batch_costs
  for each row execute function private.stock_block_mutation();
create trigger batch_costs_no_truncate before truncate on public.batch_costs
  for each statement execute function private.stock_block_mutation();

alter table public.batch_costs enable row level security;
revoke all on public.batch_costs from public, anon, authenticated;
grant select on public.batch_costs to authenticated;
create policy batch_costs_select on public.batch_costs
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission_anywhere('inventory.valuation'));

-- costs of batches that were already received through purchase orders
insert into public.batch_costs (batch_id, organization_id, unit_cost_base)
select distinct on (l.batch_id) l.batch_id, l.organization_id, l.unit_cost_base
from public.goods_receipt_lines l
where l.batch_id is not null
order by l.batch_id, l.id
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------------
-- ledger: purchase returns
-- ---------------------------------------------------------------------------------------------------------
alter table public.stock_documents drop constraint stock_documents_document_type_check;
alter table public.stock_documents add constraint stock_documents_document_type_check
  check (document_type in ('OPENING', 'ADJUSTMENT', 'TRANSFER', 'STATUS_CHANGE', 'RECEIPT', 'RETURN'));

alter table public.stock_documents drop constraint stock_documents_source_type_check;
alter table public.stock_documents add constraint stock_documents_source_type_check
  check (source_type is null or source_type in ('PURCHASE_ORDER', 'PURCHASE_RETURN', 'STOCK_COUNT'));

alter table public.stock_documents drop constraint stock_documents_reason_code_check;
alter table public.stock_documents add constraint stock_documents_reason_code_check
  check (reason_code is null or reason_code in
    ('OPENING', 'RECEIPT', 'RETURN_TO_SUPPLIER', 'COUNT_VARIANCE', 'DAMAGE', 'EXPIRY_WRITE_OFF', 'THEFT_LOSS', 'FOUND',
     'RETURN_TO_STOCK', 'QUALITY_HOLD', 'QUALITY_RELEASE', 'RECALL', 'REORGANISATION', 'OTHER'));

alter table public.stock_movements drop constraint stock_movements_movement_type_check;
alter table public.stock_movements add constraint stock_movements_movement_type_check
  check (movement_type in ('OPENING', 'RECEIPT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER_OUT', 'TRANSFER_IN',
                           'STATUS_OUT', 'STATUS_IN', 'RETURN_OUT'));
alter table public.stock_movements drop constraint stock_movements_sign;
alter table public.stock_movements add constraint stock_movements_sign check (
  quantity <> 0 and (
    (movement_type in ('OPENING', 'RECEIPT', 'ADJUSTMENT_IN', 'TRANSFER_IN', 'STATUS_IN') and quantity > 0) or
    (movement_type in ('ADJUSTMENT_OUT', 'TRANSFER_OUT', 'STATUS_OUT', 'RETURN_OUT') and quantity < 0)));

-- ---------------------------------------------------------------------------------------------------------
-- the posting engine: + RETURN documents, + batch cost on batch creation
-- ---------------------------------------------------------------------------------------------------------
-- A line that creates a batch may carry unit_cost (per entered pack) or unit_cost_base (per base unit).
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
  end;
  if v_perm is null then
    raise exception 'unknown document type' using errcode = '22023';
  end if;
  v_prefix := case p_document_type when 'OPENING' then 'OPN' when 'ADJUSTMENT' then 'ADJ'
                                   when 'TRANSFER' then 'TRF' when 'RECEIPT' then 'RCV' when 'RETURN' then 'RTN' else 'STS' end;

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

-- Receipts now pass the order's cost to the engine so received batches are costed.
create or replace function public.receive_goods(
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
      'manufacture_date', v_line -> 'manufacture_date', 'location_id', v_line -> 'location_id', 'status', v_status,
      'unit_cost_base', round(v_pol.unit_cost * v_pol.quantity_ordered / v_pol.ordered_base, 6)));
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
-- stock valuation
-- ---------------------------------------------------------------------------------------------------------
-- good stock = AVAILABLE + QUARANTINE (sellable or recoverable); DAMAGED and EXPIRED are reported but carry no value.
create function public.stock_valuation(p_warehouse_id uuid default null)
returns table (
  product_id       uuid,
  sku              text,
  brand_name       text,
  base_unit        text,
  good_quantity    numeric,
  other_quantity   numeric,
  uncosted_quantity numeric,
  value            numeric,
  total_count      bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not private.has_permission_anywhere('inventory.valuation') then
    raise exception 'insufficient privilege to see stock valuation' using errcode = '42501';
  end if;
  return query
  select p.id, p.sku::text, p.brand_name::text, u.code::text,
         coalesce(sum(b.quantity) filter (where b.stock_status in ('AVAILABLE', 'QUARANTINE')), 0),
         coalesce(sum(b.quantity) filter (where b.stock_status in ('DAMAGED', 'EXPIRED')), 0),
         coalesce(sum(b.quantity) filter (where b.stock_status in ('AVAILABLE', 'QUARANTINE') and c.batch_id is null), 0),
         coalesce(round(sum(b.quantity * c.unit_cost_base) filter (where b.stock_status in ('AVAILABLE', 'QUARANTINE')), 2), 0),
         count(*) over ()
  from public.stock_balances b
  join public.products p on p.id = b.product_id
  join public.units_of_measure u on u.id = p.base_unit_id
  left join public.batch_costs c on c.batch_id = b.batch_id
  where b.quantity > 0 and (p_warehouse_id is null or b.warehouse_id = p_warehouse_id)
  group by p.id, p.sku, p.brand_name, u.code
  order by p.brand_name, p.sku;
end;
$$;

revoke all on function public.stock_valuation(uuid) from public, anon;
grant execute on function public.stock_valuation(uuid) to authenticated;
