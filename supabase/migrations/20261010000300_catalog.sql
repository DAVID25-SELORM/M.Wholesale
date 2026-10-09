-- Phase 1 / 03: product catalogue
--
-- Identity model (why it is not a single `products` table):
--   product_identities  CANONICAL pharmaceutical identity: generic name + dosage form + strength.
--                       "Amoxicillin + Clavulanic acid | TABLET | 500 mg + 125 mg" exists once per organization.
--   products            a sellable SKU: brand / pack / manufacturer. Several SKUs (brands, pack sizes) share one
--                       identity; different pack sizes are sibling SKUs ("package variants").
--   product_units       packaging levels and conversions to the base unit (box = 14 tablets).
--   product_barcodes    GTIN / internal barcodes, each attached to a pack level.
--   product_aliases     messy real-world names ("Augmentin 625", "AUGMENTIN 625MG 14'S") that resolve to a SKU or
--                       an identity. Normalised so differences in case, punctuation and spacing do not matter.
-- No quantity lives anywhere in this module: stock will be a ledger of movements in a later phase.

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------------------------------------
-- lower-case; digits are separated from letters and every run of other characters becomes one space, so
-- "500MG", "500 mg" and "500-mg" all read "500 mg", and "AUGMENTIN 625MG 14'S" reads "augmentin 625 mg 14 s"
create function private.normalize_text(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select btrim(regexp_replace(
           regexp_replace(
             regexp_replace(lower(coalesce(p_text, '')), '([0-9])([a-z])', '\1 \2', 'g'),
             '([a-z])([0-9])', '\1 \2', 'g'),
           '[^a-z0-9]+', ' ', 'g'))
$$;

-- GS1 mod-10 check digit for GTIN-8/12/13/14
create function private.is_valid_gtin(p_value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  n int;
  i int;
  total int := 0;
begin
  if p_value !~ '^[0-9]+$' or length(p_value) not in (8, 12, 13, 14) then
    return false;
  end if;
  n := length(p_value);
  for i in 1 .. n - 1 loop
    total := total + substr(p_value, n - i, 1)::int * case when i % 2 = 1 then 3 else 1 end;
  end loop;
  return ((10 - total % 10) % 10) = substr(p_value, n, 1)::int;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- global reference data (managed by migrations; read-only for tenants)
-- ---------------------------------------------------------------------------------------------------------
create table public.units_of_measure (
  id        uuid primary key default gen_random_uuid(),
  code      public.entity_code not null unique,
  name      text not null,
  kind      text not null check (kind in ('COUNT', 'MASS', 'VOLUME', 'PACKAGING')),
  is_active boolean not null default true
);

create table public.dosage_forms (
  id        uuid primary key default gen_random_uuid(),
  code      public.entity_code not null unique,
  name      text not null,
  is_active boolean not null default true
);

insert into public.units_of_measure (code, name, kind) values
  ('TABLET', 'Tablet', 'COUNT'), ('CAPSULE', 'Capsule', 'COUNT'), ('VIAL', 'Vial', 'COUNT'),
  ('AMPOULE', 'Ampoule', 'COUNT'), ('SACHET', 'Sachet', 'COUNT'), ('PIECE', 'Piece', 'COUNT'),
  ('DOSE', 'Dose', 'COUNT'), ('SUPPOSITORY', 'Suppository', 'COUNT'), ('PESSARY', 'Pessary', 'COUNT'),
  ('PATCH', 'Patch', 'COUNT'),
  ('MG', 'Milligram', 'MASS'), ('G', 'Gram', 'MASS'), ('KG', 'Kilogram', 'MASS'),
  ('ML', 'Millilitre', 'VOLUME'), ('L', 'Litre', 'VOLUME'),
  ('STRIP', 'Strip', 'PACKAGING'), ('BLISTER', 'Blister pack', 'PACKAGING'), ('BOTTLE', 'Bottle', 'PACKAGING'),
  ('TUBE', 'Tube', 'PACKAGING'), ('JAR', 'Jar', 'PACKAGING'), ('BOX', 'Box', 'PACKAGING'),
  ('PACK', 'Pack', 'PACKAGING'), ('CARTON', 'Carton', 'PACKAGING'), ('TRAY', 'Tray', 'PACKAGING'),
  ('BAG', 'Bag', 'PACKAGING'), ('INHALER', 'Inhaler', 'PACKAGING'), ('PEN', 'Pen', 'PACKAGING'),
  ('KIT', 'Kit', 'PACKAGING')
on conflict (code) do nothing;

insert into public.dosage_forms (code, name) values
  ('TABLET', 'Tablet'), ('CAPSULE', 'Capsule'), ('SYRUP', 'Syrup'), ('SUSPENSION', 'Suspension'),
  ('SOLUTION', 'Solution'), ('DROPS', 'Drops'), ('INJECTION', 'Injection'), ('INFUSION', 'Infusion'),
  ('CREAM', 'Cream'), ('OINTMENT', 'Ointment'), ('GEL', 'Gel'), ('LOTION', 'Lotion'),
  ('POWDER', 'Powder'), ('SACHET', 'Sachet / granules'), ('SUPPOSITORY', 'Suppository'), ('PESSARY', 'Pessary'),
  ('INHALER', 'Inhaler'), ('SPRAY', 'Spray'), ('PATCH', 'Patch'), ('LOZENGE', 'Lozenge'),
  ('EFFERVESCENT', 'Effervescent tablet'), ('DISPERSIBLE', 'Dispersible tablet'), ('SHAMPOO', 'Shampoo'),
  ('OTHER', 'Other')
on conflict (code) do nothing;

alter table public.units_of_measure enable row level security;
alter table public.dosage_forms enable row level security;
revoke all on public.units_of_measure, public.dosage_forms from public, anon, authenticated;
grant select on public.units_of_measure, public.dosage_forms to authenticated;
create policy units_of_measure_select on public.units_of_measure for select to authenticated
  using ((select private.current_organization_id()) is not null);
create policy dosage_forms_select on public.dosage_forms for select to authenticated
  using ((select private.current_organization_id()) is not null);

-- ---------------------------------------------------------------------------------------------------------
-- tenant tables
-- ---------------------------------------------------------------------------------------------------------
create table public.manufacturers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict
                    default private.current_organization_id(),
  name            text not null check (btrim(name) <> '' and length(name) <= 200),
  country         text check (country is null or country ~ '^[A-Z]{2}$'),
  notes           text check (notes is null or length(notes) <= 2000),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint manufacturers_id_org_key unique (id, organization_id)
);
create unique index manufacturers_org_name_key on public.manufacturers (organization_id, lower(name));

create table public.product_categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict
                    default private.current_organization_id(),
  code            public.entity_code not null,
  name            text not null check (btrim(name) <> '' and length(name) <= 120),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint product_categories_org_code_key unique (organization_id, code),
  constraint product_categories_id_org_key unique (id, organization_id)
);
create unique index product_categories_org_name_key on public.product_categories (organization_id, lower(name));

