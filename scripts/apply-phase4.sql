-- Apply Phase 4 to the hosted database in ONE atomic paste: the five migrations, verbatim, inside a single transaction.
-- Run it once in the Supabase SQL editor. If anything fails, nothing is changed.
begin;

-- ===== migration 20261013000100_phase4_permissions =====
-- Phase 4 / 01: permissions for costing, stock counts, purchase returns and supplier invoices (payables)
--
--   inventory.valuation     see what stock cost (batch costs and the valuation report) - sensitive, so separate from inventory.view
--   inventory.count         start counts and enter counted quantities
--   inventory.count_approve approve a count (this posts the variances to stock)
--   payables.view           see supplier invoices, ageing and credits
--   payables.create         record and edit supplier invoices, record supplier credits
--   payables.approve        approve an invoice for payment (after the 3-way match)
--   payables.pay            mark an approved invoice as paid
-- Returning goods to a supplier uses purchasing.receive (the warehouse that holds the stock).

insert into public.permissions (code, module, action, description) values
  ('inventory.valuation',     'inventory', 'valuation',     'See stock cost and the stock valuation report'),
  ('inventory.count',         'inventory', 'count',         'Start stock counts and enter counted quantities'),
  ('inventory.count_approve', 'inventory', 'count_approve', 'Approve stock counts (posts the variances)'),
  ('payables.view',           'payables',  'view',          'View supplier invoices, ageing and credits'),
  ('payables.create',         'payables',  'create',        'Record and edit supplier invoices and credits'),
  ('payables.approve',        'payables',  'approve',       'Approve supplier invoices for payment'),
  ('payables.pay',            'payables',  'pay',           'Mark supplier invoices as paid')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, code) as (values
  ('SUPER_ADMIN', 'inventory.valuation'), ('SUPER_ADMIN', 'inventory.count'), ('SUPER_ADMIN', 'inventory.count_approve'),
  ('OWNER', 'inventory.valuation'), ('OWNER', 'inventory.count'), ('OWNER', 'inventory.count_approve'),
  ('GENERAL_MANAGER', 'inventory.valuation'), ('GENERAL_MANAGER', 'inventory.count'), ('GENERAL_MANAGER', 'inventory.count_approve'),
  ('WAREHOUSE_MANAGER', 'inventory.count'),
  ('WAREHOUSE_PICKER', 'inventory.count'),
  ('PHARMACIST', 'inventory.count'),
  ('BRANCH_MANAGER', 'inventory.count_approve'),
  ('PROCUREMENT_MANAGER', 'inventory.valuation'),
  ('ACCOUNTS_MANAGER', 'inventory.valuation'), ('ACCOUNTS_OFFICER', 'inventory.valuation'),
  ('AUDITOR', 'inventory.valuation'),
  ('SUPER_ADMIN', 'payables.view'), ('SUPER_ADMIN', 'payables.create'), ('SUPER_ADMIN', 'payables.approve'), ('SUPER_ADMIN', 'payables.pay'),
  ('OWNER', 'payables.view'), ('OWNER', 'payables.create'), ('OWNER', 'payables.approve'), ('OWNER', 'payables.pay'),
  ('GENERAL_MANAGER', 'payables.view'), ('GENERAL_MANAGER', 'payables.create'), ('GENERAL_MANAGER', 'payables.approve'), ('GENERAL_MANAGER', 'payables.pay'),
  ('ACCOUNTS_MANAGER', 'payables.view'), ('ACCOUNTS_MANAGER', 'payables.create'), ('ACCOUNTS_MANAGER', 'payables.approve'), ('ACCOUNTS_MANAGER', 'payables.pay'),
  ('ACCOUNTS_OFFICER', 'payables.view'), ('ACCOUNTS_OFFICER', 'payables.create'),
  ('PROCUREMENT_MANAGER', 'payables.view'), ('PROCUREMENT_MANAGER', 'payables.create'),
  ('PROCUREMENT_OFFICER', 'payables.view'), ('PROCUREMENT_OFFICER', 'payables.create'),
  ('AUDITOR', 'payables.view'), ('READ_ONLY', 'payables.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;

-- ===== migration 20261013000200_costing =====
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

-- ===== migration 20261013000300_purchase_returns =====
-- Phase 4 / 03: purchase returns (goods sent back to a supplier)
--
-- Returning goods takes stock out of the ledger (document type RETURN, movement RETURN_OUT) in the same transaction that
-- records the return, so the stock and the paperwork cannot disagree. A return is then "credited" when the supplier's credit
-- note arrives. Returns and their lines are immutable apart from recording that credit.

create table public.purchase_returns (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete restrict,
  return_number      text not null,
  supplier_id        uuid not null,
  branch_id          uuid not null,
  warehouse_id       uuid not null,
  purchase_order_id  uuid,
  stock_document_id  uuid not null,
  reason             text not null check (reason in ('DAMAGED', 'EXPIRED', 'WRONG_ITEM', 'OVER_SUPPLY', 'QUALITY', 'RECALL', 'OTHER')),
  notes              text check (notes is null or length(notes) <= 500),
  line_count         integer not null check (line_count > 0),
  expected_credit    numeric(18, 2) not null default 0 check (expected_credit >= 0),
  credit_status      text not null default 'PENDING' check (credit_status in ('PENDING', 'CREDITED')),
  credit_note_number text check (credit_note_number is null or length(credit_note_number) <= 60),
  credit_amount      numeric(18, 2) check (credit_amount is null or credit_amount >= 0),
  credited_by        uuid,
  credited_at        timestamptz,
  returned_by        uuid default auth.uid(),
  returned_at        timestamptz not null default clock_timestamp(),
  constraint purchase_returns_supplier_fk foreign key (supplier_id, organization_id)
    references public.suppliers (id, organization_id) on delete restrict,
  constraint purchase_returns_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint purchase_returns_warehouse_fk foreign key (warehouse_id, organization_id)
    references public.warehouses (id, organization_id) on delete restrict,
  constraint purchase_returns_po_fk foreign key (purchase_order_id, organization_id)
    references public.purchase_orders (id, organization_id) on delete restrict,
  constraint purchase_returns_stock_document_fk foreign key (stock_document_id, organization_id)
    references public.stock_documents (id, organization_id) on delete restrict,
  constraint purchase_returns_number_key unique (organization_id, return_number),
  constraint purchase_returns_id_org_key unique (id, organization_id),
  constraint purchase_returns_credit_consistent check ((credit_status = 'CREDITED') = (credit_note_number is not null and credit_amount is not null))
);
create index purchase_returns_org_returned_idx on public.purchase_returns (organization_id, returned_at desc, id desc);
create index purchase_returns_branch_idx on public.purchase_returns (organization_id, branch_id, credit_status);
create index purchase_returns_supplier_idx on public.purchase_returns (supplier_id);
create index purchase_returns_warehouse_idx on public.purchase_returns (warehouse_id);
create index purchase_returns_po_idx on public.purchase_returns (purchase_order_id) where purchase_order_id is not null;
create index purchase_returns_stock_document_idx on public.purchase_returns (stock_document_id);

create trigger purchase_returns_immutable before update on public.purchase_returns
  for each row execute function private.prevent_column_change(
    'organization_id', 'return_number', 'supplier_id', 'branch_id', 'warehouse_id', 'purchase_order_id', 'stock_document_id',
    'reason', 'line_count', 'expected_credit', 'returned_by', 'returned_at');
create trigger purchase_returns_no_delete before delete on public.purchase_returns
  for each row execute function private.stock_block_mutation();
create trigger purchase_returns_audit after insert or update on public.purchase_returns
  for each row execute function private.audit_row_change('purchase_return');

create table public.purchase_return_lines (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete restrict,
  purchase_return_id uuid not null,
  branch_id         uuid not null,
  line_no           integer not null check (line_no > 0),
  product_id        uuid not null,
  batch_id          uuid,
  product_unit_id   uuid not null,
  quantity_returned numeric(18, 3) not null check (quantity_returned > 0),
  returned_base     numeric(18, 3) not null check (returned_base > 0),
  unit_cost_base    numeric(18, 6) check (unit_cost_base is null or unit_cost_base >= 0),   -- NULL = batch had no cost
  stock_status      text not null check (stock_status in ('AVAILABLE', 'QUARANTINE', 'DAMAGED', 'EXPIRED')),
  location_id       uuid references public.warehouse_locations (id) on delete restrict,
  constraint purchase_return_lines_return_fk foreign key (purchase_return_id, organization_id)
    references public.purchase_returns (id, organization_id) on delete restrict,
  constraint purchase_return_lines_product_fk foreign key (product_id, organization_id)
    references public.products (id, organization_id) on delete restrict,
  constraint purchase_return_lines_batch_fk foreign key (batch_id, product_id, organization_id)
    references public.batches (id, product_id, organization_id) on delete restrict,
  constraint purchase_return_lines_unit_fk foreign key (product_unit_id, product_id, organization_id)
    references public.product_units (id, product_id, organization_id) on delete restrict
);
create index purchase_return_lines_return_idx on public.purchase_return_lines (purchase_return_id, line_no);
create index purchase_return_lines_product_idx on public.purchase_return_lines (organization_id, product_id);
create index purchase_return_lines_batch_idx on public.purchase_return_lines (batch_id) where batch_id is not null;
create index purchase_return_lines_unit_idx on public.purchase_return_lines (product_unit_id);
create index purchase_return_lines_location_idx on public.purchase_return_lines (location_id) where location_id is not null;

create trigger purchase_return_lines_append_only before update or delete on public.purchase_return_lines
  for each row execute function private.stock_block_mutation();
create trigger purchase_return_lines_no_truncate before truncate on public.purchase_return_lines
  for each statement execute function private.stock_block_mutation();

alter table public.purchase_returns      enable row level security;
alter table public.purchase_return_lines enable row level security;
revoke all on public.purchase_returns, public.purchase_return_lines from public, anon, authenticated;
grant select on public.purchase_returns, public.purchase_return_lines to authenticated;

create policy purchase_returns_select on public.purchase_returns
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('purchasing.view', branch_id));
create policy purchase_return_lines_select on public.purchase_return_lines
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('purchasing.view', branch_id));

