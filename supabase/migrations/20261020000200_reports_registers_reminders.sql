-- Phase 11 / 02: sales reports with margins, the controlled-drugs register, and payment reminders
--
-- SALES REPORT  revenue by day, month, product, category, customer or branch over a date range, from POSTED invoices (reversed ones are gone)
--               net of POSTED credit notes. Cost comes from what each sale was actually picked from (the batch cost recorded at posting);
--               goods returned in a sellable or quarantined condition give their cost back, damaged returns do not. Cost and margin are shown only to people
--               holding reports.margins for the branches concerned. Lines whose batch had no cost on record are counted ("uncosted") so a margin is never
--               silently overstated.
-- CONTROLLED-DRUGS REGISTER  for each controlled medicine: every movement of stock (receipts, sales, returns, transfers, adjustments, reversals) in date
--               order with the running balance, batch and expiry, who it came from / went to (customer with premises licence, supplier), the document and
--               who posted it. Quality-status changes are left out: they move nothing. Visible per warehouse to people holding registers.controlled there.
-- PAYMENT REMINDERS  which customers have overdue invoices, how late, and what has been sent to them already. Sending happens outside the system (e-mail, SMS,
--               WhatsApp, phone, letter); the reminder is RECORDED here with its text and the invoices it covered, append-only.