create table public.product_identities (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict
                    default private.current_organization_id(),
  generic_name    text not null check (btrim(generic_name) <> '' and length(generic_name) <= 300),
  dosage_form_id  uuid not null references public.dosage_forms (id) on delete restrict,
  strength_text   text not null check (btrim(strength_text) <> '' and length(strength_text) <= 120),
  -- derived: normalised generic name | dosage form | normalised strength. One identity per key per organization.
  identity_key    text not null default '',
  notes           text check (notes is null or length(notes) <= 2000),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint product_identities_org_key_key unique (organization_id, identity_key),
  constraint product_identities_id_org_key unique (id, organization_id)
);
create index product_identities_name_trgm on public.product_identities
  using gin (private.normalize_text(generic_name) extensions.gin_trgm_ops);

create table public.products (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations (id) on delete restrict
                             default private.current_organization_id(),
  sku                      text not null check (sku ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  identity_id              uuid,
  brand_name               text not null check (btrim(brand_name) <> '' and length(brand_name) <= 300),
  description              text check (description is null or length(description) <= 2000),
  manufacturer_id          uuid,
  category_id              uuid,
  product_class            text not null default 'POM' check (product_class in
    ('POM', 'P', 'GSL', 'CONTROLLED', 'MEDICAL_DEVICE', 'CONSUMABLE', 'SUPPLEMENT', 'COSMETIC', 'OTHER')),
  storage_condition        text not null default 'AMBIENT' check (storage_condition in
    ('AMBIENT', 'COOL', 'REFRIGERATED', 'FROZEN')),
  requires_prescription    boolean not null default false,
  is_controlled            boolean not null default false,
  fda_registration_number  text check (fda_registration_number is null or length(fda_registration_number) <= 60),
  fda_registration_expiry  date,
  base_unit_id             uuid not null references public.units_of_measure (id) on delete restrict,
  track_batches            boolean not null default true,
  is_active                boolean not null default true,
  -- derived: normalised brand + sku + generic + strength (search); maintained by triggers
  search_key               text not null default '',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint products_org_sku_key unique (organization_id, sku),
  constraint products_id_org_key unique (id, organization_id),
  constraint products_identity_fk foreign key (identity_id, organization_id)
    references public.product_identities (id, organization_id) on delete restrict,
  constraint products_manufacturer_fk foreign key (manufacturer_id, organization_id)
    references public.manufacturers (id, organization_id) on delete restrict,
  constraint products_category_fk foreign key (category_id, organization_id)
    references public.product_categories (id, organization_id) on delete restrict,
  -- medicines must have a canonical identity; devices / consumables / cosmetics may not
  constraint products_identity_required check (
    product_class in ('MEDICAL_DEVICE', 'CONSUMABLE', 'COSMETIC', 'OTHER', 'SUPPLEMENT') or identity_id is not null),
  constraint products_controlled_consistent check ((product_class = 'CONTROLLED') = is_controlled),
  constraint products_prescription_consistent check (
    product_class not in ('POM', 'CONTROLLED') or requires_prescription)
);
create index products_org_active_idx on public.products (organization_id, is_active);
create index products_identity_idx on public.products (identity_id) where identity_id is not null;
create index products_manufacturer_idx on public.products (manufacturer_id) where manufacturer_id is not null;
create index products_category_idx on public.products (category_id) where category_id is not null;
create index products_search_trgm on public.products using gin (search_key extensions.gin_trgm_ops);
create index products_org_brand_idx on public.products (organization_id, lower(brand_name));

create table public.product_units (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  product_id       uuid not null,
  unit_id          uuid not null references public.units_of_measure (id) on delete restrict,
  -- how many BASE units one of this unit contains (box of 14 tablets -> 14)
  factor_to_base   numeric(18, 6) not null check (factor_to_base > 0),
  is_base          boolean not null default false,
  is_sellable      boolean not null default true,
  is_purchasable   boolean not null default true,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint product_units_product_fk foreign key (product_id, organization_id)
    references public.products (id, organization_id) on delete restrict,
  constraint product_units_product_unit_key unique (product_id, unit_id),
  constraint product_units_ref_key unique (id, product_id, organization_id),
  constraint product_units_base_is_one check (not is_base or factor_to_base = 1)
);
create unique index product_units_one_base on public.product_units (product_id) where is_base;

create table public.product_barcodes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  product_id       uuid not null,
  product_unit_id  uuid not null,
  barcode          text not null check (barcode ~ '^[0-9A-Za-z._-]{4,64}$'),
  barcode_type     text not null default 'GTIN' check (barcode_type in ('GTIN', 'INTERNAL', 'SUPPLIER')),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- the pack level must belong to the same product and organization
  constraint product_barcodes_unit_fk foreign key (product_unit_id, product_id, organization_id)
    references public.product_units (id, product_id, organization_id) on delete restrict,
  constraint product_barcodes_org_barcode_key unique (organization_id, barcode)
  -- GTIN check digits are validated by the product_barcodes_validate trigger (it runs as the function owner,
  -- so clients need no EXECUTE right on the helper)
);
create index product_barcodes_product_idx on public.product_barcodes (product_id);
create index product_barcodes_unit_idx on public.product_barcodes (product_unit_id);