-- ---------------------------------------------------------------------------------------------------------
-- p_lines: [{ product_id, quantity, batch_id?, product_unit_id?, location_id?, status? }]  (stock is taken from that batch/location/status)
-- ---------------------------------------------------------------------------------------------------------
create function public.post_purchase_return(
  p_supplier_id uuid,
  p_warehouse_id uuid,
  p_reason text,
  p_lines jsonb,
  p_notes text default null,
  p_purchase_order_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.current_organization_id();
  v_wh      public.warehouses;
  v_sup     public.suppliers;
  v_po      public.purchase_orders;
  v_id      uuid := gen_random_uuid();
  v_stock   jsonb;
  v_doc_id  uuid;
  v_number  text;
  v_credit  numeric;
  v_n       integer;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_wh from public.warehouses w where w.id = p_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('purchasing.receive', v_wh.branch_id) then
    raise exception 'insufficient privilege for this warehouse' using errcode = '42501';
  end if;
  select * into v_sup from public.suppliers s where s.id = p_supplier_id and s.organization_id = v_org;
  if not found then
    raise exception 'supplier not found' using errcode = 'P0002';
  end if;
  if p_purchase_order_id is not null then
    select * into v_po from public.purchase_orders po
     where po.id = p_purchase_order_id and po.organization_id = v_org and po.supplier_id = v_sup.id;
    if not found then
      raise exception 'purchase order not found for this supplier' using errcode = 'P0002';
    end if;
  end if;
  if p_reason is null or p_reason not in ('DAMAGED', 'EXPIRED', 'WRONG_ITEM', 'OVER_SUPPLY', 'QUALITY', 'RECALL', 'OTHER') then
    raise exception 'choose a reason for the return' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'add at least one line' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_lines);

  v_stock := private.post_stock('RETURN', v_wh.id, p_lines, null, null, p_notes, 'PURCHASE_RETURN', v_id);
  v_doc_id := (v_stock ->> 'document_id')::uuid;
  v_number := private.generate_document_number(v_org, null, 'PURCHASE_RETURN', 'PRN');

  select coalesce(round(sum(-m.quantity * c.unit_cost_base), 2), 0) into v_credit
  from public.stock_movements m
  left join public.batch_costs c on c.batch_id = m.batch_id
  where m.document_id = v_doc_id;

  insert into public.purchase_returns (
    id, organization_id, return_number, supplier_id, branch_id, warehouse_id, purchase_order_id, stock_document_id,
    reason, notes, line_count, expected_credit)
  values (v_id, v_org, v_number, v_sup.id, v_wh.branch_id, v_wh.id, v_po.id, v_doc_id, p_reason,
          nullif(btrim(p_notes), ''), v_n, v_credit);

  insert into public.purchase_return_lines (
    organization_id, purchase_return_id, branch_id, line_no, product_id, batch_id, product_unit_id,
    quantity_returned, returned_base, unit_cost_base, stock_status, location_id)
  select v_org, v_id, v_wh.branch_id, m.line_no, m.product_id, m.batch_id, m.entered_unit_id,
         m.entered_quantity, -m.quantity, c.unit_cost_base, m.stock_status, m.location_id
  from public.stock_movements m
  left join public.batch_costs c on c.batch_id = m.batch_id
  where m.document_id = v_doc_id;

  return jsonb_build_object('purchase_return_id', v_id, 'return_number', v_number,
                            'stock_document_number', v_stock ->> 'document_number', 'expected_credit', v_credit);
