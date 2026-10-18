-- Apply Phase 16 (cutover tools: customer import, opening receivables and payables) to the hosted database in ONE atomic paste: the migration, verbatim, inside a single transaction.
-- Run it once in the Supabase SQL editor. If anything fails, nothing is changed.
begin;

-- ===== migration 20261025000100_cutover_opening_balances =====
-- Phase 16 / 01: cutover tools: import customers, import opening receivables and payables
--
-- Moving from the old system means carrying over who owes you (customers' unpaid invoices) and whom you owe (suppliers' unpaid invoices), not only products and stock.
-- OPENING INVOICES are real, posted documents with an amount, dates and a reference to the old system's invoice, but NO stock movement and NO lines: stock is loaded
-- by the opening-stock import, and the revenue and cost were recorded in the old system. They appear in receivables, statements, reminders, credit control, payments
-- and the payables list like any other invoice (customers pay them, you pay them), and are left out of sales and VAT reports. In the ledger they are carried by the
-- opening balances (Start accounting), so they are never journalled themselves.
-- Rules: importing is a one-time act per file (a reference already imported is refused, never doubled); opening invoices cannot be reversed, credited, delivered or
-- have anything done to them that needs stock; a wrong one is removed with remove_opening_balance, and only while accounting has not started (afterwards the
-- accountant corrects the opening balance, because the ledger already carries it).

insert into public.permissions (code, module, action, description) values
  ('opening.balances', 'opening', 'balances', 'Import and remove opening receivables and payables')
