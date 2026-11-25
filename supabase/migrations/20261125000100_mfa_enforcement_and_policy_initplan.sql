-- Multi-factor sign-in, enforced by the database.
-- Once a person has a VERIFIED second factor, a session that has only passed the password (assurance level
-- aal1) gets no organization identity and no platform access, so every policy and function refuses it. This
-- is not a screen-only check: it holds for direct API calls too. People without a factor are unaffected.
-- Lost-device recovery: an administrator of the Supabase project removes the person's factor
-- (Authentication -> Users), after verifying who they are.
-- Also: the three row policies the performance advisor flagged now evaluate auth.uid() once per query.

create function private.mfa_satisfied() returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal', 'aal1') = 'aal2'
     or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status::text = 'verified')
$$;
revoke all on function private.mfa_satisfied() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION private.current_organization_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select p.organization_id from public.profiles p join public.organizations o on o.id=p.organization_id
 where p.id=auth.uid() and p.is_active and o.is_active and private.trial_access_allowed(o.id) and private.session_access_allowed() and private.mfa_satisfied()
$function$;

CREATE OR REPLACE FUNCTION private.is_platform_operator()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select exists(select 1 from private.platform_operators o join auth.users u on u.id=o.user_id
 where o.user_id=auth.uid() and private.session_access_allowed() and private.mfa_satisfied() and o.is_active and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null)
$function$;

CREATE OR REPLACE FUNCTION public.get_session_context()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    if not private.mfa_satisfied() then
      return jsonb_build_object('status', 'mfa_required', 'user_id', v_uid);
    end if;
    return jsonb_build_object('status', 'no_profile', 'user_id', v_uid);
  end if;

  select * into v_org from public.organizations where id = v_profile.organization_id;

  v_status := case
    when not private.session_access_allowed() then 'session_revoked'
    when not v_profile.is_active then 'inactive_user'
    when not v_org.is_active then 'inactive_organization'
    when not private.mfa_satisfied() then 'mfa_required'
    when not private.trial_access_allowed(v_org.id) then 'trial_unavailable'
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
      join public.permissions pm on pm.id = rp.permission_id and private.plan_permission_allowed(pm.code)
      where ur.user_id = v_uid and ur.branch_id is null
    ),
    'branch_permissions', (
      select coalesce(jsonb_object_agg(x.branch_id, x.codes), '{}'::jsonb)
      from (
        select ur.branch_id, jsonb_agg(distinct pm.code) as codes
        from public.user_roles ur
        join public.roles r on r.id = ur.role_id and r.is_active
        join public.role_permissions rp on rp.role_id = ur.role_id
        join public.permissions pm on pm.id = rp.permission_id and private.plan_permission_allowed(pm.code)
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
$function$;

alter policy profiles_select on public.profiles using (
 (id = (select auth.uid())) or ((organization_id = (select private.current_organization_id())) and (select private.has_permission('users.view'))));
alter policy profiles_update on public.profiles using (
 (organization_id = (select private.current_organization_id())) and ((id = (select auth.uid())) or (select private.has_permission('users.edit'))))
 with check (
 (organization_id = (select private.current_organization_id())) and ((id = (select auth.uid())) or (select private.has_permission('users.edit'))));
alter policy user_roles_select on public.user_roles using (
 (organization_id = (select private.current_organization_id())) and ((user_id = (select auth.uid())) or (select private.has_permission('users.view')) or (select private.has_permission('roles.view'))));
