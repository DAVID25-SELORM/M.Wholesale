-- Phase 6 / 03: sales invoices (stock leaves by earliest expiry), receipts and credit control
--
-- An invoice is a DRAFT until it is POSTED. Posting, in one transaction:
--   * checks the customer: active, not on credit hold, within the credit limit (hold and limit can be overridden by someone with
--     sales.override_credit and a reason), and the regulatory rules below (which nobody can override);
--   * picks the batches FEFO - earliest expiry first, AVAILABLE and unexpired only, with the customer's minimum shelf life - splitting a line
--     over several batches when needed, and records exactly which batch each unit came from;
--   * takes that stock out of the ledger (document type SALE, movement SALE_OUT) and costs each pick from the batch cost;
--   * numbers the invoice (gap-free: a failed posting uses no number), sets the due date and makes the customer owe the total.
-- A posted invoice cannot be edited or deleted. Mistakes are corrected with a credit note (next phase).
--
-- Regulatory rules (no override): prescription-only, pharmacy-only and controlled medicines can only be sold to hospitals, clinics, pharmacies and
--   wholesalers whose premises licence is recorded and unexpired; controlled drugs additionally need the customer to be authorised for them.
--
-- Receipts: money received from a customer, allocated to invoices (oldest due first, or as chosen). Any part not allocated stays as the customer's credit
--   and counts against what they owe. A receipt can be voided (for example a bounced cheque), which re-opens the invoices it paid.

