-- Phase 8 / 02: point of sale - till sessions and counter sales
--
-- A counter sale is an ordinary sales invoice, posted on the spot and paid at the counter, so every rule of Phase 6 still holds (stock leaves
-- earliest-expiry-first, regulatory rules, credit control, price and discount rights). What the point of sale adds:
--   * WALK-IN customer: every organization has one built-in cash customer (no credit, no licence). Because it has no licence it can only buy
--     medicines that need none: prescription-only, pharmacy-only and controlled medicines are refused by the regulatory rule, with no override.
--   * TILL SESSIONS (shifts): a cashier opens a session at a warehouse with an opening float and sells within it; closing it compares the cash
--     counted with the cash expected (float + cash taken, not counting voided payments). The variance is recorded and needs a note.
--     One open session per cashier; sales can only be rung up by the session's own cashier.
--   * pos_checkout(): ONE transaction that writes the invoice, posts it (stock out, number) and records the payments - cash (with change),
--     mobile money, card, bank transfer, in any mix. If anything fails nothing is left behind: no half-sold invoice, no stray payment.
-- Returns, corrections and refunds of counter sales are credit notes (Phase 7).

-- ---------------------------------------------------------------------------------------------------------
-- the walk-in customer
-- ---------------------------------------------------------------------------------------------------------
alter table public.customers add column is_walk_in boolean not null default false;
create unique index customers_one_walk_in_key on public.customers (organization_id) where is_walk_in;

create function private.customers_walk_in_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_walk_in then
      raise exception 'the walk-in customer is built in and cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.is_walk_in is distinct from old.is_walk_in then
    raise exception 'a customer cannot be turned into (or out of) the walk-in customer' using errcode = '42501';
  end if;
  if old.is_walk_in and (not new.is_active or new.credit_limit <> 0 or new.payment_terms_days <> 0 or new.on_hold or new.customer_type <> 'RETAILER'
                         or new.controlled_drugs_authorised or new.licence_number is not null or new.licence_expiry is not null) then
    raise exception 'the walk-in customer is built in: it always pays at the counter and holds no licence (only its name and contact details can change)'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger customers_walk_in_guard before update or delete on public.customers
  for each row execute function private.customers_walk_in_guard();

create function private.organizations_walk_in()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.customers (organization_id, code, name, customer_type, payment_terms_days, credit_limit, is_walk_in)
  values (new.id, 'WALKIN', 'Walk-in customer', 'RETAILER', 0, 0, true);
  return null;
end;
$$;
create trigger organizations_walk_in after insert on public.organizations
  for each row execute function private.organizations_walk_in();

-- existing organizations: take a free name for the walk-in customer if "Walk-in customer" is already in use
insert into public.customers (organization_id, code, name, customer_type, payment_terms_days, credit_limit, is_walk_in)
select o.id,
       case when exists (select 1 from public.customers c where c.organization_id = o.id and c.code = 'WALKIN') then 'WALKIN-POS' else 'WALKIN' end,
       case when exists (select 1 from public.customers c where c.organization_id = o.id and lower(c.name) = 'walk-in customer') then 'Walk-in customer (counter)' else 'Walk-in customer' end,
       'RETAILER', 0, 0, true
from public.organizations o
where not exists (select 1 from public.customers c where c.organization_id = o.id and c.is_walk_in);