create table public.product_aliases (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict
                     default private.current_organization_id(),
  alias            text not null check (btrim(alias) <> '' and length(alias) <= 300),
  normalized_alias text not null default '',
  product_id       uuid,
  identity_id      uuid,
  source           text not null default 'MANUAL' check (source in ('MANUAL', 'SUPPLIER', 'IMPORT')),
  supplier_id      uuid,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint product_aliases_product_fk foreign key (product_id, organization_id)
    references public.products (id, organization_id) on delete restrict,
  constraint product_aliases_identity_fk foreign key (identity_id, organization_id)
    references public.product_identities (id, organization_id) on delete restrict,
  constraint product_aliases_supplier_fk foreign key (supplier_id, organization_id)
    references public.suppliers (id, organization_id) on delete restrict,
  -- an alias resolves to exactly one thing: a SKU or an identity
  constraint product_aliases_one_target check ((product_id is null) <> (identity_id is null)),
  constraint product_aliases_org_normalized_key unique (organization_id, normalized_alias),
  constraint product_aliases_normalized_not_empty check (normalized_alias <> '')
);
create index product_aliases_product_idx on public.product_aliases (product_id) where product_id is not null;
create index product_aliases_identity_idx on public.product_aliases (identity_id) where identity_id is not null;
create index product_aliases_trgm on public.product_aliases using gin (normalized_alias extensions.gin_trgm_ops);

