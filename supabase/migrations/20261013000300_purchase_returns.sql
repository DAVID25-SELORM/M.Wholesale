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