-- ---------------------------------------------------------------------------------------------------------
-- post_sales_invoice(): the payment taken at posting may now be a LIST (split tender); a single object still works
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.post_sales_invoice(p_id uuid, p_override_reason text default null, p_payment jsonb default null)
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
  v_pays    jsonb;
  v_exposure numeric;
  v_pay_item jsonb;
  v_receipt_numbers jsonb := '[]'::jsonb;
  v_receipt_ids jsonb := '[]'::jsonb;
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

  -- 2. immediate payment (cash sale / deposit / split tender): p_payment is one payment { amount, method, reference? } or a list of up to 5 of them;
  --    each is recorded and allocated to THIS invoice as part of posting, so the credit checks see it
  v_pays := case when p_payment is null then '[]'::jsonb when jsonb_typeof(p_payment) = 'array' then p_payment else jsonb_build_array(p_payment) end;
  if jsonb_array_length(v_pays) > 5 then
    raise exception 'at most 5 payments can be taken when posting' using errcode = '22023';
  end if;
  if jsonb_array_length(v_pays) > 0 and not private.has_permission('receipts.create', v_inv.branch_id) then
    raise exception 'insufficient privilege to take payment' using errcode = '42501';
  end if;
  for v_pay_item in select value from jsonb_array_elements(v_pays) loop
    if jsonb_typeof(v_pay_item) <> 'object' or jsonb_typeof(v_pay_item -> 'amount') is distinct from 'number' or (v_pay_item ->> 'amount')::numeric <= 0
       or (v_pay_item ->> 'amount')::numeric <> round((v_pay_item ->> 'amount')::numeric, 2) then
      raise exception 'the payment must have a positive amount with at most 2 decimals' using errcode = '22023';
    end if;
    v_pay_method := upper(coalesce(v_pay_item ->> 'method', ''));
    if v_pay_method not in ('CASH', 'MOBILE_MONEY', 'BANK_TRANSFER', 'CHEQUE', 'CARD') then
      raise exception 'choose how the customer paid (cash, mobile money, bank transfer, cheque or card)' using errcode = '22023';
    end if;
    v_pay_amount := v_pay_amount + (v_pay_item ->> 'amount')::numeric;
  end loop;
  if v_pay_amount > v_inv.total_amount then
    raise exception 'the payment (%) is more than the invoice total (%)', v_pay_amount, v_inv.total_amount using errcode = '22023';
  end if;

  -- 3. credit control: hold and limit can be overridden with sales.override_credit and a reason
  select * into v_pos from private.customer_position(v_org, v_cust.id);
  if v_cust.on_hold then
    v_issues := v_issues || ('the customer is on credit hold (' || coalesce(v_cust.hold_reason, 'no reason given') || ')');
  end if;
  v_exposure := case when v_cust.is_walk_in then v_inv.total_amount - v_pay_amount
                     else v_pos.outstanding + (v_inv.total_amount - v_pay_amount) - v_pos.credit_held end;
  if v_exposure > v_cust.credit_limit then
    v_issues := v_issues || format('this would take the customer to %s owed against a credit limit of %s', round(v_exposure, 2), v_cust.credit_limit);
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

  for v_pay_item in select value from jsonb_array_elements(v_pays) loop
    v_receipt := private.create_receipt(v_org, v_cust.id, v_inv.branch_id, (v_pay_item ->> 'amount')::numeric, upper(v_pay_item ->> 'method'), v_pay_item ->> 'reference',
                                        'Payment at the counter for ' || v_number,
                                        jsonb_build_array(jsonb_build_object('invoice_id', v_inv.id, 'amount', (v_pay_item ->> 'amount')::numeric)), false);
    v_receipt_numbers := v_receipt_numbers || to_jsonb(v_receipt.receipt_number);
    v_receipt_ids := v_receipt_ids || to_jsonb(v_receipt.id);
  end loop;

  return jsonb_build_object('invoice_number', v_number, 'total_amount', v_inv.total_amount, 'stock_document_number', v_stock ->> 'document_number',
                            'receipt_number', v_receipt_numbers ->> 0, 'receipt_numbers', v_receipt_numbers, 'receipt_ids', v_receipt_ids, 'overridden', array_length(v_issues, 1) > 0);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------------------------------------
create table public.pos_sessions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict
                     default private.current_organization_id(),
  session_number   text not null,
  branch_id        uuid not null,
  warehouse_id     uuid not null,                       -- the stock sold during the session comes from here
  cashier_id       uuid not null default auth.uid(),
  status           text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  opened_at        timestamptz not null default now(),
  opening_float    numeric(18, 2) not null default 0 check (opening_float >= 0),
  closed_at        timestamptz,
  closed_by        uuid,
  counted_cash     numeric(18, 2) check (counted_cash is null or counted_cash >= 0),
  expected_cash    numeric(18, 2),
  variance         numeric(18, 2) generated always as (counted_cash - expected_cash) stored,
  sales_count      integer,
  sales_total      numeric(18, 2),
  close_notes      text check (close_notes is null or length(close_notes) <= 500),
  constraint pos_sessions_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint pos_sessions_warehouse_fk foreign key (warehouse_id, organization_id)
    references public.warehouses (id, organization_id) on delete restrict,
  constraint pos_sessions_number_key unique (organization_id, session_number),
  constraint pos_sessions_id_org_key unique (id, organization_id),
  constraint pos_sessions_closed_complete check (
    (status = 'CLOSED') = (closed_at is not null and counted_cash is not null and expected_cash is not null and sales_count is not null and sales_total is not null))
);
create unique index pos_sessions_one_open_key on public.pos_sessions (organization_id, cashier_id) where status = 'OPEN';
create index pos_sessions_branch_idx on public.pos_sessions (organization_id, branch_id, opened_at desc);
create index pos_sessions_cashier_idx on public.pos_sessions (organization_id, cashier_id, opened_at desc);
create index pos_sessions_warehouse_idx on public.pos_sessions (warehouse_id);
create trigger pos_sessions_immutable before update on public.pos_sessions
  for each row execute function private.prevent_column_change('organization_id', 'session_number', 'branch_id', 'warehouse_id', 'cashier_id', 'opened_at', 'opening_float');
