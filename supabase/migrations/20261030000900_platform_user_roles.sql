create function public.platform_user_roles(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p public.profiles;
begin
 perform private.require_platform('users');
 select * into p from public.profiles where id=p_user;
 if not found then raise exception 'User not found' using errcode='P0002'; end if;
 return jsonb_build_object('roles',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'code',r.code) order by r.name),'[]') from public.roles r where r.is_active and (r.organization_id is null or r.organization_id=p.organization_id) and r.code not in ('OWNER','SUPER_ADMIN')),
 'branches',(select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'name',b.name) order by b.name),'[]') from public.branches b where b.organization_id=p.organization_id and b.is_active),
 'assigned',(select coalesce(jsonb_agg(jsonb_build_object('id',ur.id,'role_id',r.id,'name',r.name,'code',r.code,'branch_id',ur.branch_id,'branch',b.name)),'[]') from public.user_roles ur join public.roles r on r.id=ur.role_id left join public.branches b on b.id=ur.branch_id where ur.user_id=p.id));
end $$;
create function public.platform_change_user_role(p_user uuid,p_role uuid,p_branch uuid,p_grant boolean,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare p public.profiles; r public.roles;
begin
 perform private.require_platform('users');
 if p_grant is null or p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Decision and reason required' using errcode='22023'; end if;
 select * into p from public.profiles where id=p_user for update;
 if not found then raise exception 'User not found' using errcode='P0002'; end if;
 if p_user=auth.uid() then raise exception 'Another administrator must change your roles' using errcode='42501'; end if;
 select * into r from public.roles where id=p_role and (organization_id is null or organization_id=p.organization_id);
 if not found or r.code in ('OWNER','SUPER_ADMIN') then raise exception 'This role requires a dedicated ownership workflow' using errcode='42501'; end if;
 if p_grant and not r.is_active then raise exception 'Role is inactive' using errcode='22023'; end if;
 if p_branch is not null and not exists(select 1 from public.branches where id=p_branch and organization_id=p.organization_id and (is_active or not p_grant)) then raise exception 'Branch not found' using errcode='22023'; end if;
 if p_grant then
 insert into public.user_roles(user_id,role_id,organization_id,branch_id,created_by) values(p.id,r.id,p.organization_id,p_branch,auth.uid()) on conflict do nothing;
 else delete from public.user_roles where user_id=p.id and role_id=r.id and branch_id is not distinct from p_branch;
 end if;
 insert into private.platform_audit(actor_id,organization_id,action,target_id,metadata) values(auth.uid(),p.organization_id,case when p_grant then 'user.role_granted' else 'user.role_revoked' end,p.id,jsonb_build_object('role_id',r.id,'branch_id',p_branch,'reason',btrim(p_reason)));
end $$;
revoke all on function public.platform_user_roles(uuid),public.platform_change_user_role(uuid,uuid,uuid,boolean,text) from public,anon;
grant execute on function public.platform_user_roles(uuid),public.platform_change_user_role(uuid,uuid,uuid,boolean,text) to authenticated;
