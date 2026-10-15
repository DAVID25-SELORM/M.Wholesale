-- Phase 9 / 02: refunds and reversals
--
-- REFUND   Unused customer credit (an unapplied credit note, or a payment that was not allocated to any invoice) can be PAID BACK to the customer:
--          cash, mobile money, bank transfer, cheque or card. A refund is recorded once (append-only) and reduces the credit it came from; it also
--          appears on the customer's statement. A cash refund can be paid out of the cashier's open till shift, which then expects that much less cash.
--          A payment that has been (partly) refunded can no longer be voided.
-- REVERSE A SALES INVOICE
--          Undoes a posted invoice that should never have happened: the goods go back into the batches they came from (as sellable stock, or as
--          expired stock if the batch has expired meanwhile), every payment applied to the invoice becomes the customer's credit again (to be applied
--          elsewhere or refunded), and the invoice is marked REVERSED - it stays on file and on the statement, with its reversal, and drops out of
--          what the customer owes. Not possible while credit notes exist on it: reverse those first.
-- REVERSE A CREDIT NOTE
--          Withdraws a posted credit note: what it credited reopens on the invoices it was applied to, and the goods it brought back are taken out of
--          stock again (this fails, saying which batch is short, when they were meanwhile sold or moved). Not possible once part of it has been refunded.
-- Reversals need a reason, are audited, and cannot themselves be reversed.

alter table public.stock_documents drop constraint stock_documents_document_type_check;
alter table public.stock_documents add constraint stock_documents_document_type_check
  check (document_type in ('OPENING', 'ADJUSTMENT', 'TRANSFER', 'STATUS_CHANGE', 'RECEIPT', 'RETURN', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIPT', 'SALE', 'SALE_RETURN',
                           'SALE_REVERSAL', 'SALE_RETURN_REVERSAL'));
alter table public.stock_documents drop constraint stock_documents_reason_code_check;
alter table public.stock_documents add constraint stock_documents_reason_code_check
  check (reason_code is null or reason_code in
    ('OPENING', 'RECEIPT', 'RETURN_TO_SUPPLIER', 'RETURN_FROM_CUSTOMER', 'REVERSAL', 'COUNT_VARIANCE', 'DAMAGE', 'EXPIRY_WRITE_OFF', 'THEFT_LOSS', 'FOUND',
     'RETURN_TO_STOCK', 'QUALITY_HOLD', 'QUALITY_RELEASE', 'RECALL', 'REORGANISATION', 'OTHER'));
alter table public.stock_movements drop constraint stock_movements_movement_type_check;
alter table public.stock_movements add constraint stock_movements_movement_type_check
  check (movement_type in ('OPENING', 'RECEIPT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER_OUT', 'TRANSFER_IN',
                           'STATUS_OUT', 'STATUS_IN', 'RETURN_OUT', 'SALE_OUT', 'SALE_RETURN_IN', 'SALE_REVERSAL_IN', 'SALE_RETURN_REVERSAL_OUT'));
alter table public.stock_movements drop constraint stock_movements_sign;
alter table public.stock_movements add constraint stock_movements_sign check (
  quantity <> 0 and (
    (movement_type in ('OPENING', 'RECEIPT', 'ADJUSTMENT_IN', 'TRANSFER_IN', 'STATUS_IN', 'SALE_RETURN_IN', 'SALE_REVERSAL_IN') and quantity > 0) or
    (movement_type in ('ADJUSTMENT_OUT', 'TRANSFER_OUT', 'STATUS_OUT', 'RETURN_OUT', 'SALE_OUT', 'SALE_RETURN_REVERSAL_OUT') and quantity < 0)));