create trigger pos_sessions_audit after insert or update on public.pos_sessions
  for each row execute function private.audit_row_change('pos_session');
create trigger pos_sessions_no_delete before delete on public.pos_sessions
  for each row execute function private.stock_block_mutation();

create function private.pos_sessions_closed_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'CLOSED' then
    raise exception 'a closed till session cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger pos_sessions_closed_lock before update on public.pos_sessions
  for each row execute function private.pos_sessions_closed_lock();

create table public.pos_sales (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict,
  pos_session_id   uuid not null,
  sales_invoice_id uuid not null,
  branch_id        uuid not null,
  cashier_id       uuid not null,
  customer_id      uuid not null,
  total_amount     numeric(18, 2) not null check (total_amount >= 0),
  cash_tendered    numeric(18, 2) not null default 0 check (cash_tendered >= 0),
  change_given     numeric(18, 2) not null default 0 check (change_given >= 0 and change_given <= cash_tendered),
  created_at       timestamptz not null default clock_timestamp(),
  constraint pos_sales_session_fk foreign key (pos_session_id, organization_id)
    references public.pos_sessions (id, organization_id) on delete restrict,
  constraint pos_sales_invoice_fk foreign key (sales_invoice_id, organization_id)
    references public.sales_invoices (id, organization_id) on delete restrict,
  constraint pos_sales_customer_fk foreign key (customer_id, organization_id)
    references public.customers (id, organization_id) on delete restrict,
  constraint pos_sales_invoice_key unique (sales_invoice_id),
  constraint pos_sales_id_org_key unique (id, organization_id)
);
create index pos_sales_session_idx on public.pos_sales (pos_session_id, created_at desc);
create index pos_sales_branch_idx on public.pos_sales (organization_id, branch_id, created_at desc);
create index pos_sales_customer_idx on public.pos_sales (customer_id);
create trigger pos_sales_append_only before update or delete on public.pos_sales
  for each row execute function private.stock_block_mutation();

create table public.pos_sale_payments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict,
  pos_sale_id      uuid not null,
  pos_session_id   uuid not null,
  receipt_id       uuid not null,
  branch_id        uuid not null,
  cashier_id       uuid not null,
  method           text not null check (method in ('CASH', 'MOBILE_MONEY', 'BANK_TRANSFER', 'CHEQUE', 'CARD')),
  amount           numeric(18, 2) not null check (amount > 0),         -- what was kept: change is not part of it
  constraint pos_sale_payments_sale_fk foreign key (pos_sale_id, organization_id)
    references public.pos_sales (id, organization_id) on delete restrict,
  constraint pos_sale_payments_session_fk foreign key (pos_session_id, organization_id)
    references public.pos_sessions (id, organization_id) on delete restrict,
  constraint pos_sale_payments_receipt_fk foreign key (receipt_id, organization_id)
    references public.customer_receipts (id, organization_id) on delete restrict,
  constraint pos_sale_payments_receipt_key unique (receipt_id)
);
create index pos_sale_payments_sale_idx on public.pos_sale_payments (pos_sale_id);
create index pos_sale_payments_session_idx on public.pos_sale_payments (pos_session_id, method);
create trigger pos_sale_payments_append_only before update or delete on public.pos_sale_payments
  for each row execute function private.stock_block_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- RLS and grants: read only; every write goes through the functions below.
