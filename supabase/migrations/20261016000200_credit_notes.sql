-- Phase 7 / 02: credit notes - returns of goods and price corrections on posted invoices
--
-- A posted invoice is never edited. A CREDIT NOTE corrects it. A credit note is a DRAFT until it is POSTED and always refers to one posted invoice.
-- Its lines are of two kinds:
--   RETURN  goods come back: the quantity (in the pack level sold) is credited at the price actually charged, and the goods re-enter stock in
--           the batches they were sold from. They come back as QUARANTINE (default) or DAMAGED for inspection; only someone holding
--           credit_notes.restock can return them straight to AVAILABLE. An expired batch can never come back AVAILABLE.
--   PRICE   a value-only correction on an invoice line (a pricing mistake, a rebate): no stock moves.
-- Nothing can be credited twice: per invoice line, returned quantity and credited value are capped at what was invoiced (tax follows the line's rate).
--
-- Posting (one transaction): re-checks the caps, returns the stock (document SALE_RETURN, movement SALE_RETURN_IN), numbers the credit note
-- (CRN-yyyy-nnnnnn, gap-free), and applies it to the invoice it corrects (as far as that invoice still owes). Whatever the invoice no longer owes
-- (it was already paid) stays as the customer's CREDIT, counted against what they owe and appliable to other invoices later.
-- A posted credit note cannot be changed. (Refunding credit in cash and reversing a credit note are not part of this phase.)

alter table public.stock_documents drop constraint stock_documents_document_type_check;
alter table public.stock_documents add constraint stock_documents_document_type_check
  check (document_type in ('OPENING', 'ADJUSTMENT', 'TRANSFER', 'STATUS_CHANGE', 'RECEIPT', 'RETURN', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIPT', 'SALE', 'SALE_RETURN'));
alter table public.stock_documents drop constraint stock_documents_source_type_check;
alter table public.stock_documents add constraint stock_documents_source_type_check
  check (source_type is null or source_type in ('PURCHASE_ORDER', 'PURCHASE_RETURN', 'STOCK_COUNT', 'STOCK_TRANSFER', 'SALES_INVOICE', 'CREDIT_NOTE'));
alter table public.stock_documents drop constraint stock_documents_reason_code_check;
alter table public.stock_documents add constraint stock_documents_reason_code_check
  check (reason_code is null or reason_code in
    ('OPENING', 'RECEIPT', 'RETURN_TO_SUPPLIER', 'RETURN_FROM_CUSTOMER', 'COUNT_VARIANCE', 'DAMAGE', 'EXPIRY_WRITE_OFF', 'THEFT_LOSS', 'FOUND',
     'RETURN_TO_STOCK', 'QUALITY_HOLD', 'QUALITY_RELEASE', 'RECALL', 'REORGANISATION', 'OTHER'));
alter table public.stock_movements drop constraint stock_movements_movement_type_check;
alter table public.stock_movements add constraint stock_movements_movement_type_check
  check (movement_type in ('OPENING', 'RECEIPT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER_OUT', 'TRANSFER_IN',
                           'STATUS_OUT', 'STATUS_IN', 'RETURN_OUT', 'SALE_OUT', 'SALE_RETURN_IN'));
alter table public.stock_movements drop constraint stock_movements_sign;
alter table public.stock_movements add constraint stock_movements_sign check (
  quantity <> 0 and (
    (movement_type in ('OPENING', 'RECEIPT', 'ADJUSTMENT_IN', 'TRANSFER_IN', 'STATUS_IN', 'SALE_RETURN_IN') and quantity > 0) or
    (movement_type in ('ADJUSTMENT_OUT', 'TRANSFER_OUT', 'STATUS_OUT', 'RETURN_OUT', 'SALE_OUT') and quantity < 0)));

-- the posting engine learns SALE_RETURN documents (authorised by post_credit_note(), not here)
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
    when 'SALE'              then 'sales.post'           -- authorised by post_sales_invoice(), not checked here
    when 'SALE_RETURN'       then 'credit_notes.post'    -- authorised by post_credit_note(), not checked here
    when 'TRANSFER_RECEIPT'  then 'inventory.transfer'   -- checked at the RECEIVING warehouse
  end;
  if v_perm is null then
    raise exception 'unknown document type' using errcode = '22023';
  end if;
  v_prefix := case p_document_type when 'OPENING' then 'OPN' when 'ADJUSTMENT' then 'ADJ'
                                   when 'TRANSFER' then 'TRF' when 'RECEIPT' then 'RCV' when 'RETURN' then 'RTN'
                                   when 'TRANSFER_DISPATCH' then 'DSP' when 'TRANSFER_RECEIPT' then 'TRC'
                                   when 'SALE' then 'SAL' when 'SALE_RETURN' then 'SRT' else 'STS' end;

  select * into v_wh from public.warehouses w
   where w.id = p_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;
  if p_document_type not in ('RECEIPT', 'RETURN', 'SALE', 'SALE_RETURN') and p_source_type is distinct from 'STOCK_COUNT' and not private.has_permission(v_perm, v_wh.branch_id) then
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
  elsif p_document_type = 'SALE_RETURN' then
    p_reason_code := 'RETURN_FROM_CUSTOMER';
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
      if (p_document_type in ('OPENING', 'RECEIPT', 'TRANSFER_RECEIPT', 'SALE_RETURN') and v_status = 'AVAILABLE')
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
    elsif p_document_type = 'SALE' then
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'SALE_OUT', v_wh.id, v_loc, v_prod.id, v_batch_id,
                                         v_status, -v_qty, v_unit.id, v_entered);
    elsif p_document_type = 'SALE_RETURN' then
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'SALE_RETURN_IN', v_wh.id, v_loc, v_prod.id, v_batch_id,
                                         v_status, v_qty, v_unit.id, v_entered);
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
-- invoices: a second way for the balance to go down
-- ---------------------------------------------------------------------------------------------------------
drop index public.sales_invoices_open_idx;
alter table public.sales_invoices drop constraint sales_invoices_paid_cap;
alter table public.sales_invoices drop column balance_due;
alter table public.sales_invoices add column amount_credited numeric(18, 2) not null default 0 check (amount_credited >= 0);
alter table public.sales_invoices add constraint sales_invoices_settled_cap check (amount_paid + amount_credited <= total_amount);
alter table public.sales_invoices add column balance_due numeric(18, 2) generated always as (total_amount - amount_paid - amount_credited) stored;
create index sales_invoices_open_idx on public.sales_invoices (organization_id, customer_id, due_date)
  where status = 'POSTED' and total_amount > amount_paid + amount_credited;

-- allocations get a composite key so credit-note returns can point at exactly which sale pick they reverse
alter table public.sales_invoice_allocations add constraint sales_invoice_allocations_id_org_key unique (id, organization_id);

-- ---------------------------------------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------------------------------------
create table public.sales_credit_notes (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete restrict
                        default private.current_organization_id(),
  credit_note_number  text,                                   -- assigned when posted
  sales_invoice_id    uuid not null,
  customer_id         uuid not null,
  branch_id           uuid not null,                          -- branch of the warehouse the goods come back to
  warehouse_id        uuid not null,
  status              text not null default 'DRAFT' check (status in ('DRAFT', 'POSTED', 'CANCELLED')),
  credit_date         date not null,
  reason_code         text not null check (reason_code in ('DAMAGED', 'EXPIRED', 'WRONG_ITEM', 'OVER_SUPPLY', 'QUALITY_COMPLAINT', 'RECALL', 'PRICE_ERROR', 'OTHER')),
  currency_code       text not null check (currency_code ~ '^[A-Z]{3}$'),
  notes               text check (notes is null or length(notes) <= 1000),
  subtotal            numeric(18, 2) not null default 0 check (subtotal >= 0),
  tax_total           numeric(18, 2) not null default 0 check (tax_total >= 0),
  total_amount        numeric(18, 2) not null default 0 check (total_amount >= 0),
  applied_amount      numeric(18, 2) not null default 0 check (applied_amount >= 0),
  unapplied_amount    numeric(18, 2) generated always as (total_amount - applied_amount) stored,
  stock_document_id   uuid,
  status_reason       text check (status_reason is null or length(status_reason) <= 500),
  created_by          uuid default auth.uid(),
  posted_by           uuid,
  posted_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint sales_credit_notes_invoice_fk foreign key (sales_invoice_id, organization_id)
    references public.sales_invoices (id, organization_id) on delete restrict,
  constraint sales_credit_notes_customer_fk foreign key (customer_id, organization_id)
    references public.customers (id, organization_id) on delete restrict,
  constraint sales_credit_notes_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint sales_credit_notes_warehouse_fk foreign key (warehouse_id, organization_id)
    references public.warehouses (id, organization_id) on delete restrict,
  constraint sales_credit_notes_stock_document_fk foreign key (stock_document_id, organization_id)
    references public.stock_documents (id, organization_id) on delete restrict,
  constraint sales_credit_notes_id_org_key unique (id, organization_id),
  constraint sales_credit_notes_total check (total_amount = subtotal + tax_total),
  constraint sales_credit_notes_applied_cap check (applied_amount <= total_amount),
  constraint sales_credit_notes_posted_complete check (
    (status = 'POSTED') = (credit_note_number is not null and posted_at is not null)
    or status <> 'POSTED' and credit_note_number is null)
);
create unique index sales_credit_notes_number_key on public.sales_credit_notes (organization_id, credit_note_number) where credit_note_number is not null;
create index sales_credit_notes_org_created_idx on public.sales_credit_notes (organization_id, created_at desc, id desc);
create index sales_credit_notes_branch_status_idx on public.sales_credit_notes (organization_id, branch_id, status, credit_date desc);
create index sales_credit_notes_invoice_idx on public.sales_credit_notes (sales_invoice_id, status);
create index sales_credit_notes_customer_idx on public.sales_credit_notes (customer_id, status);
create index sales_credit_notes_warehouse_idx on public.sales_credit_notes (warehouse_id);
create index sales_credit_notes_stock_document_idx on public.sales_credit_notes (stock_document_id) where stock_document_id is not null;
create trigger sales_credit_notes_immutable before update on public.sales_credit_notes
  for each row execute function private.prevent_column_change('organization_id', 'created_by', 'sales_invoice_id', 'customer_id');
create trigger sales_credit_notes_set_updated_at before update on public.sales_credit_notes
  for each row execute function private.set_updated_at();
create trigger sales_credit_notes_audit after insert or update on public.sales_credit_notes
  for each row execute function private.audit_row_change('sales_credit_note');

-- a posted credit note's content can never change; only the part applied to invoices moves afterwards
create function private.sales_credit_notes_posted_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'POSTED' and (
       new.status is distinct from old.status or new.branch_id is distinct from old.branch_id or new.warehouse_id is distinct from old.warehouse_id
       or new.credit_note_number is distinct from old.credit_note_number or new.credit_date is distinct from old.credit_date
       or new.reason_code is distinct from old.reason_code or new.subtotal is distinct from old.subtotal or new.tax_total is distinct from old.tax_total
       or new.total_amount is distinct from old.total_amount or new.currency_code is distinct from old.currency_code
       or new.stock_document_id is distinct from old.stock_document_id) then
    raise exception 'a posted credit note cannot be changed' using errcode = '42501';
  end if;
  if old.status = 'CANCELLED' then
    raise exception 'a cancelled credit note cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger sales_credit_notes_posted_lock before update on public.sales_credit_notes
  for each row execute function private.sales_credit_notes_posted_lock();
create trigger sales_credit_notes_no_delete before delete on public.sales_credit_notes
  for each row execute function private.stock_block_mutation();

create table public.sales_credit_note_lines (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete restrict
                      default private.current_organization_id(),
  credit_note_id    uuid not null,
  branch_id         uuid not null,
  line_no           integer not null check (line_no > 0),
  invoice_line_id   uuid not null,
  product_id        uuid not null,
  product_unit_id   uuid not null,
  line_type         text not null check (line_type in ('RETURN', 'PRICE')),
  quantity          numeric(18, 3),                       -- RETURN: in the pack level of product_unit_id
  base_quantity     numeric(18, 3),
  return_condition  text check (return_condition in ('QUARANTINE', 'AVAILABLE', 'DAMAGED')),
  batch_id          uuid,                                 -- optional: return from this sold batch only
  description       text check (description is null or length(description) <= 200),
  line_net          numeric(18, 2) not null check (line_net >= 0),
  line_tax          numeric(18, 2) not null check (line_tax >= 0),
  line_total        numeric(18, 2) not null check (line_total >= 0),
  constraint sales_credit_note_lines_credit_note_fk foreign key (credit_note_id, organization_id)
    references public.sales_credit_notes (id, organization_id) on delete restrict,
  constraint sales_credit_note_lines_invoice_line_fk foreign key (invoice_line_id, organization_id)
    references public.sales_invoice_lines (id, organization_id) on delete restrict,
  constraint sales_credit_note_lines_product_fk foreign key (product_id, organization_id)
    references public.products (id, organization_id) on delete restrict,
  constraint sales_credit_note_lines_unit_fk foreign key (product_unit_id, product_id, organization_id)
    references public.product_units (id, product_id, organization_id) on delete restrict,
  constraint sales_credit_note_lines_batch_fk foreign key (batch_id, product_id, organization_id)
    references public.batches (id, product_id, organization_id) on delete restrict,
  constraint sales_credit_note_lines_line_key unique (credit_note_id, line_no),
  constraint sales_credit_note_lines_id_org_key unique (id, organization_id),
  constraint sales_credit_note_lines_total check (line_total = line_net + line_tax),
  constraint sales_credit_note_lines_kind check (
    (line_type = 'RETURN' and quantity > 0 and base_quantity > 0 and return_condition is not null)
    or (line_type = 'PRICE' and quantity is null and base_quantity is null and return_condition is null and batch_id is null))
);
create index sales_credit_note_lines_invoice_line_idx on public.sales_credit_note_lines (invoice_line_id);
create index sales_credit_note_lines_product_idx on public.sales_credit_note_lines (organization_id, product_id);
create index sales_credit_note_lines_unit_idx on public.sales_credit_note_lines (product_unit_id);
create index sales_credit_note_lines_batch_idx on public.sales_credit_note_lines (batch_id) where batch_id is not null;

create function private.sales_credit_note_lines_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  select n.status into v_status from public.sales_credit_notes n where n.id = old.credit_note_id;
  if v_status is distinct from 'DRAFT' then
    raise exception 'the lines of a % credit note cannot be changed', lower(coalesce(v_status, 'missing')) using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger sales_credit_note_lines_lock before update or delete on public.sales_credit_note_lines
  for each row execute function private.sales_credit_note_lines_lock();

-- which sold batch each returned unit went back to (and in what condition): recalls and expiry claims depend on it
create table public.sales_credit_note_returns (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete restrict,
  credit_note_id        uuid not null,
  credit_note_line_id   uuid not null,
  invoice_allocation_id uuid not null,
  branch_id             uuid not null,
  product_id            uuid not null,
  batch_id              uuid,
  location_id           uuid references public.warehouse_locations (id) on delete restrict,
  base_quantity         numeric(18, 3) not null check (base_quantity > 0),
  return_condition      text not null check (return_condition in ('QUARANTINE', 'AVAILABLE', 'DAMAGED')),
  constraint sales_credit_note_returns_credit_note_fk foreign key (credit_note_id, organization_id)
    references public.sales_credit_notes (id, organization_id) on delete restrict,
  constraint sales_credit_note_returns_line_fk foreign key (credit_note_line_id, organization_id)
    references public.sales_credit_note_lines (id, organization_id) on delete restrict,
  constraint sales_credit_note_returns_allocation_fk foreign key (invoice_allocation_id, organization_id)
    references public.sales_invoice_allocations (id, organization_id) on delete restrict,
  constraint sales_credit_note_returns_batch_fk foreign key (batch_id, product_id, organization_id)
    references public.batches (id, product_id, organization_id) on delete restrict
);
create index sales_credit_note_returns_note_idx on public.sales_credit_note_returns (credit_note_id);
create index sales_credit_note_returns_allocation_idx on public.sales_credit_note_returns (invoice_allocation_id);
create index sales_credit_note_returns_batch_idx on public.sales_credit_note_returns (batch_id) where batch_id is not null;
create trigger sales_credit_note_returns_append_only before update or delete on public.sales_credit_note_returns
  for each row execute function private.stock_block_mutation();

-- how a credit note's value was applied to invoices
create table public.credit_note_allocations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict,
  credit_note_id   uuid not null,
  sales_invoice_id uuid not null,
  branch_id        uuid not null,                  -- the credit note's branch
  amount           numeric(18, 2) not null check (amount > 0),
  created_at       timestamptz not null default clock_timestamp(),
  constraint credit_note_allocations_credit_note_fk foreign key (credit_note_id, organization_id)
    references public.sales_credit_notes (id, organization_id) on delete restrict,
  constraint credit_note_allocations_invoice_fk foreign key (sales_invoice_id, organization_id)
    references public.sales_invoices (id, organization_id) on delete restrict
);
create index credit_note_allocations_note_idx on public.credit_note_allocations (credit_note_id);
create index credit_note_allocations_invoice_idx on public.credit_note_allocations (sales_invoice_id);
create trigger credit_note_allocations_append_only before update or delete on public.credit_note_allocations
  for each row execute function private.stock_block_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- RLS and grants: read only; every write goes through the functions below