-- the posting engine learns the two reversal documents (authorised by reverse_sales_invoice() / reverse_credit_note(), not here)
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
    when 'SALE_REVERSAL'     then 'sales.reverse'        -- authorised by reverse_sales_invoice(), not checked here
    when 'SALE_RETURN_REVERSAL' then 'credit_notes.reverse'   -- authorised by reverse_credit_note(), not checked here
    when 'TRANSFER_RECEIPT'  then 'inventory.transfer'   -- checked at the RECEIVING warehouse
  end;
  if v_perm is null then
    raise exception 'unknown document type' using errcode = '22023';
  end if;
  v_prefix := case p_document_type when 'OPENING' then 'OPN' when 'ADJUSTMENT' then 'ADJ'
                                   when 'TRANSFER' then 'TRF' when 'RECEIPT' then 'RCV' when 'RETURN' then 'RTN'
                                   when 'TRANSFER_DISPATCH' then 'DSP' when 'TRANSFER_RECEIPT' then 'TRC'
                                   when 'SALE' then 'SAL' when 'SALE_RETURN' then 'SRT'
                                   when 'SALE_REVERSAL' then 'SRV' when 'SALE_RETURN_REVERSAL' then 'CRV' else 'STS' end;

  select * into v_wh from public.warehouses w
   where w.id = p_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;
  if p_document_type not in ('RECEIPT', 'RETURN', 'SALE', 'SALE_RETURN', 'SALE_REVERSAL', 'SALE_RETURN_REVERSAL') and p_source_type is distinct from 'STOCK_COUNT' and not private.has_permission(v_perm, v_wh.branch_id) then
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
  elsif p_document_type in ('SALE_REVERSAL', 'SALE_RETURN_REVERSAL') then
    p_reason_code := 'REVERSAL';
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
      if (p_document_type in ('OPENING', 'RECEIPT', 'TRANSFER_RECEIPT', 'SALE_RETURN', 'SALE_REVERSAL') and v_status = 'AVAILABLE')
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
    elsif p_document_type = 'SALE_REVERSAL' then
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'SALE_REVERSAL_IN', v_wh.id, v_loc, v_prod.id, v_batch_id,
                                         v_status, v_qty, v_unit.id, v_entered);
    elsif p_document_type = 'SALE_RETURN_REVERSAL' then
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'SALE_RETURN_REVERSAL_OUT', v_wh.id, v_loc, v_prod.id, v_batch_id,
                                         v_status, -v_qty, v_unit.id, v_entered);
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
-- receipts: money handed back to the customer is no longer unallocated credit
-- ---------------------------------------------------------------------------------------------------------
alter table public.customer_receipts drop constraint customer_receipts_alloc_cap;
alter table public.customer_receipts drop column unallocated_amount;
alter table public.customer_receipts add column refunded_amount numeric(18, 2) not null default 0 check (refunded_amount >= 0);
alter table public.customer_receipts add constraint customer_receipts_settled_cap check (allocated_amount + refunded_amount <= amount);
alter table public.customer_receipts add column unallocated_amount numeric(18, 2) generated always as (amount - allocated_amount - refunded_amount) stored;

-- ---------------------------------------------------------------------------------------------------------
-- credit notes: refunds and reversal
-- ---------------------------------------------------------------------------------------------------------
alter table public.sales_credit_notes drop constraint sales_credit_notes_applied_cap;
alter table public.sales_credit_notes drop constraint sales_credit_notes_status_check;
alter table public.sales_credit_notes drop constraint sales_credit_notes_posted_complete;
alter table public.sales_credit_notes drop column unapplied_amount;
alter table public.sales_credit_notes add column refunded_amount numeric(18, 2) not null default 0 check (refunded_amount >= 0);
alter table public.sales_credit_notes add column reversed_at timestamptz;
alter table public.sales_credit_notes add column reversed_by uuid;
alter table public.sales_credit_notes add column reversal_reason text check (reversal_reason is null or length(reversal_reason) <= 500);
alter table public.sales_credit_notes add column reversal_document_id uuid;
alter table public.sales_credit_notes add constraint sales_credit_notes_reversal_document_fk foreign key (reversal_document_id, organization_id)
  references public.stock_documents (id, organization_id) on delete restrict;