end;
$$;

create function public.record_return_credit(p_id uuid, p_credit_note_number text, p_amount numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_ret public.purchase_returns;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_ret from public.purchase_returns r where r.id = p_id and r.organization_id = v_org for update;
  if not found then
    raise exception 'purchase return not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('payables.create', v_ret.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_ret.credit_status <> 'PENDING' then
    raise exception 'the credit for this return was already recorded' using errcode = '22023';
  end if;
  if p_credit_note_number is null or btrim(p_credit_note_number) = '' or length(p_credit_note_number) > 60 then
    raise exception 'enter the supplier''s credit note number' using errcode = '22023';
  end if;
  if p_amount is null or p_amount < 0 or p_amount <> round(p_amount, 2) or p_amount >= 1000000000000 then
    raise exception 'enter the credit amount (0 or more, 2 decimals)' using errcode = '22023';
  end if;
  update public.purchase_returns
     set credit_status = 'CREDITED', credit_note_number = btrim(p_credit_note_number), credit_amount = p_amount,
         credited_by = auth.uid(), credited_at = now()
   where id = v_ret.id;
end;
$$;

revoke all on function public.post_purchase_return(uuid, uuid, text, jsonb, text, uuid) from public, anon;
revoke all on function public.record_return_credit(uuid, text, numeric) from public, anon;
grant execute on function public.post_purchase_return(uuid, uuid, text, jsonb, text, uuid) to authenticated;
grant execute on function public.record_return_credit(uuid, text, numeric) to authenticated;

-- ===== migration 20261013000400_supplier_invoices =====
-- Phase 4 / 04: supplier invoices with 3-way match, and payables
--
-- 3-way match = purchase order (what was agreed) <-> goods received (what arrived) <-> supplier invoice (what is being billed).
-- For every invoice line the database checks, at the time the invoice is recorded AND again when it is approved:
--   quantity  the invoiced quantity may not exceed what was received minus what other live invoices already bill for that line
--   price     the invoiced unit price must be within 1 % of the order price
-- A fully matching invoice is MATCHED; otherwise it is an EXCEPTION that can still be approved, but only with a stated reason.
-- Lifecycle: MATCHED | EXCEPTION -> APPROVED -> PAID, and CANCELLED (frees the quantities again).
-- Amounts are in the order currency; tax is entered as one amount (a tax engine arrives with finance).
-- Payments themselves are not modelled here: "PAID" records that it was paid, when and under which reference.

create table public.supplier_invoices (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete restrict
                            default private.current_organization_id(),
  invoice_number          text not null,
  supplier_invoice_number text not null check (btrim(supplier_invoice_number) <> '' and length(supplier_invoice_number) <= 60),
  supplier_id             uuid not null,
  purchase_order_id       uuid not null,
  branch_id               uuid not null,
  invoice_date            date not null,
  due_date                date not null,
  currency_code           text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal                numeric(18, 2) not null default 0 check (subtotal >= 0),
  tax_amount              numeric(18, 2) not null default 0 check (tax_amount >= 0),
  total_amount            numeric(18, 2) not null default 0 check (total_amount >= 0),
  status                  text not null default 'MATCHED' check (status in ('MATCHED', 'EXCEPTION', 'APPROVED', 'PAID', 'CANCELLED')),
  variance_reason         text check (variance_reason is null or length(variance_reason) <= 500),
  status_reason           text check (status_reason is null or length(status_reason) <= 500),
  notes                   text check (notes is null or length(notes) <= 1000),
  created_by              uuid default auth.uid(),
  approved_by             uuid,
  approved_at             timestamptz,
  paid_on                 date,
  payment_reference       text check (payment_reference is null or length(payment_reference) <= 100),
  paid_by                 uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint supplier_invoices_supplier_fk foreign key (supplier_id, organization_id)
    references public.suppliers (id, organization_id) on delete restrict,
  constraint supplier_invoices_po_fk foreign key (purchase_order_id, organization_id)
    references public.purchase_orders (id, organization_id) on delete restrict,
  constraint supplier_invoices_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint supplier_invoices_number_key unique (organization_id, invoice_number),
  constraint supplier_invoices_id_org_key unique (id, organization_id),
  constraint supplier_invoices_due_after check (due_date >= invoice_date),
  constraint supplier_invoices_total check (total_amount = subtotal + tax_amount),
  constraint supplier_invoices_paid check ((status = 'PAID') = (paid_on is not null))
);
-- the same supplier invoice number cannot be booked twice (a cancelled one may be re-entered)
create unique index supplier_invoices_supplier_number_key
  on public.supplier_invoices (organization_id, supplier_id, lower(btrim(supplier_invoice_number))) where status <> 'CANCELLED';
create index supplier_invoices_org_created_idx on public.supplier_invoices (organization_id, created_at desc, id desc);
create index supplier_invoices_branch_status_idx on public.supplier_invoices (organization_id, branch_id, status, due_date);
create index supplier_invoices_supplier_idx on public.supplier_invoices (supplier_id);
create index supplier_invoices_po_idx on public.supplier_invoices (purchase_order_id);

create trigger supplier_invoices_immutable before update on public.supplier_invoices
  for each row execute function private.prevent_column_change('organization_id', 'invoice_number');
create trigger supplier_invoices_set_updated_at before update on public.supplier_invoices
  for each row execute function private.set_updated_at();
create trigger supplier_invoices_audit after insert or update or delete on public.supplier_invoices
  for each row execute function private.audit_row_change('supplier_invoice');

create table public.supplier_invoice_lines (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete restrict
                        default private.current_organization_id(),
  supplier_invoice_id uuid not null,
  branch_id           uuid not null,
  line_no             integer not null check (line_no > 0),
  po_line_id          uuid not null,
  product_id          uuid not null,
  quantity            numeric(18, 3) not null check (quantity > 0),     -- in the pack level of the order line
  unit_price          numeric(18, 4) not null check (unit_price >= 0),
  line_total          numeric(18, 2) generated always as (round(quantity * unit_price, 2)) stored,
  po_unit_cost        numeric(18, 4) not null,                          -- the agreed price at the time of the last match
  allowed_quantity    numeric(18, 3) not null,                          -- what could be billed at the time of the last match
  match_status        text not null check (match_status in ('MATCHED', 'QTY_OVER', 'PRICE_DIFF', 'QTY_AND_PRICE')),
  constraint supplier_invoice_lines_invoice_fk foreign key (supplier_invoice_id, organization_id)
    references public.supplier_invoices (id, organization_id) on delete restrict,
  constraint supplier_invoice_lines_po_line_fk foreign key (po_line_id, organization_id)
    references public.purchase_order_lines (id, organization_id) on delete restrict,
  constraint supplier_invoice_lines_product_fk foreign key (product_id, organization_id)
    references public.products (id, organization_id) on delete restrict,
  constraint supplier_invoice_lines_line_key unique (supplier_invoice_id, line_no),
  constraint supplier_invoice_lines_po_line_once unique (supplier_invoice_id, po_line_id)
);
create index supplier_invoice_lines_po_line_idx on public.supplier_invoice_lines (po_line_id);
create index supplier_invoice_lines_product_idx on public.supplier_invoice_lines (organization_id, product_id);

alter table public.supplier_invoices      enable row level security;
alter table public.supplier_invoice_lines enable row level security;
revoke all on public.supplier_invoices, public.supplier_invoice_lines from public, anon, authenticated;
grant select on public.supplier_invoices, public.supplier_invoice_lines to authenticated;

create policy supplier_invoices_select on public.supplier_invoices
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('payables.view', branch_id));
create policy supplier_invoice_lines_select on public.supplier_invoice_lines
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('payables.view', branch_id));

