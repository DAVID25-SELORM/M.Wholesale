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
