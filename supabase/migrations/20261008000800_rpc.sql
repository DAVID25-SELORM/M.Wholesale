-- Phase 0 / 08: RPCs
--
-- All RPCs are SECURITY DEFINER with search_path = '' and derive the acting
-- user and organization from the verified JWT (auth.uid()), never from arguments.
-- Execute is revoked from PUBLIC/anon explicitly (Supabase would otherwise grant it).

-- ---------------------------------------------------------------------------
-- get_session_context(): everything the app shell needs in ONE round trip.
-- Works for inactive users too (returns a status and no permissions) so the UI
-- can show "access disabled" instead of an empty app.
-- ---------------------------------------------------------------------------
create function public.get_session_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_profile public.profiles;
  v_org     public.organizations;
  v_status  text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  if not found then
    return jsonb_build_object('status', 'no_profile', 'user_id', v_uid);
  end if;

  select * into v_org from public.organizations where id = v_profile.organization_id;

  v_status := case
    when not v_profile.is_active then 'inactive_user'
    when not v_org.is_active then 'inactive_organization'
    else 'ok'
  end;

  if v_status <> 'ok' then
    return jsonb_build_object(
      'status', v_status,
      'user_id', v_uid,
      'profile', jsonb_build_object('first_name', v_profile.first_name, 'last_name', v_profile.last_name),
      'organization', jsonb_build_object('id', v_org.id, 'name', v_org.name)
    );
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'user_id', v_uid,
    'profile', jsonb_build_object(
      'first_name', v_profile.first_name,
      'last_name', v_profile.last_name,
      'display_name', coalesce(v_profile.display_name, v_profile.first_name || ' ' || v_profile.last_name),
      'job_title', v_profile.job_title,
      'default_branch_id', v_profile.default_branch_id
    ),
    'organization', jsonb_build_object(
      'id', v_org.id, 'name', v_org.name, 'currency_code', v_org.currency_code,
      'timezone', v_org.timezone, 'country', v_org.country
    ),
    'roles', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', ur.id, 'role_code', r.code, 'role_name', r.name, 'branch_id', ur.branch_id)
               order by r.name), '[]'::jsonb)
      from public.user_roles ur
      join public.roles r on r.id = ur.role_id and r.is_active
      where ur.user_id = v_uid
    ),
    'org_permissions', (
      select coalesce(jsonb_agg(distinct pm.code), '[]'::jsonb)
      from public.user_roles ur
      join public.roles r on r.id = ur.role_id and r.is_active
      join public.role_permissions rp on rp.role_id = ur.role_id
      join public.permissions pm on pm.id = rp.permission_id
      where ur.user_id = v_uid and ur.branch_id is null
    ),
    'branch_permissions', (
      select coalesce(jsonb_object_agg(x.branch_id, x.codes), '{}'::jsonb)
      from (
        select ur.branch_id, jsonb_agg(distinct pm.code) as codes
        from public.user_roles ur
        join public.roles r on r.id = ur.role_id and r.is_active
        join public.role_permissions rp on rp.role_id = ur.role_id
        join public.permissions pm on pm.id = rp.permission_id
        where ur.user_id = v_uid and ur.branch_id is not null
        group by ur.branch_id
      ) x
    ),
    'branches', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', b.id, 'code', b.code, 'name', b.name,
               'is_head_office', b.is_head_office, 'is_active', b.is_active)
               order by b.is_head_office desc, b.name), '[]'::jsonb)
      from public.branches b
      where b.organization_id = v_org.id
        and exists (
          select 1 from public.user_roles ur
          join public.roles r on r.id = ur.role_id and r.is_active
          where ur.user_id = v_uid and (ur.branch_id is null or ur.branch_id = b.id)
        )
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- assign_user_role / revoke_user_role / set_user_active
-- Anti-escalation: the caller must hold, organization-wide, every permission of the role
-- being handed out or taken away. Last-administrator lock-out is prevented.
-- ---------------------------------------------------------------------------
create function public.assign_user_role(
  p_user_id uuid,
  p_role_id uuid,
  p_branch_id uuid default null,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_id  uuid;
begin
  if v_org is null or not private.has_permission('roles.assign') then
    raise exception 'insufficient privilege to assign roles' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id and organization_id = v_org and is_active) then
    raise exception 'user not found in your organization' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.roles r
                 where r.id = p_role_id and r.is_active
                   and (r.organization_id is null or r.organization_id = v_org)) then
    raise exception 'role not found' using errcode = 'P0002';
  end if;
  if p_branch_id is not null
     and not exists (select 1 from public.branches where id = p_branch_id and organization_id = v_org) then
    raise exception 'branch not found in your organization' using errcode = 'P0002';
  end if;
  if not private.actor_covers_role(p_role_id) then
    raise exception 'cannot assign a role with permissions you do not hold' using errcode = '42501';
  end if;

  perform set_config('app.audit_reason', coalesce(p_reason, ''), true);
  insert into public.user_roles (user_id, role_id, organization_id, branch_id, created_by)
  values (p_user_id, p_role_id, v_org, p_branch_id, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create function public.revoke_user_role(p_user_role_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_ur  public.user_roles;
  v_grants_admin boolean;
begin
  if v_org is null or not private.has_permission('roles.assign') then
    raise exception 'insufficient privilege to revoke roles' using errcode = '42501';
  end if;
  select * into v_ur from public.user_roles where id = p_user_role_id and organization_id = v_org;
  if not found then
    raise exception 'role assignment not found' using errcode = 'P0002';
  end if;
  if not private.actor_covers_role(v_ur.role_id) then
    raise exception 'cannot revoke a role with permissions you do not hold' using errcode = '42501';
  end if;

  -- serialize administrator changes per organization so two admins cannot remove each other concurrently
  perform pg_advisory_xact_lock(hashtextextended(v_org::text, 0));

  select exists (
    select 1 from public.role_permissions rp
    join public.permissions pm on pm.id = rp.permission_id
    where rp.role_id = v_ur.role_id and pm.code = 'roles.manage'
  ) into v_grants_admin;
  if v_grants_admin and v_ur.branch_id is null
     and not private.org_has_other_admin(v_org, v_ur.id, null) then
    raise exception 'cannot remove the last administrator of the organization' using errcode = '23514';
  end if;

  perform set_config('app.audit_reason', coalesce(p_reason, ''), true);
  delete from public.user_roles where id = p_user_role_id;
end;
$$;

create function public.set_user_active(p_user_id uuid, p_is_active boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_target_is_admin boolean;
begin
  if v_org is null or not private.has_permission('users.deactivate') then
    raise exception 'insufficient privilege to change user status' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'you cannot change your own active status' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id and organization_id = v_org) then
    raise exception 'user not found in your organization' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.user_roles ur
             where ur.user_id = p_user_id and not private.actor_covers_role(ur.role_id)) then
    raise exception 'cannot change a user who holds roles more powerful than yours' using errcode = '42501';
  end if;

  if not p_is_active then
    perform pg_advisory_xact_lock(hashtextextended(v_org::text, 0));
    select exists (
      select 1 from public.user_roles ur
      join public.role_permissions rp on rp.role_id = ur.role_id
      join public.permissions pm on pm.id = rp.permission_id and pm.code = 'roles.manage'
      where ur.user_id = p_user_id and ur.branch_id is null
    ) into v_target_is_admin;
    if v_target_is_admin and not private.org_has_other_admin(v_org, null, p_user_id) then
      raise exception 'cannot deactivate the last administrator of the organization' using errcode = '23514';
    end if;
  end if;

  perform set_config('app.audit_reason', coalesce(p_reason, ''), true);
  update public.profiles set is_active = p_is_active where id = p_user_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Trusted provisioning (service role only - never callable with a user JWT).
-- The auth user must already exist (created by Supabase Auth admin API / invite flow).
-- ---------------------------------------------------------------------------
create function public.provision_organization(
  p_user_id uuid,
  p_first_name text,
  p_last_name text,
  p_name text,
  p_branch_code text default 'HQ',
  p_branch_name text default 'Head Office',
  p_legal_name text default null,
  p_currency_code text default 'GHS',
  p_timezone text default 'Africa/Accra',
  p_country text default 'GH'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org    uuid;
  v_branch uuid;
  v_role   uuid;
begin
  if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'provisioning is restricted to the service role' using errcode = '42501';
  end if;

  insert into public.organizations (name, legal_name, currency_code, timezone, country)
  values (p_name, p_legal_name, p_currency_code, p_timezone, p_country)
  returning id into v_org;

  insert into public.branches (organization_id, code, name, is_head_office)
  values (v_org, p_branch_code, p_branch_name, true)
  returning id into v_branch;

  insert into public.profiles (id, organization_id, first_name, last_name, email, default_branch_id)
  values (p_user_id, v_org, p_first_name, p_last_name,
          (select au.email from auth.users au where au.id = p_user_id), v_branch);

  select id into v_role from public.roles where organization_id is null and code = 'OWNER';
  insert into public.user_roles (user_id, role_id, organization_id, branch_id)
  values (p_user_id, v_role, v_org, null);

  return v_org;
end;
$$;

create function public.provision_user(
  p_user_id uuid,
  p_organization_id uuid,
  p_first_name text,
  p_last_name text,
  p_role_code text,
  p_branch_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role uuid;
begin
  if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'provisioning is restricted to the service role' using errcode = '42501';
  end if;

  select id into v_role from public.roles where organization_id is null and code = p_role_code and is_active;
  if v_role is null then
    raise exception 'unknown role %', p_role_code using errcode = 'P0002';
  end if;

  insert into public.profiles (id, organization_id, first_name, last_name, email, default_branch_id)
  values (p_user_id, p_organization_id, p_first_name, p_last_name,
          (select au.email from auth.users au where au.id = p_user_id), p_branch_id);

  insert into public.user_roles (user_id, role_id, organization_id, branch_id)
  values (p_user_id, v_role, p_organization_id, p_branch_id);
end;
$$;

-- Grants -------------------------------------------------------------------
revoke all on function
  public.get_session_context(),
  public.assign_user_role(uuid, uuid, uuid, text),
  public.revoke_user_role(uuid, text),
  public.set_user_active(uuid, boolean, text),
  public.provision_organization(uuid, text, text, text, text, text, text, text, text, text),
  public.provision_user(uuid, uuid, text, text, text, uuid)
from public, anon, authenticated;

grant execute on function
  public.get_session_context(),
  public.assign_user_role(uuid, uuid, uuid, text),
  public.revoke_user_role(uuid, text),
  public.set_user_active(uuid, boolean, text)
to authenticated, service_role;

grant execute on function
  public.provision_organization(uuid, text, text, text, text, text, text, text, text, text),
  public.provision_user(uuid, uuid, text, text, text, uuid)
to service_role;