on conflict (code) do update set description = excluded.description;
with matrix(role_code, code) as (values
  ('SUPER_ADMIN', 'opening.balances'), ('OWNER', 'opening.balances'), ('GENERAL_MANAGER', 'opening.balances'), ('ACCOUNTS_MANAGER', 'opening.balances')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------------
-- schema: the flag, and the two constraints it relaxes
-- ---------------------------------------------------------------------------------------------------------
alter table public.sales_invoices add column is_opening boolean not null default false;
alter table public.sales_invoices drop constraint sales_invoices_posted_complete;
alter table public.sales_invoices add constraint sales_invoices_posted_complete check (
  (((status = any (array['POSTED', 'REVERSED'])) = ((invoice_number is not null) and (posted_at is not null) and (due_date is not null) and (stock_document_id is not null or is_opening)))
   and ((status = 'REVERSED') = ((reversed_at is not null) and (reversal_reason is not null) and (reversal_document_id is not null or is_opening))))
  and (not is_opening or (stock_document_id is null and reversal_document_id is null)));

alter table public.supplier_invoices add column is_opening boolean not null default false;
alter table public.supplier_invoices alter column purchase_order_id drop not null;
alter table public.supplier_invoices add constraint supplier_invoices_order_or_opening check (purchase_order_id is not null or is_opening);

-- ---------------------------------------------------------------------------------------------------------
-- import customers (same shape as import_suppliers)
-- ---------------------------------------------------------------------------------------------------------
create function public.import_customers(p_rows jsonb, p_dry_run boolean default true)
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
  v_code    text;
  v_status  text;
  v_msg     text;
  v_type    text;
  v_constraint text;
  v_created integer := 0;
  v_exists  integer := 0;
  v_errors  integer := 0;
begin
  if v_org is null or not private.has_permission('customers.create') then
    raise exception 'insufficient privilege to import customers' using errcode = '42501';
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
        raise exception 'the customer code is missing or not valid (letters, numbers, - and _ only, up to 32)';
      end if;
      if v_code = any (v_seen) then
        raise exception 'the same customer code appears more than once in this file';
      end if;
      v_seen := v_seen || v_code;

      if exists (select 1 from public.customers c where c.organization_id = v_org and c.code = v_code) then
        v_status := 'EXISTS';
        v_msg := 'already on file - left unchanged';
      else
        if btrim(coalesce(v_row ->> 'name', '')) = '' then
          raise exception 'the customer name is missing';
        end if;
        v_type := upper(btrim(coalesce(nullif(v_row ->> 'customer_type', ''), 'PHARMACY')));
        if v_type not in ('PHARMACY', 'HOSPITAL', 'CLINIC', 'WHOLESALER', 'RETAILER', 'OTHER') then
          raise exception 'unknown customer type "%" (use PHARMACY, HOSPITAL, CLINIC, WHOLESALER, RETAILER or OTHER)', v_type;
        end if;
        insert into public.customers (
          organization_id, code, name, customer_type, licence_number, licence_expiry, registered_pharmacist, controlled_drugs_authorised, tax_number,
          contact_name, phone, email, address, city, region, country, payment_terms_days, credit_limit, min_shelf_life_days, notes)
        values (
          v_org, v_code, btrim(v_row ->> 'name'), v_type,
          nullif(btrim(coalesce(v_row ->> 'licence_number', '')), ''), nullif(btrim(coalesce(v_row ->> 'licence_expiry', '')), '')::date,
          nullif(btrim(coalesce(v_row ->> 'registered_pharmacist', '')), ''), private.parse_bool(v_row ->> 'controlled_drugs_authorised', false),
          nullif(btrim(coalesce(v_row ->> 'tax_number', '')), ''), nullif(btrim(coalesce(v_row ->> 'contact_name', '')), ''),
          nullif(btrim(coalesce(v_row ->> 'phone', '')), ''), nullif(btrim(coalesce(v_row ->> 'email', '')), ''),
          nullif(btrim(coalesce(v_row ->> 'address', '')), ''), nullif(btrim(coalesce(v_row ->> 'city', '')), ''),
          nullif(btrim(coalesce(v_row ->> 'region', '')), ''), nullif(upper(btrim(coalesce(v_row ->> 'country', ''))), ''),
          coalesce(nullif(btrim(coalesce(v_row ->> 'payment_terms_days', '')), '')::integer, 0),
          coalesce(nullif(btrim(coalesce(v_row ->> 'credit_limit', '')), '')::numeric, 0),
          coalesce(nullif(btrim(coalesce(v_row ->> 'min_shelf_life_days', '')), '')::integer, 0),
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
    perform private.write_audit(v_org, 'customer.imported', 'customer_import', null, null, null,
      jsonb_build_object('rows', v_n, 'created', v_created, 'existing', v_exists, 'errors', v_errors), null, null);
  end if;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- import opening receivables: one row per customer invoice still unpaid at cutover
--   customer_code, reference (the old invoice number), invoice_date, due_date (optional), amount (what is still owed, tax included), branch (code, optional), notes
-- ---------------------------------------------------------------------------------------------------------
create function public.import_opening_receivables(p_rows jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org      uuid := private.current_organization_id();
  v_currency text;
  v_out      jsonb := '[]'::jsonb;
  v_row      jsonb;
  v_n        integer := 0;
  v_seen     text[] := '{}';
  v_key      text;
  v_ref      text;
  v_status   text;
  v_msg      text;
  v_constraint text;
  v_cust     public.customers;
  v_branch   uuid;
  v_wh       uuid;
  v_amount   numeric;
  v_date     date;
  v_due      date;
  v_created  integer := 0;
  v_errors   integer := 0;
  v_total    numeric := 0;
begin
  if v_org is null or not private.has_permission('opening.balances') then
    raise exception 'insufficient privilege to import opening balances' using errcode = '42501';
  end if;
  if exists (select 1 from public.accounting_settings where organization_id = v_org) then
    raise exception 'accounting has started: the opening balances were fixed at go-live and can no longer be imported' using errcode = '55000';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'no rows to import' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'import at most 500 rows at a time' using errcode = '22023';
  end if;
  select currency_code into v_currency from public.organizations where id = v_org;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1;
    v_status := null; v_msg := null;
    v_ref := upper(btrim(coalesce(v_row ->> 'reference', '')));
    v_key := upper(btrim(coalesce(v_row ->> 'customer_code', ''))) || ' / ' || v_ref;
    begin
      if jsonb_typeof(v_row) <> 'object' then
        raise exception 'this row is not valid';
      end if;
      if v_ref !~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$' then
        raise exception 'the invoice reference is missing or not valid (letters, numbers, . _ / - only, up to 40)';
      end if;
      if v_key = any (v_seen) then
        raise exception 'the same customer and invoice reference appear more than once in this file';
      end if;
      v_seen := v_seen || v_key;
      select * into v_cust from public.customers c where c.organization_id = v_org and c.code = upper(btrim(coalesce(v_row ->> 'customer_code', ''))) and not c.is_walk_in;
      if not found then
        raise exception 'customer "%" is not on file: import the customers first', upper(btrim(coalesce(v_row ->> 'customer_code', '')));
      end if;
      v_amount := nullif(btrim(coalesce(v_row ->> 'amount', '')), '')::numeric;
      if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
        raise exception 'the amount must be above 0 with at most 2 decimals (what is still owed, tax included)';
      end if;
      v_date := nullif(btrim(coalesce(v_row ->> 'invoice_date', '')), '')::date;
      if v_date is null or v_date > current_date or v_date < current_date - 3650 then
        raise exception 'the invoice date is missing or not a sensible past date';
      end if;
      v_due := coalesce(nullif(btrim(coalesce(v_row ->> 'due_date', '')), '')::date, v_date + v_cust.payment_terms_days);
      if v_due < v_date then
        raise exception 'the due date is before the invoice date';
      end if;
      if nullif(btrim(coalesce(v_row ->> 'branch', '')), '') is null then
        select b.id into v_branch from public.branches b where b.organization_id = v_org and b.is_head_office limit 1;
      else
        select b.id into v_branch from public.branches b where b.organization_id = v_org and upper(b.code) = upper(btrim(v_row ->> 'branch'));
        if v_branch is null then
          raise exception 'branch "%" is not on file', btrim(v_row ->> 'branch');
        end if;
      end if;
      select w.id into v_wh from public.warehouses w where w.organization_id = v_org and w.branch_id = v_branch and w.is_active order by w.created_at limit 1;
      if v_wh is null then
        raise exception 'that branch has no active warehouse yet';
      end if;
      if exists (select 1 from public.sales_invoices i where i.organization_id = v_org and i.invoice_number = 'OB-' || v_ref) then
        raise exception 'an opening invoice with this reference was already imported';
      end if;

      insert into public.sales_invoices (
        organization_id, invoice_number, customer_id, branch_id, warehouse_id, status, invoice_date, due_date, payment_terms_days, currency_code, customer_reference, notes,
        subtotal, discount_total, tax_total, total_amount, amount_paid, posted_by, posted_at, is_opening)
      values (
        v_org, 'OB-' || v_ref, v_cust.id, v_branch, v_wh, 'POSTED', v_date, v_due, least(greatest(v_due - v_date, 0), 365), v_currency, left('Opening balance, ' || v_ref, 80),
        left(nullif(btrim(coalesce(v_row ->> 'notes', '')), ''), 1000), v_amount, 0, 0, v_amount, 0, auth.uid(), now(), true);
      v_status := case when p_dry_run then 'VALID' else 'CREATED' end;
      v_total := v_total + v_amount;
      if p_dry_run then
        raise exception using errcode = 'DRYRN', message = 'dry run';
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
    elsif v_status = 'ERROR' then v_errors := v_errors + 1;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('row', v_n, 'key', v_key, 'status', v_status, 'message', v_msg));
  end loop;

  if not p_dry_run then
    perform private.write_audit(v_org, 'opening_receivables.imported', 'opening_balance_import', null, null, null,
      jsonb_build_object('rows', v_n, 'created', v_created, 'errors', v_errors, 'total', v_total), null, null);
  end if;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- import opening payables: one row per supplier invoice still unpaid at cutover
--   supplier_code, reference (the supplier's invoice number), invoice_date, due_date (optional), amount (what is still owed, tax included), branch (code, optional), notes
-- ---------------------------------------------------------------------------------------------------------
create function public.import_opening_payables(p_rows jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org      uuid := private.current_organization_id();
  v_out      jsonb := '[]'::jsonb;
  v_row      jsonb;
  v_n        integer := 0;
  v_seen     text[] := '{}';
  v_key      text;
  v_ref      text;
  v_status   text;
  v_msg      text;
  v_constraint text;
  v_sup      public.suppliers;
  v_branch   uuid;
  v_amount   numeric;
  v_date     date;
  v_due      date;
  v_created  integer := 0;
  v_errors   integer := 0;
  v_total    numeric := 0;
begin
  if v_org is null or not private.has_permission('opening.balances') then
    raise exception 'insufficient privilege to import opening balances' using errcode = '42501';
  end if;
  if exists (select 1 from public.accounting_settings where organization_id = v_org) then
    raise exception 'accounting has started: the opening balances were fixed at go-live and can no longer be imported' using errcode = '55000';
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
    v_ref := upper(btrim(coalesce(v_row ->> 'reference', '')));
    v_key := upper(btrim(coalesce(v_row ->> 'supplier_code', ''))) || ' / ' || v_ref;
    begin
      if jsonb_typeof(v_row) <> 'object' then
        raise exception 'this row is not valid';
      end if;
      if v_ref !~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$' then
        raise exception 'the invoice reference is missing or not valid (letters, numbers, . _ / - only, up to 40)';
      end if;
      if v_key = any (v_seen) then
        raise exception 'the same supplier and invoice reference appear more than once in this file';
      end if;
      v_seen := v_seen || v_key;
      select * into v_sup from public.suppliers s where s.organization_id = v_org and s.code = upper(btrim(coalesce(v_row ->> 'supplier_code', '')));
      if not found then
        raise exception 'supplier "%" is not on file: import the suppliers first', upper(btrim(coalesce(v_row ->> 'supplier_code', '')));
      end if;
      v_amount := nullif(btrim(coalesce(v_row ->> 'amount', '')), '')::numeric;
      if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
        raise exception 'the amount must be above 0 with at most 2 decimals (what is still owed, tax included)';
      end if;
      v_date := nullif(btrim(coalesce(v_row ->> 'invoice_date', '')), '')::date;
      if v_date is null or v_date > current_date or v_date < current_date - 3650 then
        raise exception 'the invoice date is missing or not a sensible past date';
      end if;
      v_due := coalesce(nullif(btrim(coalesce(v_row ->> 'due_date', '')), '')::date, v_date + v_sup.payment_terms_days);
      if v_due < v_date then
        raise exception 'the due date is before the invoice date';
      end if;
      if nullif(btrim(coalesce(v_row ->> 'branch', '')), '') is null then
        select b.id into v_branch from public.branches b where b.organization_id = v_org and b.is_head_office limit 1;
      else
        select b.id into v_branch from public.branches b where b.organization_id = v_org and upper(b.code) = upper(btrim(v_row ->> 'branch'));
        if v_branch is null then
          raise exception 'branch "%" is not on file', btrim(v_row ->> 'branch');
        end if;
      end if;
      if exists (select 1 from public.supplier_invoices i where i.organization_id = v_org and i.supplier_id = v_sup.id and upper(i.supplier_invoice_number) = v_ref) then
        raise exception 'an invoice from this supplier with this reference is already on file';
      end if;

      insert into public.supplier_invoices (
        organization_id, invoice_number, supplier_invoice_number, supplier_id, purchase_order_id, branch_id, invoice_date, due_date, currency_code,
        subtotal, tax_amount, total_amount, status, notes, created_by, approved_by, approved_at, is_opening)
      values (
        v_org, private.generate_document_number(v_org, null, 'SUPPLIER_INVOICE', 'SIN'), v_ref, v_sup.id, null, v_branch, v_date, v_due,
        coalesce(v_sup.currency_code, (select o.currency_code from public.organizations o where o.id = v_org)),
        v_amount, 0, v_amount, 'APPROVED', left('Opening balance. ' || coalesce(nullif(btrim(coalesce(v_row ->> 'notes', '')), ''), ''), 1000), auth.uid(), auth.uid(), now(), true);
      v_status := case when p_dry_run then 'VALID' else 'CREATED' end;
      v_total := v_total + v_amount;
      if p_dry_run then
        raise exception using errcode = 'DRYRN', message = 'dry run';
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
    elsif v_status = 'ERROR' then v_errors := v_errors + 1;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('row', v_n, 'key', v_key, 'status', v_status, 'message', v_msg));
  end loop;

  if not p_dry_run then
    perform private.write_audit(v_org, 'opening_payables.imported', 'opening_balance_import', null, null, null,
      jsonb_build_object('rows', v_n, 'created', v_created, 'errors', v_errors, 'total', v_total), null, null);
  end if;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- removing a wrong opening invoice (before accounting starts, and only if nothing was paid against it)
-- ---------------------------------------------------------------------------------------------------------
create function public.remove_opening_balance(p_kind text, p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_inv public.sales_invoices;
  v_si  public.supplier_invoices;
begin
  if v_org is null or not private.has_permission('opening.balances') then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 or length(p_reason) > 500 then
    raise exception 'give a reason (5 to 500 characters)' using errcode = '22023';
  end if;
  if exists (select 1 from public.accounting_settings where organization_id = v_org) then
    raise exception 'accounting has started, so the ledger already carries this balance: ask your accountant to correct the opening balance' using errcode = '55000';
  end if;
  if p_kind = 'RECEIVABLE' then
    select * into v_inv from public.sales_invoices where id = p_id and organization_id = v_org and is_opening for update;
    if not found then raise exception 'opening invoice not found' using errcode = 'P0002'; end if;
    if v_inv.status <> 'POSTED' then raise exception 'this opening invoice is already %', lower(v_inv.status) using errcode = '22023'; end if;
    if v_inv.amount_paid > 0 or v_inv.amount_credited > 0 then
      raise exception 'payments have been applied to this invoice: void them first' using errcode = '22023';
    end if;
    update public.sales_invoices set status = 'REVERSED', reversed_at = now(), reversed_by = auth.uid(), reversal_reason = btrim(p_reason) where id = v_inv.id;
  elsif p_kind = 'PAYABLE' then
    select * into v_si from public.supplier_invoices where id = p_id and organization_id = v_org and is_opening for update;
    if not found then raise exception 'opening invoice not found' using errcode = 'P0002'; end if;
    if v_si.status <> 'APPROVED' then raise exception 'this opening invoice is already %', lower(v_si.status) using errcode = '22023'; end if;
    update public.supplier_invoices set status = 'CANCELLED', status_reason = btrim(p_reason) where id = v_si.id;
  else
    raise exception 'kind must be RECEIVABLE or PAYABLE' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- everything that needs stock refuses an opening invoice; the ledger skips them (the opening balances carry them)
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  def text;
  fixed text;
begin
  def := pg_get_functiondef('public.reverse_sales_invoice(uuid, text)'::regprocedure);
  fixed := replace(def, E'    raise exception ''only a posted invoice can be reversed (this one is %)'', v_inv.status using errcode = ''22023'';\n  end if;\n',
    E'    raise exception ''only a posted invoice can be reversed (this one is %)'', v_inv.status using errcode = ''22023'';\n  end if;\n  if v_inv.is_opening then\n    raise exception ''this is an opening balance carried over from the old system: it has no stock to bring back. Remove it before accounting starts, or ask your accountant'' using errcode = ''22023'';\n  end if;\n');
  if fixed = def then raise exception 'reverse_sales_invoice not as expected'; end if;
  execute fixed;

  def := pg_get_functiondef('public.prepare_delivery_note(uuid, text, text, text, integer, text)'::regprocedure);
  fixed := replace(def, E'    raise exception ''only a posted invoice can be delivered (this one is %)'', v_inv.status using errcode = ''22023'';\n  end if;\n',
    E'    raise exception ''only a posted invoice can be delivered (this one is %)'', v_inv.status using errcode = ''22023'';\n  end if;\n  if v_inv.is_opening then\n    raise exception ''this is an opening balance carried over from the old system: there are no goods to deliver'' using errcode = ''22023'';\n  end if;\n');
  if fixed = def then raise exception 'prepare_delivery_note not as expected'; end if;
  execute fixed;

  def := pg_get_functiondef('private.gl_capture()'::regprocedure);
  fixed := replace(def, E'  if v_kind = ''SALES_INVOICE'' then\n', E'  if coalesce((to_jsonb(new) ->> ''is_opening'')::boolean, false) and (to_jsonb(new) ->> ''status'') is distinct from ''PAID'' then\n    return null;                         -- opening invoices are carried by the opening balances\n  end if;\n\n  if v_kind = ''SALES_INVOICE'' then\n');
  if fixed = def then raise exception 'gl_capture not as expected'; end if;
  execute fixed;
end $$;

revoke all on function public.import_customers(jsonb, boolean) from public, anon;
revoke all on function public.import_opening_receivables(jsonb, boolean) from public, anon;
revoke all on function public.import_opening_payables(jsonb, boolean) from public, anon;
revoke all on function public.remove_opening_balance(text, uuid, text) from public, anon;
grant execute on function public.import_customers(jsonb, boolean) to authenticated;
grant execute on function public.import_opening_receivables(jsonb, boolean) to authenticated;
grant execute on function public.import_opening_payables(jsonb, boolean) to authenticated;
grant execute on function public.remove_opening_balance(text, uuid, text) to authenticated;

commit;