-- A cashier sees their own sessions and sales; pos.view sees the whole branch.
-- ---------------------------------------------------------------------------------------------------------
alter table public.pos_sessions      enable row level security;
alter table public.pos_sales         enable row level security;
alter table public.pos_sale_payments enable row level security;
revoke all on public.pos_sessions, public.pos_sales, public.pos_sale_payments from public, anon, authenticated;
grant select on public.pos_sessions, public.pos_sales, public.pos_sale_payments to authenticated;

create policy pos_sessions_select on public.pos_sessions for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and (cashier_id = (select auth.uid()) or private.has_permission('pos.view', branch_id)));
create policy pos_sales_select on public.pos_sales for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and (cashier_id = (select auth.uid()) or private.has_permission('pos.view', branch_id)));
create policy pos_sale_payments_select on public.pos_sale_payments for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and (cashier_id = (select auth.uid()) or private.has_permission('pos.view', branch_id)));

-- ---------------------------------------------------------------------------------------------------------
-- till sessions
-- ---------------------------------------------------------------------------------------------------------
-- cash kept in the session so far (voided payments do not count)
create function private.pos_cash_in(p_session_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(p.amount), 0)
  from public.pos_sale_payments p
  join public.customer_receipts r on r.id = p.receipt_id
  where p.pos_session_id = p_session_id and p.method = 'CASH' and r.status = 'POSTED'
$$;

