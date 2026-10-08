-- Phase 0 / 02: organizations -> branches -> warehouses -> warehouse_locations
--
-- Tenant integrity: every child carries organization_id and references its parent
-- through a COMPOSITE foreign key (parent_id, organization_id), so a child can never
-- point at a parent of another organization. Rows are never hard-deleted; lifecycle
-- is controlled with is_active and FKs are ON DELETE RESTRICT.

create table public.organizations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (btrim(name) <> ''),
  legal_name          text,
  trading_name        text,
  registration_number text,
  tax_number          text,
  phone               text,
  email               text,
  address             text,
  city                text,
  region              text,
  country             text not null default 'GH' check (country ~ '^[A-Z]{2}$'),
  logo_url            text,
  currency_code       text not null default 'GHS' check (currency_code ~ '^[A-Z]{3}$'),
  timezone            text not null default 'Africa/Accra',
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create function private.validate_organization()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- raises "time zone ... not recognized" for invalid names
  perform now() at time zone new.timezone;
  return new;
end;
$$;

create trigger organizations_validate
  before insert or update on public.organizations
  for each row execute function private.validate_organization();
create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function private.set_updated_at();

create table public.branches (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  code            public.entity_code not null,
  name            text not null check (btrim(name) <> ''),
  phone           text,
  email           text,
  address         text,
  city            text,
  region          text,
  is_head_office  boolean not null default false,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint branches_org_code_key unique (organization_id, code),
  constraint branches_id_org_key unique (id, organization_id)
);
create unique index branches_one_head_office_per_org
  on public.branches (organization_id) where is_head_office;

create trigger branches_immutable before update on public.branches
  for each row execute function private.prevent_column_change('organization_id');
create trigger branches_set_updated_at before update on public.branches
  for each row execute function private.set_updated_at();

create table public.warehouses (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  code            public.entity_code not null,
  name            text not null check (btrim(name) <> ''),
  description     text,
  warehouse_type  public.warehouse_type not null default 'MAIN',
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint warehouses_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint warehouses_org_code_key unique (organization_id, code),
  constraint warehouses_id_org_key unique (id, organization_id)
);
create index warehouses_branch_idx on public.warehouses (branch_id);
create index warehouses_org_active_idx on public.warehouses (organization_id, is_active);

-- A warehouse never moves between branches (stock history will hang off it).
create trigger warehouses_immutable before update on public.warehouses
  for each row execute function private.prevent_column_change('organization_id', 'branch_id');
create trigger warehouses_set_updated_at before update on public.warehouses
  for each row execute function private.set_updated_at();

create table public.warehouse_locations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  warehouse_id     uuid not null,
  code             public.entity_code not null,
  aisle            text check (aisle is null or (btrim(aisle) <> '' and length(aisle) <= 32)),
  rack             text check (rack  is null or (btrim(rack)  <> '' and length(rack)  <= 32)),
  shelf            text check (shelf is null or (btrim(shelf) <> '' and length(shelf) <= 32)),
  bin              text check (bin   is null or (btrim(bin)   <> '' and length(bin)   <= 32)),
  description      text,
  -- walking order for future pick lists (lower = earlier)
  picking_sequence integer not null default 0 check (picking_sequence >= 0),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint warehouse_locations_warehouse_fk foreign key (warehouse_id, organization_id)
    references public.warehouses (id, organization_id) on delete restrict,
  constraint warehouse_locations_warehouse_code_key unique (warehouse_id, code),
  constraint warehouse_locations_id_org_key unique (id, organization_id)
);
create index warehouse_locations_pick_idx
  on public.warehouse_locations (warehouse_id, picking_sequence, code);
create index warehouse_locations_org_idx on public.warehouse_locations (organization_id);

create trigger warehouse_locations_immutable before update on public.warehouse_locations
  for each row execute function private.prevent_column_change('organization_id', 'warehouse_id');
create trigger warehouse_locations_set_updated_at before update on public.warehouse_locations
  for each row execute function private.set_updated_at();
