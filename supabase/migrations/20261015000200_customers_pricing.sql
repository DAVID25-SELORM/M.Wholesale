-- Phase 6 / 02: tax codes, customers and price lists
--
-- Tax: a tax code is a named rate (for example "VAT 15%", "EXEMPT 0%", or a combined rate for VAT plus levies). Every product points at one;
--   a product without one uses the organization's default code. The rate is copied onto each invoice line when the invoice is written, so
--   changing a rate later never alters a posted invoice.
-- Customers: organization-level master data with the facts wholesale selling depends on: premises licence and expiry, whether they may buy
--   controlled drugs, payment terms, credit limit, credit hold, a price list and the minimum shelf life they accept.
-- Price lists: a price per product PACK LEVEL (what one box costs, not one tablet). A customer's own list wins; otherwise the default list.

-- ---------------------------------------------------------------------------------------------------------
-- tax codes
-- ---------------------------------------------------------------------------------------------------------
create table public.tax_codes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict
                    default private.current_organization_id(),
  code            public.entity_code not null,
  name            text not null check (btrim(name) <> '' and length(name) <= 120),
  rate            numeric(7, 4) not null check (rate >= 0 and rate <= 100),   -- percent
  is_default      boolean not null default false,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint tax_codes_org_code_key unique (organization_id, code),
  constraint tax_codes_id_org_key unique (id, organization_id)
);
create unique index tax_codes_one_default on public.tax_codes (organization_id) where is_default;
create trigger tax_codes_immutable before update on public.tax_codes
  for each row execute function private.prevent_column_change('organization_id', 'code');
create trigger tax_codes_set_updated_at before update on public.tax_codes
  for each row execute function private.set_updated_at();
create trigger tax_codes_audit after insert or update or delete on public.tax_codes
  for each row execute function private.audit_row_change('tax_code');

-- a default code must stay active
create function private.tax_codes_default_active()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_default and not new.is_active then
    raise exception 'the default tax code cannot be deactivated: choose another default first' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger tax_codes_default_active before insert or update on public.tax_codes
  for each row execute function private.tax_codes_default_active();

-- every organization starts with an EXEMPT 0 % code as its default (medicines are often exempt); more are added in the UI
create function private.organizations_default_tax()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tax_codes (organization_id, code, name, rate, is_default) values (new.id, 'EXEMPT', 'Exempt (0%)', 0, true);
  return null;
end;
$$;
create trigger organizations_default_tax after insert on public.organizations
  for each row execute function private.organizations_default_tax();
insert into public.tax_codes (organization_id, code, name, rate, is_default)
select o.id, 'EXEMPT', 'Exempt (0%)', 0, true from public.organizations o
where not exists (select 1 from public.tax_codes t where t.organization_id = o.id);

alter table public.products add column tax_code_id uuid;
alter table public.products add constraint products_tax_code_fk foreign key (tax_code_id, organization_id)
  references public.tax_codes (id, organization_id) on delete restrict;
