-- Phase 0 / 04: security helper functions
--
-- All helpers live in the private schema (not exposed by PostgREST) and are
-- SECURITY DEFINER with an empty search_path so they (a) read profiles / user_roles
-- without recursing into RLS and (b) cannot be hijacked through search_path.
-- Every object is schema-qualified. They are STABLE so the planner can cache them.
-- EXECUTE is granted to `authenticated` only because RLS policies must be able to call
-- them; they only ever answer questions about the calling user (auth.uid()), never
-- about an arbitrary caller-supplied user, EXCEPT user_can_access_branch which is
-- reachable only from within definer functions/triggers and is not exposed via the API.

-- The organization of the calling user, or NULL when the caller is not an active
-- member of an active organization. NULL makes every tenant policy fail closed:
-- inactive users and users of deactivated organizations see and change nothing.
create function private.current_organization_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.organization_id
  from public.profiles p
  join public.organizations o on o.id = p.organization_id
  where p.id = auth.uid()
    and p.is_active
    and o.is_active
$$;

create function private.current_profile_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.profiles p
  join public.organizations o on o.id = p.organization_id
  where p.id = auth.uid()
    and p.is_active
    and o.is_active
$$;

-- Does the caller hold permission p_code?
--   p_branch_id IS NULL  -> must hold it ORGANIZATION-WIDE (role assigned without branch)
--   p_branch_id = <id>   -> organization-wide OR assigned for exactly that branch
create function private.has_permission(p_code text, p_branch_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.is_active
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions pm on pm.id = rp.permission_id
    where ur.user_id = auth.uid()
      and ur.organization_id = private.current_organization_id()
      and pm.code = p_code
      and (ur.branch_id is null or (p_branch_id is not null and ur.branch_id = p_branch_id))
  )
$$;

-- Does the caller hold the permission in ANY scope (organization-wide or for some branch)?
-- Used for organization-level reads that every scoped staff member may perform.
create function private.has_permission_anywhere(p_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.is_active
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions pm on pm.id = rp.permission_id
    where ur.user_id = auth.uid()
      and ur.organization_id = private.current_organization_id()
      and pm.code = p_code
  )
$$;

-- May the caller see/operate in this branch (any active role assignment that is
-- organization-wide or scoped to this branch)?
-- NOTE: it deliberately does NOT look the branch up in public.branches (a lookup cannot see
-- a row being inserted by the same statement, which would break INSERT ... RETURNING under
-- RLS). It therefore does not prove the branch belongs to the caller's organization:
-- every policy pairs it with `organization_id = current_organization_id()` on the row.
create function private.can_access_branch(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_branch_id is not null
    and exists (
      select 1
      from public.user_roles ur
      join public.roles r on r.id = ur.role_id and r.is_active
      where ur.user_id = auth.uid()
        and ur.organization_id = private.current_organization_id()
        and (ur.branch_id is null or ur.branch_id = p_branch_id)
    )
$$;

-- Branch that owns a warehouse (only resolvable inside the caller's organization).
create function private.warehouse_branch_id(p_warehouse_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.branch_id
  from public.warehouses w
  where w.id = p_warehouse_id
    and w.organization_id = private.current_organization_id()
$$;

-- Warehouse access currently follows branch access. A future per-warehouse restriction
-- (user_warehouse_access) plugs in here without touching any policy.
create function private.can_access_warehouse(p_warehouse_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_access_branch(private.warehouse_branch_id(p_warehouse_id))
$$;

-- Could this (other) user access the branch through their own role assignments?
-- Used by validation triggers/RPCs. Not callable through the API (see grants).
create function private.user_can_access_branch(p_user_id uuid, p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id and r.is_active
    join public.profiles p on p.id = ur.user_id
    join public.branches b on b.id = p_branch_id and b.organization_id = p.organization_id
    where ur.user_id = p_user_id
      and (ur.branch_id is null or ur.branch_id = p_branch_id)
  )
$$;

-- Anti-escalation: does the caller hold, ORGANIZATION-WIDE, every permission that
-- p_role_id grants? A person can only hand out / take away roles that are no more
-- powerful than their own.
create function private.actor_covers_role(p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from public.role_permissions rp
    join public.permissions pm on pm.id = rp.permission_id
    where rp.role_id = p_role_id
      and not private.has_permission(pm.code)
  )
$$;

-- Lock-out protection: does the organization keep at least one active administrator
-- (organization-wide holder of roles.manage) if the given assignment/user is excluded?
create function private.org_has_other_admin(
  p_organization_id uuid,
  p_excluding_user_role_id uuid default null,
  p_excluding_user_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.profiles p on p.id = ur.user_id and p.is_active
    join public.roles r on r.id = ur.role_id and r.is_active
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions pm on pm.id = rp.permission_id and pm.code = 'roles.manage'
    where ur.organization_id = p_organization_id
      and ur.branch_id is null
      and ur.id is distinct from p_excluding_user_role_id
      and ur.user_id is distinct from p_excluding_user_id
  )
$$;

-- Grants: functions default to EXECUTE for PUBLIC; take that away explicitly.
revoke all on function
  private.current_organization_id(),
  private.current_profile_id(),
  private.has_permission(text, uuid),
  private.has_permission_anywhere(text),
  private.can_access_branch(uuid),
  private.warehouse_branch_id(uuid),
  private.can_access_warehouse(uuid),
  private.user_can_access_branch(uuid, uuid),
  private.actor_covers_role(uuid),
  private.org_has_other_admin(uuid, uuid, uuid)
from public;

grant execute on function
  private.current_organization_id(),
  private.current_profile_id(),
  private.has_permission(text, uuid),
  private.has_permission_anywhere(text),
  private.can_access_branch(uuid),
  private.warehouse_branch_id(uuid),
  private.can_access_warehouse(uuid),
  private.actor_covers_role(uuid)
to authenticated, service_role;

grant execute on function
  private.user_can_access_branch(uuid, uuid),
  private.org_has_other_admin(uuid, uuid, uuid)
to service_role;

-- Profile write guard (runs in addition to RLS and column grants).
--  * default branch must be one the profile's owner can actually access
--  * without users.edit a person may only edit their own personal fields
-- auth.uid() IS NULL means a trusted server context (service role / migrations).
create function private.guard_profile_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.default_branch_id is not null
     and new.default_branch_id is distinct from old.default_branch_id
     and not private.user_can_access_branch(new.id, new.default_branch_id) then
    raise exception 'default branch is not accessible to this user' using errcode = '23514';
  end if;

  if not private.has_permission('users.edit')
     and (new.employee_code is distinct from old.employee_code
          or new.job_title is distinct from old.job_title) then
    raise exception 'insufficient privilege to change employee_code / job_title'
      using errcode = '42501';
  end if;

  return new;
end;
$$;
revoke all on function private.guard_profile_update() from public;

create trigger profiles_guard_update
  before update on public.profiles
  for each row execute function private.guard_profile_update();
