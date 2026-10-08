-- Phase 0 / 03: profiles and role-based access control
--
-- Authentication stays with Supabase Auth (auth.users). profiles.id == auth.users.id.
-- Authorization = user_roles (user, role, optional branch scope) -> role_permissions -> permissions.
--   user_roles.branch_id IS NULL     -> role applies organization-wide (all branches)
--   user_roles.branch_id = <branch>  -> role applies to that branch only
-- This replaces a separate user_branch_access table: one source of truth for
-- "what can this person do, and where".

create table public.profiles (
  id                uuid primary key references auth.users (id) on delete restrict,
  organization_id   uuid not null references public.organizations (id) on delete restrict,
  first_name        text not null check (btrim(first_name) <> ''),
  last_name         text not null check (btrim(last_name) <> ''),
  -- denormalised copy of auth.users.email for display/search; Supabase Auth stays the authority
  email             text,
  display_name      text,
  phone             text,
  employee_code     text check (employee_code is null or btrim(employee_code) <> ''),
  job_title         text,
  default_branch_id uuid,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint profiles_id_org_key unique (id, organization_id),
  constraint profiles_default_branch_fk foreign key (default_branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict
);
create index profiles_org_idx on public.profiles (organization_id, is_active);
create index profiles_default_branch_idx on public.profiles (default_branch_id)
  where default_branch_id is not null;
create unique index profiles_org_employee_code_key
  on public.profiles (organization_id, employee_code) where employee_code is not null;
create index profiles_org_name_idx on public.profiles (organization_id, last_name, first_name);

create trigger profiles_immutable before update on public.profiles
  for each row execute function private.prevent_column_change('organization_id');
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();

create table public.permissions (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  module      text not null check (module ~ '^[a-z][a-z_]*$'),
  action      text not null check (action ~ '^[a-z][a-z_]*$'),
  description text not null,
  constraint permissions_code_matches check (code = module || '.' || action)
);

-- System roles (is_system_role) are global templates: organization_id IS NULL, editable
-- only by migrations. Organization roles (organization_id set) are reserved for later.
create table public.roles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete restrict,
  code            text not null check (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  name            text not null check (btrim(name) <> ''),
  description     text,
  is_system_role  boolean not null default false,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint roles_scope_matches_kind check (is_system_role = (organization_id is null)),
  constraint roles_org_code_key unique nulls not distinct (organization_id, code)
);
create trigger roles_set_updated_at before update on public.roles
  for each row execute function private.set_updated_at();

create table public.role_permissions (
  role_id       uuid not null references public.roles (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete restrict,
  primary key (role_id, permission_id)
);
create index role_permissions_permission_idx on public.role_permissions (permission_id);

create table public.user_roles (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,
  role_id         uuid not null references public.roles (id) on delete restrict,
  organization_id uuid not null,
  branch_id       uuid,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  constraint user_roles_profile_fk foreign key (user_id, organization_id)
    references public.profiles (id, organization_id) on delete restrict,
  constraint user_roles_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint user_roles_unique unique nulls not distinct (user_id, role_id, branch_id)
);
create index user_roles_user_idx on public.user_roles (user_id);
create index user_roles_role_idx on public.user_roles (role_id);
create index user_roles_org_branch_idx on public.user_roles (organization_id, branch_id);

create function private.validate_user_role()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_role public.roles;
begin
  select * into v_role from public.roles where id = new.role_id;
  if v_role.organization_id is not null and v_role.organization_id <> new.organization_id then
    raise exception 'role belongs to a different organization' using errcode = '23514';
  end if;
  if not v_role.is_active then
    raise exception 'role % is inactive', v_role.code using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger user_roles_validate before insert on public.user_roles
  for each row execute function private.validate_user_role();
create trigger user_roles_immutable before update on public.user_roles
  for each row execute function private.prevent_column_change(
    'user_id', 'role_id', 'organization_id', 'branch_id');