alter table public.sales_credit_notes add constraint sales_credit_notes_status_check check (status in ('DRAFT', 'POSTED', 'CANCELLED', 'REVERSED'));
alter table public.sales_credit_notes add constraint sales_credit_notes_settled_cap check (applied_amount + refunded_amount <= total_amount);
alter table public.sales_credit_notes add column unapplied_amount numeric(18, 2) generated always as (total_amount - applied_amount - refunded_amount) stored;
alter table public.sales_credit_notes add constraint sales_credit_notes_posted_complete check (
  ((status in ('POSTED', 'REVERSED')) = (credit_note_number is not null and posted_at is not null))
  and ((status = 'REVERSED') = (reversed_at is not null and reversal_reason is not null)));

create or replace function private.sales_credit_notes_posted_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('CANCELLED', 'REVERSED') then
    raise exception 'a % credit note cannot be changed', lower(old.status) using errcode = '42501';
  end if;
  if old.status = 'POSTED' and (
       (new.status is distinct from old.status and new.status <> 'REVERSED')
       or new.branch_id is distinct from old.branch_id or new.warehouse_id is distinct from old.warehouse_id
       or new.credit_note_number is distinct from old.credit_note_number or new.credit_date is distinct from old.credit_date
       or new.reason_code is distinct from old.reason_code or new.subtotal is distinct from old.subtotal or new.tax_total is distinct from old.tax_total
       or new.total_amount is distinct from old.total_amount or new.currency_code is distinct from old.currency_code
       or new.stock_document_id is distinct from old.stock_document_id) then
    raise exception 'a posted credit note cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

alter table public.credit_note_allocations add column is_reversed boolean not null default false;
drop trigger credit_note_allocations_append_only on public.credit_note_allocations;
create trigger credit_note_allocations_immutable before update on public.credit_note_allocations
  for each row execute function private.prevent_column_change('organization_id', 'credit_note_id', 'sales_invoice_id', 'branch_id', 'amount', 'created_at');
create trigger credit_note_allocations_no_delete before delete on public.credit_note_allocations
  for each row execute function private.stock_block_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- invoices: reversal
-- ---------------------------------------------------------------------------------------------------------
alter table public.sales_invoices drop constraint sales_invoices_status_check;
alter table public.sales_invoices drop constraint sales_invoices_posted_complete;
alter table public.sales_invoices add column reversed_at timestamptz;
alter table public.sales_invoices add column reversed_by uuid;
alter table public.sales_invoices add column reversal_reason text check (reversal_reason is null or length(reversal_reason) <= 500);
alter table public.sales_invoices add column reversal_document_id uuid;
alter table public.sales_invoices add constraint sales_invoices_reversal_document_fk foreign key (reversal_document_id, organization_id)
  references public.stock_documents (id, organization_id) on delete restrict;
alter table public.sales_invoices add constraint sales_invoices_status_check check (status in ('DRAFT', 'POSTED', 'CANCELLED', 'REVERSED'));
alter table public.sales_invoices add constraint sales_invoices_posted_complete check (
  ((status in ('POSTED', 'REVERSED')) = (invoice_number is not null and posted_at is not null and due_date is not null and stock_document_id is not null))
  and ((status = 'REVERSED') = (reversed_at is not null and reversal_reason is not null and reversal_document_id is not null)));

create or replace function private.sales_invoices_posted_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('CANCELLED', 'REVERSED') then
    raise exception 'a % invoice cannot be changed', lower(old.status) using errcode = '42501';
  end if;
  if old.status = 'POSTED' and (
       (new.status is distinct from old.status and new.status <> 'REVERSED')
       or new.customer_id is distinct from old.customer_id or new.branch_id is distinct from old.branch_id
       or new.warehouse_id is distinct from old.warehouse_id or new.invoice_number is distinct from old.invoice_number
       or new.invoice_date is distinct from old.invoice_date or new.due_date is distinct from old.due_date
       or new.subtotal is distinct from old.subtotal or new.tax_total is distinct from old.tax_total
       or new.total_amount is distinct from old.total_amount or new.currency_code is distinct from old.currency_code) then
    raise exception 'a posted invoice cannot be changed: issue a credit note, or reverse it' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- refunds paid out to customers
