alter table public.product_units add constraint product_units_id_org_unique unique(id,organization_id);
create table public.price_agreements (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 customer_id uuid not null, product_unit_id uuid not null, unit_price numeric(18,4) not null check(unit_price>=0 and unit_price<1000000000000),
 valid_from date not null, valid_until date not null, reason text not null check(length(btrim(reason)) between 3 and 500),
 is_active boolean not null default true, created_at timestamptz not null default now(), created_by uuid not null default auth.uid(),
 check(valid_until>=valid_from), unique(id,organization_id),
 foreign key(customer_id,organization_id) references public.customers(id,organization_id),
 foreign key(product_unit_id,organization_id) references public.product_units(id,organization_id)
);
alter table public.price_agreements enable row level security;
revoke all on public.price_agreements from public,anon,authenticated;
grant select on public.price_agreements to authenticated;
create policy agreements_read on public.price_agreements for select to authenticated using(organization_id=(select private.current_organization_id()) and (select private.has_permission_anywhere('pricing.view') or private.has_permission('pricing.manage')));
create trigger agreements_audit after insert or update on public.price_agreements for each row execute function private.audit_row_change('price_agreement');
create trigger agreements_no_delete before delete on public.price_agreements for each row execute function private.stock_block_mutation();

create function public.create_price_agreement(p_customer uuid,p_unit uuid,p_price numeric,p_from date,p_until date,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare org uuid:=private.current_organization_id(); result uuid;
begin
 if not private.has_permission('pricing.manage') then raise exception 'Pricing management permission required' using errcode='42501'; end if;
 -- Serialize all agreement changes for a customer, including overlapping intervals.
 perform 1 from public.customers where id=p_customer and organization_id=org and is_active for update;
 if not found then raise exception 'Active customer not found' using errcode='P0002'; end if;
 if not exists(select 1 from public.product_units u join public.products p on p.id=u.product_id and p.organization_id=u.organization_id where u.id=p_unit and u.organization_id=org and u.is_active and p.is_active) then raise exception 'Active product unit not found' using errcode='P0002'; end if;
 if p_price is null or p_price<0 or p_price>=1000000000000 or p_price<>round(p_price,4) or p_price='NaN'::numeric then raise exception 'Invalid agreement price' using errcode='22023'; end if;
 if p_from is null or p_until is null or p_until<p_from then raise exception 'Invalid validity period' using errcode='22023'; end if;
 if exists(select 1 from public.price_agreements where organization_id=org and customer_id=p_customer and product_unit_id=p_unit and is_active and valid_from<=p_until and valid_until>=p_from) then raise exception 'An active agreement overlaps this period' using errcode='22023'; end if;
 insert into public.price_agreements(customer_id,product_unit_id,unit_price,valid_from,valid_until,reason) values(p_customer,p_unit,p_price,p_from,p_until,btrim(p_reason)) returning id into result;
 return result;
end $$;
create function public.cancel_price_agreement(p_id uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not private.has_permission('pricing.manage') then raise exception 'Pricing management permission required' using errcode='42501'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Cancellation reason required' using errcode='22023'; end if;
 update public.price_agreements set is_active=false,reason=btrim(p_reason) where id=p_id and organization_id=private.current_organization_id() and is_active;
 if not found then raise exception 'Active agreement not found' using errcode='P0002'; end if;
end $$;
create or replace function public.resolve_price(p_customer_id uuid,p_product_unit_id uuid) returns numeric
language sql stable security invoker set search_path='' as $$
 select coalesce(
  (select a.unit_price from public.price_agreements a where a.organization_id=private.current_organization_id() and a.customer_id=p_customer_id and a.product_unit_id=p_product_unit_id and a.is_active and current_date between a.valid_from and a.valid_until limit 1),
  (select i.unit_price from public.price_list_items i join public.price_lists l on l.id=i.price_list_id and l.is_active
   where i.organization_id=private.current_organization_id() and l.organization_id=i.organization_id and i.product_unit_id=p_product_unit_id and i.is_active and (l.id=(select c.price_list_id from public.customers c where c.id=p_customer_id and c.organization_id=i.organization_id) or l.is_default)
   order by coalesce(l.id=(select c.price_list_id from public.customers c where c.id=p_customer_id),false) desc,l.is_default desc limit 1))
$$;
revoke all on function public.create_price_agreement(uuid,uuid,numeric,date,date,text),public.cancel_price_agreement(uuid,text) from public,anon;
grant execute on function public.create_price_agreement(uuid,uuid,numeric,date,date,text),public.cancel_price_agreement(uuid,text) to authenticated;

create or replace function private.compute_doc_lines(p_org uuid, p_customer public.customers, p_warehouse public.warehouses, p_lines jsonb)
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

    v_list := public.resolve_price(p_customer.id, v_unit.id);
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
    v_list := public.resolve_price(v_cust.id, v_unit.id);
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
