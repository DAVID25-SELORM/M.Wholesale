-- Apply Phase 10 to the hosted database in ONE atomic paste: the Phase 10 migrations, verbatim, inside a single transaction.
-- Run it once in the Supabase SQL editor. If anything fails, nothing is changed.
begin;

-- ===== migration 20261019000100_orders_permissions =====
-- Phase 10 / 01: permissions for quotations and sales orders
--
--   quotations.view / create   see, draft, send, reject and cancel quotations and turn an accepted one into an order (branch of the dispatching warehouse)
--   orders.view / create       see, draft and cancel draft sales orders
--   orders.confirm             confirm an order: it numbers it and RESERVES the stock for the customer
--   orders.manage              cancel a confirmed order, or close it short (release what was never delivered)
-- Invoicing an order needs sales.create / sales.post as for any invoice; prices, discounts and credit rules are those of invoices.

insert into public.permissions (code, module, action, description) values
  ('quotations.view',   'quotations', 'view',    'View quotations'),
  ('quotations.create', 'quotations', 'create',  'Draft, send and convert quotations'),
  ('orders.view',       'orders',     'view',    'View sales orders'),
  ('orders.create',     'orders',     'create',  'Draft and cancel draft sales orders'),
  ('orders.confirm',    'orders',     'confirm', 'Confirm sales orders and reserve stock for them'),
  ('orders.manage',     'orders',     'manage',  'Cancel confirmed orders or close them short')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, code) as (values
  ('SUPER_ADMIN','quotations.view'),('SUPER_ADMIN','quotations.create'),('SUPER_ADMIN','orders.view'),('SUPER_ADMIN','orders.create'),('SUPER_ADMIN','orders.confirm'),('SUPER_ADMIN','orders.manage'),
  ('OWNER','quotations.view'),('OWNER','quotations.create'),('OWNER','orders.view'),('OWNER','orders.create'),('OWNER','orders.confirm'),('OWNER','orders.manage'),
  ('GENERAL_MANAGER','quotations.view'),('GENERAL_MANAGER','quotations.create'),('GENERAL_MANAGER','orders.view'),('GENERAL_MANAGER','orders.create'),('GENERAL_MANAGER','orders.confirm'),('GENERAL_MANAGER','orders.manage'),
  ('SALES_MANAGER','quotations.view'),('SALES_MANAGER','quotations.create'),('SALES_MANAGER','orders.view'),('SALES_MANAGER','orders.create'),('SALES_MANAGER','orders.confirm'),('SALES_MANAGER','orders.manage'),
  ('BRANCH_MANAGER','quotations.view'),('BRANCH_MANAGER','quotations.create'),('BRANCH_MANAGER','orders.view'),('BRANCH_MANAGER','orders.create'),('BRANCH_MANAGER','orders.confirm'),('BRANCH_MANAGER','orders.manage'),
  ('SALES_REP','quotations.view'),('SALES_REP','quotations.create'),('SALES_REP','orders.view'),('SALES_REP','orders.create'),
  ('CASHIER','quotations.view'),('CASHIER','orders.view'),
  ('ACCOUNTS_MANAGER','quotations.view'),('ACCOUNTS_MANAGER','orders.view'),
  ('ACCOUNTS_OFFICER','quotations.view'),('ACCOUNTS_OFFICER','orders.view'),
  ('WAREHOUSE_MANAGER','orders.view'),('WAREHOUSE_PICKER','orders.view'),('WAREHOUSE_PACKER','orders.view'),('DISPATCHER','orders.view'),
  ('PHARMACIST','orders.view'),
  ('AUDITOR','quotations.view'),('AUDITOR','orders.view'),
  ('READ_ONLY','quotations.view'),('READ_ONLY','orders.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;

-- ===== migration 20261019000200_orders =====
-- Phase 10 / 02: quotations and sales orders with stock reservation
--
-- QUOTATION   an offer to a customer at stated prices, valid until a date. DRAFT -> SENT (numbered QUO-...) -> ACCEPTED (converted into a sales order) or
--             REJECTED, or CANCELLED. An expired quotation (valid_until passed) can no longer be sent or converted. No stock is held for a quotation.
-- SALES ORDER what the customer has ordered. DRAFT -> CONFIRMED (numbered SO-...) -> COMPLETED when everything ordered is invoiced; or CANCELLED, or CLOSED
--             (short) when the rest will never be delivered. CONFIRMING an order RESERVES its stock: the quantity not yet invoiced is held for this customer
--             at that warehouse until the order is completed, closed, cancelled or its "reserved until" date passes.
-- RESERVATION is a claim, not a hold on particular batches: when an invoice is posted (including counter sales) the stock reserved for OTHER customers'
--             orders is not available to it, so a reserved quantity cannot be sold away. Which batches ship is still decided at invoicing, earliest expiry first.
--             Stock adjustments, transfers and write-offs are not blocked by reservations.
-- INVOICING AN ORDER creates a DRAFT invoice from the order's lines at the ORDER's agreed prices (so the invoicing clerk needs no price-override right), for all
--             or part of what is left; the invoice is then posted like any other (credit control, regulatory rules, FEFO). Posting it moves the order forward;
--             reversing that invoice puts the quantity back on the order.

-- ---------------------------------------------------------------------------------------------------------
-- pricing helper shared by quotations and orders (the same rules as an invoice line)
-- ---------------------------------------------------------------------------------------------------------
create function private.compute_doc_lines(p_org uuid, p_customer public.customers, p_warehouse public.warehouses, p_lines jsonb)
returns table (
  line_no integer, product_id uuid, product_unit_id uuid, quantity numeric, base_quantity numeric, list_price numeric, unit_price numeric,
  discount_percent numeric, tax_code_id uuid, tax_rate numeric, line_net numeric, line_tax numeric, line_total numeric, gross numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_line  jsonb;
  v_n     integer := 0;
  v_prod  public.products;
  v_unit  public.product_units;
  v_qty   numeric;
  v_base  numeric;
  v_list  numeric;
  v_price numeric;
  v_disc  numeric;
  v_taxid uuid;
  v_rate  numeric;
  v_net   numeric;
  v_tax   numeric;
  v_seen  text[] := '{}';
  v_key   text;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'add at least one line' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'a document is limited to 200 lines' using errcode = '22023';
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'line %: invalid line', v_n using errcode = '22023';
    end if;
    select * into v_prod from public.products p
     where p.id = nullif(v_line ->> 'product_id', '')::uuid and p.organization_id = p_org and p.is_active;
    if not found then
      raise exception 'line %: product not found or inactive', v_n using errcode = 'P0002';
    end if;
    if nullif(v_line ->> 'product_unit_id', '') is null then
      select * into v_unit from public.product_units u where u.product_id = v_prod.id and u.is_base;
    else
      select * into v_unit from public.product_units u
       where u.id = (v_line ->> 'product_unit_id')::uuid and u.product_id = v_prod.id and u.organization_id = p_org and u.is_active and u.is_sellable;
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

    select i.unit_price into v_list
    from public.price_list_items i
    join public.price_lists l on l.id = i.price_list_id and l.is_active
    where i.product_unit_id = v_unit.id and i.is_active and (l.id = p_customer.price_list_id or l.is_default)
    order by coalesce(l.id = p_customer.price_list_id, false) desc, l.is_default desc
    limit 1;
    if jsonb_typeof(v_line -> 'unit_price') = 'number' then
      v_price := (v_line ->> 'unit_price')::numeric;
      if v_price < 0 or v_price <> round(v_price, 4) or v_price >= 100000000000 then
        raise exception 'line %: price must be 0 or more with at most 4 decimals', v_n using errcode = '22023';
      end if;
      if (v_list is null or v_price <> v_list) and not private.has_permission('sales.price_override', p_warehouse.branch_id) then
        raise exception 'line %: you cannot offer % at a price other than the price list (%)', v_n, v_prod.sku, coalesce(v_list::text, 'no price on any list')
          using errcode = '42501';
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
    if v_disc > 0 and not private.has_permission('sales.discount', p_warehouse.branch_id) then
      raise exception 'line %: you are not allowed to give discounts', v_n using errcode = '42501';
    end if;
    v_key := v_prod.id::text || '|' || v_unit.id::text || '|' || v_price::text || '|' || v_disc::text;
    if v_key = any (v_seen) then
      raise exception 'line %: the same product, pack level, price and discount is already on the document - increase its quantity', v_n using errcode = '22023';
    end if;
    v_seen := v_seen || v_key;

    select t.id, t.rate into v_taxid, v_rate from public.tax_codes t
     where t.organization_id = p_org and t.is_active and t.id = coalesce(v_prod.tax_code_id, (select d.id from public.tax_codes d where d.organization_id = p_org and d.is_default));
    v_rate := coalesce(v_rate, 0);
    v_net := round(v_qty * v_price * (1 - v_disc / 100), 2);
    v_tax := round(v_net * v_rate / 100, 2);
    line_no := v_n; product_id := v_prod.id; product_unit_id := v_unit.id; quantity := v_qty; base_quantity := v_base; list_price := v_list; unit_price := v_price;
    discount_percent := v_disc; tax_code_id := v_taxid; tax_rate := v_rate; line_net := v_net; line_tax := v_tax; line_total := v_net + v_tax;
    gross := round(v_qty * v_price, 2);
    return next;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- tables: quotations
-- ---------------------------------------------------------------------------------------------------------
create table public.sales_quotations (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete restrict default private.current_organization_id(),
  quotation_number   text,                                  -- assigned when sent
  customer_id        uuid not null,
  branch_id          uuid not null,
  warehouse_id       uuid not null,                         -- where the goods would ship from (decides the branch)
  status             text not null default 'DRAFT' check (status in ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'CANCELLED')),
  quotation_date     date not null,
  valid_until        date not null,
  currency_code      text not null check (currency_code ~ '^[A-Z]{3}$'),
  customer_reference text check (customer_reference is null or length(customer_reference) <= 80),
  notes              text check (notes is null or length(notes) <= 1000),
  subtotal           numeric(18, 2) not null default 0 check (subtotal >= 0),
  discount_total     numeric(18, 2) not null default 0 check (discount_total >= 0),
  tax_total          numeric(18, 2) not null default 0 check (tax_total >= 0),
  total_amount       numeric(18, 2) not null default 0 check (total_amount >= 0),
  converted_order_id uuid,
  status_reason      text check (status_reason is null or length(status_reason) <= 500),
  created_by         uuid default auth.uid(),
  sent_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint sales_quotations_customer_fk foreign key (customer_id, organization_id) references public.customers (id, organization_id) on delete restrict,
  constraint sales_quotations_branch_fk foreign key (branch_id, organization_id) references public.branches (id, organization_id) on delete restrict,
  constraint sales_quotations_warehouse_fk foreign key (warehouse_id, organization_id) references public.warehouses (id, organization_id) on delete restrict,
  constraint sales_quotations_id_org_key unique (id, organization_id),
  constraint sales_quotations_total check (total_amount = subtotal + tax_total),
  constraint sales_quotations_numbered check (status in ('DRAFT', 'CANCELLED') or quotation_number is not null)
);
create unique index sales_quotations_number_key on public.sales_quotations (organization_id, quotation_number) where quotation_number is not null;
create index sales_quotations_org_created_idx on public.sales_quotations (organization_id, created_at desc, id desc);
create index sales_quotations_branch_status_idx on public.sales_quotations (organization_id, branch_id, status, valid_until);
create index sales_quotations_customer_idx on public.sales_quotations (customer_id, status);
create index sales_quotations_warehouse_idx on public.sales_quotations (warehouse_id);
create trigger sales_quotations_immutable before update on public.sales_quotations
  for each row execute function private.prevent_column_change('organization_id', 'created_by');
create trigger sales_quotations_set_updated_at before update on public.sales_quotations
  for each row execute function private.set_updated_at();
create trigger sales_quotations_audit after insert or update on public.sales_quotations
  for each row execute function private.audit_row_change('sales_quotation');
create trigger sales_quotations_no_delete before delete on public.sales_quotations
  for each row execute function private.stock_block_mutation();

create function private.sales_quotations_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('ACCEPTED', 'REJECTED', 'CANCELLED') then
    raise exception 'a % quotation cannot be changed', lower(old.status) using errcode = '42501';
  end if;
  if old.status = 'SENT' and (
       new.customer_id is distinct from old.customer_id or new.branch_id is distinct from old.branch_id or new.warehouse_id is distinct from old.warehouse_id
       or new.valid_until is distinct from old.valid_until or new.quotation_date is distinct from old.quotation_date or new.quotation_number is distinct from old.quotation_number
       or new.subtotal is distinct from old.subtotal or new.tax_total is distinct from old.tax_total or new.total_amount is distinct from old.total_amount
       or new.currency_code is distinct from old.currency_code or new.notes is distinct from old.notes or new.customer_reference is distinct from old.customer_reference) then
    raise exception 'a quotation that has been sent cannot be changed: cancel it and make a new one' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger sales_quotations_lock before update on public.sales_quotations
  for each row execute function private.sales_quotations_lock();

create table public.sales_quotation_lines (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict default private.current_organization_id(),
  quotation_id     uuid not null,
  branch_id        uuid not null,
  line_no          integer not null check (line_no > 0),
  product_id       uuid not null,
  product_unit_id  uuid not null,
  quantity         numeric(18, 3) not null check (quantity > 0),
  base_quantity    numeric(18, 3) not null check (base_quantity > 0),
  list_price       numeric(18, 4) check (list_price is null or list_price >= 0),
  unit_price       numeric(18, 4) not null check (unit_price >= 0),
  discount_percent numeric(5, 2) not null default 0 check (discount_percent between 0 and 100),
  tax_code_id      uuid,
  tax_rate         numeric(7, 4) not null default 0 check (tax_rate between 0 and 100),
  line_net         numeric(18, 2) not null check (line_net >= 0),
  line_tax         numeric(18, 2) not null check (line_tax >= 0),
  line_total       numeric(18, 2) not null check (line_total >= 0),
  constraint sales_quotation_lines_quotation_fk foreign key (quotation_id, organization_id) references public.sales_quotations (id, organization_id) on delete restrict,
  constraint sales_quotation_lines_product_fk foreign key (product_id, organization_id) references public.products (id, organization_id) on delete restrict,
  constraint sales_quotation_lines_unit_fk foreign key (product_unit_id, product_id, organization_id) references public.product_units (id, product_id, organization_id) on delete restrict,
  constraint sales_quotation_lines_tax_fk foreign key (tax_code_id, organization_id) references public.tax_codes (id, organization_id) on delete restrict,
  constraint sales_quotation_lines_line_key unique (quotation_id, line_no),
  constraint sales_quotation_lines_total check (line_total = line_net + line_tax)
);
create index sales_quotation_lines_product_idx on public.sales_quotation_lines (organization_id, product_id);
create index sales_quotation_lines_unit_idx on public.sales_quotation_lines (product_unit_id);
create index sales_quotation_lines_tax_idx on public.sales_quotation_lines (tax_code_id) where tax_code_id is not null;

create function private.sales_quotation_lines_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  select q.status into v_status from public.sales_quotations q where q.id = old.quotation_id;
  if v_status is distinct from 'DRAFT' then
    raise exception 'the lines of a % quotation cannot be changed', lower(coalesce(v_status, 'missing')) using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger sales_quotation_lines_lock before update or delete on public.sales_quotation_lines
  for each row execute function private.sales_quotation_lines_lock();

-- ---------------------------------------------------------------------------------------------------------
-- tables: sales orders
-- ---------------------------------------------------------------------------------------------------------
create table public.sales_orders (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete restrict default private.current_organization_id(),
  order_number       text,                                  -- assigned when confirmed
  customer_id        uuid not null,
  branch_id          uuid not null,
  warehouse_id       uuid not null,                         -- stock is reserved here, and invoices ship from here
  status             text not null default 'DRAFT' check (status in ('DRAFT', 'CONFIRMED', 'COMPLETED', 'CLOSED', 'CANCELLED')),
  order_date         date not null,
  required_date      date,
  reserved_until     date,                                  -- the reservation lapses after this date (null = until the order ends)
  currency_code      text not null check (currency_code ~ '^[A-Z]{3}$'),
  customer_reference text check (customer_reference is null or length(customer_reference) <= 80),   -- the customer's own purchase order number
  quotation_id       uuid,
  notes              text check (notes is null or length(notes) <= 1000),
  subtotal           numeric(18, 2) not null default 0 check (subtotal >= 0),
  discount_total     numeric(18, 2) not null default 0 check (discount_total >= 0),
  tax_total          numeric(18, 2) not null default 0 check (tax_total >= 0),
  total_amount       numeric(18, 2) not null default 0 check (total_amount >= 0),
  status_reason      text check (status_reason is null or length(status_reason) <= 500),
  created_by         uuid default auth.uid(),
  confirmed_by       uuid,
  confirmed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint sales_orders_customer_fk foreign key (customer_id, organization_id) references public.customers (id, organization_id) on delete restrict,
  constraint sales_orders_branch_fk foreign key (branch_id, organization_id) references public.branches (id, organization_id) on delete restrict,
  constraint sales_orders_warehouse_fk foreign key (warehouse_id, organization_id) references public.warehouses (id, organization_id) on delete restrict,
  constraint sales_orders_quotation_fk foreign key (quotation_id, organization_id) references public.sales_quotations (id, organization_id) on delete restrict,
  constraint sales_orders_id_org_key unique (id, organization_id),
  constraint sales_orders_total check (total_amount = subtotal + tax_total),
  constraint sales_orders_numbered check (status in ('DRAFT', 'CANCELLED') or (order_number is not null and confirmed_at is not null))
);
create unique index sales_orders_number_key on public.sales_orders (organization_id, order_number) where order_number is not null;
create index sales_orders_org_created_idx on public.sales_orders (organization_id, created_at desc, id desc);
create index sales_orders_branch_status_idx on public.sales_orders (organization_id, branch_id, status, order_date desc);
create index sales_orders_customer_idx on public.sales_orders (customer_id, status);
create index sales_orders_warehouse_status_idx on public.sales_orders (organization_id, warehouse_id, status) where status = 'CONFIRMED';
create index sales_orders_quotation_idx on public.sales_orders (quotation_id) where quotation_id is not null;
create trigger sales_orders_immutable before update on public.sales_orders
  for each row execute function private.prevent_column_change('organization_id', 'created_by');
create trigger sales_orders_set_updated_at before update on public.sales_orders
  for each row execute function private.set_updated_at();
create trigger sales_orders_audit after insert or update on public.sales_orders
  for each row execute function private.audit_row_change('sales_order');
create trigger sales_orders_no_delete before delete on public.sales_orders
  for each row execute function private.stock_block_mutation();

alter table public.sales_quotations add constraint sales_quotations_order_fk foreign key (converted_order_id, organization_id)
  references public.sales_orders (id, organization_id) on delete restrict;

create function private.sales_orders_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('CANCELLED', 'CLOSED') then
    raise exception 'a % order cannot be changed', lower(old.status) using errcode = '42501';
  end if;
  if old.status <> 'DRAFT' and (
       new.customer_id is distinct from old.customer_id or new.branch_id is distinct from old.branch_id or new.warehouse_id is distinct from old.warehouse_id
       or new.order_number is distinct from old.order_number or new.order_date is distinct from old.order_date or new.required_date is distinct from old.required_date
       or new.reserved_until is distinct from old.reserved_until or new.subtotal is distinct from old.subtotal or new.tax_total is distinct from old.tax_total
       or new.total_amount is distinct from old.total_amount or new.currency_code is distinct from old.currency_code or new.customer_reference is distinct from old.customer_reference
       or new.quotation_id is distinct from old.quotation_id or new.notes is distinct from old.notes) then
    raise exception 'a confirmed order cannot be changed: cancel it and make a new one' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger sales_orders_lock before update on public.sales_orders
  for each row execute function private.sales_orders_lock();

create table public.sales_order_lines (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict default private.current_organization_id(),
  sales_order_id   uuid not null,
  branch_id        uuid not null,
  line_no          integer not null check (line_no > 0),
  product_id       uuid not null,
  product_unit_id  uuid not null,
  quantity         numeric(18, 3) not null check (quantity > 0),
  base_quantity    numeric(18, 3) not null check (base_quantity > 0),
  list_price       numeric(18, 4) check (list_price is null or list_price >= 0),
  unit_price       numeric(18, 4) not null check (unit_price >= 0),
  discount_percent numeric(5, 2) not null default 0 check (discount_percent between 0 and 100),
  tax_code_id      uuid,
  tax_rate         numeric(7, 4) not null default 0 check (tax_rate between 0 and 100),
  line_net         numeric(18, 2) not null check (line_net >= 0),
  line_tax         numeric(18, 2) not null check (line_tax >= 0),
  line_total       numeric(18, 2) not null check (line_total >= 0),
  constraint sales_order_lines_order_fk foreign key (sales_order_id, organization_id) references public.sales_orders (id, organization_id) on delete restrict,
  constraint sales_order_lines_product_fk foreign key (product_id, organization_id) references public.products (id, organization_id) on delete restrict,
  constraint sales_order_lines_unit_fk foreign key (product_unit_id, product_id, organization_id) references public.product_units (id, product_id, organization_id) on delete restrict,
  constraint sales_order_lines_tax_fk foreign key (tax_code_id, organization_id) references public.tax_codes (id, organization_id) on delete restrict,
  constraint sales_order_lines_line_key unique (sales_order_id, line_no),
  constraint sales_order_lines_id_org_key unique (id, organization_id),
  constraint sales_order_lines_total check (line_total = line_net + line_tax)
);
create index sales_order_lines_product_idx on public.sales_order_lines (organization_id, product_id);
create index sales_order_lines_unit_idx on public.sales_order_lines (product_unit_id);
create index sales_order_lines_tax_idx on public.sales_order_lines (tax_code_id) where tax_code_id is not null;

create function private.sales_order_lines_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  select o.status into v_status from public.sales_orders o where o.id = old.sales_order_id;
  if v_status is distinct from 'DRAFT' then
    raise exception 'the lines of a % order cannot be changed', lower(coalesce(v_status, 'missing')) using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger sales_order_lines_lock before update or delete on public.sales_order_lines
  for each row execute function private.sales_order_lines_lock();

-- invoices raised from an order remember which order line each of their lines belongs to
alter table public.sales_invoices add column sales_order_id uuid;
alter table public.sales_invoices add constraint sales_invoices_order_fk foreign key (sales_order_id, organization_id)
  references public.sales_orders (id, organization_id) on delete restrict;
create index sales_invoices_order_idx on public.sales_invoices (sales_order_id) where sales_order_id is not null;
alter table public.sales_invoice_lines add column sales_order_line_id uuid;
alter table public.sales_invoice_lines add constraint sales_invoice_lines_order_line_fk foreign key (sales_order_line_id, organization_id)
  references public.sales_order_lines (id, organization_id) on delete restrict;
create index sales_invoice_lines_order_line_idx on public.sales_invoice_lines (sales_order_line_id) where sales_order_line_id is not null;

-- ---------------------------------------------------------------------------------------------------------
-- RLS and grants: read only; every write goes through the functions below
-- ---------------------------------------------------------------------------------------------------------
alter table public.sales_quotations      enable row level security;
alter table public.sales_quotation_lines enable row level security;
alter table public.sales_orders          enable row level security;
alter table public.sales_order_lines     enable row level security;
revoke all on public.sales_quotations, public.sales_quotation_lines, public.sales_orders, public.sales_order_lines from public, anon, authenticated;
grant select on public.sales_quotations, public.sales_quotation_lines, public.sales_orders, public.sales_order_lines to authenticated;
create policy sales_quotations_select on public.sales_quotations for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('quotations.view', branch_id));
create policy sales_quotation_lines_select on public.sales_quotation_lines for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('quotations.view', branch_id));
create policy sales_orders_select on public.sales_orders for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('orders.view', branch_id));
create policy sales_order_lines_select on public.sales_order_lines for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('orders.view', branch_id));