create table public.supplier_products (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null,
  supplier_id           uuid not null,
  product_id            uuid not null,
  -- the pack level the supplier sells (and the cost refers to)
  product_unit_id       uuid not null,
  supplier_sku          text check (supplier_sku is null or length(supplier_sku) <= 80),
  supplier_product_name text check (supplier_product_name is null or length(supplier_product_name) <= 300),
  last_cost             numeric(18, 4) check (last_cost is null or last_cost >= 0),
  last_cost_at          timestamptz,
  lead_time_days        integer check (lead_time_days is null or lead_time_days between 0 and 365),
  min_order_quantity    numeric(18, 4) check (min_order_quantity is null or min_order_quantity > 0),
  is_preferred          boolean not null default false,
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint supplier_products_supplier_fk foreign key (supplier_id, organization_id)
    references public.suppliers (id, organization_id) on delete restrict,
  constraint supplier_products_unit_fk foreign key (product_unit_id, product_id, organization_id)
    references public.product_units (id, product_id, organization_id) on delete restrict,
  constraint supplier_products_supplier_product_key unique (supplier_id, product_id)
);
-- at most one preferred supplier per product
create unique index supplier_products_one_preferred on public.supplier_products (product_id)
  where is_preferred and is_active;
create index supplier_products_product_idx on public.supplier_products (product_id);
create index supplier_products_org_idx on public.supplier_products (organization_id);