create index products_tax_code_idx on public.products (tax_code_id) where tax_code_id is not null;
grant insert (tax_code_id) on public.products to authenticated;
grant update (tax_code_id) on public.products to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- price lists
-- ---------------------------------------------------------------------------------------------------------
create table public.price_lists (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict
                    default private.current_organization_id(),
  code            public.entity_code not null,
  name            text not null check (btrim(name) <> '' and length(name) <= 120),
  is_default      boolean not null default false,
  is_active       boolean not null default true,
  notes           text check (notes is null or length(notes) <= 500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint price_lists_org_code_key unique (organization_id, code),
  constraint price_lists_id_org_key unique (id, organization_id)
);
create unique index price_lists_one_default on public.price_lists (organization_id) where is_default;
create trigger price_lists_immutable before update on public.price_lists
  for each row execute function private.prevent_column_change('organization_id', 'code');
create trigger price_lists_set_updated_at before update on public.price_lists
  for each row execute function private.set_updated_at();
create trigger price_lists_audit after insert or update or delete on public.price_lists
  for each row execute function private.audit_row_change('price_list');

create table public.price_list_items (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null default private.current_organization_id(),
  price_list_id   uuid not null,
  product_id      uuid not null,
  product_unit_id uuid not null,
  unit_price      numeric(18, 4) not null check (unit_price >= 0),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint price_list_items_list_fk foreign key (price_list_id, organization_id)
    references public.price_lists (id, organization_id) on delete restrict,
  constraint price_list_items_unit_fk foreign key (product_unit_id, product_id, organization_id)
    references public.product_units (id, product_id, organization_id) on delete restrict,
  constraint price_list_items_list_unit_key unique (price_list_id, product_unit_id)
);
create index price_list_items_product_idx on public.price_list_items (organization_id, product_id);
create index price_list_items_unit_idx on public.price_list_items (product_unit_id);
create trigger price_list_items_immutable before update on public.price_list_items
  for each row execute function private.prevent_column_change('organization_id', 'price_list_id', 'product_id', 'product_unit_id');
create trigger price_list_items_set_updated_at before update on public.price_list_items
  for each row execute function private.set_updated_at();
create trigger price_list_items_audit after insert or update or delete on public.price_list_items
  for each row execute function private.audit_row_change('price_list_item');

-- ---------------------------------------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------------------------------------
create table public.customers (
  id                          uuid primary key default gen_random_uuid(),
  organization_id             uuid not null references public.organizations (id) on delete restrict
                                default private.current_organization_id(),
  code                        public.entity_code not null,
  name                        text not null check (btrim(name) <> '' and length(name) <= 200),
  customer_type               text not null default 'PHARMACY'
                                check (customer_type in ('PHARMACY', 'HOSPITAL', 'CLINIC', 'WHOLESALER', 'RETAILER', 'OTHER')),
  licence_number              text check (licence_number is null or length(licence_number) <= 60),
  licence_expiry              date,
  registered_pharmacist       text check (registered_pharmacist is null or length(registered_pharmacist) <= 120),
  controlled_drugs_authorised boolean not null default false,
  tax_number                  text check (tax_number is null or length(tax_number) <= 60),
  contact_name                text check (contact_name is null or length(contact_name) <= 120),
  phone                       text check (phone is null or length(phone) <= 40),
  email                       text check (email is null or length(email) <= 254),
  address                     text check (address is null or length(address) <= 300),
  city                        text check (city is null or length(city) <= 100),
  region                      text check (region is null or length(region) <= 100),
  country                     text check (country is null or country ~ '^[A-Z]{2}$'),
  payment_terms_days          integer not null default 0 check (payment_terms_days between 0 and 365),
  credit_limit                numeric(18, 2) not null default 0 check (credit_limit >= 0),   -- 0 = no credit: invoices must be paid when posted
  price_list_id               uuid,
  min_shelf_life_days         integer not null default 0 check (min_shelf_life_days between 0 and 3650),
  on_hold                     boolean not null default false,
  hold_reason                 text check (hold_reason is null or length(hold_reason) <= 300),
  notes                       text check (notes is null or length(notes) <= 2000),
  is_active                   boolean not null default true,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint customers_org_code_key unique (organization_id, code),
  constraint customers_id_org_key unique (id, organization_id),
  constraint customers_price_list_fk foreign key (price_list_id, organization_id)
    references public.price_lists (id, organization_id) on delete restrict,
  constraint customers_hold_has_reason check (not on_hold or hold_reason is not null)
);
create unique index customers_org_name_key on public.customers (organization_id, lower(name));
create index customers_org_active_idx on public.customers (organization_id, is_active);
create index customers_licence_expiry_idx on public.customers (organization_id, licence_expiry) where licence_expiry is not null;
create index customers_price_list_idx on public.customers (price_list_id) where price_list_id is not null;

create trigger customers_immutable before update on public.customers
  for each row execute function private.prevent_column_change('organization_id');
create trigger customers_set_updated_at before update on public.customers
  for each row execute function private.set_updated_at();
create trigger customers_audit after insert or update or delete on public.customers
  for each row execute function private.audit_row_change('customer');

-- ---------------------------------------------------------------------------------------------------------
-- RLS and grants (master data: read in any scope, write organization-wide)
-- ---------------------------------------------------------------------------------------------------------
alter table public.tax_codes        enable row level security;
alter table public.price_lists      enable row level security;
alter table public.price_list_items enable row level security;
alter table public.customers        enable row level security;
revoke all on public.tax_codes, public.price_lists, public.price_list_items, public.customers from public, anon, authenticated;

grant select on public.tax_codes, public.price_lists, public.price_list_items, public.customers to authenticated;
grant insert (code, name, rate, is_default, is_active) on public.tax_codes to authenticated;
grant update (name, rate, is_default, is_active) on public.tax_codes to authenticated;
grant insert (code, name, is_default, is_active, notes) on public.price_lists to authenticated;
grant update (name, is_default, is_active, notes) on public.price_lists to authenticated;
grant insert (price_list_id, product_id, product_unit_id, unit_price, is_active) on public.price_list_items to authenticated;
grant update (unit_price, is_active) on public.price_list_items to authenticated;
grant insert (code, name, customer_type, licence_number, licence_expiry, registered_pharmacist, controlled_drugs_authorised, tax_number,
              contact_name, phone, email, address, city, region, country, payment_terms_days, credit_limit, price_list_id,
              min_shelf_life_days, on_hold, hold_reason, notes, is_active)
  on public.customers to authenticated;
grant update (name, customer_type, licence_number, licence_expiry, registered_pharmacist, controlled_drugs_authorised, tax_number,
              contact_name, phone, email, address, city, region, country, payment_terms_days, credit_limit, price_list_id,
              min_shelf_life_days, on_hold, hold_reason, notes, is_active)
  on public.customers to authenticated;

create policy tax_codes_select on public.tax_codes for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission_anywhere('pricing.view'));
create policy tax_codes_insert on public.tax_codes for insert to authenticated
  with check (organization_id = (select private.current_organization_id()) and private.has_permission('pricing.manage'));