-- ---------------------------------------------------------------------------------------------------------
-- reservations
-- ---------------------------------------------------------------------------------------------------------
-- What confirmed orders still hold at a warehouse for a product, in base units: ordered minus invoiced (posted), for orders that are CONFIRMED and whose
-- reservation has not lapsed. p_exclude_order leaves out one order (the one an invoice is being posted for).
create function private.reserved_quantity(p_org uuid, p_warehouse_id uuid, p_product_id uuid, p_exclude_order uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(greatest(0, ol.base_quantity - coalesce(inv.q, 0))), 0)
  from public.sales_order_lines ol
  join public.sales_orders o on o.id = ol.sales_order_id and o.status = 'CONFIRMED'
  left join lateral (
    select sum(il.base_quantity) as q
    from public.sales_invoice_lines il
    join public.sales_invoices i on i.id = il.sales_invoice_id and i.status = 'POSTED'
    where il.sales_order_line_id = ol.id) inv on true
  where o.organization_id = p_org and o.warehouse_id = p_warehouse_id and ol.product_id = p_product_id
    and (o.reserved_until is null or o.reserved_until >= current_date)
    and (p_exclude_order is null or o.id <> p_exclude_order)
$$;

-- sellable stock at a warehouse for a product (AVAILABLE, unexpired), what orders hold, and what is left to promise
create function public.stock_availability(p_warehouse_id uuid, p_product_id uuid)
returns table (on_hand numeric, reserved numeric, free numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_wh  public.warehouses;
  v_on  numeric;
  v_res numeric;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_wh from public.warehouses w where w.id = p_warehouse_id and w.organization_id = v_org;
  if not found or not (private.has_permission('sales.view', v_wh.branch_id) or private.has_permission('orders.view', v_wh.branch_id)) then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;
  select coalesce(sum(sb.quantity), 0) into v_on
  from public.stock_balances sb
  left join public.batches ba on ba.id = sb.batch_id
  where sb.organization_id = v_org and sb.warehouse_id = p_warehouse_id and sb.product_id = p_product_id and sb.stock_status = 'AVAILABLE'
    and (ba.id is null or ba.expiry_date >= current_date);
  v_res := private.reserved_quantity(v_org, p_warehouse_id, p_product_id);
  on_hand := v_on; reserved := v_res; free := greatest(0, v_on - v_res);
  return next;
end;
$$;

-- per order line: ordered, invoiced (posted), in draft invoices, still to invoice, and what is held in reserve
create function public.order_progress(p_order_id uuid)
returns table (order_line_id uuid, line_no integer, quantity numeric, invoiced numeric, in_draft numeric, remaining numeric, reserved_base numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  select ol.id, ol.line_no, ol.quantity,
         coalesce(p.q, 0), coalesce(d.q, 0), ol.quantity - coalesce(p.q, 0) - coalesce(d.q, 0),
         case when o.status = 'CONFIRMED' and (o.reserved_until is null or o.reserved_until >= current_date)
              then greatest(0, ol.base_quantity - coalesce(p.b, 0)) else 0 end
  from public.sales_order_lines ol
  join public.sales_orders o on o.id = ol.sales_order_id
  left join lateral (select sum(il.quantity) as q, sum(il.base_quantity) as b from public.sales_invoice_lines il
                     join public.sales_invoices i on i.id = il.sales_invoice_id and i.status = 'POSTED' where il.sales_order_line_id = ol.id) p on true
  left join lateral (select sum(il.quantity) as q from public.sales_invoice_lines il
                     join public.sales_invoices i on i.id = il.sales_invoice_id and i.status = 'DRAFT' where il.sales_order_line_id = ol.id) d on true
  where ol.sales_order_id = p_order_id
  order by ol.line_no
$$;

-- moves an order between CONFIRMED and COMPLETED as its invoices are posted or reversed
create function private.refresh_order_status(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_open   boolean;
begin
  select o.status into v_status from public.sales_orders o where o.id = p_order_id for update;
  if v_status not in ('CONFIRMED', 'COMPLETED') then
    return;
  end if;
  select exists (
    select 1 from public.sales_order_lines ol
    where ol.sales_order_id = p_order_id
      and ol.quantity > coalesce((select sum(il.quantity) from public.sales_invoice_lines il join public.sales_invoices i on i.id = il.sales_invoice_id and i.status = 'POSTED'
                                  where il.sales_order_line_id = ol.id), 0)) into v_open;
  if v_status = 'CONFIRMED' and not v_open then
    update public.sales_orders set status = 'COMPLETED' where id = p_order_id;
  elsif v_status = 'COMPLETED' and v_open then
    update public.sales_orders set status = 'CONFIRMED' where id = p_order_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- quotations
-- ---------------------------------------------------------------------------------------------------------
create function public.save_quotation(
  p_id uuid, p_customer_id uuid, p_warehouse_id uuid, p_valid_until date, p_customer_reference text, p_notes text, p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_wh    public.warehouses;
  v_cust  public.customers;
  v_q     public.sales_quotations;
  v_today date;
  v_cur   text;
  v_valid date;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_wh from public.warehouses w where w.id = p_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('quotations.create', v_wh.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  select * into v_cust from public.customers c where c.id = p_customer_id and c.organization_id = v_org and c.is_active;
  if not found then
    raise exception 'customer not found or inactive' using errcode = 'P0002';
  end if;
  if (p_customer_reference is not null and length(p_customer_reference) > 80) or (p_notes is not null and length(p_notes) > 1000) then
    raise exception 'reference is limited to 80 and notes to 1000 characters' using errcode = '22023';
  end if;
  select o.currency_code, (now() at time zone o.timezone)::date into v_cur, v_today from public.organizations o where o.id = v_org;
  v_valid := coalesce(p_valid_until, v_today + 30);
  if v_valid < v_today then
    raise exception 'the quotation cannot be valid until a date in the past' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.sales_quotations (organization_id, customer_id, branch_id, warehouse_id, quotation_date, valid_until, currency_code, customer_reference, notes)
    values (v_org, v_cust.id, v_wh.branch_id, v_wh.id, v_today, v_valid, v_cur, nullif(btrim(p_customer_reference), ''), nullif(btrim(p_notes), ''))
    returning * into v_q;
  else
    select * into v_q from public.sales_quotations q where q.id = p_id and q.organization_id = v_org for update;
    if not found then
      raise exception 'quotation not found' using errcode = 'P0002';
    end if;
    if v_q.status <> 'DRAFT' then
      raise exception 'only a draft quotation can be edited (this one is %)', v_q.status using errcode = '22023';
    end if;
    if not private.has_permission('quotations.create', v_q.branch_id) then
      raise exception 'insufficient privilege for this branch' using errcode = '42501';
    end if;
    update public.sales_quotations
       set customer_id = v_cust.id, branch_id = v_wh.branch_id, warehouse_id = v_wh.id, quotation_date = v_today, valid_until = v_valid,
           customer_reference = nullif(btrim(p_customer_reference), ''), notes = nullif(btrim(p_notes), '')
     where id = v_q.id;
    delete from public.sales_quotation_lines where quotation_id = v_q.id;
  end if;

  insert into public.sales_quotation_lines (organization_id, quotation_id, branch_id, line_no, product_id, product_unit_id, quantity, base_quantity, list_price, unit_price,
                                            discount_percent, tax_code_id, tax_rate, line_net, line_tax, line_total)
  select v_org, v_q.id, v_wh.branch_id, c.line_no, c.product_id, c.product_unit_id, c.quantity, c.base_quantity, c.list_price, c.unit_price,
         c.discount_percent, c.tax_code_id, c.tax_rate, c.line_net, c.line_tax, c.line_total
  from private.compute_doc_lines(v_org, v_cust, v_wh, p_lines) c;
  update public.sales_quotations q
     set subtotal = t.net, discount_total = t.disc, tax_total = t.tax, total_amount = t.net + t.tax
    from (select sum(l.line_net) net, sum(l.line_tax) tax, sum(round(l.quantity * l.unit_price, 2) - l.line_net) disc from public.sales_quotation_lines l where l.quotation_id = v_q.id) t
   where q.id = v_q.id;
  return v_q.id;
end;
$$;

create function public.send_quotation(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_q     public.sales_quotations;
  v_today date;
  v_no    text;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_q from public.sales_quotations q where q.id = p_id and q.organization_id = v_org for update;
  if not found then
    raise exception 'quotation not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('quotations.create', v_q.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_q.status <> 'DRAFT' then
    raise exception 'only a draft quotation can be sent (this one is %)', v_q.status using errcode = '22023';
  end if;
  select (now() at time zone o.timezone)::date into v_today from public.organizations o where o.id = v_org;
  if v_q.valid_until < v_today then
    raise exception 'the quotation has already expired (valid until %): change its date first', v_q.valid_until using errcode = '22023';
  end if;
  if not exists (select 1 from public.sales_quotation_lines l where l.quotation_id = v_q.id) then
    raise exception 'the quotation has no lines' using errcode = '22023';
  end if;
  v_no := private.generate_document_number(v_org, null, 'SALES_QUOTATION', 'QUO');
  update public.sales_quotations set status = 'SENT', quotation_number = v_no, sent_at = now() where id = v_q.id;
  return v_no;
end;
$$;

-- p_new_status: REJECTED (the customer declined) or CANCELLED (withdrawn by us)
create function private.close_quotation(p_id uuid, p_reason text, p_new_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_q   public.sales_quotations;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_q from public.sales_quotations q where q.id = p_id and q.organization_id = v_org for update;
  if not found then
    raise exception 'quotation not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('quotations.create', v_q.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if (p_new_status = 'REJECTED' and v_q.status <> 'SENT') or (p_new_status = 'CANCELLED' and v_q.status not in ('DRAFT', 'SENT')) then
    raise exception 'a % quotation cannot be %', lower(v_q.status), lower(p_new_status) using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.sales_quotations set status = p_new_status, status_reason = btrim(p_reason) where id = v_q.id;
end;
$$;
create function public.reject_quotation(p_id uuid, p_reason text) returns void language sql security definer set search_path = ''
  as $$ select private.close_quotation(p_id, p_reason, 'REJECTED') $$;
create function public.cancel_quotation(p_id uuid, p_reason text) returns void language sql security definer set search_path = ''
  as $$ select private.close_quotation(p_id, p_reason, 'CANCELLED') $$;

-- the customer accepted: a DRAFT order is created with the quoted lines at the quoted prices
create function public.convert_quotation_to_order(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_q     public.sales_quotations;
  v_today date;
  v_cust  public.customers;
  v_order uuid;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_q from public.sales_quotations q where q.id = p_id and q.organization_id = v_org for update;
  if not found then
    raise exception 'quotation not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('quotations.create', v_q.branch_id) or not private.has_permission('orders.create', v_q.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_q.status <> 'SENT' then
    raise exception 'only a sent quotation can be accepted (this one is %)', v_q.status using errcode = '22023';
  end if;
  select (now() at time zone o.timezone)::date into v_today from public.organizations o where o.id = v_org;
  if v_q.valid_until < v_today then
    raise exception 'the quotation expired on %: it can no longer be accepted', v_q.valid_until using errcode = '22023';
  end if;
  select * into v_cust from public.customers c where c.id = v_q.customer_id and c.organization_id = v_org and c.is_active;
  if not found then
    raise exception 'the customer is inactive' using errcode = '22023';
  end if;
  insert into public.sales_orders (organization_id, customer_id, branch_id, warehouse_id, order_date, currency_code, customer_reference, quotation_id, notes,
                                   subtotal, discount_total, tax_total, total_amount)
  values (v_org, v_q.customer_id, v_q.branch_id, v_q.warehouse_id, v_today, v_q.currency_code, v_q.customer_reference, v_q.id, v_q.notes,
          v_q.subtotal, v_q.discount_total, v_q.tax_total, v_q.total_amount)
  returning id into v_order;
  insert into public.sales_order_lines (organization_id, sales_order_id, branch_id, line_no, product_id, product_unit_id, quantity, base_quantity, list_price, unit_price,
                                        discount_percent, tax_code_id, tax_rate, line_net, line_tax, line_total)
  select v_org, v_order, l.branch_id, l.line_no, l.product_id, l.product_unit_id, l.quantity, l.base_quantity, l.list_price, l.unit_price,
         l.discount_percent, l.tax_code_id, l.tax_rate, l.line_net, l.line_tax, l.line_total
  from public.sales_quotation_lines l where l.quotation_id = v_q.id;
  update public.sales_quotations set status = 'ACCEPTED', converted_order_id = v_order where id = v_q.id;
  return v_order;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- sales orders
-- ---------------------------------------------------------------------------------------------------------
create function public.save_sales_order(
  p_id uuid, p_customer_id uuid, p_warehouse_id uuid, p_required_date date, p_reserved_until date, p_customer_reference text, p_notes text, p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_wh    public.warehouses;
  v_cust  public.customers;
  v_o     public.sales_orders;
  v_today date;
  v_cur   text;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_wh from public.warehouses w where w.id = p_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('orders.create', v_wh.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  select * into v_cust from public.customers c where c.id = p_customer_id and c.organization_id = v_org and c.is_active;
  if not found then
    raise exception 'customer not found or inactive' using errcode = 'P0002';
  end if;
  if v_cust.is_walk_in then
    raise exception 'orders are for named customers: the walk-in customer buys at the counter' using errcode = '22023';
  end if;
  if (p_customer_reference is not null and length(p_customer_reference) > 80) or (p_notes is not null and length(p_notes) > 1000) then
    raise exception 'reference is limited to 80 and notes to 1000 characters' using errcode = '22023';
  end if;
  select o.currency_code, (now() at time zone o.timezone)::date into v_cur, v_today from public.organizations o where o.id = v_org;
  if p_reserved_until is not null and p_reserved_until < v_today then
    raise exception 'the reservation cannot end on a date in the past' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.sales_orders (organization_id, customer_id, branch_id, warehouse_id, order_date, required_date, reserved_until, currency_code, customer_reference, notes)
    values (v_org, v_cust.id, v_wh.branch_id, v_wh.id, v_today, p_required_date, p_reserved_until, v_cur, nullif(btrim(p_customer_reference), ''), nullif(btrim(p_notes), ''))
    returning * into v_o;
  else
    select * into v_o from public.sales_orders o where o.id = p_id and o.organization_id = v_org for update;
    if not found then
      raise exception 'order not found' using errcode = 'P0002';
    end if;
    if v_o.status <> 'DRAFT' then
      raise exception 'only a draft order can be edited (this one is %)', v_o.status using errcode = '22023';
    end if;
    if not private.has_permission('orders.create', v_o.branch_id) then
      raise exception 'insufficient privilege for this branch' using errcode = '42501';
    end if;
    update public.sales_orders
       set customer_id = v_cust.id, branch_id = v_wh.branch_id, warehouse_id = v_wh.id, order_date = v_today, required_date = p_required_date,
           reserved_until = p_reserved_until, customer_reference = nullif(btrim(p_customer_reference), ''), notes = nullif(btrim(p_notes), '')
     where id = v_o.id;
    delete from public.sales_order_lines where sales_order_id = v_o.id;
  end if;

  insert into public.sales_order_lines (organization_id, sales_order_id, branch_id, line_no, product_id, product_unit_id, quantity, base_quantity, list_price, unit_price,
                                        discount_percent, tax_code_id, tax_rate, line_net, line_tax, line_total)
  select v_org, v_o.id, v_wh.branch_id, c.line_no, c.product_id, c.product_unit_id, c.quantity, c.base_quantity, c.list_price, c.unit_price,
         c.discount_percent, c.tax_code_id, c.tax_rate, c.line_net, c.line_tax, c.line_total
  from private.compute_doc_lines(v_org, v_cust, v_wh, p_lines) c;
  update public.sales_orders o
     set subtotal = t.net, discount_total = t.disc, tax_total = t.tax, total_amount = t.net + t.tax
    from (select sum(l.line_net) net, sum(l.line_tax) tax, sum(round(l.quantity * l.unit_price, 2) - l.line_net) disc from public.sales_order_lines l where l.sales_order_id = v_o.id) t
   where o.id = v_o.id;
  return v_o.id;
end;
$$;

-- numbers the order and reserves its stock; refused when the free stock (sellable minus what other orders hold) does not cover it
create function public.confirm_sales_order(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_o     public.sales_orders;
  v_cust  public.customers;
  v_today date;
  v_p     record;
  v_on    numeric;
  v_res   numeric;
  v_no    text;
  v_short text[] := '{}';
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_o from public.sales_orders o where o.id = p_id and o.organization_id = v_org for update;
  if not found then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('orders.confirm', v_o.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_o.status <> 'DRAFT' then
    raise exception 'only a draft order can be confirmed (this one is %)', v_o.status using errcode = '22023';
  end if;
  select * into v_cust from public.customers c where c.id = v_o.customer_id and c.organization_id = v_org;
  if not v_cust.is_active then
    raise exception 'the customer is inactive' using errcode = '22023';
  end if;
  select (now() at time zone o.timezone)::date into v_today from public.organizations o where o.id = v_org;
  if v_o.reserved_until is not null and v_o.reserved_until < v_today then
    raise exception 'the reservation date has passed: change it first' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sales_order_lines l where l.sales_order_id = v_o.id) then
    raise exception 'the order has no lines' using errcode = '22023';
  end if;
  -- serialise confirmations at one warehouse so two orders cannot both claim the last units
  perform pg_advisory_xact_lock(hashtextextended(v_o.warehouse_id::text, 0));
  for v_p in
    select l.product_id, sum(l.base_quantity) as need, max(p.sku) as sku
    from public.sales_order_lines l join public.products p on p.id = l.product_id
    where l.sales_order_id = v_o.id group by l.product_id order by l.product_id
  loop
    select coalesce(sum(sb.quantity), 0) into v_on
    from public.stock_balances sb left join public.batches ba on ba.id = sb.batch_id
    where sb.organization_id = v_org and sb.warehouse_id = v_o.warehouse_id and sb.product_id = v_p.product_id and sb.stock_status = 'AVAILABLE'
      and (ba.id is null or ba.expiry_date >= v_today + v_cust.min_shelf_life_days);
    v_res := private.reserved_quantity(v_org, v_o.warehouse_id, v_p.product_id);
    if v_p.need > v_on - v_res then
      v_short := v_short || format('%s: %s needed, %s free (%s sellable, %s reserved for other orders)', v_p.sku, trim_scale(v_p.need), trim_scale(greatest(0, v_on - v_res)), trim_scale(v_on), trim_scale(v_res));
    end if;
  end loop;
  if array_length(v_short, 1) > 0 then
    raise exception 'not enough free stock to reserve: %', array_to_string(v_short, '; ') using errcode = '23514';
  end if;
  v_no := private.generate_document_number(v_org, null, 'SALES_ORDER', 'SO');
  update public.sales_orders set status = 'CONFIRMED', order_number = v_no, confirmed_by = auth.uid(), confirmed_at = now() where id = v_o.id;
  return jsonb_build_object('order_number', v_no);
end;
$$;

create function private.end_sales_order(p_id uuid, p_reason text, p_new_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_o   public.sales_orders;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_o from public.sales_orders o where o.id = p_id and o.organization_id = v_org for update;
  if not found then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  if p_new_status = 'CANCELLED' and v_o.status = 'DRAFT' then
    if not private.has_permission('orders.create', v_o.branch_id) then
      raise exception 'insufficient privilege for this branch' using errcode = '42501';
    end if;
  elsif p_new_status = 'CANCELLED' and v_o.status = 'CONFIRMED' then
    if not private.has_permission('orders.manage', v_o.branch_id) then
      raise exception 'insufficient privilege for this branch' using errcode = '42501';
    end if;
    if exists (select 1 from public.sales_invoices i where i.sales_order_id = v_o.id and i.status = 'POSTED') then
      raise exception 'part of this order has been invoiced: close it short instead of cancelling it' using errcode = '22023';
    end if;
  elsif p_new_status = 'CLOSED' and v_o.status in ('CONFIRMED', 'COMPLETED') then
    if not private.has_permission('orders.manage', v_o.branch_id) then
      raise exception 'insufficient privilege for this branch' using errcode = '42501';
    end if;
  else
    raise exception 'a % order cannot be %', lower(v_o.status), case p_new_status when 'CLOSED' then 'closed short' else 'cancelled' end using errcode = '22023';
  end if;
  if exists (select 1 from public.sales_invoices i where i.sales_order_id = v_o.id and i.status = 'DRAFT') then
    raise exception 'this order has draft invoices: cancel or post them first' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.sales_orders set status = p_new_status, status_reason = btrim(p_reason) where id = v_o.id;
end;
$$;
create function public.cancel_sales_order(p_id uuid, p_reason text) returns void language sql security definer set search_path = ''
  as $$ select private.end_sales_order(p_id, p_reason, 'CANCELLED') $$;
create function public.close_sales_order(p_id uuid, p_reason text) returns void language sql security definer set search_path = ''
  as $$ select private.end_sales_order(p_id, p_reason, 'CLOSED') $$;

-- Creates a DRAFT invoice from a confirmed order at the ORDER's prices. p_lines: [{ order_line_id, quantity }] in the order line's pack level,
-- or null for everything that is still left to invoice.
create function public.invoice_sales_order(p_order_id uuid, p_lines jsonb default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_o     public.sales_orders;
  v_cust  public.customers;
  v_today date;
  v_inv   uuid;
  v_ol    record;
  v_req   jsonb;
  v_qty   numeric;
  v_left  numeric;
  v_n     integer := 0;
  v_base  numeric;
  v_net   numeric;
  v_tax   numeric;
  v_sub   numeric := 0;
  v_disc  numeric := 0;
  v_taxs  numeric := 0;
  v_given jsonb := '{}'::jsonb;
  v_unit_factor numeric;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_o from public.sales_orders o where o.id = p_order_id and o.organization_id = v_org for update;
  if not found then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('sales.create', v_o.branch_id) then
    raise exception 'insufficient privilege for this branch' using errcode = '42501';
  end if;
  if v_o.status <> 'CONFIRMED' then
    raise exception 'only a confirmed order can be invoiced (this one is %)', v_o.status using errcode = '22023';
  end if;
  select * into v_cust from public.customers c where c.id = v_o.customer_id and c.organization_id = v_org;
  if not v_cust.is_active then
    raise exception 'the customer is inactive' using errcode = '22023';
  end if;
  if p_lines is not null and (jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 200) then
    raise exception 'choose the lines to invoice' using errcode = '22023';
  end if;
  select (now() at time zone o.timezone)::date into v_today from public.organizations o where o.id = v_org;

  -- what was asked for: per order line the quantity (default: everything still left)
  for v_ol in
    select ol.*, ol.quantity - coalesce((select sum(il.quantity) from public.sales_invoice_lines il join public.sales_invoices i on i.id = il.sales_invoice_id and i.status in ('POSTED', 'DRAFT')
                                         where il.sales_order_line_id = ol.id), 0) as remaining
    from public.sales_order_lines ol where ol.sales_order_id = v_o.id order by ol.line_no
  loop
    if p_lines is null then
      v_qty := v_ol.remaining;
    else
      select (x.value ->> 'quantity')::numeric into v_qty from jsonb_array_elements(p_lines) x where (x.value ->> 'order_line_id')::uuid = v_ol.id limit 1;
      if v_qty is null then
        continue;
      end if;
      v_given := v_given || jsonb_build_object(v_ol.id::text, true);
    end if;
    if v_qty <= 0 then
      continue;
    end if;
    if v_qty <> round(v_qty, 3) then
      raise exception 'line %: the quantity can have at most 3 decimals', v_ol.line_no using errcode = '22023';
    end if;
    if v_qty > v_ol.remaining then
      raise exception 'line %: only % can still be invoiced (% ordered, the rest already invoiced or on a draft invoice)', v_ol.line_no, trim_scale(v_ol.remaining), trim_scale(v_ol.quantity)
        using errcode = '22023';
    end if;
    if v_inv is null then
      insert into public.sales_invoices (organization_id, customer_id, branch_id, warehouse_id, invoice_date, payment_terms_days, currency_code, customer_reference, notes, sales_order_id)
      values (v_org, v_cust.id, v_o.branch_id, v_o.warehouse_id, v_today, v_cust.payment_terms_days, v_o.currency_code,
              coalesce(v_o.customer_reference, v_o.order_number), 'Order ' || v_o.order_number, v_o.id)
      returning id into v_inv;
    end if;
    v_n := v_n + 1;
    select u.factor_to_base into v_unit_factor from public.product_units u where u.id = v_ol.product_unit_id;
    v_base := round(v_qty * v_unit_factor, 3);
    v_net := round(v_qty * v_ol.unit_price * (1 - v_ol.discount_percent / 100), 2);
    v_tax := round(v_net * v_ol.tax_rate / 100, 2);
    v_sub := v_sub + v_net;
    v_taxs := v_taxs + v_tax;
    v_disc := v_disc + (round(v_qty * v_ol.unit_price, 2) - v_net);
    insert into public.sales_invoice_lines (organization_id, sales_invoice_id, branch_id, line_no, product_id, product_unit_id, quantity, base_quantity, list_price, unit_price,
                                            discount_percent, tax_code_id, tax_rate, line_net, line_tax, line_total, sales_order_line_id)
    values (v_org, v_inv, v_o.branch_id, v_n, v_ol.product_id, v_ol.product_unit_id, v_qty, v_base, v_ol.list_price, v_ol.unit_price,
            v_ol.discount_percent, v_ol.tax_code_id, v_ol.tax_rate, v_net, v_tax, v_net + v_tax, v_ol.id);
  end loop;
  if p_lines is not null and exists (select 1 from jsonb_array_elements(p_lines) x where not (v_given ? coalesce(x.value ->> 'order_line_id', ''))) then
    raise exception 'a chosen line is not on this order' using errcode = 'P0002';
  end if;
  if v_inv is null then
    raise exception 'there is nothing left on this order to invoice' using errcode = '22023';
  end if;
  update public.sales_invoices set subtotal = v_sub, discount_total = v_disc, tax_total = v_taxs, total_amount = v_sub + v_taxs where id = v_inv;
  return v_inv;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- invoices: raised from an order, reservations respected, order progress followed
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.save_sales_invoice(
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
    if v_inv.sales_order_id is not null then
      raise exception 'this invoice was raised from a sales order and follows it: it can only be posted or cancelled' using errcode = '22023';
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
  v_elig    numeric;
  v_reserved numeric;
  v_taken   jsonb := '{}'::jsonb;
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
    -- stock held for OTHER customers' confirmed orders is not for sale (this invoice's own order, if any, is excluded)
    select coalesce(sum(sb.quantity), 0) into v_elig
    from public.stock_balances sb left join public.batches ba on ba.id = sb.batch_id
    where sb.organization_id = v_org and sb.warehouse_id = v_inv.warehouse_id and sb.product_id = v_line.product_id and sb.stock_status = 'AVAILABLE' and sb.quantity > 0
      and (ba.id is null or ba.expiry_date >= v_today + v_cust.min_shelf_life_days);
    v_reserved := private.reserved_quantity(v_org, v_inv.warehouse_id, v_line.product_id, v_inv.sales_order_id);
    if v_line.base_quantity + coalesce((v_taken ->> v_line.product_id::text)::numeric, 0) > v_elig - v_reserved then
      select * into v_prod from public.products p where p.id = v_line.product_id;
      raise exception 'line %: part of the stock of % is reserved for customer orders - only % can be sold now (% sellable, % reserved)',
        v_line.line_no, v_prod.sku, trim_scale(greatest(0, v_elig - v_reserved - coalesce((v_taken ->> v_line.product_id::text)::numeric, 0))), trim_scale(v_elig), trim_scale(v_reserved) using errcode = '23514';
    end if;
    v_taken := jsonb_set(v_taken, array[v_line.product_id::text], to_jsonb(coalesce((v_taken ->> v_line.product_id::text)::numeric, 0) + v_line.base_quantity));
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

  if v_inv.sales_order_id is not null then
    perform private.refresh_order_status(v_inv.sales_order_id);
  end if;

  return jsonb_build_object('invoice_number', v_number, 'total_amount', v_inv.total_amount, 'stock_document_number', v_stock ->> 'document_number',
                            'receipt_number', v_receipt_numbers ->> 0, 'receipt_numbers', v_receipt_numbers, 'receipt_ids', v_receipt_ids, 'overridden', array_length(v_issues, 1) > 0);
end;
$$;

create or replace function public.reverse_sales_invoice(p_id uuid, p_reason text)
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
  if v_inv.sales_order_id is not null then
    perform private.refresh_order_status(v_inv.sales_order_id);
  end if;
  return jsonb_build_object('invoice_number', v_inv.invoice_number, 'stock_document_number', v_stock ->> 'document_number', 'credit_released', v_released);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- function privileges
-- ---------------------------------------------------------------------------------------------------------
revoke all on function private.compute_doc_lines(uuid, public.customers, public.warehouses, jsonb) from public, anon, authenticated;
revoke all on function private.sales_quotations_lock() from public, anon, authenticated;
revoke all on function private.sales_quotation_lines_lock() from public, anon, authenticated;
revoke all on function private.sales_orders_lock() from public, anon, authenticated;
revoke all on function private.sales_order_lines_lock() from public, anon, authenticated;
revoke all on function private.reserved_quantity(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.refresh_order_status(uuid) from public, anon, authenticated;
revoke all on function private.close_quotation(uuid, text, text) from public, anon, authenticated;
revoke all on function private.end_sales_order(uuid, text, text) from public, anon, authenticated;

revoke all on function public.stock_availability(uuid, uuid) from public, anon;
revoke all on function public.order_progress(uuid) from public, anon;
revoke all on function public.save_quotation(uuid, uuid, uuid, date, text, text, jsonb) from public, anon;
revoke all on function public.send_quotation(uuid) from public, anon;
revoke all on function public.reject_quotation(uuid, text) from public, anon;
revoke all on function public.cancel_quotation(uuid, text) from public, anon;
revoke all on function public.convert_quotation_to_order(uuid) from public, anon;
revoke all on function public.save_sales_order(uuid, uuid, uuid, date, date, text, text, jsonb) from public, anon;
revoke all on function public.confirm_sales_order(uuid) from public, anon;
revoke all on function public.cancel_sales_order(uuid, text) from public, anon;
revoke all on function public.close_sales_order(uuid, text) from public, anon;
revoke all on function public.invoice_sales_order(uuid, jsonb) from public, anon;
grant execute on function public.stock_availability(uuid, uuid) to authenticated;
grant execute on function public.order_progress(uuid) to authenticated;
grant execute on function public.save_quotation(uuid, uuid, uuid, date, text, text, jsonb) to authenticated;
grant execute on function public.send_quotation(uuid) to authenticated;
grant execute on function public.reject_quotation(uuid, text) to authenticated;
grant execute on function public.cancel_quotation(uuid, text) to authenticated;
grant execute on function public.convert_quotation_to_order(uuid) to authenticated;
grant execute on function public.save_sales_order(uuid, uuid, uuid, date, date, text, text, jsonb) to authenticated;
grant execute on function public.confirm_sales_order(uuid) to authenticated;
grant execute on function public.cancel_sales_order(uuid, text) to authenticated;
grant execute on function public.close_sales_order(uuid, text) to authenticated;
grant execute on function public.invoice_sales_order(uuid, jsonb) to authenticated;

commit;