-- ---------------------------------------------------------------------------------------------------------
-- sales report
-- ---------------------------------------------------------------------------------------------------------
create function public.sales_report(p_from date, p_to date, p_group text default 'DAY', p_branch_id uuid default null)
returns table (
  group_key text, group_label text, invoices bigint, units numeric, sales numeric, credits numeric, net_sales numeric, tax numeric,
  cost numeric, margin numeric, margin_pct numeric, uncosted_lines bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
begin
  if v_org is null or not private.has_permission_anywhere('reports.sales') then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if p_group is null or p_group not in ('DAY', 'MONTH', 'PRODUCT', 'CATEGORY', 'CUSTOMER', 'BRANCH') then
    raise exception 'group the report by DAY, MONTH, PRODUCT, CATEGORY, CUSTOMER or BRANCH' using errcode = '22023';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'choose a valid date range' using errcode = '22023';
  end if;
  if p_to - p_from > 3660 then
    raise exception 'a report covers at most ten years' using errcode = '22023';
  end if;
  return query
  with facts as (
    select i.id as doc_id, false as is_credit, i.invoice_date as d, i.branch_id, i.customer_id, l.product_id,
           l.line_net as net, l.line_tax as tax, l.base_quantity as units,
           (select coalesce(sum(a.base_quantity * coalesce(a.unit_cost_base, 0)), 0) from public.sales_invoice_allocations a where a.sales_invoice_line_id = l.id) as cost,
           exists (select 1 from public.sales_invoice_allocations a where a.sales_invoice_line_id = l.id and a.unit_cost_base is null) as uncosted
    from public.sales_invoices i
    join public.sales_invoice_lines l on l.sales_invoice_id = i.id
    where i.organization_id = v_org and i.status = 'POSTED' and i.invoice_date between p_from and p_to
      and (p_branch_id is null or i.branch_id = p_branch_id) and private.has_permission('reports.sales', i.branch_id)
    union all
    select n.id, true, n.credit_date, i.branch_id, n.customer_id, cl.product_id,
           cl.line_net, cl.line_tax, coalesce(cl.base_quantity, 0),
           coalesce((select sum(r.base_quantity * coalesce(a.unit_cost_base, 0))
                       from public.sales_credit_note_returns r join public.sales_invoice_allocations a on a.id = r.invoice_allocation_id
                      where r.credit_note_line_id = cl.id and r.return_condition <> 'DAMAGED'), 0),
           false
    from public.sales_credit_notes n
    join public.sales_credit_note_lines cl on cl.credit_note_id = n.id
    join public.sales_invoices i on i.id = n.sales_invoice_id
    where n.organization_id = v_org and n.status = 'POSTED' and n.credit_date between p_from and p_to
      and (p_branch_id is null or i.branch_id = p_branch_id) and private.has_permission('reports.sales', i.branch_id)
  ),
  keyed as (
    select f.*,
           private.has_permission('reports.margins', f.branch_id) as can_cost,
           case p_group when 'DAY' then f.d::text when 'MONTH' then to_char(f.d, 'YYYY-MM') when 'PRODUCT' then f.product_id::text
                        when 'CATEGORY' then coalesce(p.category_id::text, '-') when 'CUSTOMER' then f.customer_id::text else f.branch_id::text end as k,
           case p_group when 'DAY' then to_char(f.d, 'DD Mon YYYY') when 'MONTH' then to_char(f.d, 'Mon YYYY') when 'PRODUCT' then p.sku || ' ' || p.brand_name
                        when 'CATEGORY' then coalesce(pc.name, 'Uncategorised') when 'CUSTOMER' then c.name else b.name end as lbl
    from facts f
    join public.products p on p.id = f.product_id
    left join public.product_categories pc on pc.id = p.category_id
    join public.customers c on c.id = f.customer_id
    join public.branches b on b.id = f.branch_id
  )
  select k.k, max(k.lbl),
         count(distinct k.doc_id) filter (where not k.is_credit),
         coalesce(sum(k.units) filter (where not k.is_credit), 0) - coalesce(sum(k.units) filter (where k.is_credit), 0),
         coalesce(sum(k.net) filter (where not k.is_credit), 0),
         coalesce(sum(k.net) filter (where k.is_credit), 0),
         coalesce(sum(k.net) filter (where not k.is_credit), 0) - coalesce(sum(k.net) filter (where k.is_credit), 0),
         coalesce(sum(k.tax) filter (where not k.is_credit), 0) - coalesce(sum(k.tax) filter (where k.is_credit), 0),
         case when bool_and(k.can_cost) then coalesce(sum(k.cost) filter (where not k.is_credit), 0) - coalesce(sum(k.cost) filter (where k.is_credit), 0) end,
         case when bool_and(k.can_cost) then coalesce(sum(k.net) filter (where not k.is_credit), 0) - coalesce(sum(k.net) filter (where k.is_credit), 0)
                                             - (coalesce(sum(k.cost) filter (where not k.is_credit), 0) - coalesce(sum(k.cost) filter (where k.is_credit), 0)) end,
         case when bool_and(k.can_cost) and (coalesce(sum(k.net) filter (where not k.is_credit), 0) - coalesce(sum(k.net) filter (where k.is_credit), 0)) > 0
              then round(((coalesce(sum(k.net) filter (where not k.is_credit), 0) - coalesce(sum(k.net) filter (where k.is_credit), 0))
                          - (coalesce(sum(k.cost) filter (where not k.is_credit), 0) - coalesce(sum(k.cost) filter (where k.is_credit), 0)))
                         / (coalesce(sum(k.net) filter (where not k.is_credit), 0) - coalesce(sum(k.net) filter (where k.is_credit), 0)) * 100, 2) end,
         case when bool_and(k.can_cost) then count(*) filter (where k.uncosted) end
  from keyed k
  group by k.k
  order by case when p_group in ('DAY', 'MONTH') then k.k end,
           coalesce(sum(k.net) filter (where not k.is_credit), 0) - coalesce(sum(k.net) filter (where k.is_credit), 0) desc, max(k.lbl);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- controlled-drugs register
-- ---------------------------------------------------------------------------------------------------------
-- one line per controlled medicine: opening stock, what came in, what went out, adjustments, closing stock (base units, all stock statuses)
create function public.controlled_drug_summary(p_from date, p_to date, p_warehouse_id uuid default null)
returns table (product_id uuid, sku text, product_name text, opening numeric, received numeric, issued numeric, adjusted numeric, closing numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
begin
  if v_org is null or not private.has_permission_anywhere('registers.controlled') then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'choose a valid date range' using errcode = '22023';
  end if;
  return query
  select p.id, p.sku, p.brand_name,
         coalesce(sum(m.quantity) filter (where m.posted_at < p_from::timestamptz), 0),
         coalesce(sum(m.quantity) filter (where m.posted_at >= p_from::timestamptz and m.posted_at < (p_to + 1)::timestamptz and m.quantity > 0 and m.movement_type <> 'ADJUSTMENT_IN'), 0),
         coalesce(-sum(m.quantity) filter (where m.posted_at >= p_from::timestamptz and m.posted_at < (p_to + 1)::timestamptz and m.quantity < 0 and m.movement_type <> 'ADJUSTMENT_OUT'), 0),
         coalesce(sum(m.quantity) filter (where m.posted_at >= p_from::timestamptz and m.posted_at < (p_to + 1)::timestamptz and m.movement_type in ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT')), 0),
         coalesce(sum(m.quantity) filter (where m.posted_at < (p_to + 1)::timestamptz), 0)
  from public.products p
  left join (
    select mv.* from public.stock_movements mv
    join public.warehouses w on w.id = mv.warehouse_id
    where mv.organization_id = v_org and mv.movement_type not in ('STATUS_OUT', 'STATUS_IN')
      and (p_warehouse_id is null or mv.warehouse_id = p_warehouse_id) and private.has_permission('registers.controlled', w.branch_id)
  ) m on m.product_id = p.id
  where p.organization_id = v_org and p.product_class = 'CONTROLLED'
  group by p.id, p.sku, p.brand_name
  order by p.sku;
end;
$$;

-- the register of ONE controlled medicine: an opening line, then every movement in date order with the running balance
create function public.controlled_drug_register(p_product_id uuid, p_from date, p_to date, p_warehouse_id uuid default null)
returns table (
  line_no bigint, is_opening boolean, posted_at timestamptz, document_number text, document_type text, movement_type text, warehouse_name text,
  batch_number text, expiry_date date, stock_status text, quantity numeric, balance numeric, counterparty text, licence_number text, reference text, posted_by_name text, notes text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.current_organization_id();
  v_prod    public.products;
  v_opening numeric;
begin
  if v_org is null or not private.has_permission_anywhere('registers.controlled') then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'choose a valid date range' using errcode = '22023';
  end if;
  select * into v_prod from public.products p where p.id = p_product_id and p.organization_id = v_org;
  if not found then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  if v_prod.product_class <> 'CONTROLLED' then
    raise exception '% is not a controlled medicine', v_prod.sku using errcode = '22023';
  end if;
  select coalesce(sum(mv.quantity), 0) into v_opening
  from public.stock_movements mv join public.warehouses w on w.id = mv.warehouse_id
  where mv.organization_id = v_org and mv.product_id = p_product_id and mv.movement_type not in ('STATUS_OUT', 'STATUS_IN')
    and mv.posted_at < p_from::timestamptz and (p_warehouse_id is null or mv.warehouse_id = p_warehouse_id) and private.has_permission('registers.controlled', w.branch_id);
  return query
  with moves as (
    select mv.seq, mv.posted_at, d.document_number, d.document_type, mv.movement_type, w.name as wname, ba.batch_number, ba.expiry_date, mv.stock_status, mv.quantity,
           d.source_type, d.source_id, d.notes, d.posted_by
    from public.stock_movements mv
    join public.stock_documents d on d.id = mv.document_id
    join public.warehouses w on w.id = mv.warehouse_id
    left join public.batches ba on ba.id = mv.batch_id
    where mv.organization_id = v_org and mv.product_id = p_product_id and mv.movement_type not in ('STATUS_OUT', 'STATUS_IN')
      and mv.posted_at >= p_from::timestamptz and mv.posted_at < (p_to + 1)::timestamptz
      and (p_warehouse_id is null or mv.warehouse_id = p_warehouse_id) and private.has_permission('registers.controlled', w.branch_id)
  ), described as (
    select m.*,
           coalesce(ci.name, cn_c.name, s.name, sr_s.name) as party,
           coalesce(ci.licence_number, cn_c.licence_number) as licence,
           coalesce(si.invoice_number, cn.credit_note_number, po.po_number, sr.return_number) as ref
    from moves m
    left join public.sales_invoices si on m.source_type = 'SALES_INVOICE' and si.id = m.source_id
    left join public.customers ci on ci.id = si.customer_id
    left join public.sales_credit_notes cn on m.source_type = 'CREDIT_NOTE' and cn.id = m.source_id
    left join public.customers cn_c on cn_c.id = cn.customer_id
    left join public.purchase_orders po on m.source_type = 'PURCHASE_ORDER' and po.id = m.source_id
    left join public.suppliers s on s.id = po.supplier_id
    left join public.purchase_returns sr on m.source_type = 'PURCHASE_RETURN' and sr.id = m.source_id
    left join public.suppliers sr_s on sr_s.id = sr.supplier_id
  )
  select 0::bigint, true, p_from::timestamptz, null::text, null::text, 'OPENING_BALANCE'::text, null::text, null::text, null::date, null::text, null::numeric, v_opening,
         null::text, null::text, null::text, null::text, 'Balance brought forward'::text
  union all
  select row_number() over (order by x.posted_at, x.seq), false, x.posted_at, x.document_number, x.document_type, x.movement_type, x.wname, x.batch_number, x.expiry_date, x.stock_status,
         x.quantity, v_opening + sum(x.quantity) over (order by x.posted_at, x.seq), x.party, x.licence, x.ref,
         (select coalesce(pr.display_name, btrim(coalesce(pr.first_name, '') || ' ' || coalesce(pr.last_name, ''))) from public.profiles pr where pr.id = x.posted_by), x.notes
  from described x
  order by 1;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- payment reminders
-- ---------------------------------------------------------------------------------------------------------
create table public.payment_reminders (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict default private.current_organization_id(),
  customer_id     uuid not null,
  level           smallint not null check (level between 1 and 3),                      -- 1 friendly, 2 firm, 3 final
  channel         text not null check (channel in ('EMAIL', 'SMS', 'WHATSAPP', 'PHONE', 'LETTER')),
  message         text not null check (btrim(message) <> '' and length(message) <= 4000),
  invoice_ids     uuid[] not null check (cardinality(invoice_ids) between 1 and 200),
  overdue_amount  numeric(18, 2) not null check (overdue_amount > 0),
  sent_by         uuid default auth.uid(),
  sent_at         timestamptz not null default clock_timestamp(),
  constraint payment_reminders_customer_fk foreign key (customer_id, organization_id) references public.customers (id, organization_id) on delete restrict
);
create index payment_reminders_customer_idx on public.payment_reminders (customer_id, sent_at desc);
create index payment_reminders_org_idx on public.payment_reminders (organization_id, sent_at desc);
create trigger payment_reminders_append_only before update or delete on public.payment_reminders
  for each row execute function private.stock_block_mutation();
create trigger payment_reminders_audit after insert on public.payment_reminders
  for each row execute function private.audit_row_change('payment_reminder');

alter table public.payment_reminders enable row level security;
revoke all on public.payment_reminders from public, anon, authenticated;
grant select on public.payment_reminders to authenticated;
create policy payment_reminders_select on public.payment_reminders for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission_anywhere('reminders.view'));

-- customers with overdue posted invoices (balance still due, due date before today), as far as the caller can see invoices
create function public.overdue_customers(p_min_days integer default 1)
returns table (
  customer_id uuid, customer_name text, phone text, email text, contact_name text, overdue_amount numeric, invoices integer, oldest_days integer,
  on_hold boolean, last_reminder_at timestamptz, last_level smallint, suggested_level smallint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.id, c.name, c.phone, c.email, c.contact_name, o.amount, o.n, o.oldest, c.on_hold, r.sent_at, r.level,
         case when r.sent_at is null then 1::smallint when r.sent_at < now() - interval '7 days' then least(3, r.level + 1)::smallint end
  from (
    select i.customer_id, sum(i.balance_due) as amount, count(*)::int as n, max(current_date - i.due_date)::int as oldest
    from public.sales_invoices i
    where i.status = 'POSTED' and i.balance_due > 0 and current_date - i.due_date >= greatest(1, coalesce(p_min_days, 1))
    group by i.customer_id
  ) o
  join public.customers c on c.id = o.customer_id
  left join lateral (select pr.sent_at, pr.level from public.payment_reminders pr where pr.customer_id = c.id order by pr.sent_at desc limit 1) r on true
  where not c.is_walk_in
  order by o.oldest desc, o.amount desc
$$;

-- records that a reminder was sent: the invoices must be this customer's overdue invoices
create function public.record_payment_reminder(p_customer_id uuid, p_level integer, p_channel text, p_message text, p_invoice_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org    uuid := private.current_organization_id();
  v_amount numeric;
  v_found  integer;
  v_id     uuid;
begin
  if v_org is null or not private.has_permission_anywhere('reminders.send') then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if not exists (select 1 from public.customers c where c.id = p_customer_id and c.organization_id = v_org) then
    raise exception 'customer not found' using errcode = 'P0002';
  end if;
  if p_level is null or p_level not between 1 and 3 then
    raise exception 'the reminder level is 1 (friendly), 2 (firm) or 3 (final)' using errcode = '22023';
  end if;
  if p_channel is null or upper(p_channel) not in ('EMAIL', 'SMS', 'WHATSAPP', 'PHONE', 'LETTER') then
    raise exception 'say how the reminder was sent (e-mail, SMS, WhatsApp, phone or letter)' using errcode = '22023';
  end if;
  if p_message is null or btrim(p_message) = '' or length(p_message) > 4000 then
    raise exception 'record what was said (up to 4000 characters)' using errcode = '22023';
  end if;
  if p_invoice_ids is null or cardinality(p_invoice_ids) = 0 or cardinality(p_invoice_ids) > 200 then
    raise exception 'choose the overdue invoices the reminder covers' using errcode = '22023';
  end if;
  select count(*), coalesce(sum(i.balance_due), 0) into v_found, v_amount
  from public.sales_invoices i
  where i.id = any (p_invoice_ids) and i.organization_id = v_org and i.customer_id = p_customer_id and i.status = 'POSTED' and i.balance_due > 0 and i.due_date < current_date
    and private.has_permission('sales.view', i.branch_id);
  if v_found <> cardinality(array (select distinct x from unnest(p_invoice_ids) x)) then
    raise exception 'every invoice must be an overdue, unpaid invoice of this customer that you can see' using errcode = '22023';
  end if;
  insert into public.payment_reminders (organization_id, customer_id, level, channel, message, invoice_ids, overdue_amount)
  values (v_org, p_customer_id, p_level, upper(p_channel), btrim(p_message), array (select distinct x from unnest(p_invoice_ids) x), v_amount)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- function privileges
-- ---------------------------------------------------------------------------------------------------------
revoke all on function public.sales_report(date, date, text, uuid) from public, anon;
revoke all on function public.controlled_drug_summary(date, date, uuid) from public, anon;
revoke all on function public.controlled_drug_register(uuid, date, date, uuid) from public, anon;
revoke all on function public.overdue_customers(integer) from public, anon;
revoke all on function public.record_payment_reminder(uuid, integer, text, text, uuid[]) from public, anon;
grant execute on function public.sales_report(date, date, text, uuid) to authenticated;
grant execute on function public.controlled_drug_summary(date, date, uuid) to authenticated;
grant execute on function public.controlled_drug_register(uuid, date, date, uuid) to authenticated;
grant execute on function public.overdue_customers(integer) to authenticated;
grant execute on function public.record_payment_reminder(uuid, integer, text, text, uuid[]) to authenticated;