create function public.open_pos_session(p_warehouse_id uuid, p_opening_float numeric default 0)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_wh  public.warehouses;
  v_id  uuid;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_wh from public.warehouses w where w.id = p_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('pos.sell', v_wh.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if p_opening_float is null or p_opening_float < 0 or p_opening_float <> round(p_opening_float, 2) or p_opening_float >= 100000000 then
    raise exception 'the opening float must be 0 or more with at most 2 decimals' using errcode = '22023';
  end if;
  if exists (select 1 from public.pos_sessions s where s.organization_id = v_org and s.cashier_id = auth.uid() and s.status = 'OPEN') then
    raise exception 'you already have an open till session - close it first' using errcode = '22023';
  end if;
  insert into public.pos_sessions (organization_id, session_number, branch_id, warehouse_id, opening_float)
  values (v_org, private.generate_document_number(v_org, null, 'POS_SESSION', 'SHF'), v_wh.branch_id, v_wh.id, p_opening_float)
  returning id into v_id;
  return v_id;
end;
$$;

-- totals of one session (the cashier of the session, or pos.view for the branch)
create function public.pos_session_summary(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org  uuid := private.current_organization_id();
  v_s    public.pos_sessions;
  v_cash numeric;
  v_n    integer;
  v_tot  numeric;
  v_by   jsonb;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_s from public.pos_sessions s where s.id = p_session_id and s.organization_id = v_org;
  if not found or not (v_s.cashier_id = auth.uid() or private.has_permission('pos.view', v_s.branch_id)) then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  v_cash := private.pos_cash_in(v_s.id);
  select count(*)::int, coalesce(sum(x.total_amount), 0) into v_n, v_tot from public.pos_sales x where x.pos_session_id = v_s.id;
  select coalesce(jsonb_agg(jsonb_build_object('method', m.method, 'payments', m.n, 'amount', m.amount) order by m.method), '[]'::jsonb) into v_by
  from (select p.method, count(*)::int as n, sum(p.amount) as amount
        from public.pos_sale_payments p join public.customer_receipts r on r.id = p.receipt_id
        where p.pos_session_id = v_s.id and r.status = 'POSTED' group by p.method) m;
  return jsonb_build_object('sales_count', v_n, 'sales_total', v_tot, 'cash_in', v_cash, 'opening_float', v_s.opening_float,
                            'expected_cash', v_s.opening_float + v_cash, 'by_method', v_by);
end;
$$;

-- p_counted_cash: what is physically in the drawer. A difference to the expected cash must be explained in p_notes.
create function public.close_pos_session(p_id uuid, p_counted_cash numeric, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org      uuid := private.current_organization_id();
  v_s        public.pos_sessions;
  v_expected numeric;
  v_n        integer;
  v_tot      numeric;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_s from public.pos_sessions s where s.id = p_id and s.organization_id = v_org for update;
  if not found then
    raise exception 'till session not found' using errcode = 'P0002';
  end if;
  if not (v_s.cashier_id = auth.uid() and private.has_permission('pos.sell', v_s.branch_id)) and not private.has_permission('pos.manage', v_s.branch_id) then
    raise exception 'insufficient privilege to close this till session' using errcode = '42501';
  end if;
  if v_s.status <> 'OPEN' then
    raise exception 'this till session is already closed' using errcode = '22023';
  end if;
  if p_counted_cash is null or p_counted_cash < 0 or p_counted_cash <> round(p_counted_cash, 2) or p_counted_cash >= 100000000000 then
    raise exception 'enter the cash counted in the drawer (0 or more, at most 2 decimals)' using errcode = '22023';
  end if;
  if p_notes is not null and length(p_notes) > 500 then
    raise exception 'notes are limited to 500 characters' using errcode = '22023';
  end if;
  v_expected := v_s.opening_float + private.pos_cash_in(v_s.id);
  if p_counted_cash <> v_expected and (p_notes is null or btrim(p_notes) = '') then
    raise exception 'the drawer holds % but % was expected: explain the difference in the notes', p_counted_cash, v_expected using errcode = '22023';
  end if;
  select count(*)::int, coalesce(sum(x.total_amount), 0) into v_n, v_tot from public.pos_sales x where x.pos_session_id = v_s.id;
  if p_notes is not null and btrim(p_notes) <> '' then
    perform set_config('app.audit_reason', btrim(p_notes), true);
  end if;
  update public.pos_sessions
     set status = 'CLOSED', closed_at = now(), closed_by = auth.uid(), counted_cash = p_counted_cash, expected_cash = v_expected,
         sales_count = v_n, sales_total = v_tot, close_notes = nullif(btrim(p_notes), '')
   where id = v_s.id;
  return jsonb_build_object('expected_cash', v_expected, 'counted_cash', p_counted_cash, 'variance', p_counted_cash - v_expected, 'sales_count', v_n, 'sales_total', v_tot);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- the counter sale
-- ---------------------------------------------------------------------------------------------------------
-- p_lines:    as save_sales_invoice() - [{ product_id, quantity, product_unit_id?, unit_price?, discount_percent? }]
-- p_payments: [{ method: CASH|MOBILE_MONEY|CARD|BANK_TRANSFER|CHEQUE, amount, reference? }]
--             cash is what the customer HANDED OVER: anything above what is still due after the other payments is returned as change.
--             Non-cash payments need a reference and can never exceed what is due. Payments may be empty only for a customer with credit.
-- p_customer_id: null = the walk-in customer
create function public.pos_checkout(
  p_session_id uuid,
  p_customer_id uuid,
  p_lines jsonb,
  p_payments jsonb,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.current_organization_id();
  v_s       public.pos_sessions;
  v_cust    uuid;
  v_inv_id  uuid;
  v_total   numeric;
  v_item    jsonb;
  v_method  text;
  v_amount  numeric;
  v_noncash numeric := 0;
  v_cash    numeric := 0;
  v_applied numeric;
  v_change  numeric;
  v_pays    jsonb := '[]'::jsonb;
  v_post    jsonb;
  v_sale_id uuid;
  v_ref     text;
  v_sess_no text;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_s from public.pos_sessions s where s.id = p_session_id and s.organization_id = v_org for share;
  if not found then
    raise exception 'till session not found' using errcode = 'P0002';
  end if;
  if v_s.cashier_id <> auth.uid() then
    raise exception 'this till session belongs to another cashier' using errcode = '42501';
  end if;
  if not private.has_permission('pos.sell', v_s.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_s.status <> 'OPEN' then
    raise exception 'this till session is closed - open a new one to keep selling' using errcode = '22023';
  end if;
  if p_payments is null or jsonb_typeof(p_payments) <> 'array' or jsonb_array_length(p_payments) > 5 then
    raise exception 'payments must be a list of up to 5 payments' using errcode = '22023';
  end if;

  v_cust := coalesce(p_customer_id, (select c.id from public.customers c where c.organization_id = v_org and c.is_walk_in));
  if v_cust is null then
    raise exception 'the walk-in customer is missing' using errcode = 'P0002';
  end if;

  -- validate the payments before anything is written
  for v_item in select value from jsonb_array_elements(p_payments) loop
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item -> 'amount') is distinct from 'number' or (v_item ->> 'amount')::numeric <= 0
       or (v_item ->> 'amount')::numeric <> round((v_item ->> 'amount')::numeric, 2) then
      raise exception 'each payment needs a positive amount with at most 2 decimals' using errcode = '22023';
    end if;
    v_method := upper(coalesce(v_item ->> 'method', ''));
    if v_method not in ('CASH', 'MOBILE_MONEY', 'CARD', 'BANK_TRANSFER', 'CHEQUE') then
      raise exception 'choose how the customer paid (cash, mobile money, card, bank transfer or cheque)' using errcode = '22023';
    end if;
    if v_method = 'CASH' then
      v_cash := v_cash + (v_item ->> 'amount')::numeric;
    else
      if nullif(btrim(coalesce(v_item ->> 'reference', '')), '') is null then
        raise exception 'a % payment needs its reference (transaction, cheque or card slip number)', lower(replace(v_method, '_', ' ')) using errcode = '22023';
      end if;
      v_noncash := v_noncash + (v_item ->> 'amount')::numeric;
    end if;
  end loop;

  v_sess_no := v_s.session_number;
  -- the invoice: written with the cashier's own rights (price override / discount rules apply), then posted in the same transaction
  v_inv_id := public.save_sales_invoice(null, v_cust, v_s.warehouse_id, 'POS ' || v_sess_no, null, p_lines);
  select i.total_amount into v_total from public.sales_invoices i where i.id = v_inv_id;
  if v_noncash > v_total then
    raise exception 'the card / mobile money / bank payments (%) are more than the total (%)', v_noncash, v_total using errcode = '22023';
  end if;
  v_applied := least(v_cash, v_total - v_noncash);
  v_change := v_cash - v_applied;

  for v_item in select value from jsonb_array_elements(p_payments) loop
    if upper(v_item ->> 'method') <> 'CASH' then
      v_pays := v_pays || jsonb_build_array(jsonb_build_object('method', upper(v_item ->> 'method'), 'amount', (v_item ->> 'amount')::numeric, 'reference', v_item ->> 'reference'));
    end if;
  end loop;
  if v_applied > 0 then
    v_pays := v_pays || jsonb_build_array(jsonb_build_object('method', 'CASH', 'amount', v_applied));
  end if;

  v_post := public.post_sales_invoice(v_inv_id, p_override_reason, case when jsonb_array_length(v_pays) = 0 then null else v_pays end);

  insert into public.pos_sales (organization_id, pos_session_id, sales_invoice_id, branch_id, cashier_id, customer_id, total_amount, cash_tendered, change_given)
  values (v_org, v_s.id, v_inv_id, v_s.branch_id, v_s.cashier_id, v_cust, v_total, v_cash, v_change)
  returning id into v_sale_id;
  insert into public.pos_sale_payments (organization_id, pos_sale_id, pos_session_id, receipt_id, branch_id, cashier_id, method, amount)
  select v_org, v_sale_id, v_s.id, r.id, v_s.branch_id, v_s.cashier_id, r.method, r.amount
  from jsonb_array_elements_text(v_post -> 'receipt_ids') x
  join public.customer_receipts r on r.id = x.value::uuid;

  return jsonb_build_object('pos_sale_id', v_sale_id, 'invoice_id', v_inv_id, 'invoice_number', v_post ->> 'invoice_number', 'total_amount', v_total,
                            'paid', v_noncash + v_applied, 'owed', v_total - v_noncash - v_applied, 'cash_tendered', v_cash, 'change', v_change,
                            'receipt_numbers', v_post -> 'receipt_numbers', 'overridden', (v_post ->> 'overridden')::boolean);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- function privileges
-- ---------------------------------------------------------------------------------------------------------
revoke all on function private.customers_walk_in_guard() from public, anon, authenticated;
revoke all on function private.organizations_walk_in() from public, anon, authenticated;
revoke all on function private.pos_sessions_closed_lock() from public, anon, authenticated;
revoke all on function private.pos_cash_in(uuid) from public, anon, authenticated;

revoke all on function public.open_pos_session(uuid, numeric) from public, anon;
revoke all on function public.pos_session_summary(uuid) from public, anon;
revoke all on function public.close_pos_session(uuid, numeric, text) from public, anon;
revoke all on function public.pos_checkout(uuid, uuid, jsonb, jsonb, text) from public, anon;
grant execute on function public.open_pos_session(uuid, numeric) to authenticated;
grant execute on function public.pos_session_summary(uuid) to authenticated;
grant execute on function public.close_pos_session(uuid, numeric, text) to authenticated;
grant execute on function public.pos_checkout(uuid, uuid, jsonb, jsonb, text) to authenticated;