-- ---------------------------------------------------------------------------------------------------------
-- helpers (private)
-- ---------------------------------------------------------------------------------------------------------
-- Does somebody other than the caller hold p_permission for this branch? (separation of duties; a sole holder is exempt)
create function private.other_holder_exists(p_permission text, p_branch_id uuid)
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
      and pm.code = p_permission
      and (ur.branch_id is null or ur.branch_id = p_branch_id)
  )
$$;

-- The 3-way check for one invoice line. Locks nothing: callers hold the lock on the purchase order.
create function private.invoice_line_check(p_po_line_id uuid, p_exclude_invoice uuid, p_quantity numeric, p_price numeric)
returns table (allowed_quantity numeric, po_unit_cost numeric, match_status text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pol      public.purchase_order_lines;
  v_received numeric;
  v_billed   numeric;
  v_allowed  numeric;
  v_qty_ok   boolean;
  v_price_ok boolean;
begin
  select * into v_pol from public.purchase_order_lines l where l.id = p_po_line_id;
  v_received := round(v_pol.received_base / v_pol.ordered_base * v_pol.quantity_ordered, 3);
  select coalesce(sum(il.quantity), 0) into v_billed
  from public.supplier_invoice_lines il
  join public.supplier_invoices i on i.id = il.supplier_invoice_id
  where il.po_line_id = p_po_line_id and i.status <> 'CANCELLED' and i.id is distinct from p_exclude_invoice;
  v_allowed := greatest(0, v_received - v_billed);
  v_qty_ok := p_quantity <= v_allowed + 0.0005;
  v_price_ok := abs(p_price - v_pol.unit_cost) <= v_pol.unit_cost * 0.01 + 0.00005;
  return query select v_allowed, v_pol.unit_cost,
    case when v_qty_ok and v_price_ok then 'MATCHED' when v_price_ok then 'QTY_OVER'
         when v_qty_ok then 'PRICE_DIFF' else 'QTY_AND_PRICE' end;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- recording an invoice
-- ---------------------------------------------------------------------------------------------------------
-- p_lines: [{ po_line_id, quantity, unit_price }]  (quantity in the pack level the order line was placed in)
create function public.record_supplier_invoice(
  p_id uuid,
  p_purchase_order_id uuid,
  p_supplier_invoice_number text,
  p_invoice_date date,
  p_tax_amount numeric,
  p_notes text,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_po    public.purchase_orders;
  v_inv   public.supplier_invoices;
  v_line  jsonb;
  v_n     integer := 0;
  v_pol   public.purchase_order_lines;
  v_qty   numeric;
  v_price numeric;
  v_chk   record;
  v_bad   integer := 0;
  v_seen  uuid[] := '{}';
  v_tax   numeric := coalesce(p_tax_amount, 0);
  v_sub   numeric;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  v_po := private.po_load(p_purchase_order_id);       -- locks the order: invoices for one order are recorded one at a time
  if not private.has_permission('payables.create', v_po.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_po.status not in ('APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED') then
    raise exception 'an invoice can only be recorded against an approved order (this one is %)', v_po.status using errcode = '22023';
  end if;
  if p_supplier_invoice_number is null or btrim(p_supplier_invoice_number) = '' or length(p_supplier_invoice_number) > 60 then
    raise exception 'enter the supplier''s invoice number (up to 60 characters)' using errcode = '22023';
  end if;
  if p_invoice_date is null or p_invoice_date > current_date + 1 then
    raise exception 'enter a valid invoice date (not in the future)' using errcode = '22023';
  end if;
  if v_tax < 0 or v_tax <> round(v_tax, 2) or v_tax >= 1000000000000 then
    raise exception 'tax must be 0 or more with at most 2 decimals' using errcode = '22023';
  end if;
  if p_notes is not null and length(p_notes) > 1000 then
    raise exception 'notes are limited to 1000 characters' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'add at least one invoice line' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 100 then
    raise exception 'an invoice is limited to 100 lines' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.supplier_invoices (
      organization_id, invoice_number, supplier_invoice_number, supplier_id, purchase_order_id, branch_id, invoice_date,
      due_date, currency_code, tax_amount, total_amount, notes)
    values (v_org, private.generate_document_number(v_org, null, 'SUPPLIER_INVOICE', 'SIN'), btrim(p_supplier_invoice_number),
            v_po.supplier_id, v_po.id, v_po.branch_id, p_invoice_date, p_invoice_date + v_po.payment_terms_days,
            v_po.currency_code, v_tax, v_tax, nullif(btrim(p_notes), ''))
    returning * into v_inv;
  else
    select * into v_inv from public.supplier_invoices i where i.id = p_id and i.organization_id = v_org for update;
    if not found or v_inv.purchase_order_id <> v_po.id then
      raise exception 'supplier invoice not found for this order' using errcode = 'P0002';
    end if;
    if v_inv.status not in ('MATCHED', 'EXCEPTION') then
      raise exception 'an invoice that is % cannot be edited', v_inv.status using errcode = '22023';
    end if;
    update public.supplier_invoices
       set supplier_invoice_number = btrim(p_supplier_invoice_number), invoice_date = p_invoice_date,
           due_date = p_invoice_date + v_po.payment_terms_days, tax_amount = v_tax, subtotal = 0, total_amount = v_tax,
           notes = nullif(btrim(p_notes), ''), variance_reason = null
     where id = v_inv.id;
    delete from public.supplier_invoice_lines where supplier_invoice_id = v_inv.id;
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'line %: invalid line', v_n using errcode = '22023';
    end if;
    select * into v_pol from public.purchase_order_lines l
     where l.id = nullif(v_line ->> 'po_line_id', '')::uuid and l.purchase_order_id = v_po.id;
    if not found then
      raise exception 'line %: not a line of this order', v_n using errcode = 'P0002';
    end if;
    if v_pol.id = any (v_seen) then
      raise exception 'line %: this order line is already on the invoice', v_n using errcode = '22023';
    end if;
    v_seen := v_seen || v_pol.id;
    if jsonb_typeof(v_line -> 'quantity') is distinct from 'number' or (v_line ->> 'quantity')::numeric <= 0 then
      raise exception 'line %: quantity must be a positive number', v_n using errcode = '22023';
    end if;
    if jsonb_typeof(v_line -> 'unit_price') is distinct from 'number' or (v_line ->> 'unit_price')::numeric < 0 then
      raise exception 'line %: price must be 0 or more', v_n using errcode = '22023';
    end if;
    v_qty := (v_line ->> 'quantity')::numeric;
    v_price := (v_line ->> 'unit_price')::numeric;
    if v_qty <> round(v_qty, 3) or v_price <> round(v_price, 4) or v_price >= 100000000000 or v_qty >= 1000000000000 then
      raise exception 'line %: too many decimals in quantity or price', v_n using errcode = '22023';
    end if;

    select * into v_chk from private.invoice_line_check(v_pol.id, v_inv.id, v_qty, v_price);
    if v_chk.match_status <> 'MATCHED' then
      v_bad := v_bad + 1;
    end if;
    insert into public.supplier_invoice_lines (
      organization_id, supplier_invoice_id, branch_id, line_no, po_line_id, product_id, quantity, unit_price,
      po_unit_cost, allowed_quantity, match_status)
    values (v_org, v_inv.id, v_po.branch_id, v_n, v_pol.id, v_pol.product_id, v_qty, v_price,
            v_chk.po_unit_cost, v_chk.allowed_quantity, v_chk.match_status);
  end loop;

  select coalesce(sum(l.line_total), 0) into v_sub from public.supplier_invoice_lines l where l.supplier_invoice_id = v_inv.id;
  update public.supplier_invoices
     set subtotal = v_sub, total_amount = v_sub + v_tax, status = case when v_bad = 0 then 'MATCHED' else 'EXCEPTION' end
   where id = v_inv.id;
  return v_inv.id;
end;
$$;

-- Re-checks the match; an invoice with variances needs a reason to be approved anyway.
create function public.approve_supplier_invoice(p_id uuid, p_variance_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid := private.current_organization_id();
  v_inv  public.supplier_invoices;
  v_l    record;
  v_chk  record;
  v_bad  integer := 0;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_inv from public.supplier_invoices i where i.id = p_id and i.organization_id = v_org;
  if not found then
    raise exception 'supplier invoice not found' using errcode = 'P0002';
  end if;
  perform private.po_load(v_inv.purchase_order_id);       -- serialise with other invoices on the same order
  select * into v_inv from public.supplier_invoices i where i.id = p_id for update;
  if not private.has_permission('payables.approve', v_inv.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_inv.status not in ('MATCHED', 'EXCEPTION') then
    raise exception 'only a recorded invoice can be approved (this one is %)', v_inv.status using errcode = '22023';
  end if;
  if v_inv.created_by = auth.uid() and private.other_holder_exists('payables.approve', v_inv.branch_id) then
    raise exception 'an invoice you recorded must be approved by someone else' using errcode = '42501';
  end if;

  for v_l in select * from public.supplier_invoice_lines l where l.supplier_invoice_id = v_inv.id loop
    select * into v_chk from private.invoice_line_check(v_l.po_line_id, v_inv.id, v_l.quantity, v_l.unit_price);
    if v_chk.match_status <> 'MATCHED' then
      v_bad := v_bad + 1;
    end if;
    update public.supplier_invoice_lines
       set allowed_quantity = v_chk.allowed_quantity, po_unit_cost = v_chk.po_unit_cost, match_status = v_chk.match_status
     where id = v_l.id;
  end loop;

  if v_bad > 0 and (p_variance_reason is null or btrim(p_variance_reason) = '' or length(p_variance_reason) > 500) then
    raise exception 'this invoice does not match the order and receipts - give the reason for accepting it (up to 500 characters)'
      using errcode = '22023';
  end if;
  if v_bad > 0 then
    perform set_config('app.audit_reason', btrim(p_variance_reason), true);
  end if;
  update public.supplier_invoices
     set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(),
         variance_reason = case when v_bad > 0 then btrim(p_variance_reason) else null end
   where id = v_inv.id;
end;
$$;

create function public.cancel_supplier_invoice(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_inv public.supplier_invoices;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_inv from public.supplier_invoices i where i.id = p_id and i.organization_id = v_org for update;
  if not found then
    raise exception 'supplier invoice not found' using errcode = 'P0002';
  end if;
  if v_inv.status not in ('MATCHED', 'EXCEPTION', 'APPROVED') then
    raise exception 'an invoice that is % cannot be cancelled', v_inv.status using errcode = '22023';
  end if;
  if not private.has_permission(case when v_inv.status = 'APPROVED' then 'payables.approve' else 'payables.create' end, v_inv.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.supplier_invoices set status = 'CANCELLED', status_reason = btrim(p_reason) where id = v_inv.id;
end;
$$;

create function public.pay_supplier_invoice(p_id uuid, p_paid_on date, p_reference text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_inv public.supplier_invoices;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_inv from public.supplier_invoices i where i.id = p_id and i.organization_id = v_org for update;
  if not found then
    raise exception 'supplier invoice not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('payables.pay', v_inv.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_inv.status <> 'APPROVED' then
    raise exception 'only an approved invoice can be marked as paid (this one is %)', v_inv.status using errcode = '22023';
  end if;
  if p_paid_on is null or p_paid_on > current_date + 1 or p_paid_on < v_inv.invoice_date then
    raise exception 'enter the date it was paid (not before the invoice, not in the future)' using errcode = '22023';
  end if;
  if p_reference is null or btrim(p_reference) = '' or length(p_reference) > 100 then
    raise exception 'enter the payment reference (cheque, transfer or MoMo number)' using errcode = '22023';
  end if;
  update public.supplier_invoices
     set status = 'PAID', paid_on = p_paid_on, payment_reference = btrim(p_reference), paid_by = auth.uid()
   where id = v_inv.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- payables ageing (SECURITY INVOKER: the caller's branch scope applies)
-- ---------------------------------------------------------------------------------------------------------
create function public.payables_summary()
returns table (
  supplier_id       uuid,
  supplier_name     text,
  currency_code     text,
  outstanding       numeric,
  not_due           numeric,
  overdue_1_30      numeric,
  overdue_31_60     numeric,
  overdue_61_90     numeric,
  overdue_over_90   numeric,
  awaiting_approval numeric,
  credit_expected   numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with inv as (
    select i.supplier_id, i.currency_code,
           sum(i.total_amount) filter (where i.status = 'APPROVED') as outstanding,
           sum(i.total_amount) filter (where i.status = 'APPROVED' and i.due_date >= current_date) as not_due,
           sum(i.total_amount) filter (where i.status = 'APPROVED' and current_date - i.due_date between 1 and 30) as d30,
           sum(i.total_amount) filter (where i.status = 'APPROVED' and current_date - i.due_date between 31 and 60) as d60,
           sum(i.total_amount) filter (where i.status = 'APPROVED' and current_date - i.due_date between 61 and 90) as d90,
           sum(i.total_amount) filter (where i.status = 'APPROVED' and current_date - i.due_date > 90) as d90p,
           sum(i.total_amount) filter (where i.status in ('MATCHED', 'EXCEPTION')) as pending
    from public.supplier_invoices i
    group by i.supplier_id, i.currency_code
  ),
  cr as (
    select r.supplier_id, sum(r.expected_credit) as expected
    from public.purchase_returns r
    where r.credit_status = 'PENDING'
    group by r.supplier_id
  )
  select s.id, s.name, inv.currency_code, coalesce(inv.outstanding, 0), coalesce(inv.not_due, 0), coalesce(inv.d30, 0),
         coalesce(inv.d60, 0), coalesce(inv.d90, 0), coalesce(inv.d90p, 0), coalesce(inv.pending, 0), coalesce(cr.expected, 0)
  from inv
  join public.suppliers s on s.id = inv.supplier_id
  left join cr on cr.supplier_id = inv.supplier_id
  where coalesce(inv.outstanding, 0) > 0 or coalesce(inv.pending, 0) > 0
  order by coalesce(inv.outstanding, 0) desc, s.name
$$;

revoke all on function public.record_supplier_invoice(uuid, uuid, text, date, numeric, text, jsonb) from public, anon;
revoke all on function public.approve_supplier_invoice(uuid, text) from public, anon;
revoke all on function public.cancel_supplier_invoice(uuid, text) from public, anon;
revoke all on function public.pay_supplier_invoice(uuid, date, text) from public, anon;
revoke all on function public.payables_summary() from public, anon;
grant execute on function public.record_supplier_invoice(uuid, uuid, text, date, numeric, text, jsonb) to authenticated;
grant execute on function public.approve_supplier_invoice(uuid, text) to authenticated;
grant execute on function public.cancel_supplier_invoice(uuid, text) to authenticated;
grant execute on function public.pay_supplier_invoice(uuid, date, text) to authenticated;
grant execute on function public.payables_summary() to authenticated;

-- ===== migration 20261013000500_stock_counts =====
-- Phase 4 / 05: stock counts (cycle counts) with approval
--
-- A count takes a SNAPSHOT of the system quantities for a warehouse (optionally one location or a list of products), people
-- walk the shelves and enter what they counted, someone else reviews and approves, and approval posts ONE stock adjustment
-- (reason COUNT_VARIANCE) for the variances. Variance = counted - system quantity at the time the count was started; it is applied
-- to the stock as it is at approval, so movements during the count are not lost. Lines nobody counted are left alone.
--   OPEN -> SUBMITTED -> APPROVED          (SUBMITTED can be sent back to OPEN; OPEN / SUBMITTED can be CANCELLED)
-- Note: counters can see the system quantity in the database; a blind count is a UI concern for now.

create table public.stock_counts (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations (id) on delete restrict
                           default private.current_organization_id(),
  count_number           text not null,
  warehouse_id           uuid not null,
  branch_id              uuid not null,
  location_id            uuid references public.warehouse_locations (id) on delete restrict,
  status                 text not null default 'OPEN' check (status in ('OPEN', 'SUBMITTED', 'APPROVED', 'CANCELLED')),
  notes                  text check (notes is null or length(notes) <= 500),
  status_reason          text check (status_reason is null or length(status_reason) <= 500),
  line_count             integer not null check (line_count > 0),
  created_by             uuid default auth.uid(),
  submitted_by           uuid,
  submitted_at           timestamptz,
  approved_by            uuid,
  approved_at            timestamptz,
  adjustment_document_id uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint stock_counts_warehouse_fk foreign key (warehouse_id, organization_id)
    references public.warehouses (id, organization_id) on delete restrict,
  constraint stock_counts_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint stock_counts_adjustment_fk foreign key (adjustment_document_id, organization_id)
    references public.stock_documents (id, organization_id) on delete restrict,
  constraint stock_counts_number_key unique (organization_id, count_number),
  constraint stock_counts_id_org_key unique (id, organization_id)
);
create index stock_counts_org_created_idx on public.stock_counts (organization_id, created_at desc, id desc);
create index stock_counts_branch_status_idx on public.stock_counts (organization_id, branch_id, status);
create index stock_counts_warehouse_idx on public.stock_counts (warehouse_id);
create index stock_counts_location_idx on public.stock_counts (location_id) where location_id is not null;
create index stock_counts_adjustment_idx on public.stock_counts (adjustment_document_id) where adjustment_document_id is not null;

create trigger stock_counts_immutable before update on public.stock_counts
  for each row execute function private.prevent_column_change('organization_id', 'count_number', 'warehouse_id', 'branch_id', 'location_id', 'line_count');
create trigger stock_counts_set_updated_at before update on public.stock_counts
  for each row execute function private.set_updated_at();
create trigger stock_counts_audit after insert or update or delete on public.stock_counts
  for each row execute function private.audit_row_change('stock_count');

create table public.stock_count_lines (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict
                     default private.current_organization_id(),
  stock_count_id   uuid not null,
  branch_id        uuid not null,
  line_no          integer not null check (line_no > 0),
  product_id       uuid not null,
  batch_id         uuid,
  location_id      uuid references public.warehouse_locations (id) on delete restrict,
  stock_status     text not null check (stock_status in ('AVAILABLE', 'QUARANTINE', 'DAMAGED', 'EXPIRED')),
  system_quantity  numeric(18, 3) not null check (system_quantity > 0),
  counted_quantity numeric(18, 3) check (counted_quantity is null or counted_quantity >= 0),
  counted_by       uuid,
  counted_at       timestamptz,
  constraint stock_count_lines_count_fk foreign key (stock_count_id, organization_id)
    references public.stock_counts (id, organization_id) on delete restrict,
  constraint stock_count_lines_product_fk foreign key (product_id, organization_id)
    references public.products (id, organization_id) on delete restrict,
  constraint stock_count_lines_batch_fk foreign key (batch_id, product_id, organization_id)
    references public.batches (id, product_id, organization_id) on delete restrict,
  constraint stock_count_lines_line_key unique (stock_count_id, line_no)
);
create index stock_count_lines_product_idx on public.stock_count_lines (organization_id, product_id);
create index stock_count_lines_batch_idx on public.stock_count_lines (batch_id) where batch_id is not null;
create index stock_count_lines_location_idx on public.stock_count_lines (location_id) where location_id is not null;

create trigger stock_count_lines_immutable before update on public.stock_count_lines
  for each row execute function private.prevent_column_change(
    'organization_id', 'stock_count_id', 'branch_id', 'line_no', 'product_id', 'batch_id', 'location_id', 'stock_status', 'system_quantity');
create trigger stock_count_lines_no_delete before delete on public.stock_count_lines
  for each row execute function private.stock_block_mutation();

alter table public.stock_counts      enable row level security;
alter table public.stock_count_lines enable row level security;
revoke all on public.stock_counts, public.stock_count_lines from public, anon, authenticated;
grant select on public.stock_counts, public.stock_count_lines to authenticated;

create policy stock_counts_select on public.stock_counts
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('inventory.view', branch_id));
create policy stock_count_lines_select on public.stock_count_lines
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('inventory.view', branch_id));

-- ---------------------------------------------------------------------------------------------------------
create function public.start_stock_count(
  p_warehouse_id uuid,
  p_location_id uuid default null,
  p_product_ids uuid[] default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_wh    public.warehouses;
  v_id    uuid := gen_random_uuid();
  v_n     integer;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_wh from public.warehouses w where w.id = p_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.count', v_wh.branch_id) then
    raise exception 'insufficient privilege for this warehouse' using errcode = '42501';
  end if;
  if p_location_id is not null and not exists (
       select 1 from public.warehouse_locations l where l.id = p_location_id and l.warehouse_id = v_wh.id and l.organization_id = v_org) then
    raise exception 'location not found in this warehouse' using errcode = 'P0002';
  end if;
  if p_notes is not null and length(p_notes) > 500 then
    raise exception 'notes are limited to 500 characters' using errcode = '22023';
  end if;

  create temporary table pg_temp.count_snapshot on commit drop as
  select b.product_id, b.batch_id, b.location_id, b.stock_status, b.quantity,
         row_number() over (order by coalesce(l.code, ''), p.brand_name, ba.expiry_date nulls last, b.stock_status) as rn
  from public.stock_balances b
  join public.products p on p.id = b.product_id
  left join public.batches ba on ba.id = b.batch_id
  left join public.warehouse_locations l on l.id = b.location_id
  where b.organization_id = v_org and b.warehouse_id = v_wh.id and b.quantity > 0
    and (p_location_id is null or b.location_id = p_location_id)
    and (p_product_ids is null or b.product_id = any (p_product_ids));
  select count(*) into v_n from pg_temp.count_snapshot;
  if v_n = 0 then
    drop table pg_temp.count_snapshot;
    raise exception 'there is no stock in that scope to count' using errcode = '22023';
  end if;
  if v_n > 5000 then
    drop table pg_temp.count_snapshot;
    raise exception 'that is % stock lines - narrow the count to a location or a list of products (limit 5000)', v_n using errcode = '22023';
  end if;

  insert into public.stock_counts (id, organization_id, count_number, warehouse_id, branch_id, location_id, notes, line_count)
  values (v_id, v_org, private.generate_document_number(v_org, null, 'STOCK_COUNT', 'CNT'), v_wh.id, v_wh.branch_id,
          p_location_id, nullif(btrim(p_notes), ''), v_n);
  insert into public.stock_count_lines (organization_id, stock_count_id, branch_id, line_no, product_id, batch_id, location_id, stock_status, system_quantity)
  select v_org, v_id, v_wh.branch_id, s.rn, s.product_id, s.batch_id, s.location_id, s.stock_status, s.quantity
  from pg_temp.count_snapshot s;
  drop table pg_temp.count_snapshot;
  return v_id;
end;
$$;

-- p_entries: [{ line_id, counted_quantity }]  (counted_quantity null clears the entry)
create function public.save_count_entries(p_id uuid, p_entries jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_cnt public.stock_counts;
  v_e   jsonb;
  v_qty numeric;
  v_done integer := 0;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_cnt from public.stock_counts c where c.id = p_id and c.organization_id = v_org for update;
  if not found then
    raise exception 'stock count not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.count', v_cnt.branch_id) then
    raise exception 'insufficient privilege for this warehouse' using errcode = '42501';
  end if;
  if v_cnt.status <> 'OPEN' then
    raise exception 'counted quantities can only be entered while the count is open (this one is %)', v_cnt.status using errcode = '22023';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then
    raise exception 'no entries to save' using errcode = '22023';
  end if;
  if jsonb_array_length(p_entries) > 5000 then
    raise exception 'too many entries in one save' using errcode = '22023';
  end if;
  for v_e in select value from jsonb_array_elements(p_entries) loop
    if jsonb_typeof(v_e) <> 'object' then
      raise exception 'invalid entry' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'counted_quantity') = 'null' or (v_e -> 'counted_quantity') is null then
      v_qty := null;
    elsif jsonb_typeof(v_e -> 'counted_quantity') = 'number' then
      v_qty := (v_e ->> 'counted_quantity')::numeric;
      if v_qty < 0 or v_qty <> round(v_qty, 3) or v_qty >= 1000000000000 then
        raise exception 'a counted quantity must be 0 or more with at most 3 decimals' using errcode = '22023';
      end if;
    else
      raise exception 'a counted quantity must be a number' using errcode = '22023';
    end if;
    update public.stock_count_lines l
       set counted_quantity = v_qty,
           counted_by = case when v_qty is null then null else auth.uid() end,
           counted_at = case when v_qty is null then null else now() end
     where l.id = nullif(v_e ->> 'line_id', '')::uuid and l.stock_count_id = v_cnt.id;
    if not found then
      raise exception 'a line does not belong to this count' using errcode = 'P0002';
    end if;
    v_done := v_done + 1;
  end loop;
  return v_done;
end;
$$;

create function public.submit_stock_count(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_cnt public.stock_counts;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_cnt from public.stock_counts c where c.id = p_id and c.organization_id = v_org for update;
  if not found then
    raise exception 'stock count not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.count', v_cnt.branch_id) then
    raise exception 'insufficient privilege for this warehouse' using errcode = '42501';
  end if;
  if v_cnt.status <> 'OPEN' then
    raise exception 'only an open count can be submitted (this one is %)', v_cnt.status using errcode = '22023';
  end if;
  if not exists (select 1 from public.stock_count_lines l where l.stock_count_id = v_cnt.id and l.counted_quantity is not null) then
    raise exception 'enter at least one counted quantity before submitting' using errcode = '22023';
  end if;
  update public.stock_counts set status = 'SUBMITTED', submitted_by = auth.uid(), submitted_at = now(), status_reason = null where id = v_cnt.id;
end;
$$;

create function public.return_stock_count(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_cnt public.stock_counts;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_cnt from public.stock_counts c where c.id = p_id and c.organization_id = v_org for update;
  if not found then
    raise exception 'stock count not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.count_approve', v_cnt.branch_id) then
    raise exception 'insufficient privilege for this warehouse' using errcode = '42501';
  end if;
  if v_cnt.status <> 'SUBMITTED' then
    raise exception 'only a submitted count can be sent back (this one is %)', v_cnt.status using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.stock_counts set status = 'OPEN', status_reason = btrim(p_reason) where id = v_cnt.id;
end;
$$;

create function public.cancel_stock_count(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_cnt public.stock_counts;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_cnt from public.stock_counts c where c.id = p_id and c.organization_id = v_org for update;
  if not found then
    raise exception 'stock count not found' using errcode = 'P0002';
  end if;
  if v_cnt.status not in ('OPEN', 'SUBMITTED') then
    raise exception 'a count that is % cannot be cancelled', v_cnt.status using errcode = '22023';
  end if;
  if not private.has_permission(case when v_cnt.status = 'OPEN' then 'inventory.count' else 'inventory.count_approve' end, v_cnt.branch_id) then
    raise exception 'insufficient privilege for this warehouse' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.stock_counts set status = 'CANCELLED', status_reason = btrim(p_reason) where id = v_cnt.id;
end;
$$;

create function public.approve_stock_count(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_cnt   public.stock_counts;
  v_lines jsonb;
  v_stock jsonb;
  v_doc   uuid;
  v_vars  integer;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_cnt from public.stock_counts c where c.id = p_id and c.organization_id = v_org for update;
  if not found then
    raise exception 'stock count not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.count_approve', v_cnt.branch_id) then
    raise exception 'insufficient privilege for this warehouse' using errcode = '42501';
  end if;
  if v_cnt.status <> 'SUBMITTED' then
    raise exception 'only a submitted count can be approved (this one is %)', v_cnt.status using errcode = '22023';
  end if;
  if v_cnt.submitted_by = auth.uid() and private.other_holder_exists('inventory.count_approve', v_cnt.branch_id) then
    raise exception 'a count you submitted must be approved by someone else' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(
           jsonb_strip_nulls(jsonb_build_object(
             'product_id', l.product_id, 'batch_id', l.batch_id, 'location_id', l.location_id, 'status', l.stock_status,
             'direction', case when l.counted_quantity > l.system_quantity then 'IN' else 'OUT' end,
             'quantity', abs(l.counted_quantity - l.system_quantity)))
           order by l.line_no), '[]'::jsonb),
         count(*)
    into v_lines, v_vars
  from public.stock_count_lines l
  where l.stock_count_id = v_cnt.id and l.counted_quantity is not null and l.counted_quantity <> l.system_quantity;

  if v_vars > 0 then
    v_stock := private.post_stock('ADJUSTMENT', v_cnt.warehouse_id, v_lines, null, 'COUNT_VARIANCE',
                                  'Stock count ' || v_cnt.count_number, 'STOCK_COUNT', v_cnt.id);
    v_doc := (v_stock ->> 'document_id')::uuid;
  end if;

  update public.stock_counts
     set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), adjustment_document_id = v_doc, status_reason = null
   where id = v_cnt.id;
  return jsonb_build_object('variances', v_vars, 'stock_document_number', v_stock ->> 'document_number');
end;
$$;

revoke all on function public.start_stock_count(uuid, uuid, uuid[], text) from public, anon;
revoke all on function public.save_count_entries(uuid, jsonb) from public, anon;
revoke all on function public.submit_stock_count(uuid) from public, anon;
revoke all on function public.return_stock_count(uuid, text) from public, anon;
revoke all on function public.cancel_stock_count(uuid, text) from public, anon;
revoke all on function public.approve_stock_count(uuid) from public, anon;
grant execute on function public.start_stock_count(uuid, uuid, uuid[], text) to authenticated;
grant execute on function public.save_count_entries(uuid, jsonb) to authenticated;
grant execute on function public.submit_stock_count(uuid) to authenticated;
grant execute on function public.return_stock_count(uuid, text) to authenticated;
grant execute on function public.cancel_stock_count(uuid, text) to authenticated;
grant execute on function public.approve_stock_count(uuid) to authenticated;

commit;
