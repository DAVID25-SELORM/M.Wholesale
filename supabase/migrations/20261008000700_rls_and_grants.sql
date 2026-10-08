-- Phase 0 / 07: Row Level Security and table privileges
--
-- Defence in depth, three independent layers on every tenant table:
--   1. GRANTs   - `anon` gets nothing; `authenticated` gets only the columns it may write
--                 (organization_id / parent ids / is_active-on-profiles are never client-writable).
--   2. RLS      - every policy is scoped to private.current_organization_id(), which is NULL for
--                 inactive users / inactive organizations (fail closed), and checks permission
--                 (and branch scope) through private.has_permission / can_access_branch.
--   3. Triggers - immutable parents, composite FKs, audit.
-- Supabase grants new public tables to anon/authenticated by default, so every table is
-- explicitly revoked first. There are NO delete grants: history is kept, lifecycle = is_active.
-- Policies use (select fn()) so Postgres evaluates the helper once per statement.

alter table public.organizations       enable row level security;
alter table public.branches            enable row level security;
alter table public.warehouses          enable row level security;
alter table public.warehouse_locations enable row level security;
alter table public.profiles            enable row level security;
alter table public.permissions         enable row level security;
alter table public.roles               enable row level security;
alter table public.role_permissions    enable row level security;
alter table public.user_roles          enable row level security;
alter table public.audit_logs          enable row level security;
alter table public.system_settings     enable row level security;
alter table public.number_sequences    enable row level security;

revoke all on
  public.organizations, public.branches, public.warehouses, public.warehouse_locations,
  public.profiles, public.permissions, public.roles, public.role_permissions,
  public.user_roles, public.audit_logs, public.system_settings, public.number_sequences
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
grant select on public.organizations to authenticated;
grant update (name, legal_name, trading_name, registration_number, tax_number, phone, email,
              address, city, region, country, logo_url, currency_code, timezone)
  on public.organizations to authenticated;

create policy organizations_select on public.organizations
  for select to authenticated
  using (id = (select private.current_organization_id()));
create policy organizations_update on public.organizations
  for update to authenticated
  using (id = (select private.current_organization_id()) and private.has_permission('organizations.manage'))
  with check (id = (select private.current_organization_id()) and private.has_permission('organizations.manage'));

-- ---------------------------------------------------------------------------
-- branches  (organization_id is filled by default from the caller's session, never by the client)
-- ---------------------------------------------------------------------------
alter table public.branches
  alter column organization_id set default private.current_organization_id();

grant select on public.branches to authenticated;
grant insert (code, name, phone, email, address, city, region, is_head_office, is_active)
  on public.branches to authenticated;
grant update (code, name, phone, email, address, city, region, is_head_office, is_active)
  on public.branches to authenticated;

create policy branches_select on public.branches
  for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.can_access_branch(id));
create policy branches_insert on public.branches
  for insert to authenticated
  with check (organization_id = (select private.current_organization_id())
              and private.has_permission('branches.create'));
create policy branches_update on public.branches
  for update to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('branches.edit', id))
  with check (organization_id = (select private.current_organization_id())
              and private.has_permission('branches.edit', id));

-- ---------------------------------------------------------------------------
-- warehouses
-- ---------------------------------------------------------------------------
alter table public.warehouses
  alter column organization_id set default private.current_organization_id();

grant select on public.warehouses to authenticated;
grant insert (branch_id, code, name, description, warehouse_type, is_active)
  on public.warehouses to authenticated;
grant update (code, name, description, warehouse_type, is_active)
  on public.warehouses to authenticated;

create policy warehouses_select on public.warehouses
  for select to authenticated
  using (organization_id = (select private.current_organization_id()) and private.can_access_branch(branch_id));
create policy warehouses_insert on public.warehouses
  for insert to authenticated
  with check (organization_id = (select private.current_organization_id())
              and private.has_permission('warehouses.create', branch_id));
create policy warehouses_update on public.warehouses
  for update to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('warehouses.edit', branch_id))
  with check (organization_id = (select private.current_organization_id())
              and private.has_permission('warehouses.edit', branch_id));

-- ---------------------------------------------------------------------------
-- warehouse_locations
-- ---------------------------------------------------------------------------
alter table public.warehouse_locations
  alter column organization_id set default private.current_organization_id();

grant select on public.warehouse_locations to authenticated;
grant insert (warehouse_id, code, aisle, rack, shelf, bin, description, picking_sequence, is_active)
  on public.warehouse_locations to authenticated;