-- ---------------------------------------------------------------------------------------------------------
alter table public.sales_credit_notes        enable row level security;
alter table public.sales_credit_note_lines   enable row level security;
alter table public.sales_credit_note_returns enable row level security;
alter table public.credit_note_allocations   enable row level security;
revoke all on public.sales_credit_notes, public.sales_credit_note_lines, public.sales_credit_note_returns, public.credit_note_allocations
  from public, anon, authenticated;
grant select on public.sales_credit_notes, public.sales_credit_note_lines, public.sales_credit_note_returns, public.credit_note_allocations
  to authenticated;

create policy sales_credit_notes_select on public.sales_credit_notes for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('credit_notes.view', branch_id));
create policy sales_credit_note_lines_select on public.sales_credit_note_lines for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('credit_notes.view', branch_id));
create policy sales_credit_note_returns_select on public.sales_credit_note_returns for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('credit_notes.view', branch_id));
create policy credit_note_allocations_select on public.credit_note_allocations for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('credit_notes.view', branch_id));

-- ---------------------------------------------------------------------------------------------------------
-- what a credit note line is worth, and what can still be credited on an invoice line
-- ---------------------------------------------------------------------------------------------------------
-- p_extra_*: what EARLIER lines of the same draft already take from the same invoice line
create function private.credit_line_amounts(
  p_org uuid, p_invoice_line_id uuid, p_type text, p_quantity numeric, p_amount numeric,
  p_extra_net numeric, p_extra_tax numeric, p_extra_qty numeric
)
returns table (net numeric, tax numeric, base_quantity numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_il     public.sales_invoice_lines;
  v_factor numeric;
  v_pnet   numeric;
  v_ptax   numeric;
  v_pqty   numeric;
  v_rnet   numeric;
  v_rtax   numeric;
  v_rqty   numeric;
  v_net    numeric;
  v_tax    numeric;
begin
  select * into v_il from public.sales_invoice_lines l where l.id = p_invoice_line_id and l.organization_id = p_org;
  if not found then
    raise exception 'that invoice line was not found' using errcode = 'P0002';
  end if;
  select u.factor_to_base into v_factor from public.product_units u where u.id = v_il.product_unit_id;
  select coalesce(sum(c.line_net), 0), coalesce(sum(c.line_tax), 0), coalesce(sum(c.quantity) filter (where c.line_type = 'RETURN'), 0)
    into v_pnet, v_ptax, v_pqty
  from public.sales_credit_note_lines c
  join public.sales_credit_notes n on n.id = c.credit_note_id
  where c.invoice_line_id = p_invoice_line_id and n.status = 'POSTED';
  v_rnet := v_il.line_net - v_pnet - p_extra_net;
  v_rtax := v_il.line_tax - v_ptax - p_extra_tax;
  v_rqty := v_il.quantity - v_pqty - p_extra_qty;

  if p_type = 'RETURN' then
    if p_quantity > v_rqty then
      raise exception 'only % can still be returned on this line (% were invoiced, % already credited)', trim_scale(v_rqty), trim_scale(v_il.quantity), trim_scale(v_il.quantity - v_rqty)
        using errcode = '22023';
    end if;
    if p_quantity = v_rqty then
      v_net := v_rnet;                       -- the last of the line: exactly what is left, so cents never go missing or double
      v_tax := v_rtax;
    else
      v_net := least(v_rnet, round(p_quantity * v_il.unit_price * (1 - v_il.discount_percent / 100), 2));
      v_tax := least(v_rtax, round(v_net * v_il.tax_rate / 100, 2));
    end if;
    return query select v_net, v_tax, round(p_quantity * v_factor, 3);
  else
    if p_amount > v_rnet then
      raise exception 'only % can still be credited on this line', trim_scale(v_rnet) using errcode = '22023';
    end if;
    v_net := p_amount;
    v_tax := case when v_net = v_rnet then v_rtax else least(v_rtax, round(v_net * v_il.tax_rate / 100, 2)) end;
    return query select v_net, v_tax, null::numeric;
  end if;
end;
$$;

-- per invoice line: what was sold, what has been credited, what is left (the credit note form uses this)
create function public.invoice_creditable(p_invoice_id uuid)
returns table (invoice_line_id uuid, line_no integer, quantity numeric, returned_quantity numeric, remaining_quantity numeric,
               line_net numeric, credited_net numeric, remaining_net numeric, line_tax numeric, credited_tax numeric, remaining_tax numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  select l.id, l.line_no, l.quantity, coalesce(c.qty, 0), l.quantity - coalesce(c.qty, 0), l.line_net, coalesce(c.net, 0), l.line_net - coalesce(c.net, 0),
         l.line_tax, coalesce(c.tax, 0), l.line_tax - coalesce(c.tax, 0)
  from public.sales_invoice_lines l
  left join lateral (
    select sum(x.quantity) filter (where x.line_type = 'RETURN') as qty, sum(x.line_net) as net, sum(x.line_tax) as tax
    from public.sales_credit_note_lines x
    join public.sales_credit_notes n on n.id = x.credit_note_id and n.status = 'POSTED'
    where x.invoice_line_id = l.id) c on true
  where l.sales_invoice_id = p_invoice_id
  order by l.line_no
$$;

-- ---------------------------------------------------------------------------------------------------------
-- drafts
-- ---------------------------------------------------------------------------------------------------------
-- p_lines: [{ type: 'RETURN', invoice_line_id, quantity, condition?: QUARANTINE|AVAILABLE|DAMAGED, batch_id? }
--           { type: 'PRICE',  invoice_line_id, amount, description? }]
-- p_warehouse_id: where returned goods go (default: the invoice's warehouse)
create function public.save_credit_note(
  p_id uuid,
  p_invoice_id uuid,
  p_warehouse_id uuid,
  p_reason_code text,
  p_notes text,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.current_organization_id();
  v_inv     public.sales_invoices;
  v_wh      public.warehouses;
  v_note    public.sales_credit_notes;
  v_today   date;
  v_line    jsonb;
  v_n       integer := 0;
  v_il      public.sales_invoice_lines;
  v_type    text;
  v_qty     numeric;
  v_amount  numeric;
  v_cond    text;
  v_batch   uuid;
  v_amt     record;
  v_acc     jsonb := '{}'::jsonb;
  v_key     text;
  v_sub     numeric := 0;
  v_taxsum  numeric := 0;
  v_desc    text;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_inv from public.sales_invoices i where i.id = p_invoice_id and i.organization_id = v_org;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if v_inv.status <> 'POSTED' then
    raise exception 'only a posted invoice can be credited (this one is %)', v_inv.status using errcode = '22023';
  end if;
  select * into v_wh from public.warehouses w where w.id = coalesce(p_warehouse_id, v_inv.warehouse_id) and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'the warehouse the goods come back to was not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('credit_notes.create', v_wh.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if p_reason_code is null or p_reason_code not in ('DAMAGED', 'EXPIRED', 'WRONG_ITEM', 'OVER_SUPPLY', 'QUALITY_COMPLAINT', 'RECALL', 'PRICE_ERROR', 'OTHER') then
    raise exception 'choose the reason for the credit note' using errcode = '22023';
  end if;
  if p_notes is not null and length(p_notes) > 1000 then
    raise exception 'notes are limited to 1000 characters' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'add at least one line' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'a credit note is limited to 200 lines' using errcode = '22023';
  end if;
  select (now() at time zone o.timezone)::date into v_today from public.organizations o where o.id = v_org;

  if p_id is null then
    insert into public.sales_credit_notes (organization_id, sales_invoice_id, customer_id, branch_id, warehouse_id, credit_date, reason_code, currency_code, notes)
    values (v_org, v_inv.id, v_inv.customer_id, v_wh.branch_id, v_wh.id, v_today, p_reason_code, v_inv.currency_code, nullif(btrim(p_notes), ''))
    returning * into v_note;
  else
    select * into v_note from public.sales_credit_notes n where n.id = p_id and n.organization_id = v_org for update;
    if not found then
      raise exception 'credit note not found' using errcode = 'P0002';
    end if;
    if v_note.sales_invoice_id <> v_inv.id then
      raise exception 'a credit note cannot be moved to another invoice' using errcode = '22023';
    end if;
    if v_note.status <> 'DRAFT' then
      raise exception 'only a draft credit note can be edited (this one is %)', v_note.status using errcode = '22023';
    end if;
    if not private.has_permission('credit_notes.create', v_note.branch_id) then
      raise exception 'insufficient privilege for this branch' using errcode = '42501';
    end if;
    update public.sales_credit_notes
       set branch_id = v_wh.branch_id, warehouse_id = v_wh.id, credit_date = v_today, reason_code = p_reason_code, notes = nullif(btrim(p_notes), '')
     where id = v_note.id;
    delete from public.sales_credit_note_lines where credit_note_id = v_note.id;
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'line %: invalid line', v_n using errcode = '22023';
    end if;
    v_type := upper(coalesce(v_line ->> 'type', 'RETURN'));
    if v_type not in ('RETURN', 'PRICE') then
      raise exception 'line %: the type must be RETURN or PRICE', v_n using errcode = '22023';
    end if;
    select * into v_il from public.sales_invoice_lines l
     where l.id = nullif(v_line ->> 'invoice_line_id', '')::uuid and l.sales_invoice_id = v_inv.id and l.organization_id = v_org;
    if not found then
      raise exception 'line %: that line is not on the invoice', v_n using errcode = 'P0002';
    end if;
    v_key := v_il.id::text;
    v_qty := null; v_amount := null; v_cond := null; v_batch := null; v_desc := null;

    if v_type = 'RETURN' then
      if jsonb_typeof(v_line -> 'quantity') is distinct from 'number' or (v_line ->> 'quantity')::numeric <= 0 then
        raise exception 'line %: quantity must be a positive number', v_n using errcode = '22023';
      end if;
      v_qty := (v_line ->> 'quantity')::numeric;
      if v_qty <> round(v_qty, 3) then
        raise exception 'line %: quantity can have at most 3 decimals', v_n using errcode = '22023';
      end if;
      v_cond := upper(coalesce(nullif(v_line ->> 'condition', ''), 'QUARANTINE'));
      if v_cond not in ('QUARANTINE', 'AVAILABLE', 'DAMAGED') then
        raise exception 'line %: the condition must be QUARANTINE, AVAILABLE or DAMAGED', v_n using errcode = '22023';
      end if;
      if v_cond = 'AVAILABLE' and not private.has_permission('credit_notes.restock', v_wh.branch_id) then
        raise exception 'line %: you are not allowed to return goods straight to sellable stock - choose quarantine for inspection', v_n using errcode = '42501';
      end if;
      v_batch := nullif(v_line ->> 'batch_id', '')::uuid;
      if v_batch is not null and not exists (
           select 1 from public.sales_invoice_allocations a where a.sales_invoice_line_id = v_il.id and a.batch_id = v_batch) then
        raise exception 'line %: that batch was not sold on this invoice line', v_n using errcode = 'P0002';
      end if;
    else
      if jsonb_typeof(v_line -> 'amount') is distinct from 'number' or (v_line ->> 'amount')::numeric <= 0 then
        raise exception 'line %: the amount must be a positive number', v_n using errcode = '22023';
      end if;
      v_amount := (v_line ->> 'amount')::numeric;
      if v_amount <> round(v_amount, 2) then
        raise exception 'line %: the amount can have at most 2 decimals', v_n using errcode = '22023';
      end if;
      v_desc := nullif(btrim(coalesce(v_line ->> 'description', '')), '');
      if v_desc is not null and length(v_desc) > 200 then
        raise exception 'line %: the description is limited to 200 characters', v_n using errcode = '22023';
      end if;
    end if;

    begin
      select * into v_amt from private.credit_line_amounts(
        v_org, v_il.id, v_type, v_qty, v_amount,
        coalesce((v_acc -> v_key ->> 'net')::numeric, 0), coalesce((v_acc -> v_key ->> 'tax')::numeric, 0), coalesce((v_acc -> v_key ->> 'qty')::numeric, 0));
    exception when sqlstate '22023' then
      raise exception 'line %: %', v_n, sqlerrm using errcode = '22023';
    end;
    v_acc := jsonb_set(v_acc, array[v_key], jsonb_build_object(
      'net', coalesce((v_acc -> v_key ->> 'net')::numeric, 0) + v_amt.net,
      'tax', coalesce((v_acc -> v_key ->> 'tax')::numeric, 0) + v_amt.tax,
      'qty', coalesce((v_acc -> v_key ->> 'qty')::numeric, 0) + coalesce(v_qty, 0)));
    v_sub := v_sub + v_amt.net;
    v_taxsum := v_taxsum + v_amt.tax;

    insert into public.sales_credit_note_lines (
      organization_id, credit_note_id, branch_id, line_no, invoice_line_id, product_id, product_unit_id, line_type, quantity, base_quantity,
      return_condition, batch_id, description, line_net, line_tax, line_total)
    values (v_org, v_note.id, v_wh.branch_id, v_n, v_il.id, v_il.product_id, v_il.product_unit_id, v_type, v_qty, v_amt.base_quantity,
            v_cond, v_batch, v_desc, v_amt.net, v_amt.tax, v_amt.net + v_amt.tax);
  end loop;

  if v_sub + v_taxsum <= 0 then
    raise exception 'the credit note has no value' using errcode = '22023';
  end if;
  update public.sales_credit_notes set subtotal = v_sub, tax_total = v_taxsum, total_amount = v_sub + v_taxsum where id = v_note.id;
  return v_note.id;
end;
$$;

create function public.cancel_credit_note(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid := private.current_organization_id();
  v_note public.sales_credit_notes;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_note from public.sales_credit_notes n where n.id = p_id and n.organization_id = v_org for update;
  if not found then
    raise exception 'credit note not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('credit_notes.create', v_note.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_note.status <> 'DRAFT' then
    raise exception 'only a draft credit note can be cancelled (this one is %)', v_note.status using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.sales_credit_notes set status = 'CANCELLED', status_reason = btrim(p_reason) where id = v_note.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- applying credit to invoices (internal engine shared by posting and apply_credit_note)
-- ---------------------------------------------------------------------------------------------------------
-- p_allocations: [{ invoice_id, amount }]. Locks the invoices in id order, checks each against what is still owed, applies.
create function private.apply_credit_allocations(p_note public.sales_credit_notes, p_allocations jsonb)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row    record;
  v_inv    public.sales_invoices;
  v_amount numeric;
  v_total  numeric := 0;
  v_left   numeric;
begin
  for v_row in
    select (a.value ->> 'invoice_id')::uuid as invoice_id, (a.value ->> 'amount')::numeric as amount
    from jsonb_array_elements(p_allocations) a
    order by (a.value ->> 'invoice_id')::uuid
  loop
    v_amount := v_row.amount;
    if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
      raise exception 'an allocation must be a positive amount with at most 2 decimals' using errcode = '22023';
    end if;
    select * into v_inv from public.sales_invoices i
     where i.id = v_row.invoice_id and i.organization_id = p_note.organization_id for update;
    if not found or v_inv.customer_id <> p_note.customer_id then
      raise exception 'an invoice does not belong to this customer' using errcode = 'P0002';
    end if;
    if v_inv.status <> 'POSTED' then
      raise exception 'credit can only be applied to a posted invoice (% is %)', coalesce(v_inv.invoice_number, 'a draft'), v_inv.status using errcode = '22023';
    end if;
    if v_amount > v_inv.balance_due then
      raise exception 'invoice % only has % left to pay', v_inv.invoice_number, v_inv.balance_due using errcode = '22023';
    end if;
    insert into public.credit_note_allocations (organization_id, credit_note_id, sales_invoice_id, branch_id, amount)
    values (p_note.organization_id, p_note.id, v_inv.id, p_note.branch_id, v_amount);
    update public.sales_invoices set amount_credited = amount_credited + v_amount where id = v_inv.id;
    v_total := v_total + v_amount;
  end loop;
  select n.unapplied_amount into v_left from public.sales_credit_notes n where n.id = p_note.id;
  if v_total > v_left then
    raise exception 'the allocations (%) exceed what is left of this credit note (%)', v_total, v_left using errcode = '22023';
  end if;
  update public.sales_credit_notes set applied_amount = applied_amount + v_total where id = p_note.id;
  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- posting
-- ---------------------------------------------------------------------------------------------------------
create function public.post_credit_note(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.current_organization_id();
  v_note    public.sales_credit_notes;
  v_inv     public.sales_invoices;
  v_wh      public.warehouses;
  v_today   date;
  v_line    record;
  v_alloc   record;
  v_amt     record;
  v_acc     jsonb := '{}'::jsonb;
  v_key     text;
  v_sub     numeric := 0;
  v_taxsum  numeric := 0;
  v_base_unit uuid;
  v_remaining numeric;
  v_take    numeric;
  v_loc     uuid;
  v_stock_lines jsonb := '[]'::jsonb;
  v_return_rows jsonb := '[]'::jsonb;
  v_stock   jsonb;
  v_doc_id  uuid;
  v_number  text;
  v_apply   numeric;
  v_prod    public.products;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_note from public.sales_credit_notes n where n.id = p_id and n.organization_id = v_org for update;
  if not found then
    raise exception 'credit note not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('credit_notes.post', v_note.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_note.status <> 'DRAFT' then
    raise exception 'only a draft credit note can be posted (this one is %)', v_note.status using errcode = '22023';
  end if;
  -- the invoice is locked first: concurrent credit notes on it are serialised, so nothing can be credited twice
  select * into v_inv from public.sales_invoices i where i.id = v_note.sales_invoice_id and i.organization_id = v_org for update;
  if v_inv.status <> 'POSTED' then
    raise exception 'the invoice is not posted' using errcode = '22023';
  end if;
  select * into v_wh from public.warehouses w where w.id = v_note.warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'the warehouse the goods come back to is no longer active' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sales_credit_note_lines l where l.credit_note_id = v_note.id) then
    raise exception 'the credit note has no lines' using errcode = '22023';
  end if;
  select (now() at time zone o.timezone)::date into v_today from public.organizations o where o.id = v_org;

  -- 1. re-price every line against what has been credited meanwhile, and prepare the returned stock
  for v_line in
    select l.* from public.sales_credit_note_lines l where l.credit_note_id = v_note.id order by l.line_no
  loop
    v_key := v_line.invoice_line_id::text;
    begin
      select * into v_amt from private.credit_line_amounts(
        v_org, v_line.invoice_line_id, v_line.line_type, v_line.quantity, v_line.line_net,
        coalesce((v_acc -> v_key ->> 'net')::numeric, 0), coalesce((v_acc -> v_key ->> 'tax')::numeric, 0), coalesce((v_acc -> v_key ->> 'qty')::numeric, 0));
    exception when sqlstate '22023' then
      raise exception 'line %: %', v_line.line_no, sqlerrm using errcode = '22023';
    end;
    v_acc := jsonb_set(v_acc, array[v_key], jsonb_build_object(
      'net', coalesce((v_acc -> v_key ->> 'net')::numeric, 0) + v_amt.net,
      'tax', coalesce((v_acc -> v_key ->> 'tax')::numeric, 0) + v_amt.tax,
      'qty', coalesce((v_acc -> v_key ->> 'qty')::numeric, 0) + coalesce(v_line.quantity, 0)));
    v_sub := v_sub + v_amt.net;
    v_taxsum := v_taxsum + v_amt.tax;
    if v_amt.net <> v_line.line_net or v_amt.tax <> v_line.line_tax then
      update public.sales_credit_note_lines set line_net = v_amt.net, line_tax = v_amt.tax, line_total = v_amt.net + v_amt.tax where id = v_line.id;
    end if;

    if v_line.line_type = 'RETURN' then
      select * into v_prod from public.products p where p.id = v_line.product_id;
      select u.id into v_base_unit from public.product_units u where u.product_id = v_line.product_id and u.is_base;
      v_remaining := v_line.base_quantity;
      for v_alloc in
        select a.id, a.batch_id, a.location_id,
               a.base_quantity - coalesce((select sum(r.base_quantity) from public.sales_credit_note_returns r where r.invoice_allocation_id = a.id), 0)
                 - coalesce((select sum((x ->> 'qty')::numeric) from jsonb_array_elements(v_return_rows) x where (x ->> 'allocation_id')::uuid = a.id), 0) as room
        from public.sales_invoice_allocations a
        left join public.batches ba on ba.id = a.batch_id
        where a.sales_invoice_line_id = v_line.invoice_line_id and (v_line.batch_id is null or a.batch_id = v_line.batch_id)
        order by ba.expiry_date desc nulls last, a.id    -- the batch picked LAST (latest expiry) comes back first
      loop
        exit when v_remaining <= 0;
        v_take := least(v_alloc.room, v_remaining);
        if v_take <= 0 then
          continue;
        end if;
        v_loc := case when v_note.warehouse_id = v_inv.warehouse_id and v_alloc.location_id is not null
                       and exists (select 1 from public.warehouse_locations wl where wl.id = v_alloc.location_id and wl.warehouse_id = v_wh.id and wl.is_active)
                      then v_alloc.location_id end;
        v_stock_lines := v_stock_lines || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'product_id', v_line.product_id, 'batch_id', v_alloc.batch_id, 'location_id', v_loc,
          'status', v_line.return_condition, 'quantity', v_take, 'product_unit_id', v_base_unit)));
        v_return_rows := v_return_rows || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'line_id', v_line.id, 'allocation_id', v_alloc.id, 'product_id', v_line.product_id, 'batch_id', v_alloc.batch_id, 'location_id', v_loc,
          'qty', v_take, 'condition', v_line.return_condition)));
        v_remaining := v_remaining - v_take;
      end loop;
      if v_remaining > 0 then
        raise exception 'line %: % cannot be traced back to the batches sold (% still unaccounted for)', v_line.line_no, v_prod.sku, v_remaining
          using errcode = '22023';
      end if;
    end if;
  end loop;
  if v_sub + v_taxsum <= 0 then
    raise exception 'the credit note has no value' using errcode = '22023';
  end if;

  -- 2. the goods come back (all or nothing with everything else)
  if jsonb_array_length(v_stock_lines) > 0 then
    v_stock := private.post_stock('SALE_RETURN', v_wh.id, v_stock_lines, null, null, null, 'CREDIT_NOTE', v_note.id);
    v_doc_id := (v_stock ->> 'document_id')::uuid;
    insert into public.sales_credit_note_returns (organization_id, credit_note_id, credit_note_line_id, invoice_allocation_id, branch_id, product_id, batch_id, location_id, base_quantity, return_condition)
    select v_org, v_note.id, (r.value ->> 'line_id')::uuid, (r.value ->> 'allocation_id')::uuid, v_note.branch_id, (r.value ->> 'product_id')::uuid,
           nullif(r.value ->> 'batch_id', '')::uuid, nullif(r.value ->> 'location_id', '')::uuid, (r.value ->> 'qty')::numeric, r.value ->> 'condition'
    from jsonb_array_elements(v_return_rows) r;
  end if;

  -- 3. number it, then apply it to the invoice it corrects (as far as that invoice still owes)
  v_number := private.generate_document_number(v_org, null, 'CREDIT_NOTE', 'CRN');
  update public.sales_credit_notes
     set status = 'POSTED', credit_note_number = v_number, credit_date = v_today, subtotal = v_sub, tax_total = v_taxsum, total_amount = v_sub + v_taxsum,
         stock_document_id = v_doc_id, posted_by = auth.uid(), posted_at = now()
   where id = v_note.id
  returning * into v_note;
  v_apply := least(v_note.total_amount, v_inv.balance_due);
  if v_apply > 0 then
    perform private.apply_credit_allocations(v_note, jsonb_build_array(jsonb_build_object('invoice_id', v_inv.id, 'amount', v_apply)));
  end if;

  return jsonb_build_object('credit_note_number', v_number, 'total_amount', v_note.total_amount, 'applied', coalesce(v_apply, 0),
                            'unapplied', v_note.total_amount - coalesce(v_apply, 0), 'stock_document_number', v_stock ->> 'document_number');