-- ---------------------------------------------------------------------------------------------------------
create table public.customer_refunds (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict,
  refund_number    text not null,
  customer_id      uuid not null,
  branch_id        uuid not null,
  source_type      text not null check (source_type in ('CREDIT_NOTE', 'RECEIPT')),
  credit_note_id   uuid,
  receipt_id       uuid,
  refund_date      date not null,
  method           text not null check (method in ('CASH', 'MOBILE_MONEY', 'BANK_TRANSFER', 'CHEQUE', 'CARD')),
  reference        text check (reference is null or length(reference) <= 100),
  amount           numeric(18, 2) not null check (amount > 0),
  pos_session_id   uuid,                              -- a cash refund paid out of this till shift
  notes            text check (notes is null or length(notes) <= 500),
  refunded_by      uuid default auth.uid(),
  created_at       timestamptz not null default clock_timestamp(),
  constraint customer_refunds_customer_fk foreign key (customer_id, organization_id)
    references public.customers (id, organization_id) on delete restrict,
  constraint customer_refunds_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint customer_refunds_credit_note_fk foreign key (credit_note_id, organization_id)
    references public.sales_credit_notes (id, organization_id) on delete restrict,
  constraint customer_refunds_receipt_fk foreign key (receipt_id, organization_id)
    references public.customer_receipts (id, organization_id) on delete restrict,
  constraint customer_refunds_session_fk foreign key (pos_session_id, organization_id)
    references public.pos_sessions (id, organization_id) on delete restrict,
  constraint customer_refunds_number_key unique (organization_id, refund_number),
  constraint customer_refunds_id_org_key unique (id, organization_id),
  constraint customer_refunds_source check ((source_type = 'CREDIT_NOTE' and credit_note_id is not null and receipt_id is null)
                                         or (source_type = 'RECEIPT' and receipt_id is not null and credit_note_id is null)),
  constraint customer_refunds_session_cash check (pos_session_id is null or method = 'CASH')
);
create index customer_refunds_org_created_idx on public.customer_refunds (organization_id, created_at desc, id desc);
create index customer_refunds_customer_idx on public.customer_refunds (customer_id, created_at desc);
create index customer_refunds_branch_idx on public.customer_refunds (organization_id, branch_id, created_at desc);
create index customer_refunds_credit_note_idx on public.customer_refunds (credit_note_id) where credit_note_id is not null;
create index customer_refunds_receipt_idx on public.customer_refunds (receipt_id) where receipt_id is not null;
create index customer_refunds_session_idx on public.customer_refunds (pos_session_id) where pos_session_id is not null;
create trigger customer_refunds_append_only before update or delete on public.customer_refunds
  for each row execute function private.stock_block_mutation();
create trigger customer_refunds_audit after insert on public.customer_refunds
  for each row execute function private.audit_row_change('customer_refund');

alter table public.customer_refunds enable row level security;
revoke all on public.customer_refunds from public, anon, authenticated;
grant select on public.customer_refunds to authenticated;
create policy customer_refunds_select on public.customer_refunds for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('refunds.view', branch_id));