-- ---------------------------------------------------------------------------------------------------------
-- triggers
-- ---------------------------------------------------------------------------------------------------------
create function private.product_search_key(p_org uuid, p_brand text, p_sku text, p_identity_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.normalize_text(concat_ws(' ', p_brand, p_sku, i.generic_name, i.strength_text))
  from (select 1) x
  left join public.product_identities i on i.id = p_identity_id and i.organization_id = p_org
$$;

create function private.products_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.search_key := private.product_search_key(new.organization_id, new.brand_name, new.sku, new.identity_id);
  return new;
end;
$$;

create function private.products_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- every product has exactly one base unit with factor 1, created together with it
  insert into public.product_units (organization_id, product_id, unit_id, factor_to_base, is_base)
  values (new.organization_id, new.id, new.base_unit_id, 1, true);
  return null;
end;
$$;

create function private.identities_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_form text;
begin
  select code into v_form from public.dosage_forms where id = new.dosage_form_id;
  new.identity_key := private.normalize_text(new.generic_name) || '|' || v_form || '|' || private.normalize_text(new.strength_text);

  -- the identity of something already catalogued must not silently change meaning
  if tg_op = 'UPDATE'
     and new.identity_key is distinct from old.identity_key
     and exists (select 1 from public.products p where p.identity_id = old.id) then
    raise exception 'this identity is used by products; create a new identity instead of changing it'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create function private.identities_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- display-only edits (e.g. spelling of the generic name) must refresh dependent search keys
  update public.products p
     set search_key = private.product_search_key(p.organization_id, p.brand_name, p.sku, p.identity_id)
   where p.identity_id = new.id;
  return null;
end;
$$;

create function private.aliases_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.normalized_alias := private.normalize_text(new.alias);
  return new;
end;
$$;

create function private.barcodes_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.barcode_type = 'GTIN' and not private.is_valid_gtin(new.barcode) then
    raise exception 'invalid GTIN: the check digit does not match' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function private.product_units_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_base and not new.is_active then
    raise exception 'the base unit of a product cannot be deactivated' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function private.supplier_products_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.last_cost is not null then new.last_cost_at := now(); end if;
  elsif new.last_cost is distinct from old.last_cost then
    new.last_cost_at := case when new.last_cost is null then null else now() end;
  end if;
  return new;
end;
$$;

-- manufacturers / categories / identities / products
create trigger manufacturers_immutable before update on public.manufacturers
  for each row execute function private.prevent_column_change('organization_id');
create trigger product_categories_immutable before update on public.product_categories
  for each row execute function private.prevent_column_change('organization_id');
create trigger product_identities_immutable before update on public.product_identities
  for each row execute function private.prevent_column_change('organization_id');
create trigger product_identities_derive before insert or update on public.product_identities
  for each row execute function private.identities_before_write();
create trigger product_identities_refresh after update on public.product_identities
  for each row execute function private.identities_after_update();
-- sku and base unit are business keys that documents and stock will reference: they never change
create trigger products_immutable before update on public.products
  for each row execute function private.prevent_column_change('organization_id', 'sku', 'base_unit_id');
create trigger products_derive before insert or update on public.products
  for each row execute function private.products_before_write();
create trigger products_base_unit after insert on public.products
  for each row execute function private.products_after_insert();
-- units: conversions are history-bearing, so only flags may change
create trigger product_units_immutable before update on public.product_units
  for each row execute function private.prevent_column_change(
    'organization_id', 'product_id', 'unit_id', 'factor_to_base', 'is_base');
create trigger product_units_guard before update on public.product_units
  for each row execute function private.product_units_guard();
create trigger product_barcodes_immutable before update on public.product_barcodes
  for each row execute function private.prevent_column_change(
    'organization_id', 'product_id', 'product_unit_id', 'barcode', 'barcode_type');
create trigger product_barcodes_validate before insert on public.product_barcodes
  for each row execute function private.barcodes_validate();
create trigger product_aliases_immutable before update on public.product_aliases
  for each row execute function private.prevent_column_change(
    'organization_id', 'alias', 'product_id', 'identity_id', 'source', 'supplier_id');
create trigger product_aliases_derive before insert on public.product_aliases
  for each row execute function private.aliases_before_write();
create trigger supplier_products_immutable before update on public.supplier_products
  for each row execute function private.prevent_column_change(
    'organization_id', 'supplier_id', 'product_id', 'product_unit_id');
create trigger supplier_products_stamp before insert or update on public.supplier_products
  for each row execute function private.supplier_products_stamp();

do $$
declare
  t text;
begin
  foreach t in array array['manufacturers', 'product_categories', 'product_identities', 'products',
                           'product_units', 'product_barcodes', 'product_aliases', 'supplier_products']
  loop
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()',
                   t || '_set_updated_at', t);
  end loop;
end;
$$;

create trigger manufacturers_audit after insert or update or delete on public.manufacturers
  for each row execute function private.audit_row_change('manufacturer');
create trigger product_categories_audit after insert or update or delete on public.product_categories
  for each row execute function private.audit_row_change('product_category');
create trigger product_identities_audit after insert or update or delete on public.product_identities
  for each row execute function private.audit_row_change('product_identity');
create trigger products_audit after insert or update or delete on public.products
  for each row execute function private.audit_row_change('product');
create trigger product_units_audit after insert or update or delete on public.product_units
  for each row execute function private.audit_row_change('product_unit');
create trigger product_barcodes_audit after insert or update or delete on public.product_barcodes
  for each row execute function private.audit_row_change('product_barcode');
create trigger product_aliases_audit after insert or update or delete on public.product_aliases
  for each row execute function private.audit_row_change('product_alias');
create trigger supplier_products_audit after insert or update or delete on public.supplier_products
  for each row execute function private.audit_row_change('supplier_product');