end;
$$;

-- Applies the unused part of a posted credit note to invoices (p_allocations [{ invoice_id, amount }], or oldest-due-first when null).
create function public.apply_credit_note(p_id uuid, p_allocations jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_note  public.sales_credit_notes;
  v_alloc jsonb;
  v_done  numeric := 0;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_note from public.sales_credit_notes n where n.id = p_id and n.organization_id = v_org for update;
  if not found then
    raise exception 'credit note not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('credit_notes.post', v_note.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_note.status <> 'POSTED' then
    raise exception 'only a posted credit note can be applied (this one is %)', v_note.status using errcode = '22023';
  end if;
  if v_note.unapplied_amount <= 0 then
    raise exception 'this credit note has nothing left to apply' using errcode = '22023';
  end if;
  if p_allocations is not null and (jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 or jsonb_array_length(p_allocations) > 100) then
    raise exception 'allocations must be a list of up to 100 invoices' using errcode = '22023';
  end if;
  v_alloc := coalesce(p_allocations, private.fifo_allocations(v_org, v_note.customer_id, v_note.unapplied_amount));
  if jsonb_array_length(v_alloc) > 0 then
    v_done := private.apply_credit_allocations(v_note, v_alloc);
  end if;
  return jsonb_build_object('applied', v_done);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- credit position: unused credit notes count as the customer's credit, like unallocated receipts
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.customer_position(p_org uuid, p_customer_id uuid)
returns table (outstanding numeric, credit_held numeric, credit_limit numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select sum(i.balance_due) from public.sales_invoices i
                    where i.organization_id = p_org and i.customer_id = p_customer_id and i.status = 'POSTED'), 0),
         coalesce((select sum(r.unallocated_amount) from public.customer_receipts r
                    where r.organization_id = p_org and r.customer_id = p_customer_id and r.status = 'POSTED'), 0)
         + coalesce((select sum(n.unapplied_amount) from public.sales_credit_notes n
                      where n.organization_id = p_org and n.customer_id = p_customer_id and n.status = 'POSTED'), 0),
         (select c.credit_limit from public.customers c where c.id = p_customer_id and c.organization_id = p_org)