-- ---------------------------------------------------------------------------------------------------------
-- refund
-- ---------------------------------------------------------------------------------------------------------
-- p_source_type: 'CREDIT_NOTE' (a posted credit note's unused part) or 'RECEIPT' (a payment's unallocated part)
-- p_pos_session_id: pay a CASH refund out of your own open till shift (the shift then expects that much less cash)
create function public.refund_customer(
  p_source_type text,
  p_source_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text,
  p_notes text default null,
  p_pos_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.current_organization_id();
  v_note    public.sales_credit_notes;
  v_rec     public.customer_receipts;
  v_branch  uuid;
  v_customer uuid;
  v_unused  numeric;
  v_s       public.pos_sessions;
  v_today   date;
  v_method  text := upper(coalesce(p_method, ''));
  v_id      uuid;
  v_number  text;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if p_source_type = 'CREDIT_NOTE' then
    select * into v_note from public.sales_credit_notes n where n.id = p_source_id and n.organization_id = v_org for update;
    if not found then
      raise exception 'credit note not found' using errcode = 'P0002';
    end if;
    if v_note.status <> 'POSTED' then
      raise exception 'only a posted credit note can be refunded (this one is %)', v_note.status using errcode = '22023';
    end if;
    v_branch := v_note.branch_id; v_customer := v_note.customer_id; v_unused := v_note.unapplied_amount;
  elsif p_source_type = 'RECEIPT' then
    select * into v_rec from public.customer_receipts r where r.id = p_source_id and r.organization_id = v_org for update;
    if not found then
      raise exception 'payment not found' using errcode = 'P0002';
    end if;
    if v_rec.status <> 'POSTED' then
      raise exception 'only a posted payment can be refunded (this one is %)', v_rec.status using errcode = '22023';
    end if;
    v_branch := v_rec.branch_id; v_customer := v_rec.customer_id; v_unused := v_rec.unallocated_amount;
  else
    raise exception 'the refund must come from a CREDIT_NOTE or a RECEIPT' using errcode = '22023';
  end if;
  if not private.has_permission('refunds.create', v_branch) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) or p_amount >= 100000000000 then
    raise exception 'the refund must be a positive amount with at most 2 decimals' using errcode = '22023';
  end if;
  if p_amount > v_unused then
    raise exception 'only % of this credit is unused and can be refunded', v_unused using errcode = '22023';
  end if;
  if v_method not in ('CASH', 'MOBILE_MONEY', 'BANK_TRANSFER', 'CHEQUE', 'CARD') then
    raise exception 'choose how the money is paid back (cash, mobile money, bank transfer, cheque or card)' using errcode = '22023';
  end if;
  if v_method <> 'CASH' and nullif(btrim(coalesce(p_reference, '')), '') is null then
    raise exception 'enter the reference of the payment (transaction, cheque or transfer number)' using errcode = '22023';
  end if;
  if (p_reference is not null and length(p_reference) > 100) or (p_notes is not null and length(p_notes) > 500) then
    raise exception 'reference is limited to 100 and notes to 500 characters' using errcode = '22023';
  end if;
  if p_pos_session_id is not null then
    select * into v_s from public.pos_sessions s where s.id = p_pos_session_id and s.organization_id = v_org for share;
    if not found or v_s.cashier_id <> auth.uid() or v_s.status <> 'OPEN' then
      raise exception 'choose your own open till shift to pay the cash refund from' using errcode = '22023';
    end if;
    if v_method <> 'CASH' or v_s.branch_id <> v_branch then
      raise exception 'only a cash refund of this branch can be paid from the till' using errcode = '22023';
    end if;
  end if;

  select (now() at time zone o.timezone)::date into v_today from public.organizations o where o.id = v_org;
  v_number := private.generate_document_number(v_org, null, 'CUSTOMER_REFUND', 'RFD');
  insert into public.customer_refunds (organization_id, refund_number, customer_id, branch_id, source_type, credit_note_id, receipt_id, refund_date, method,
                                       reference, amount, pos_session_id, notes)
  values (v_org, v_number, v_customer, v_branch, p_source_type, case when p_source_type = 'CREDIT_NOTE' then p_source_id end,
          case when p_source_type = 'RECEIPT' then p_source_id end, v_today, v_method, nullif(btrim(p_reference), ''), p_amount, p_pos_session_id,
          nullif(btrim(p_notes), ''))
  returning id into v_id;
  if p_source_type = 'CREDIT_NOTE' then
    update public.sales_credit_notes set refunded_amount = refunded_amount + p_amount where id = p_source_id;
  else
    update public.customer_receipts set refunded_amount = refunded_amount + p_amount where id = p_source_id;
  end if;
  return jsonb_build_object('refund_id', v_id, 'refund_number', v_number, 'amount', p_amount);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- reverse a sales invoice
-- ---------------------------------------------------------------------------------------------------------
create function public.reverse_sales_invoice(p_id uuid, p_reason text)
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
  return jsonb_build_object('invoice_number', v_inv.invoice_number, 'stock_document_number', v_stock ->> 'document_number', 'credit_released', v_released);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- reverse a credit note
