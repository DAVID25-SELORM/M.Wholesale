-- Explicit replacement of one organization-wide owner. Other roles are retained.
create function public.platform_transfer_ownership(p_organization uuid,p_previous uuid,p_next uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare owner_role uuid;
begin
 perform private.require_platform('organizations');
 perform private.require_platform('users');
 if p_previous is null or p_next is null or p_previous=p_next or p_reason is null or length(btrim(p_reason)) not between 5 and 500 then
 raise exception 'Choose two different members and give a transfer reason (5 to 500 characters)' using errcode='22023'; end if;
 if auth.uid() in (p_previous,p_next) then raise exception 'An independent platform administrator must transfer ownership' using errcode='42501'; end if;
 perform 1 from public.organizations where id=p_organization and is_active and archived_at is null for update;
 if not found then raise exception 'Active organization not found' using errcode='P0002'; end if;
 perform 1 from public.profiles where organization_id=p_organization and id in (p_previous,p_next) order by id for update;
 select id into owner_role from public.roles where organization_id is null and code='OWNER' and is_active;
 if owner_role is null then raise exception 'Owner role unavailable' using errcode='22023'; end if;
 if not exists(select 1 from public.user_roles where organization_id=p_organization and user_id=p_previous and role_id=owner_role and branch_id is null) then
 raise exception 'Previous owner has changed; refresh before transferring' using errcode='22023'; end if;
 if not exists(select 1 from public.profiles p join auth.users u on u.id=p.id where p.id=p_next and p.organization_id=p_organization and p.is_active and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null) then
 raise exception 'New owner must be an active verified member of this organization' using errcode='22023'; end if;
 insert into public.user_roles(user_id,role_id,organization_id,created_by) values(p_next,owner_role,p_organization,auth.uid()) on conflict do nothing;
 delete from public.user_roles where organization_id=p_organization and user_id=p_previous and role_id=owner_role;
 insert into private.platform_audit(actor_id,organization_id,action,target_id,metadata) values(auth.uid(),p_organization,'organization.ownership_transferred',p_next,jsonb_build_object('previous_owner',p_previous,'new_owner',p_next,'reason',btrim(p_reason)));
end $$;
revoke all on function public.platform_transfer_ownership(uuid,uuid,uuid,text) from public,anon;
grant execute on function public.platform_transfer_ownership(uuid,uuid,uuid,text) to authenticated;

create function public.platform_ownership_options(p_organization uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_platform('organizations');
 perform private.require_platform('users');
 if not exists(select 1 from public.organizations where id=p_organization and is_active and archived_at is null) then
 raise exception 'Active organization not found' using errcode='P0002'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.first_name||' '||p.last_name,'email',p.email,
 'eligible',p.is_active and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null and p.id<>auth.uid(),
 'is_owner',exists(select 1 from public.user_roles ur join public.roles r on r.id=ur.role_id where ur.user_id=p.id and ur.organization_id=p_organization and ur.branch_id is null and r.organization_id is null and r.code='OWNER')) order by p.first_name,p.last_name,p.id),'[]')
 from public.profiles p join auth.users u on u.id=p.id where p.organization_id=p_organization);
end $$;
revoke all on function public.platform_ownership_options(uuid) from public,anon;
grant execute on function public.platform_ownership_options(uuid) to authenticated;
