-- Phase 0 / 11: user invitation support
--
-- The invitation itself (sending the e-mail, creating the auth user) needs the service-role key, so it
-- runs in the `invite-user` Edge Function. Authorization stays in the database:
--   1. prepare_invitation()   - called with the CALLER's JWT. Checks users.invite, that the role/branch are
--                               valid for the caller's organization and that the caller is not handing out a
--                               role more powerful than their own (same anti-escalation rule as assign_user_role).
--   2. (Edge Function)        - creates the invited auth user.
--   3. complete_invitation()  - service role only. Creates profile + role assignment and an audit entry
--                               attributed to the person who invited.
-- prepare_resend() is the equivalent pre-check for re-sending a pending invitation.

create function public.prepare_invitation(p_role_id uuid, p_branch_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid := private.current_organization_id();
  v_role public.roles;
begin
  if v_org is null or not private.has_permission('users.invite') then
    raise exception 'insufficient privilege to invite users' using errcode = '42501';
  end if;

  select * into v_role
  from public.roles r
  where r.id = p_role_id and r.is_active and (r.organization_id is null or r.organization_id = v_org);
  if not found then
    raise exception 'role not found' using errcode = 'P0002';
  end if;

  if p_branch_id is not null
     and not exists (select 1 from public.branches b
                     where b.id = p_branch_id and b.organization_id = v_org and b.is_active) then
    raise exception 'branch not found in your organization' using errcode = 'P0002';
  end if;

  if not private.actor_covers_role(p_role_id) then
    raise exception 'cannot invite someone with a role more powerful than your own' using errcode = '42501';
  end if;

  return jsonb_build_object('actor_id', auth.uid(), 'organization_id', v_org, 'role_code', v_role.code);
end;
$$;

create function public.prepare_resend(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_profile public.profiles;
begin
  if v_org is null or not private.has_permission('users.invite') then
    raise exception 'insufficient privilege to invite users' using errcode = '42501';
  end if;

  select * into v_profile from public.profiles p
  where p.id = p_user_id and p.organization_id = v_org and p.is_active;
  if not found or v_profile.email is null then
    raise exception 'user not found in your organization' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.user_roles ur
             where ur.user_id = p_user_id and not private.actor_covers_role(ur.role_id)) then
    raise exception 'cannot manage a user who holds roles more powerful than yours' using errcode = '42501';
  end if;

  return jsonb_build_object('actor_id', auth.uid(), 'organization_id', v_org, 'email', v_profile.email);
end;
$$;

create function public.complete_invitation(
  p_actor_id uuid,
  p_user_id uuid,
  p_organization_id uuid,
  p_first_name text,
  p_last_name text,
  p_role_id uuid,
  p_branch_id uuid default null,
  p_job_title text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role_code text;
begin
  if auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'restricted to the service role' using errcode = '42501';
  end if;

  if not exists (select 1 from public.profiles a
                 where a.id = p_actor_id and a.organization_id = p_organization_id and a.is_active) then
    raise exception 'inviting user is not an active member of the organization' using errcode = '42501';
  end if;

  select r.code into v_role_code
  from public.roles r
  where r.id = p_role_id and r.is_active and (r.organization_id is null or r.organization_id = p_organization_id);
  if v_role_code is null then
    raise exception 'role not found' using errcode = 'P0002';
  end if;

  insert into public.profiles (id, organization_id, first_name, last_name, email, job_title, default_branch_id)
  values (p_user_id, p_organization_id, p_first_name, p_last_name,
          (select au.email from auth.users au where au.id = p_user_id),
          nullif(btrim(p_job_title), ''), p_branch_id);

  insert into public.user_roles (user_id, role_id, organization_id, branch_id, created_by)
  values (p_user_id, p_role_id, p_organization_id, p_branch_id, p_actor_id);

  insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, branch_id,
                                 new_values, metadata)
  values (p_organization_id, p_actor_id, 'user.invited', 'user', p_user_id::text, p_branch_id,
          jsonb_build_object('role_code', v_role_code, 'branch_id', p_branch_id),
          jsonb_build_object('via', 'invite-user'));
end;
$$;

revoke all on function
  public.prepare_invitation(uuid, uuid),
  public.prepare_resend(uuid),
  public.complete_invitation(uuid, uuid, uuid, text, text, uuid, uuid, text)
from public, anon, authenticated;

grant execute on function public.prepare_invitation(uuid, uuid), public.prepare_resend(uuid)
  to authenticated, service_role;
grant execute on function public.complete_invitation(uuid, uuid, uuid, text, text, uuid, uuid, text)
  to service_role;