-- ---------------------------------------------------------------------------------------------------------
create function public.reverse_credit_note(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.current_organization_id();
  v_note    public.sales_credit_notes;
  v_inv_ids uuid[];
  v_alloc   record;
  v_ret     record;
  v_base    uuid;
  v_lines   jsonb := '[]'::jsonb;
  v_stock   jsonb;
  v_reopened numeric := 0;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_note from public.sales_credit_notes n where n.id = p_id and n.organization_id = v_org;
  if not found then
    raise exception 'credit note not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('credit_notes.reverse', v_note.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  select array_agg(distinct x.sales_invoice_id order by x.sales_invoice_id) into v_inv_ids from (
    select a.sales_invoice_id from public.credit_note_allocations a where a.credit_note_id = v_note.id and not a.is_reversed
    union select v_note.sales_invoice_id) x;
  perform 1 from public.sales_invoices i where i.id = any (v_inv_ids) order by i.id for update;
  select * into v_note from public.sales_credit_notes n where n.id = p_id for update;
  if v_note.status <> 'POSTED' then
    raise exception 'only a posted credit note can be reversed (this one is %)', v_note.status using errcode = '22023';
  end if;
  if v_note.refunded_amount > 0 then
    raise exception 'part of this credit note (%) has been refunded to the customer, so it cannot be reversed', v_note.refunded_amount using errcode = '22023';
  end if;

  -- 1. the goods it brought back leave stock again, from the condition they were put in
  for v_ret in select r.* from public.sales_credit_note_returns r where r.credit_note_id = v_note.id order by r.id loop
    select u.id into v_base from public.product_units u where u.product_id = v_ret.product_id and u.is_base;
    v_lines := v_lines || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'product_id', v_ret.product_id, 'batch_id', v_ret.batch_id, 'location_id', v_ret.location_id, 'status', v_ret.return_condition,
      'quantity', v_ret.base_quantity, 'product_unit_id', v_base)));
  end loop;
  if jsonb_array_length(v_lines) > 0 then
    v_stock := private.post_stock('SALE_RETURN_REVERSAL', v_note.warehouse_id, v_lines, null, null, 'Reversal of ' || v_note.credit_note_number, 'CREDIT_NOTE', v_note.id);
  end if;

  -- 2. what it had credited on invoices is owed again
  for v_alloc in
    select a.id, a.sales_invoice_id, a.amount from public.credit_note_allocations a where a.credit_note_id = v_note.id and not a.is_reversed order by a.sales_invoice_id, a.id
  loop
    update public.sales_invoices set amount_credited = amount_credited - v_alloc.amount where id = v_alloc.sales_invoice_id;
    update public.credit_note_allocations set is_reversed = true where id = v_alloc.id;
    v_reopened := v_reopened + v_alloc.amount;
  end loop;

  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.sales_credit_notes
     set status = 'REVERSED', reversed_at = now(), reversed_by = auth.uid(), reversal_reason = btrim(p_reason),
         reversal_document_id = (v_stock ->> 'document_id')::uuid
   where id = v_note.id;
  return jsonb_build_object('credit_note_number', v_note.credit_note_number, 'stock_document_number', v_stock ->> 'document_number', 'reopened', v_reopened);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- a payment that has been refunded can no longer be voided
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.void_receipt(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_rec public.customer_receipts;
  v_a   record;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_rec from public.customer_receipts r where r.id = p_id and r.organization_id = v_org for update;
  if not found then
    raise exception 'receipt not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('receipts.void', v_rec.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_rec.status <> 'POSTED' then
    raise exception 'this receipt is already void' using errcode = '22023';
  end if;
  if v_rec.refunded_amount > 0 then
    raise exception 'part of this payment (%) has been refunded to the customer, so it cannot be voided', v_rec.refunded_amount using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  for v_a in
    select a.id, a.sales_invoice_id, a.amount from public.receipt_allocations a where a.receipt_id = v_rec.id and not a.is_voided order by a.sales_invoice_id
  loop
    perform 1 from public.sales_invoices i where i.id = v_a.sales_invoice_id for update;
    update public.sales_invoices set amount_paid = amount_paid - v_a.amount where id = v_a.sales_invoice_id;
    update public.receipt_allocations set is_voided = true where id = v_a.id;
  end loop;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.customer_receipts
     set status = 'VOID', void_reason = btrim(p_reason), voided_by = auth.uid(), voided_at = now(), allocated_amount = 0
   where id = v_rec.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- cash expected in a till shift: cash refunds paid from the till come out
-- ---------------------------------------------------------------------------------------------------------
create or replace function private.pos_cash_in(p_session_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select sum(p.amount) from public.pos_sale_payments p join public.customer_receipts r on r.id = p.receipt_id
                    where p.pos_session_id = p_session_id and p.method = 'CASH' and r.status = 'POSTED'), 0)
       - coalesce((select sum(f.amount) from public.customer_refunds f where f.pos_session_id = p_session_id and f.method = 'CASH'), 0)
