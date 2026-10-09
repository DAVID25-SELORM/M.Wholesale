-- Phase 1 / 02: suppliers
--
-- Same pattern as every tenant table: organization_id never client-writable (filled from the session),
-- composite-FK parentage, RLS scoped to private.current_organization_id(), explicit column grants,
-- no hard deletes (is_active), audit trigger.

create table public.suppliers (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete restrict
                      default private.current_organization_id(),
  code              public.entity_code not null,
  name              text not null check (btrim(name) <> '' and length(name) <= 200),
  supplier_type     text not null default 'DISTRIBUTOR'
                      check (supplier_type in ('MANUFACTURER', 'IMPORTER', 'DISTRIBUTOR', 'WHOLESALER', 'OTHER')),
  registration_number text check (registration_number is null or length(registration_number) <= 60),
  tax_number        text check (tax_number is null or length(tax_number) <= 60),
  -- regulatory licence of the supplier (e.g. FDA / Pharmacy Council); expiry drives alerts and blocking later
  licence_number    text check (licence_number is null or length(licence_number) <= 60),
  licence_expiry    date,
  payment_terms_days integer not null default 30 check (payment_terms_days between 0 and 365),
  -- NULL = the organization's own currency
  currency_code     text check (currency_code is null or currency_code ~ '^[A-Z]{3}$'),
  contact_name      text check (contact_name is null or length(contact_name) <= 120),
  phone             text check (phone is null or length(phone) <= 40),
  email             text check (email is null or length(email) <= 254),
  address           text check (address is null or length(address) <= 300),
  city              text check (city is null or length(city) <= 100),
  region            text check (region is null or length(region) <= 100),
  country           text check (country is null or country ~ '^[A-Z]{2}$'),
  notes             text check (notes is null or length(notes) <= 2000),
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint suppliers_org_code_key unique (organization_id, code),
  constraint suppliers_id_org_key unique (id, organization_id)
);
create unique index suppliers_org_name_key on public.suppliers (organization_id, lower(name));
create index suppliers_org_active_idx on public.suppliers (organization_id, is_active);
create index suppliers_licence_expiry_idx on public.suppliers (organization_id, licence_expiry) where licence_expiry is not null;

create trigger suppliers_immutable before update on public.suppliers
  for each row execute function private.prevent_column_change('organization_id');
create trigger suppliers_set_updated_at before update on public.suppliers
  for each row execute function private.set_updated_at();
create trigger suppliers_audit after insert or update or delete on public.suppliers
  for each row execute function private.audit_row_change('supplier');

alter table public.suppliers enable row level security;
revoke all on public.suppliers from public, anon, authenticated;

grant select on public.suppliers to authenticated;
grant insert (code, name, supplier_type, registration_number, tax_number, licence_number, licence_expiry,
              payment_terms_days, currency_code, contact_name, phone, email, address, city, region, country,
              notes, is_active)
  on public.suppliers to authenticated;
grant update (code, name, supplier_type, registration_number, tax_number, licence_number, licence_expiry,
              payment_terms_days, currency_code, contact_name, phone, email, address, city, region, country,
              notes, is_active)
  on public.suppliers to authenticated;

create policy suppliers_select on public.suppliers
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission_anywhere('suppliers.view'));
create policy suppliers_insert on public.suppliers
  for insert to authenticated
  with check (organization_id = (select private.current_organization_id())
              and private.has_permission('suppliers.create'));
create policy suppliers_update on public.suppliers
  for update to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('suppliers.edit'))
  with check (organization_id = (select private.current_organization_id())
              and private.has_permission('suppliers.edit'));