alter table public.stock_documents drop constraint stock_documents_document_type_check;
alter table public.stock_documents add constraint stock_documents_document_type_check
  check (document_type in ('OPENING', 'ADJUSTMENT', 'TRANSFER', 'STATUS_CHANGE', 'RECEIPT', 'RETURN', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIPT', 'SALE'));
alter table public.stock_documents drop constraint stock_documents_source_type_check;
alter table public.stock_documents add constraint stock_documents_source_type_check
  check (source_type is null or source_type in ('PURCHASE_ORDER', 'PURCHASE_RETURN', 'STOCK_COUNT', 'STOCK_TRANSFER', 'SALES_INVOICE'));
alter table public.stock_movements drop constraint stock_movements_movement_type_check;
alter table public.stock_movements add constraint stock_movements_movement_type_check
  check (movement_type in ('OPENING', 'RECEIPT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER_OUT', 'TRANSFER_IN',
                           'STATUS_OUT', 'STATUS_IN', 'RETURN_OUT', 'SALE_OUT'));
alter table public.stock_movements drop constraint stock_movements_sign;
alter table public.stock_movements add constraint stock_movements_sign check (
  quantity <> 0 and (
    (movement_type in ('OPENING', 'RECEIPT', 'ADJUSTMENT_IN', 'TRANSFER_IN', 'STATUS_IN') and quantity > 0) or
    (movement_type in ('ADJUSTMENT_OUT', 'TRANSFER_OUT', 'STATUS_OUT', 'RETURN_OUT', 'SALE_OUT') and quantity < 0)));

-- the posting engine learns SALE documents (authorised by post_sales_invoice(), not here)
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
    when 'TRANSFER_RECEIPT'  then 'inventory.transfer'   -- checked at the RECEIVING warehouse
  end;
  if v_perm is null then
    raise exception 'unknown document type' using errcode = '22023';
  end if;
  v_prefix := case p_document_type when 'OPENING' then 'OPN' when 'ADJUSTMENT' then 'ADJ'
                                   when 'TRANSFER' then 'TRF' when 'RECEIPT' then 'RCV' when 'RETURN' then 'RTN'
                                   when 'TRANSFER_DISPATCH' then 'DSP' when 'TRANSFER_RECEIPT' then 'TRC'
                                   when 'SALE' then 'SAL' else 'STS' end;

  select * into v_wh from public.warehouses w
   where w.id = p_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;
  if p_document_type not in ('RECEIPT', 'RETURN', 'SALE') and p_source_type is distinct from 'STOCK_COUNT' and not private.has_permission(v_perm, v_wh.branch_id) then
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
    elsif p_document_type = 'SALE' then
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'SALE_OUT', v_wh.id, v_loc, v_prod.id, v_batch_id,
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
-- tables
-- ---------------------------------------------------------------------------------------------------------
create table public.sales_invoices (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete restrict
                        default private.current_organization_id(),
  invoice_number      text,                                   -- assigned when posted
  customer_id         uuid not null,
  branch_id           uuid not null,
  warehouse_id        uuid not null,
  status              text not null default 'DRAFT' check (status in ('DRAFT', 'POSTED', 'CANCELLED')),
  invoice_date        date not null,
  due_date            date,
  payment_terms_days  integer not null default 0 check (payment_terms_days between 0 and 365),
  currency_code       text not null check (currency_code ~ '^[A-Z]{3}$'),
  customer_reference  text check (customer_reference is null or length(customer_reference) <= 80),
  notes               text check (notes is null or length(notes) <= 1000),
  subtotal            numeric(18, 2) not null default 0 check (subtotal >= 0),      -- after line discounts, before tax
  discount_total      numeric(18, 2) not null default 0 check (discount_total >= 0),
  tax_total           numeric(18, 2) not null default 0 check (tax_total >= 0),
  total_amount        numeric(18, 2) not null default 0 check (total_amount >= 0),
  amount_paid         numeric(18, 2) not null default 0 check (amount_paid >= 0),
  balance_due         numeric(18, 2) generated always as (total_amount - amount_paid) stored,
  override_reason     text check (override_reason is null or length(override_reason) <= 500),
  status_reason       text check (status_reason is null or length(status_reason) <= 500),
  stock_document_id   uuid,
  created_by          uuid default auth.uid(),
  posted_by           uuid,
  posted_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint sales_invoices_customer_fk foreign key (customer_id, organization_id)
    references public.customers (id, organization_id) on delete restrict,
  constraint sales_invoices_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint sales_invoices_warehouse_fk foreign key (warehouse_id, organization_id)
    references public.warehouses (id, organization_id) on delete restrict,
  constraint sales_invoices_stock_document_fk foreign key (stock_document_id, organization_id)
    references public.stock_documents (id, organization_id) on delete restrict,
  constraint sales_invoices_id_org_key unique (id, organization_id),
  constraint sales_invoices_total check (total_amount = subtotal + tax_total),
  constraint sales_invoices_paid_cap check (amount_paid <= total_amount),
  constraint sales_invoices_posted_complete check (
    (status = 'POSTED') = (invoice_number is not null and posted_at is not null and due_date is not null and stock_document_id is not null)
    or status <> 'POSTED' and invoice_number is null)
);
create unique index sales_invoices_number_key on public.sales_invoices (organization_id, invoice_number) where invoice_number is not null;
create index sales_invoices_org_created_idx on public.sales_invoices (organization_id, created_at desc, id desc);
create index sales_invoices_branch_status_idx on public.sales_invoices (organization_id, branch_id, status, invoice_date desc);
create index sales_invoices_customer_idx on public.sales_invoices (customer_id, status);
create index sales_invoices_open_idx on public.sales_invoices (organization_id, customer_id, due_date) where status = 'POSTED' and total_amount > amount_paid;
create index sales_invoices_warehouse_idx on public.sales_invoices (warehouse_id);
create index sales_invoices_stock_document_idx on public.sales_invoices (stock_document_id) where stock_document_id is not null;

create trigger sales_invoices_immutable before update on public.sales_invoices
  for each row execute function private.prevent_column_change('organization_id', 'created_by');
create trigger sales_invoices_set_updated_at before update on public.sales_invoices
  for each row execute function private.set_updated_at();
create trigger sales_invoices_audit after insert or update on public.sales_invoices
  for each row execute function private.audit_row_change('sales_invoice');

-- a posted invoice's content can never change; only payments (amount_paid) move afterwards
create function private.sales_invoices_posted_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'POSTED' and (
       new.status is distinct from old.status or new.customer_id is distinct from old.customer_id or new.branch_id is distinct from old.branch_id
       or new.warehouse_id is distinct from old.warehouse_id or new.invoice_number is distinct from old.invoice_number
       or new.invoice_date is distinct from old.invoice_date or new.due_date is distinct from old.due_date
       or new.subtotal is distinct from old.subtotal or new.tax_total is distinct from old.tax_total
       or new.total_amount is distinct from old.total_amount or new.currency_code is distinct from old.currency_code) then
    raise exception 'a posted invoice cannot be changed: issue a credit note instead' using errcode = '42501';
  end if;
  if old.status = 'CANCELLED' then
    raise exception 'a cancelled invoice cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger sales_invoices_posted_lock before update on public.sales_invoices
  for each row execute function private.sales_invoices_posted_lock();
create trigger sales_invoices_no_delete before delete on public.sales_invoices
  for each row execute function private.stock_block_mutation();

create table public.sales_invoice_lines (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete restrict
                      default private.current_organization_id(),
  sales_invoice_id  uuid not null,
  branch_id         uuid not null,
  line_no           integer not null check (line_no > 0),
  product_id        uuid not null,
  product_unit_id   uuid not null,
  quantity          numeric(18, 3) not null check (quantity > 0),          -- in the pack level of product_unit_id
  base_quantity     numeric(18, 3) not null check (base_quantity > 0),
  list_price        numeric(18, 4) check (list_price is null or list_price >= 0),   -- what the price list said (null = no price on any list)
  unit_price        numeric(18, 4) not null check (unit_price >= 0),                -- what was charged, per pack
  discount_percent  numeric(5, 2) not null default 0 check (discount_percent between 0 and 100),
  tax_code_id       uuid,
  tax_rate          numeric(7, 4) not null default 0 check (tax_rate between 0 and 100),
  line_net          numeric(18, 2) not null check (line_net >= 0),
  line_tax          numeric(18, 2) not null check (line_tax >= 0),
  line_total        numeric(18, 2) not null check (line_total >= 0),
  constraint sales_invoice_lines_invoice_fk foreign key (sales_invoice_id, organization_id)
    references public.sales_invoices (id, organization_id) on delete restrict,
  constraint sales_invoice_lines_product_fk foreign key (product_id, organization_id)
    references public.products (id, organization_id) on delete restrict,
  constraint sales_invoice_lines_unit_fk foreign key (product_unit_id, product_id, organization_id)
    references public.product_units (id, product_id, organization_id) on delete restrict,
  constraint sales_invoice_lines_tax_fk foreign key (tax_code_id, organization_id)
    references public.tax_codes (id, organization_id) on delete restrict,
  constraint sales_invoice_lines_line_key unique (sales_invoice_id, line_no),
  constraint sales_invoice_lines_id_org_key unique (id, organization_id),
  constraint sales_invoice_lines_total check (line_total = line_net + line_tax)
);
create index sales_invoice_lines_product_idx on public.sales_invoice_lines (organization_id, product_id);
create index sales_invoice_lines_unit_idx on public.sales_invoice_lines (product_unit_id);
create index sales_invoice_lines_tax_idx on public.sales_invoice_lines (tax_code_id) where tax_code_id is not null;

-- which batch every unit sold came from (and what it cost): the basis for recalls, expiry claims and margin
create table public.sales_invoice_allocations (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete restrict,
  sales_invoice_id      uuid not null,
  sales_invoice_line_id uuid not null,
  branch_id             uuid not null,
  product_id            uuid not null,
  batch_id              uuid,
  location_id           uuid references public.warehouse_locations (id) on delete restrict,
  base_quantity         numeric(18, 3) not null check (base_quantity > 0),
  unit_cost_base        numeric(18, 6) check (unit_cost_base is null or unit_cost_base >= 0),   -- NULL = the batch had no cost on record
  constraint sales_invoice_allocations_invoice_fk foreign key (sales_invoice_id, organization_id)
    references public.sales_invoices (id, organization_id) on delete restrict,
  constraint sales_invoice_allocations_line_fk foreign key (sales_invoice_line_id, organization_id)
    references public.sales_invoice_lines (id, organization_id) on delete restrict,
  constraint sales_invoice_allocations_batch_fk foreign key (batch_id, product_id, organization_id)
    references public.batches (id, product_id, organization_id) on delete restrict
);
create index sales_invoice_allocations_invoice_idx on public.sales_invoice_allocations (sales_invoice_id);
create index sales_invoice_allocations_line_idx on public.sales_invoice_allocations (sales_invoice_line_id);
create index sales_invoice_allocations_batch_idx on public.sales_invoice_allocations (batch_id) where batch_id is not null;
create index sales_invoice_allocations_product_idx on public.sales_invoice_allocations (organization_id, product_id);
create index sales_invoice_allocations_location_idx on public.sales_invoice_allocations (location_id) where location_id is not null;
create trigger sales_invoice_allocations_append_only before update or delete on public.sales_invoice_allocations
  for each row execute function private.stock_block_mutation();

create table public.customer_receipts (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete restrict,
  receipt_number    text not null,
  customer_id       uuid not null,
  branch_id         uuid not null,
  receipt_date      date not null,
  method            text not null check (method in ('CASH', 'MOBILE_MONEY', 'BANK_TRANSFER', 'CHEQUE', 'CARD')),
  reference         text check (reference is null or length(reference) <= 100),
  amount            numeric(18, 2) not null check (amount > 0),
  allocated_amount  numeric(18, 2) not null default 0 check (allocated_amount >= 0),
  unallocated_amount numeric(18, 2) generated always as (amount - allocated_amount) stored,
  status            text not null default 'POSTED' check (status in ('POSTED', 'VOID')),
  void_reason       text check (void_reason is null or length(void_reason) <= 500),
  voided_by         uuid,
  voided_at         timestamptz,
  notes             text check (notes is null or length(notes) <= 500),
  received_by       uuid default auth.uid(),
  created_at        timestamptz not null default clock_timestamp(),
  constraint customer_receipts_customer_fk foreign key (customer_id, organization_id)
    references public.customers (id, organization_id) on delete restrict,
  constraint customer_receipts_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint customer_receipts_number_key unique (organization_id, receipt_number),
  constraint customer_receipts_id_org_key unique (id, organization_id),
  constraint customer_receipts_alloc_cap check (allocated_amount <= amount),
  constraint customer_receipts_void_consistent check ((status = 'VOID') = (void_reason is not null))
);
create index customer_receipts_org_created_idx on public.customer_receipts (organization_id, created_at desc, id desc);
create index customer_receipts_customer_idx on public.customer_receipts (customer_id, status);
create index customer_receipts_branch_idx on public.customer_receipts (organization_id, branch_id, created_at desc);
create trigger customer_receipts_immutable before update on public.customer_receipts
  for each row execute function private.prevent_column_change('organization_id', 'receipt_number', 'customer_id', 'branch_id', 'receipt_date', 'method', 'amount', 'received_by');
create trigger customer_receipts_no_delete before delete on public.customer_receipts
  for each row execute function private.stock_block_mutation();
create trigger customer_receipts_audit after insert or update on public.customer_receipts
  for each row execute function private.audit_row_change('customer_receipt');

create table public.receipt_allocations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict,
  receipt_id       uuid not null,
  sales_invoice_id uuid not null,
  branch_id        uuid not null,                  -- the receipt's branch
  amount           numeric(18, 2) not null check (amount > 0),
  is_voided        boolean not null default false,
  created_at       timestamptz not null default clock_timestamp(),
  constraint receipt_allocations_receipt_fk foreign key (receipt_id, organization_id)
    references public.customer_receipts (id, organization_id) on delete restrict,
  constraint receipt_allocations_invoice_fk foreign key (sales_invoice_id, organization_id)
    references public.sales_invoices (id, organization_id) on delete restrict
);
create index receipt_allocations_receipt_idx on public.receipt_allocations (receipt_id);
create index receipt_allocations_invoice_idx on public.receipt_allocations (sales_invoice_id);
create trigger receipt_allocations_immutable before update on public.receipt_allocations
  for each row execute function private.prevent_column_change('organization_id', 'receipt_id', 'sales_invoice_id', 'branch_id', 'amount');
create trigger receipt_allocations_no_delete before delete on public.receipt_allocations
  for each row execute function private.stock_block_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- RLS and grants: read only; every write goes through the functions below
-- ---------------------------------------------------------------------------------------------------------
alter table public.sales_invoices            enable row level security;
alter table public.sales_invoice_lines       enable row level security;
alter table public.sales_invoice_allocations enable row level security;
alter table public.customer_receipts         enable row level security;
alter table public.receipt_allocations       enable row level security;
revoke all on public.sales_invoices, public.sales_invoice_lines, public.sales_invoice_allocations, public.customer_receipts, public.receipt_allocations
  from public, anon, authenticated;
grant select on public.sales_invoices, public.sales_invoice_lines, public.sales_invoice_allocations, public.customer_receipts, public.receipt_allocations
  to authenticated;

create policy sales_invoices_select on public.sales_invoices for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('sales.view', branch_id));
create policy sales_invoice_lines_select on public.sales_invoice_lines for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('sales.view', branch_id));
create policy sales_invoice_allocations_select on public.sales_invoice_allocations for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('sales.view', branch_id));
create policy customer_receipts_select on public.customer_receipts for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('receipts.view', branch_id));
create policy receipt_allocations_select on public.receipt_allocations for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('receipts.view', branch_id));