create policy tax_codes_update on public.tax_codes for update to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('pricing.manage'))
  with check (organization_id = (select private.current_organization_id()) and private.has_permission('pricing.manage'));

create policy price_lists_select on public.price_lists for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission_anywhere('pricing.view'));
create policy price_lists_insert on public.price_lists for insert to authenticated
  with check (organization_id = (select private.current_organization_id()) and private.has_permission('pricing.manage'));
create policy price_lists_update on public.price_lists for update to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('pricing.manage'))
  with check (organization_id = (select private.current_organization_id()) and private.has_permission('pricing.manage'));

create policy price_list_items_select on public.price_list_items for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission_anywhere('pricing.view'));
create policy price_list_items_insert on public.price_list_items for insert to authenticated
  with check (organization_id = (select private.current_organization_id()) and private.has_permission('pricing.manage'));
create policy price_list_items_update on public.price_list_items for update to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('pricing.manage'))
  with check (organization_id = (select private.current_organization_id()) and private.has_permission('pricing.manage'));

create policy customers_select on public.customers for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission_anywhere('customers.view'));
create policy customers_insert on public.customers for insert to authenticated
  with check (organization_id = (select private.current_organization_id()) and private.has_permission('customers.create'));
create policy customers_update on public.customers for update to authenticated
  using (organization_id = (select private.current_organization_id()) and private.has_permission('customers.edit'))
  with check (organization_id = (select private.current_organization_id()) and private.has_permission('customers.edit'));

-- ---------------------------------------------------------------------------------------------------------
-- price lookup
-- ---------------------------------------------------------------------------------------------------------
-- The price of one pack level for a customer: their own list first, then the default list. NULL when neither has it.
-- SECURITY INVOKER: it reads only what the caller may read (pricing.view).
create function public.resolve_price(p_customer_id uuid, p_product_unit_id uuid)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select i.unit_price
  from public.price_list_items i
  join public.price_lists l on l.id = i.price_list_id and l.is_active
  where i.product_unit_id = p_product_unit_id and i.is_active
    and (l.id = (select c.price_list_id from public.customers c where c.id = p_customer_id) or l.is_default)
  order by coalesce(l.id = (select c.price_list_id from public.customers c where c.id = p_customer_id), false) desc, l.is_default desc
  limit 1
$$;
revoke all on function public.resolve_price(uuid, uuid) from public, anon;
grant execute on function public.resolve_price(uuid, uuid) to authenticated;

revoke all on function private.tax_codes_default_active() from public, anon, authenticated;
revoke all on function private.organizations_default_tax() from public, anon, authenticated;