-- ---------------------------------------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------------------------------------
alter table public.manufacturers       enable row level security;
alter table public.product_categories  enable row level security;
alter table public.product_identities  enable row level security;
alter table public.products            enable row level security;
alter table public.product_units       enable row level security;
alter table public.product_barcodes    enable row level security;
alter table public.product_aliases     enable row level security;
alter table public.supplier_products   enable row level security;

revoke all on
  public.manufacturers, public.product_categories, public.product_identities, public.products,
  public.product_units, public.product_barcodes, public.product_aliases, public.supplier_products
from public, anon, authenticated;

-- organization_id is filled by a column default from the caller's session on tables that clients insert into
alter table public.product_units    alter column organization_id set default private.current_organization_id();
alter table public.product_barcodes alter column organization_id set default private.current_organization_id();
alter table public.supplier_products alter column organization_id set default private.current_organization_id();

grant select on
  public.manufacturers, public.product_categories, public.product_identities, public.products,
  public.product_units, public.product_barcodes, public.product_aliases, public.supplier_products
to authenticated;

grant insert (name, country, notes, is_active) on public.manufacturers to authenticated;
grant update (name, country, notes, is_active) on public.manufacturers to authenticated;
grant insert (code, name, is_active) on public.product_categories to authenticated;
grant update (code, name, is_active) on public.product_categories to authenticated;
grant insert (generic_name, dosage_form_id, strength_text, notes, is_active) on public.product_identities to authenticated;
grant update (generic_name, dosage_form_id, strength_text, notes, is_active) on public.product_identities to authenticated;
grant insert (sku, identity_id, brand_name, description, manufacturer_id, category_id, product_class, storage_condition,
              requires_prescription, is_controlled, fda_registration_number, fda_registration_expiry, base_unit_id,
              track_batches, is_active) on public.products to authenticated;
grant update (identity_id, brand_name, description, manufacturer_id, category_id, product_class, storage_condition,
              requires_prescription, is_controlled, fda_registration_number, fda_registration_expiry,
              track_batches, is_active) on public.products to authenticated;
grant insert (product_id, unit_id, factor_to_base, is_sellable, is_purchasable, is_active) on public.product_units to authenticated;
grant update (is_sellable, is_purchasable, is_active) on public.product_units to authenticated;
grant insert (product_id, product_unit_id, barcode, barcode_type, is_active) on public.product_barcodes to authenticated;
grant update (is_active) on public.product_barcodes to authenticated;
grant insert (alias, product_id, identity_id, source, supplier_id, is_active) on public.product_aliases to authenticated;
grant update (is_active) on public.product_aliases to authenticated;
grant insert (supplier_id, product_id, product_unit_id, supplier_sku, supplier_product_name, last_cost,
              lead_time_days, min_order_quantity, is_preferred, is_active) on public.supplier_products to authenticated;
grant update (supplier_sku, supplier_product_name, last_cost, lead_time_days, min_order_quantity,
              is_preferred, is_active) on public.supplier_products to authenticated;

-- read: organization member holding the permission in any scope; write: the permission organization-wide
do $$
declare
  t text;
begin
  foreach t in array array['manufacturers', 'product_categories', 'product_identities', 'products',
                           'product_units', 'product_barcodes', 'product_aliases']
  loop
    execute format($f$create policy %I on public.%I for select to authenticated
      using (organization_id = (select private.current_organization_id())
             and private.has_permission_anywhere('products.view'))$f$, t || '_select', t);
  end loop;

  -- creating a brand-new product / identity / lookup row = products.create; adding detail to a product = products.edit
  foreach t in array array['manufacturers', 'product_categories', 'product_identities', 'products']
  loop
    execute format($f$create policy %I on public.%I for insert to authenticated
      with check (organization_id = (select private.current_organization_id())
                  and private.has_permission('products.create'))$f$, t || '_insert', t);
  end loop;
  foreach t in array array['product_units', 'product_barcodes', 'product_aliases']
  loop
    execute format($f$create policy %I on public.%I for insert to authenticated
      with check (organization_id = (select private.current_organization_id())
                  and private.has_permission('products.edit'))$f$, t || '_insert', t);
  end loop;
  foreach t in array array['manufacturers', 'product_categories', 'product_identities', 'products',
                           'product_units', 'product_barcodes', 'product_aliases']
  loop
    execute format($f$create policy %I on public.%I for update to authenticated
      using (organization_id = (select private.current_organization_id())
             and private.has_permission('products.edit'))
      with check (organization_id = (select private.current_organization_id())
                  and private.has_permission('products.edit'))$f$, t || '_update', t);
  end loop;