$$;

-- ---------------------------------------------------------------------------------------------------------
-- statement: reversals and refunds
-- ---------------------------------------------------------------------------------------------------------
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
    from public.sales_invoices i where i.customer_id = p_customer_id and i.status in ('POSTED', 'REVERSED')
    union all
    select i.reversed_at::date, i.reversed_at, 'REVERSAL', i.invoice_number, 'Reversal of invoice: ' || i.reversal_reason, 0, i.total_amount
    from public.sales_invoices i where i.customer_id = p_customer_id and i.status = 'REVERSED'
    union all
    select r.receipt_date, r.created_at, 'RECEIPT', r.receipt_number, initcap(replace(lower(r.method), '_', ' ')) || coalesce(' ' || r.reference, ''), 0, r.amount
    from public.customer_receipts r where r.customer_id = p_customer_id and r.status = 'POSTED'
    union all
    select n.credit_date, n.posted_at, 'CREDIT_NOTE', n.credit_note_number,
           'Credit note for ' || coalesce(si.invoice_number, 'invoice') || ' (' || initcap(replace(lower(n.reason_code), '_', ' ')) || ')', 0, n.total_amount
    from public.sales_credit_notes n
    join public.sales_invoices si on si.id = n.sales_invoice_id
    where n.customer_id = p_customer_id and n.status in ('POSTED', 'REVERSED')
    union all
    select n.reversed_at::date, n.reversed_at, 'REVERSAL', n.credit_note_number, 'Reversal of credit note: ' || n.reversal_reason, n.total_amount, 0
    from public.sales_credit_notes n where n.customer_id = p_customer_id and n.status = 'REVERSED'
    union all
    select f.refund_date, f.created_at, 'REFUND', f.refund_number, 'Refund - ' || initcap(replace(lower(f.method), '_', ' ')) || coalesce(' ' || f.reference, ''), f.amount, 0
    from public.customer_refunds f where f.customer_id = p_customer_id
  ),
  running as (
    select e.*, sum(e.debit - e.credit) over (order by e.d, e.at, e.ref, e.t rows between unbounded preceding and current row) as bal
    from entries e
  )
  select d, t, ref, descr, debit, credit, bal from running
  where p_from is null or d >= p_from
  order by d, at, ref, t
$$;

-- ---------------------------------------------------------------------------------------------------------
-- function privileges
-- ---------------------------------------------------------------------------------------------------------
revoke all on function public.refund_customer(text, uuid, numeric, text, text, text, uuid) from public, anon;
revoke all on function public.reverse_sales_invoice(uuid, text) from public, anon;
revoke all on function public.reverse_credit_note(uuid, text) from public, anon;
grant execute on function public.refund_customer(text, uuid, numeric, text, text, text, uuid) to authenticated;
grant execute on function public.reverse_sales_invoice(uuid, text) to authenticated;
grant execute on function public.reverse_credit_note(uuid, text) to authenticated;