$$;

create or replace function public.customer_credit(p_customer_id uuid)
returns table (outstanding numeric, overdue numeric, credit_held numeric, credit_limit numeric, available numeric, on_hold boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  select o.outstanding, o.overdue, h.held, c.credit_limit, greatest(0, c.credit_limit - o.outstanding + h.held), c.on_hold
  from public.customers c
  cross join lateral (
    select coalesce(sum(i.balance_due), 0) as outstanding,
           coalesce(sum(i.balance_due) filter (where i.due_date < current_date), 0) as overdue
    from public.sales_invoices i where i.customer_id = c.id and i.status = 'POSTED') o
  cross join lateral (
    select coalesce((select sum(r.unallocated_amount) from public.customer_receipts r where r.customer_id = c.id and r.status = 'POSTED'), 0)
         + coalesce((select sum(n.unapplied_amount) from public.sales_credit_notes n where n.customer_id = c.id and n.status = 'POSTED'), 0) as held) h
  where c.id = p_customer_id
$$;

create or replace function public.receivables_summary()
returns table (
  customer_id     uuid,
  customer_name   text,
  currency_code   text,
  outstanding     numeric,
  not_due         numeric,
  overdue_1_30    numeric,
  overdue_31_60   numeric,
  overdue_61_90   numeric,
  overdue_over_90 numeric,
  credit_held     numeric,
  credit_limit    numeric,
  on_hold         boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with inv as (
    select i.customer_id, i.currency_code,
           sum(i.balance_due) as outstanding,
           sum(i.balance_due) filter (where i.due_date >= current_date) as not_due,
           sum(i.balance_due) filter (where current_date - i.due_date between 1 and 30) as d30,
           sum(i.balance_due) filter (where current_date - i.due_date between 31 and 60) as d60,
           sum(i.balance_due) filter (where current_date - i.due_date between 61 and 90) as d90,
           sum(i.balance_due) filter (where current_date - i.due_date > 90) as d90p
    from public.sales_invoices i
    where i.status = 'POSTED' and i.balance_due > 0
    group by i.customer_id, i.currency_code
  ),
  cr as (
    select x.customer_id, sum(x.held) as held from (
      select r.customer_id, r.unallocated_amount as held from public.customer_receipts r where r.status = 'POSTED' and r.unallocated_amount > 0
      union all
      select n.customer_id, n.unapplied_amount from public.sales_credit_notes n where n.status = 'POSTED' and n.unapplied_amount > 0
    ) x group by x.customer_id
  )
  select c.id, c.name, coalesce(inv.currency_code, (select o.currency_code from public.organizations o where o.id = c.organization_id)),
         coalesce(inv.outstanding, 0), coalesce(inv.not_due, 0), coalesce(inv.d30, 0), coalesce(inv.d60, 0), coalesce(inv.d90, 0), coalesce(inv.d90p, 0),
         coalesce(cr.held, 0), c.credit_limit, c.on_hold
  from public.customers c
  left join inv on inv.customer_id = c.id
  left join cr on cr.customer_id = c.id
  where coalesce(inv.outstanding, 0) > 0 or coalesce(cr.held, 0) > 0
  order by coalesce(inv.outstanding, 0) desc, c.name
$$;

create or replace function public.customer_statement(p_customer_id uuid, p_from date default null)
returns table (entry_date date, entry_type text, reference text, description text, debit numeric, credit numeric, balance numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  with entries as (
    select i.invoice_date as d, i.posted_at as at, 'INVOICE'::text as t, i.invoice_number as ref,
           coalesce(i.customer_reference, 'Invoice') as descr, i.total_amount as debit, 0::numeric as credit
    from public.sales_invoices i where i.customer_id = p_customer_id and i.status = 'POSTED'
    union all
    select r.receipt_date, r.created_at, 'RECEIPT', r.receipt_number, initcap(replace(lower(r.method), '_', ' ')) || coalesce(' ' || r.reference, ''), 0, r.amount
    from public.customer_receipts r where r.customer_id = p_customer_id and r.status = 'POSTED'
    union all
    select n.credit_date, n.posted_at, 'CREDIT_NOTE', n.credit_note_number,
           'Credit note for ' || coalesce(si.invoice_number, 'invoice') || ' (' || initcap(replace(lower(n.reason_code), '_', ' ')) || ')', 0, n.total_amount
    from public.sales_credit_notes n
    join public.sales_invoices si on si.id = n.sales_invoice_id
    where n.customer_id = p_customer_id and n.status = 'POSTED'
  ),
  running as (
    select e.*, sum(e.debit - e.credit) over (order by e.d, e.at, e.ref rows between unbounded preceding and current row) as bal
    from entries e
  )
  select d, t, ref, descr, debit, credit, bal from running
  where p_from is null or d >= p_from
  order by d, at, ref
$$;

-- ---------------------------------------------------------------------------------------------------------
-- function privileges
-- ---------------------------------------------------------------------------------------------------------
revoke all on function private.sales_credit_notes_posted_lock() from public, anon, authenticated;
revoke all on function private.sales_credit_note_lines_lock() from public, anon, authenticated;
revoke all on function private.credit_line_amounts(uuid, uuid, text, numeric, numeric, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function private.apply_credit_allocations(public.sales_credit_notes, jsonb) from public, anon, authenticated;

revoke all on function public.invoice_creditable(uuid) from public, anon;
revoke all on function public.save_credit_note(uuid, uuid, uuid, text, text, jsonb) from public, anon;
revoke all on function public.cancel_credit_note(uuid, text) from public, anon;
revoke all on function public.post_credit_note(uuid) from public, anon;
revoke all on function public.apply_credit_note(uuid, jsonb) from public, anon;
grant execute on function public.invoice_creditable(uuid) to authenticated;
grant execute on function public.save_credit_note(uuid, uuid, uuid, text, text, jsonb) to authenticated;
grant execute on function public.cancel_credit_note(uuid, text) to authenticated;
grant execute on function public.post_credit_note(uuid) to authenticated;
grant execute on function public.apply_credit_note(uuid, jsonb) to authenticated;