end;
$$;

-- supplier price list: visible with suppliers.view (it carries costs), editable with suppliers.edit
create policy supplier_products_select on public.supplier_products
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission_anywhere('suppliers.view'));
create policy supplier_products_insert on public.supplier_products
  for insert to authenticated
  with check (organization_id = (select private.current_organization_id())
              and private.has_permission('suppliers.edit'));
create policy supplier_products_update on public.supplier_products
  for update to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('suppliers.edit'))
  with check (organization_id = (select private.current_organization_id())
              and private.has_permission('suppliers.edit'));

-- ---------------------------------------------------------------------------------------------------------
-- search: one entry point for "find this product", however it was typed
-- ---------------------------------------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: the caller's RLS applies, so tenant isolation and products.view are enforced
-- by the database. Every word must match the product name/SKU/generic/strength OR one of its aliases
-- (so "625 augmentin" and "AUGMENTIN 625MG 14'S" both find the same SKU); an exact barcode always matches.
create function public.search_products(p_query text, p_limit integer default 25, p_offset integer default 0)
returns table (
  product_id        uuid,
  sku               text,
  brand_name        text,
  generic_name      text,
  strength_text     text,
  dosage_form       text,
  manufacturer_name text,
  product_class     text,
  is_active         boolean,
  matched_on        text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select private.normalize_text(p_query) as nq, btrim(p_query) as raw
  )
  select p.id, p.sku, p.brand_name, i.generic_name, i.strength_text, d.name, m.name, p.product_class, p.is_active,
         case
           when exists (select 1 from public.product_barcodes b
                        where b.product_id = p.id and b.barcode = q.raw) then 'barcode'
           when p.sku = upper(q.raw) then 'sku'
           when private.normalize_text(p.brand_name) like q.nq || '%' then 'name'
           else 'match'
         end
  from public.products p
  cross join q
  left join public.product_identities i on i.id = p.identity_id
  left join public.dosage_forms d on d.id = i.dosage_form_id
  left join public.manufacturers m on m.id = p.manufacturer_id
  where q.nq <> ''
    and (
      exists (select 1 from public.product_barcodes b where b.product_id = p.id and b.is_active and b.barcode = q.raw)
      or not exists (
        select 1
        from unnest(string_to_array(q.nq, ' ')) as t(tok)
        where not (
          p.search_key like '%' || t.tok || '%'
          or exists (select 1 from public.product_aliases a
                     where a.is_active
                       and (a.product_id = p.id or (a.identity_id is not null and a.identity_id = p.identity_id))
                       and a.normalized_alias like '%' || t.tok || '%')
        )
      )
    )
  order by
    case
      when exists (select 1 from public.product_barcodes b where b.product_id = p.id and b.barcode = q.raw) then 0
      when p.sku = upper(q.raw) then 1
      when private.normalize_text(p.brand_name) like q.nq || '%' then 2
      else 3
    end,
    p.is_active desc,
    p.brand_name
  limit least(greatest(coalesce(p_limit, 25), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.search_products(text, integer, integer) from public, anon;
grant execute on function public.search_products(text, integer, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- function privileges
-- ---------------------------------------------------------------------------------------------------------
-- PostgreSQL grants EXECUTE on every new function to PUBLIC, and a schema-level ALTER DEFAULT PRIVILEGES cannot
-- remove that built-in grant. So: stop it for future functions created by this role, and reset the private schema
-- explicitly to the exact allow-list (what RLS policies and invoker functions need).
alter default privileges revoke execute on functions from public;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.current_organization_id(),
  private.current_profile_id(),
  private.has_permission(text, uuid),
  private.has_permission_anywhere(text),
  private.can_access_branch(uuid),
  private.warehouse_branch_id(uuid),
  private.can_access_warehouse(uuid),
  private.actor_covers_role(uuid),
  private.normalize_text(text)
to authenticated;
grant execute on function private.normalize_text(text) to service_role;