-- ---------------------------------------------------------------------------------------------------------
-- drafts
-- ---------------------------------------------------------------------------------------------------------
-- p_lines: [{ product_id, quantity, product_unit_id?, unit_price?, discount_percent? }]
--   unit_price omitted -> the customer's price list price (an error when there is none: name a price, which needs sales.price_override)
--   a price that differs from the list price needs sales.price_override; any discount needs sales.discount
create function public.save_sales_invoice(
  p_id uuid,
  p_customer_id uuid,
  p_warehouse_id uuid,
  p_customer_reference text,
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
  v_wh      public.warehouses;
  v_cust    public.customers;
  v_inv     public.sales_invoices;
  v_org_cur text;
  v_today   date;
  v_line    jsonb;
  v_n       integer := 0;
  v_prod    public.products;
  v_unit    public.product_units;
  v_qty     numeric;
  v_base    numeric;
  v_list    numeric;
  v_price   numeric;
  v_disc    numeric;
  v_taxid   uuid;
  v_rate    numeric;
  v_net     numeric;
  v_tax     numeric;
  v_sub     numeric := 0;
  v_discsum numeric := 0;
  v_taxsum  numeric := 0;
  v_seen    text[] := '{}';
  v_key     text;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_wh from public.warehouses w where w.id = p_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'dispatch warehouse not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('sales.create', v_wh.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  select * into v_cust from public.customers c where c.id = p_customer_id and c.organization_id = v_org and c.is_active;
  if not found then
    raise exception 'customer not found or inactive' using errcode = 'P0002';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'add at least one line' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'an invoice is limited to 200 lines' using errcode = '22023';
  end if;
  if (p_customer_reference is not null and length(p_customer_reference) > 80) or (p_notes is not null and length(p_notes) > 1000) then
    raise exception 'reference is limited to 80 and notes to 1000 characters' using errcode = '22023';
  end if;

  select o.currency_code, (now() at time zone o.timezone)::date into v_org_cur, v_today from public.organizations o where o.id = v_org;

  if p_id is null then
    insert into public.sales_invoices (organization_id, customer_id, branch_id, warehouse_id, invoice_date, payment_terms_days, currency_code,
                                       customer_reference, notes)
    values (v_org, v_cust.id, v_wh.branch_id, v_wh.id, v_today, v_cust.payment_terms_days, v_org_cur,
            nullif(btrim(p_customer_reference), ''), nullif(btrim(p_notes), ''))
    returning * into v_inv;
  else
    select * into v_inv from public.sales_invoices i where i.id = p_id and i.organization_id = v_org for update;
    if not found then
      raise exception 'invoice not found' using errcode = 'P0002';
    end if;
    if v_inv.status <> 'DRAFT' then
      raise exception 'only a draft invoice can be edited (this one is %)', v_inv.status using errcode = '22023';
    end if;
    if not private.has_permission('sales.create', v_inv.branch_id) then
      raise exception 'insufficient privilege for this branch' using errcode = '42501';
    end if;
    update public.sales_invoices
       set customer_id = v_cust.id, branch_id = v_wh.branch_id, warehouse_id = v_wh.id, invoice_date = v_today,
           payment_terms_days = v_cust.payment_terms_days, customer_reference = nullif(btrim(p_customer_reference), ''), notes = nullif(btrim(p_notes), '')
     where id = v_inv.id;
    delete from public.sales_invoice_lines where sales_invoice_id = v_inv.id;
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
       where u.id = (v_line ->> 'product_unit_id')::uuid and u.product_id = v_prod.id and u.organization_id = v_org and u.is_active and u.is_sellable;
    end if;
    if not found then
      raise exception 'line %: that pack level cannot be sold for this product', v_n using errcode = 'P0002';
    end if;
    if jsonb_typeof(v_line -> 'quantity') is distinct from 'number' or (v_line ->> 'quantity')::numeric <= 0 then
      raise exception 'line %: quantity must be a positive number', v_n using errcode = '22023';
    end if;
    v_qty := (v_line ->> 'quantity')::numeric;
    v_base := v_qty * v_unit.factor_to_base;
    if v_qty <> round(v_qty, 3) or v_base <> round(v_base, 3) or v_base >= 1000000000000 then
      raise exception 'line %: quantity is not a valid amount in the base unit', v_n using errcode = '22023';
    end if;

    -- price: the list price unless a price is named
    select i.unit_price into v_list
    from public.price_list_items i
    join public.price_lists l on l.id = i.price_list_id and l.is_active
    where i.product_unit_id = v_unit.id and i.is_active and (l.id = v_cust.price_list_id or l.is_default)
    order by coalesce(l.id = v_cust.price_list_id, false) desc, l.is_default desc
    limit 1;
    if jsonb_typeof(v_line -> 'unit_price') = 'number' then
      v_price := (v_line ->> 'unit_price')::numeric;
      if v_price < 0 or v_price <> round(v_price, 4) or v_price >= 100000000000 then
        raise exception 'line %: price must be 0 or more with at most 4 decimals', v_n using errcode = '22023';
      end if;
      if v_list is null or v_price <> v_list then
        if not private.has_permission('sales.price_override', v_wh.branch_id) then
          raise exception 'line %: you cannot sell % at a price other than the price list (%)', v_n, v_prod.sku, coalesce(v_list::text, 'no price on any list')
            using errcode = '42501';
        end if;
      end if;
    elsif v_list is not null then
      v_price := v_list;
    else
      raise exception 'line %: % has no price for this customer - add it to a price list', v_n, v_prod.sku using errcode = '22023';
    end if;

    v_disc := coalesce((v_line ->> 'discount_percent')::numeric, 0);
    if v_disc < 0 or v_disc > 100 or v_disc <> round(v_disc, 2) then
      raise exception 'line %: discount must be between 0 and 100 %% with at most 2 decimals', v_n using errcode = '22023';
    end if;
    if v_disc > 0 and not private.has_permission('sales.discount', v_wh.branch_id) then
      raise exception 'line %: you are not allowed to give discounts', v_n using errcode = '42501';
    end if;

    v_key := v_prod.id::text || '|' || v_unit.id::text || '|' || v_price::text || '|' || v_disc::text;
    if v_key = any (v_seen) then
      raise exception 'line %: the same product, pack level, price and discount is already on the invoice - increase its quantity', v_n using errcode = '22023';
    end if;
    v_seen := v_seen || v_key;

    -- tax: the product's code, else the organization's default
    select t.id, t.rate into v_taxid, v_rate from public.tax_codes t
     where t.organization_id = v_org and t.is_active and t.id = coalesce(v_prod.tax_code_id, (select d.id from public.tax_codes d where d.organization_id = v_org and d.is_default));
    v_rate := coalesce(v_rate, 0);
    v_net := round(v_qty * v_price * (1 - v_disc / 100), 2);
    v_tax := round(v_net * v_rate / 100, 2);
    v_sub := v_sub + v_net;
    v_taxsum := v_taxsum + v_tax;
    v_discsum := v_discsum + (round(v_qty * v_price, 2) - v_net);

    insert into public.sales_invoice_lines (
      organization_id, sales_invoice_id, branch_id, line_no, product_id, product_unit_id, quantity, base_quantity, list_price, unit_price,
      discount_percent, tax_code_id, tax_rate, line_net, line_tax, line_total)
    values (v_org, v_inv.id, v_wh.branch_id, v_n, v_prod.id, v_unit.id, v_qty, v_base, v_list, v_price, v_disc, v_taxid, v_rate,
            v_net, v_tax, v_net + v_tax);
  end loop;

  update public.sales_invoices
     set subtotal = v_sub, discount_total = v_discsum, tax_total = v_taxsum, total_amount = v_sub + v_taxsum
   where id = v_inv.id;
  return v_inv.id;
end;
$$;

create function public.cancel_sales_invoice(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_inv public.sales_invoices;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_inv from public.sales_invoices i where i.id = p_id and i.organization_id = v_org for update;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('sales.create', v_inv.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_inv.status <> 'DRAFT' then
    raise exception 'only a draft invoice can be cancelled (this one is %); a posted invoice needs a credit note', v_inv.status using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.sales_invoices set status = 'CANCELLED', status_reason = btrim(p_reason) where id = v_inv.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- receipts (internal engine shared by record_receipt, post_sales_invoice and allocate_receipt)
-- ---------------------------------------------------------------------------------------------------------
-- p_allocations: [{ invoice_id, amount }]. Locks the invoices in id order, checks each against what is still owed, applies.
create function private.apply_receipt_allocations(p_receipt public.customer_receipts, p_allocations jsonb)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row     record;
  v_inv     public.sales_invoices;
  v_amount  numeric;
  v_total   numeric := 0;
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
     where i.id = v_row.invoice_id and i.organization_id = p_receipt.organization_id for update;
    if not found or v_inv.customer_id <> p_receipt.customer_id then
      raise exception 'an invoice does not belong to this customer' using errcode = 'P0002';
    end if;
    if v_inv.status <> 'POSTED' then
      raise exception 'only a posted invoice can be paid (% is %)', coalesce(v_inv.invoice_number, 'a draft'), v_inv.status using errcode = '22023';
    end if;
    if v_amount > v_inv.balance_due then
      raise exception 'invoice % only has % left to pay', v_inv.invoice_number, v_inv.balance_due using errcode = '22023';
    end if;
    insert into public.receipt_allocations (organization_id, receipt_id, sales_invoice_id, branch_id, amount)
    values (p_receipt.organization_id, p_receipt.id, v_inv.id, p_receipt.branch_id, v_amount);
    update public.sales_invoices set amount_paid = amount_paid + v_amount where id = v_inv.id;
    v_total := v_total + v_amount;
  end loop;
  if v_total > p_receipt.unallocated_amount then
    raise exception 'the allocations (%) exceed what is left of this receipt (%)', v_total, p_receipt.unallocated_amount using errcode = '22023';
  end if;
  update public.customer_receipts set allocated_amount = allocated_amount + v_total where id = p_receipt.id;
  return v_total;
end;
$$;

-- oldest-due-first allocation of an amount over a customer's open invoices
create function private.fifo_allocations(p_org uuid, p_customer_id uuid, p_amount numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_left  numeric := p_amount;
  v_out   jsonb := '[]'::jsonb;
  v_inv   record;
  v_take  numeric;
begin
  for v_inv in
    select i.id, i.balance_due from public.sales_invoices i
    where i.organization_id = p_org and i.customer_id = p_customer_id and i.status = 'POSTED' and i.balance_due > 0
    order by i.due_date, i.posted_at, i.id
  loop
    exit when v_left <= 0;
    v_take := least(v_left, v_inv.balance_due);
    v_out := v_out || jsonb_build_array(jsonb_build_object('invoice_id', v_inv.id, 'amount', v_take));
    v_left := v_left - v_take;
  end loop;
  return v_out;
end;
$$;

-- Creates and numbers a receipt, then allocates (the given allocations, or oldest-due-first when null).
create function private.create_receipt(
  p_org uuid, p_customer_id uuid, p_branch_id uuid, p_amount numeric, p_method text, p_reference text, p_notes text,
  p_allocations jsonb, p_auto_allocate boolean
)
returns public.customer_receipts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_rec   public.customer_receipts;
  v_alloc jsonb;
begin
  select (now() at time zone o.timezone)::date into v_today from public.organizations o where o.id = p_org;
  insert into public.customer_receipts (organization_id, receipt_number, customer_id, branch_id, receipt_date, method, reference, amount, notes)
  values (p_org, private.generate_document_number(p_org, null, 'CUSTOMER_RECEIPT', 'RCP'), p_customer_id, p_branch_id, v_today, p_method,
          nullif(btrim(p_reference), ''), p_amount, nullif(btrim(p_notes), ''))
  returning * into v_rec;
  v_alloc := case when p_allocations is not null then p_allocations
                  when p_auto_allocate then private.fifo_allocations(p_org, p_customer_id, p_amount) else '[]'::jsonb end;
  if jsonb_array_length(v_alloc) > 0 then
    perform private.apply_receipt_allocations(v_rec, v_alloc);
    select * into v_rec from public.customer_receipts r where r.id = v_rec.id;
  end if;
  return v_rec;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- credit position
-- ---------------------------------------------------------------------------------------------------------
-- What the customer owes on posted invoices, their unused credit (unallocated receipts), and what that leaves under their limit.
create function private.customer_position(p_org uuid, p_customer_id uuid)
returns table (outstanding numeric, credit_held numeric, credit_limit numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select sum(i.balance_due) from public.sales_invoices i
                    where i.organization_id = p_org and i.customer_id = p_customer_id and i.status = 'POSTED'), 0),
         coalesce((select sum(r.unallocated_amount) from public.customer_receipts r
                    where r.organization_id = p_org and r.customer_id = p_customer_id and r.status = 'POSTED'), 0),
         (select c.credit_limit from public.customers c where c.id = p_customer_id and c.organization_id = p_org)
$$;

-- ---------------------------------------------------------------------------------------------------------
-- posting
-- ---------------------------------------------------------------------------------------------------------
-- p_payment: { amount, method, reference? } - money handed over at the counter, recorded and allocated to THIS invoice as part of posting
create function public.post_sales_invoice(p_id uuid, p_override_reason text default null, p_payment jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.current_organization_id();
  v_inv     public.sales_invoices;
  v_cust    public.customers;
  v_today   date;
  v_line    record;
  v_cand    record;
  v_prod    public.products;
  v_base_unit uuid;
  v_remaining numeric;
  v_take    numeric;
  v_avail   numeric;
  v_used    jsonb := '{}'::jsonb;
  v_stock_lines jsonb := '[]'::jsonb;
  v_alloc_rows jsonb := '[]'::jsonb;
  v_stock   jsonb;
  v_doc_id  uuid;
  v_number  text;
  v_issues  text[] := '{}';
  v_pos     record;
  v_pay_amount numeric := 0;
  v_pay_method text;
  v_receipt public.customer_receipts;
  v_medicine boolean;
  v_alloc   record;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_inv from public.sales_invoices i where i.id = p_id and i.organization_id = v_org for update;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('sales.post', v_inv.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_inv.status <> 'DRAFT' then
    raise exception 'only a draft invoice can be posted (this one is %)', v_inv.status using errcode = '22023';
  end if;
  if not exists (select 1 from public.sales_invoice_lines l where l.sales_invoice_id = v_inv.id) then
    raise exception 'the invoice has no lines' using errcode = '22023';
  end if;

  select * into v_cust from public.customers c where c.id = v_inv.customer_id and c.organization_id = v_org;
  if not v_cust.is_active then
    raise exception 'the customer is inactive' using errcode = '22023';
  end if;
  select (now() at time zone o.timezone)::date into v_today from public.organizations o where o.id = v_org;

  -- 1. regulatory rules: nobody can override these
  for v_line in
    select l.line_no, l.product_id from public.sales_invoice_lines l where l.sales_invoice_id = v_inv.id order by l.line_no
  loop
    select * into v_prod from public.products p where p.id = v_line.product_id;
    if not v_prod.is_active then
      raise exception 'line %: % is no longer active', v_line.line_no, v_prod.sku using errcode = '22023';
    end if;
    v_medicine := v_prod.product_class in ('POM', 'P', 'CONTROLLED');
    if v_medicine then
      if v_cust.customer_type not in ('PHARMACY', 'HOSPITAL', 'CLINIC', 'WHOLESALER') then
        raise exception 'line %: % is a medicine (%) and % is not a licensed pharmacy, hospital, clinic or wholesaler',
          v_line.line_no, v_prod.sku, v_prod.product_class, v_cust.name using errcode = '22023';
      end if;
      if v_cust.licence_expiry is null or v_cust.licence_number is null then
        raise exception 'line %: % is a medicine and the premises licence of % is not recorded - add it to the customer first',
          v_line.line_no, v_prod.sku, v_cust.name using errcode = '22023';
      end if;
      if v_cust.licence_expiry < v_today then
        raise exception 'line %: % is a medicine and the premises licence of % expired on % - it must be renewed first',
          v_line.line_no, v_prod.sku, v_cust.name, v_cust.licence_expiry using errcode = '22023';
      end if;
    end if;
    if v_prod.product_class = 'CONTROLLED' and not v_cust.controlled_drugs_authorised then
      raise exception 'line %: % is a controlled drug and % is not authorised to buy controlled drugs', v_line.line_no, v_prod.sku, v_cust.name
        using errcode = '22023';
    end if;
  end loop;

  -- 2. immediate payment (cash sale / deposit): recorded and allocated to this invoice, so credit checks see it
  if p_payment is not null then
    if jsonb_typeof(p_payment) <> 'object' or jsonb_typeof(p_payment -> 'amount') is distinct from 'number' or (p_payment ->> 'amount')::numeric <= 0
       or (p_payment ->> 'amount')::numeric <> round((p_payment ->> 'amount')::numeric, 2) then
      raise exception 'the payment must have a positive amount with at most 2 decimals' using errcode = '22023';
    end if;
    if not private.has_permission('receipts.create', v_inv.branch_id) then
      raise exception 'insufficient privilege to take payment' using errcode = '42501';
    end if;
    v_pay_amount := (p_payment ->> 'amount')::numeric;
    v_pay_method := upper(coalesce(p_payment ->> 'method', ''));
    if v_pay_method not in ('CASH', 'MOBILE_MONEY', 'BANK_TRANSFER', 'CHEQUE', 'CARD') then
      raise exception 'choose how the customer paid (cash, mobile money, bank transfer, cheque or card)' using errcode = '22023';
    end if;
    if v_pay_amount > v_inv.total_amount then
      raise exception 'the payment (%) is more than the invoice total (%)', v_pay_amount, v_inv.total_amount using errcode = '22023';
    end if;
  end if;

  -- 3. credit control: hold and limit can be overridden with sales.override_credit and a reason
  select * into v_pos from private.customer_position(v_org, v_cust.id);
  if v_cust.on_hold then
    v_issues := v_issues || ('the customer is on credit hold (' || coalesce(v_cust.hold_reason, 'no reason given') || ')');
  end if;
  if v_pos.outstanding + (v_inv.total_amount - v_pay_amount) - v_pos.credit_held > v_cust.credit_limit then
    v_issues := v_issues || format('this would take the customer to %s owed against a credit limit of %s',
      round(v_pos.outstanding + (v_inv.total_amount - v_pay_amount) - v_pos.credit_held, 2), v_cust.credit_limit);
  end if;
  if array_length(v_issues, 1) > 0 then
    if p_override_reason is null or btrim(p_override_reason) = '' then
      raise exception 'credit check failed: %. Take payment, or ask someone allowed to override credit for a reason.', array_to_string(v_issues, '; ')
        using errcode = '22023';
    end if;
    if not private.has_permission('sales.override_credit', v_inv.branch_id) then
      raise exception 'credit check failed: %. You are not allowed to override credit.', array_to_string(v_issues, '; ') using errcode = '42501';
    end if;
    if length(p_override_reason) > 500 then
      raise exception 'the override reason is limited to 500 characters' using errcode = '22023';
    end if;
  end if;

  -- 4. pick the batches, earliest expiry first, and prepare the stock lines
  for v_line in
    select l.id, l.line_no, l.product_id, l.base_quantity from public.sales_invoice_lines l where l.sales_invoice_id = v_inv.id order by l.line_no
  loop
    select u.id into v_base_unit from public.product_units u where u.product_id = v_line.product_id and u.is_base;
    v_remaining := v_line.base_quantity;
    v_avail := 0;
    for v_cand in
      select sb.id, sb.batch_id, sb.location_id, sb.quantity, ba.expiry_date
      from public.stock_balances sb
      left join public.batches ba on ba.id = sb.batch_id
      where sb.organization_id = v_org and sb.warehouse_id = v_inv.warehouse_id and sb.product_id = v_line.product_id
        and sb.stock_status = 'AVAILABLE' and sb.quantity > 0
        and (ba.id is null or ba.expiry_date >= v_today + v_cust.min_shelf_life_days)
      order by ba.expiry_date nulls last, ba.created_at, ba.id, sb.location_id nulls first, sb.id
    loop
      v_avail := v_avail + greatest(0, v_cand.quantity - coalesce((v_used ->> v_cand.id::text)::numeric, 0));
      exit when v_remaining <= 0;
      v_take := least(greatest(0, v_cand.quantity - coalesce((v_used ->> v_cand.id::text)::numeric, 0)), v_remaining);
      if v_take > 0 then
        v_used := jsonb_set(v_used, array[v_cand.id::text], to_jsonb(coalesce((v_used ->> v_cand.id::text)::numeric, 0) + v_take));
        v_stock_lines := v_stock_lines || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'product_id', v_line.product_id, 'batch_id', v_cand.batch_id, 'location_id', v_cand.location_id,
          'status', 'AVAILABLE', 'quantity', v_take, 'product_unit_id', v_base_unit)));
        v_alloc_rows := v_alloc_rows || jsonb_build_array(jsonb_build_object(
          'line_id', v_line.id, 'product_id', v_line.product_id, 'batch_id', v_cand.batch_id, 'location_id', v_cand.location_id, 'qty', v_take));
        v_remaining := v_remaining - v_take;
      end if;
    end loop;
    if v_remaining > 0 then
      select * into v_prod from public.products p where p.id = v_line.product_id;
      raise exception 'line %: not enough sellable stock of % - % needed, % available (unexpired, with at least % days of shelf life for this customer)',
        v_line.line_no, v_prod.sku, v_line.base_quantity, v_line.base_quantity - v_remaining, v_cust.min_shelf_life_days using errcode = '23514';
    end if;
  end loop;

  -- 5. the stock leaves, atomically with everything else
  v_stock := private.post_stock('SALE', v_inv.warehouse_id, v_stock_lines, null, null, null, 'SALES_INVOICE', v_inv.id);
  v_doc_id := (v_stock ->> 'document_id')::uuid;
  v_number := private.generate_document_number(v_org, null, 'SALES_INVOICE', 'INV');

  insert into public.sales_invoice_allocations (organization_id, sales_invoice_id, sales_invoice_line_id, branch_id, product_id, batch_id, location_id, base_quantity, unit_cost_base)
  select v_org, v_inv.id, (a.value ->> 'line_id')::uuid, v_inv.branch_id, (a.value ->> 'product_id')::uuid,
         nullif(a.value ->> 'batch_id', '')::uuid, nullif(a.value ->> 'location_id', '')::uuid, (a.value ->> 'qty')::numeric, c.unit_cost_base
  from jsonb_array_elements(v_alloc_rows) a
  left join public.batch_costs c on c.batch_id = nullif(a.value ->> 'batch_id', '')::uuid;

  if array_length(v_issues, 1) > 0 then
    perform set_config('app.audit_reason', btrim(p_override_reason), true);
  end if;
  update public.sales_invoices
     set status = 'POSTED', invoice_number = v_number, due_date = v_today + v_inv.payment_terms_days, posted_by = auth.uid(), posted_at = now(),
         stock_document_id = v_doc_id, override_reason = case when array_length(v_issues, 1) > 0 then btrim(p_override_reason) else null end
   where id = v_inv.id;

  if p_payment is not null then
    v_receipt := private.create_receipt(v_org, v_cust.id, v_inv.branch_id, v_pay_amount, v_pay_method, p_payment ->> 'reference',
                                        'Payment at the counter for ' || v_number,
                                        jsonb_build_array(jsonb_build_object('invoice_id', v_inv.id, 'amount', v_pay_amount)), false);
  end if;

  return jsonb_build_object('invoice_number', v_number, 'total_amount', v_inv.total_amount, 'stock_document_number', v_stock ->> 'document_number',
                            'receipt_number', v_receipt.receipt_number, 'overridden', array_length(v_issues, 1) > 0);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- receipts (public)
-- ---------------------------------------------------------------------------------------------------------
-- p_allocations: [{ invoice_id, amount }] or null for oldest-due-first. Whatever is not allocated stays as the customer's credit.
create function public.record_receipt(
  p_customer_id uuid,
  p_branch_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text default null,
  p_allocations jsonb default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid := private.current_organization_id();
  v_rec  public.customer_receipts;
  v_method text := upper(coalesce(p_method, ''));
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.organization_id = v_org and b.is_active) then
    raise exception 'branch not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('receipts.create', p_branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if not exists (select 1 from public.customers c where c.id = p_customer_id and c.organization_id = v_org) then
    raise exception 'customer not found' using errcode = 'P0002';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) or p_amount >= 1000000000000 then
    raise exception 'enter the amount received (more than 0, at most 2 decimals)' using errcode = '22023';
  end if;
  if v_method not in ('CASH', 'MOBILE_MONEY', 'BANK_TRANSFER', 'CHEQUE', 'CARD') then
    raise exception 'choose how the customer paid' using errcode = '22023';
  end if;
  if v_method <> 'CASH' and (p_reference is null or btrim(p_reference) = '') then
    raise exception 'enter the reference (cheque number, transfer or mobile money reference)' using errcode = '22023';
  end if;
  if p_reference is not null and length(p_reference) > 100 then
    raise exception 'the reference is limited to 100 characters' using errcode = '22023';
  end if;
  if p_allocations is not null and jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'allocations must be a list' using errcode = '22023';
  end if;
  v_rec := private.create_receipt(v_org, p_customer_id, p_branch_id, p_amount, v_method, p_reference, p_notes, p_allocations, p_allocations is null);
  return jsonb_build_object('receipt_id', v_rec.id, 'receipt_number', v_rec.receipt_number, 'allocated', v_rec.allocated_amount, 'unallocated', v_rec.unallocated_amount);
end;
$$;

-- Applies the unallocated part of an existing receipt to invoices (for example credit received before the invoice existed).
create function public.allocate_receipt(p_receipt_id uuid, p_allocations jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_rec public.customer_receipts;
  v_alloc jsonb;
  v_done numeric;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_rec from public.customer_receipts r where r.id = p_receipt_id and r.organization_id = v_org for update;
  if not found then
    raise exception 'receipt not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('receipts.create', v_rec.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_rec.status <> 'POSTED' then
    raise exception 'a voided receipt cannot be allocated' using errcode = '22023';
  end if;
  if v_rec.unallocated_amount <= 0 then
    raise exception 'this receipt is fully allocated' using errcode = '22023';
  end if;
  v_alloc := coalesce(p_allocations, private.fifo_allocations(v_org, v_rec.customer_id, v_rec.unallocated_amount));
  if jsonb_typeof(v_alloc) <> 'array' or jsonb_array_length(v_alloc) = 0 then
    raise exception 'there is no open invoice to allocate this receipt to' using errcode = '22023';
  end if;
  v_done := private.apply_receipt_allocations(v_rec, v_alloc);
  return jsonb_build_object('allocated', v_done);
end;
$$;

create function public.void_receipt(p_id uuid, p_reason text)
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
-- credit and receivables reads (SECURITY INVOKER: the caller's RLS applies)
-- ---------------------------------------------------------------------------------------------------------
-- A customer's position for the invoice form and the customer page.
create function public.customer_credit(p_customer_id uuid)
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
    select coalesce(sum(r.unallocated_amount), 0) as held from public.customer_receipts r where r.customer_id = c.id and r.status = 'POSTED') h
  where c.id = p_customer_id
$$;

create function public.receivables_summary()
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
    select r.customer_id, sum(r.unallocated_amount) as held from public.customer_receipts r where r.status = 'POSTED' and r.unallocated_amount > 0 group by r.customer_id
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

-- Invoices and receipts of one customer in date order with a running balance (debit = they owe more, credit = they paid).
create function public.customer_statement(p_customer_id uuid, p_from date default null)
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
revoke all on function private.sales_invoices_posted_lock() from public, anon, authenticated;
revoke all on function private.apply_receipt_allocations(public.customer_receipts, jsonb) from public, anon, authenticated;
revoke all on function private.fifo_allocations(uuid, uuid, numeric) from public, anon, authenticated;
revoke all on function private.create_receipt(uuid, uuid, uuid, numeric, text, text, text, jsonb, boolean) from public, anon, authenticated;
revoke all on function private.customer_position(uuid, uuid) from public, anon, authenticated;

revoke all on function public.save_sales_invoice(uuid, uuid, uuid, text, text, jsonb) from public, anon;
revoke all on function public.cancel_sales_invoice(uuid, text) from public, anon;
revoke all on function public.post_sales_invoice(uuid, text, jsonb) from public, anon;
revoke all on function public.record_receipt(uuid, uuid, numeric, text, text, jsonb, text) from public, anon;
revoke all on function public.allocate_receipt(uuid, jsonb) from public, anon;
revoke all on function public.void_receipt(uuid, text) from public, anon;
revoke all on function public.customer_credit(uuid) from public, anon;
revoke all on function public.receivables_summary() from public, anon;
revoke all on function public.customer_statement(uuid, date) from public, anon;
grant execute on function public.save_sales_invoice(uuid, uuid, uuid, text, text, jsonb) to authenticated;
grant execute on function public.cancel_sales_invoice(uuid, text) to authenticated;
grant execute on function public.post_sales_invoice(uuid, text, jsonb) to authenticated;
grant execute on function public.record_receipt(uuid, uuid, numeric, text, text, jsonb, text) to authenticated;
grant execute on function public.allocate_receipt(uuid, jsonb) to authenticated;
grant execute on function public.void_receipt(uuid, text) to authenticated;
grant execute on function public.customer_credit(uuid) to authenticated;
grant execute on function public.receivables_summary() to authenticated;
grant execute on function public.customer_statement(uuid, date) to authenticated;
