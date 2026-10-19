-- Apply Phase 17a (delivery fleet: drivers and vehicles) to the hosted database in ONE atomic paste: the migration, verbatim, inside a single transaction.
-- Run it once in the Supabase SQL editor. If anything fails, nothing is changed.
begin;

-- ===== migration 20261027000100_fleet =====
-- Phase 17a: delivery fleet: drivers and vehicles
--
-- First stage of Advanced Warehouse Operations (docs/phase17/WAREHOUSE_OPERATIONS_DESIGN.md). Delivery runs (a later stage) are planned on these records, and a run cannot be
-- created or dispatched with an inactive driver or vehicle, an expired driving licence, or an expired insurance or roadworthy date. This stage holds the records, their
-- permissions, and the expiry warning window.
--
-- Tenant rules as everywhere: organization_id on every row (default = the caller's organization, never writable), composite foreign keys to branches and profiles so a
-- row can never point into another organization, row-level security by organization and by branch, column-limited writes, audit on every change, and no deletes
-- (a driver or vehicle that is no longer used is deactivated; history stays intact).

-- ---------------------------------------------------------------------------------------------------------
-- permissions: who sees and who manages the fleet
-- ---------------------------------------------------------------------------------------------------------
insert into public.permissions (code, module, action, description) values
  ('fleet.view',   'fleet', 'view',   'View drivers and vehicles'),
  ('fleet.manage', 'fleet', 'manage', 'Create and edit drivers and vehicles, including licence, insurance and roadworthy dates')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, code) as (values
  ('SUPER_ADMIN','fleet.view'),('SUPER_ADMIN','fleet.manage'),
  ('OWNER','fleet.view'),('OWNER','fleet.manage'),
  ('GENERAL_MANAGER','fleet.view'),('GENERAL_MANAGER','fleet.manage'),
  ('BRANCH_MANAGER','fleet.view'),('BRANCH_MANAGER','fleet.manage'),
  ('DISPATCHER','fleet.view'),('DISPATCHER','fleet.manage'),
  ('WAREHOUSE_MANAGER','fleet.view'),
  ('AUDITOR','fleet.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------------
-- settings: how many days before an expiry the screens warn (also used by the later stages when they refuse an assignment)
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  v_name text;
begin
  select conname into v_name from pg_constraint where conrelid = 'public.system_settings'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%notifications%';
  if v_name is null then raise exception 'system_settings category constraint not found'; end if;
  execute format('alter table public.system_settings drop constraint %I', v_name);
  alter table public.system_settings add constraint system_settings_category_check
    check (category = any (array['company', 'inventory', 'sales', 'purchasing', 'credit', 'invoice', 'notifications', 'security', 'integrations', 'fleet']));
end $$;

create or replace function private.setting_defs()
returns table (category text, key text, kind text, min_num numeric, max_num numeric, min_nonzero numeric, max_len integer, branch_scoped boolean, sensitive boolean, default_value jsonb)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('invoice',    'footer',                     'text',      null::numeric, null::numeric, null::numeric, 300,  false, false, '""'::jsonb),
    ('invoice',    'payment_instructions',       'text',      null,          null,          null,          500,  false, false, '""'::jsonb),
    ('sales',      'default_payment_terms_days', 'int',       0,             365,           null,          null, false, false, '0'::jsonb),
    ('sales',      'quotation_validity_days',    'int',       1,             365,           null,          null, false, false, '30'::jsonb),
    ('credit',     'default_credit_limit',       'number',    0,             1000000000,    null,          null, false, false, '0'::jsonb),
    ('purchasing', 'default_payment_terms_days', 'int',       0,             365,           null,          null, false, false, '30'::jsonb),
    ('inventory',  'near_expiry_days',           'int',       1,             730,           null,          null, false, false, '90'::jsonb),
    ('inventory',  'default_sales_warehouse',    'warehouse', null,          null,          null,          null, true,  false, 'null'::jsonb),
    ('security',   'idle_timeout_minutes',       'int',       0,             480,           5,             null, false, true,  '0'::jsonb),
    ('fleet',      'expiry_warning_days',        'int',       1,             365,           null,          null, false, false, '30'::jsonb)
  ) as d(category, key, kind, min_num, max_num, min_nonzero, max_len, branch_scoped, sensitive, default_value)
$$;

-- ---------------------------------------------------------------------------------------------------------
-- drivers
-- ---------------------------------------------------------------------------------------------------------
create table public.drivers (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete restrict default private.current_organization_id(),
  branch_id         uuid not null,
  code              public.entity_code not null,
  name              text not null check (btrim(name) <> '' and length(name) <= 120),
  phone             text check (phone is null or length(phone) <= 40),
  licence_number    text check (licence_number is null or length(licence_number) <= 40),
  licence_class     text check (licence_class is null or length(licence_class) <= 20),
  licence_expiry    date,
  -- optional: the driver's own sign-in, so they can see their runs on a phone (later stage). One driver record per sign-in.
  profile_id        uuid,
  notes             text check (notes is null or length(notes) <= 1000),
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint drivers_branch_fk foreign key (branch_id, organization_id) references public.branches (id, organization_id) on delete restrict,
  constraint drivers_profile_fk foreign key (profile_id, organization_id) references public.profiles (id, organization_id) on delete restrict,
  constraint drivers_org_code_key unique (organization_id, code),
  constraint drivers_id_org_key unique (id, organization_id)
);
create unique index drivers_profile_key on public.drivers (profile_id) where profile_id is not null;
create index drivers_org_branch_idx on public.drivers (organization_id, branch_id, is_active);
create index drivers_licence_expiry_idx on public.drivers (organization_id, licence_expiry) where licence_expiry is not null;
create trigger drivers_immutable before update on public.drivers
  for each row execute function private.prevent_column_change('organization_id', 'created_at');
create trigger drivers_set_updated_at before update on public.drivers
  for each row execute function private.set_updated_at();
create trigger drivers_audit after insert or update on public.drivers
  for each row execute function private.audit_row_change('driver');
create trigger drivers_no_delete before delete on public.drivers
  for each row execute function private.stock_block_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- vehicles
-- ---------------------------------------------------------------------------------------------------------
create table public.vehicles (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete restrict default private.current_organization_id(),
  branch_id           uuid not null,
  registration_number text not null,
  name                text check (name is null or length(name) <= 80),
  vehicle_type        text not null default 'VAN' check (vehicle_type in ('MOTORBIKE', 'CAR', 'VAN', 'PICKUP', 'TRUCK', 'OTHER')),
  capacity_packages   integer check (capacity_packages is null or capacity_packages between 0 and 100000),
  capacity_kg         numeric(10, 2) check (capacity_kg is null or capacity_kg between 0 and 1000000),
  refrigerated        boolean not null default false,
  insurance_expiry    date,
  roadworthy_expiry   date,
  notes               text check (notes is null or length(notes) <= 1000),
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint vehicles_branch_fk foreign key (branch_id, organization_id) references public.branches (id, organization_id) on delete restrict,
  constraint vehicles_registration_format check (registration_number ~ '^[A-Z0-9-]{3,20}$'),
  constraint vehicles_org_registration_key unique (organization_id, registration_number),
  constraint vehicles_id_org_key unique (id, organization_id)
);
create index vehicles_org_branch_idx on public.vehicles (organization_id, branch_id, is_active);
create index vehicles_insurance_idx on public.vehicles (organization_id, insurance_expiry) where insurance_expiry is not null;
create index vehicles_roadworthy_idx on public.vehicles (organization_id, roadworthy_expiry) where roadworthy_expiry is not null;

-- a registration is stored one way (upper case, no spaces), so "gr 1234-24" and "GR1234-24" cannot both exist
create function private.vehicles_normalise()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.registration_number := upper(regexp_replace(btrim(coalesce(new.registration_number, '')), '\s+', '', 'g'));
  return new;
end;
$$;
create trigger vehicles_normalise before insert or update on public.vehicles
  for each row execute function private.vehicles_normalise();
create trigger vehicles_immutable before update on public.vehicles
  for each row execute function private.prevent_column_change('organization_id', 'created_at');
create trigger vehicles_set_updated_at before update on public.vehicles
  for each row execute function private.set_updated_at();
create trigger vehicles_audit after insert or update on public.vehicles
  for each row execute function private.audit_row_change('vehicle');
create trigger vehicles_no_delete before delete on public.vehicles
  for each row execute function private.stock_block_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- row-level security and grants: by organization and branch; no deletes; no writing of organization_id or created_at
-- ---------------------------------------------------------------------------------------------------------
alter table public.drivers enable row level security;
alter table public.vehicles enable row level security;
revoke all on public.drivers, public.vehicles from public, anon, authenticated;
grant select on public.drivers, public.vehicles to authenticated;
grant insert (branch_id, code, name, phone, licence_number, licence_class, licence_expiry, profile_id, notes, is_active) on public.drivers to authenticated;
grant update (branch_id, code, name, phone, licence_number, licence_class, licence_expiry, profile_id, notes, is_active) on public.drivers to authenticated;
grant insert (branch_id, registration_number, name, vehicle_type, capacity_packages, capacity_kg, refrigerated, insurance_expiry, roadworthy_expiry, notes, is_active) on public.vehicles to authenticated;
grant update (branch_id, registration_number, name, vehicle_type, capacity_packages, capacity_kg, refrigerated, insurance_expiry, roadworthy_expiry, notes, is_active) on public.vehicles to authenticated;

create policy drivers_select on public.drivers for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and ((select private.has_permission('fleet.view')) or branch_id in (select private.permitted_branches('fleet.view'))));
create policy drivers_insert on public.drivers for insert to authenticated
  with check (organization_id = (select private.current_organization_id())
              and ((select private.has_permission('fleet.manage')) or branch_id in (select private.permitted_branches('fleet.manage'))));
create policy drivers_update on public.drivers for update to authenticated
  using (organization_id = (select private.current_organization_id())
         and ((select private.has_permission('fleet.manage')) or branch_id in (select private.permitted_branches('fleet.manage'))))
  with check (organization_id = (select private.current_organization_id())
              and ((select private.has_permission('fleet.manage')) or branch_id in (select private.permitted_branches('fleet.manage'))));

create policy vehicles_select on public.vehicles for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and ((select private.has_permission('fleet.view')) or branch_id in (select private.permitted_branches('fleet.view'))));
create policy vehicles_insert on public.vehicles for insert to authenticated
  with check (organization_id = (select private.current_organization_id())
              and ((select private.has_permission('fleet.manage')) or branch_id in (select private.permitted_branches('fleet.manage'))));
create policy vehicles_update on public.vehicles for update to authenticated
  using (organization_id = (select private.current_organization_id())
         and ((select private.has_permission('fleet.manage')) or branch_id in (select private.permitted_branches('fleet.manage'))))
  with check (organization_id = (select private.current_organization_id())
              and ((select private.has_permission('fleet.manage')) or branch_id in (select private.permitted_branches('fleet.manage'))));

commit;