grant update (code, aisle, rack, shelf, bin, description, picking_sequence, is_active)
  on public.warehouse_locations to authenticated;

create policy warehouse_locations_select on public.warehouse_locations
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.can_access_warehouse(warehouse_id));
create policy warehouse_locations_insert on public.warehouse_locations
  for insert to authenticated
  with check (organization_id = (select private.current_organization_id())
              and private.warehouse_branch_id(warehouse_id) is not null
              and private.has_permission('warehouse_locations.create', private.warehouse_branch_id(warehouse_id)));
create policy warehouse_locations_update on public.warehouse_locations
  for update to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.warehouse_branch_id(warehouse_id) is not null
         and private.has_permission('warehouse_locations.edit', private.warehouse_branch_id(warehouse_id)))
  with check (organization_id = (select private.current_organization_id())
              and private.warehouse_branch_id(warehouse_id) is not null
              and private.has_permission('warehouse_locations.edit', private.warehouse_branch_id(warehouse_id)));

-- ---------------------------------------------------------------------------
-- profiles  (no INSERT: created by trusted provisioning; is_active changes only via
-- public.set_user_active(); organization_id immutable)
-- ---------------------------------------------------------------------------
grant select on public.profiles to authenticated;
grant update (first_name, last_name, display_name, phone, employee_code, job_title, default_branch_id)
  on public.profiles to authenticated;

create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid()
         or (organization_id = (select private.current_organization_id()) and private.has_permission('users.view')));
create policy profiles_update on public.profiles
  for update to authenticated
  using (organization_id = (select private.current_organization_id())
         and (id = auth.uid() or private.has_permission('users.edit')))
  with check (organization_id = (select private.current_organization_id())
              and (id = auth.uid() or private.has_permission('users.edit')));

-- ---------------------------------------------------------------------------
-- RBAC tables: read-only for clients. Writes only through guarded RPCs / migrations.
-- ---------------------------------------------------------------------------
grant select on public.permissions, public.roles, public.role_permissions, public.user_roles
  to authenticated;

create policy permissions_select on public.permissions
  for select to authenticated
  using ((select private.current_organization_id()) is not null);

create policy roles_select on public.roles
  for select to authenticated
  using ((select private.current_organization_id()) is not null
         and (organization_id is null or organization_id = (select private.current_organization_id())));

create policy role_permissions_select on public.role_permissions
  for select to authenticated
  using (private.has_permission('roles.view')
         and exists (select 1 from public.roles r where r.id = role_id));

create policy user_roles_select on public.user_roles
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and (user_id = auth.uid()
              or private.has_permission('users.view') or private.has_permission('roles.view')));

-- ---------------------------------------------------------------------------
-- audit_logs: SELECT only (INSERT happens in SECURITY DEFINER code; mutation blocked by trigger)
-- ---------------------------------------------------------------------------
grant select on public.audit_logs to authenticated;

create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and (private.has_permission('audit.view')
              or (branch_id is not null and private.has_permission('audit.view', branch_id))));

-- ---------------------------------------------------------------------------
-- system_settings / number_sequences
-- ---------------------------------------------------------------------------
alter table public.system_settings
  alter column organization_id set default private.current_organization_id();

grant select on public.system_settings to authenticated;
grant insert (branch_id, category, key, value, description) on public.system_settings to authenticated;
grant update (value, description) on public.system_settings to authenticated;

-- Organization-wide settings are readable by anyone holding settings.view in any scope;
-- a branch's own settings need settings.view for that branch.
create policy system_settings_select on public.system_settings
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and ((branch_id is null and private.has_permission_anywhere('settings.view'))
              or (branch_id is not null and private.has_permission('settings.view', branch_id))));
create policy system_settings_insert on public.system_settings
  for insert to authenticated
  with check (organization_id = (select private.current_organization_id())
              and private.has_permission('settings.manage', branch_id));
create policy system_settings_update on public.system_settings
  for update to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('settings.manage', branch_id))
  with check (organization_id = (select private.current_organization_id())
              and private.has_permission('settings.manage', branch_id));

grant select on public.number_sequences to authenticated;
create policy number_sequences_select on public.number_sequences
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and ((branch_id is null and private.has_permission_anywhere('settings.view'))
              or (branch_id is not null and private.has_permission('settings.view', branch_id))));
