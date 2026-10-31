create function public.platform_organization_activity(p_organization uuid,p_page integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare rows jsonb; total bigint;
begin
 perform private.require_platform('organizations');
 perform private.require_platform('audit');
 if p_page is null or p_page<0 or p_page>100000 then raise exception 'Invalid page' using errcode='22023'; end if;
 if not exists(select 1 from public.organizations where id=p_organization) then raise exception 'Organization not found' using errcode='P0002'; end if;
 select count(*) into total from private.platform_audit where organization_id=p_organization;
 select coalesce(jsonb_agg(x),'[]') into rows from (
 select id,actor_id,action,target_id,result,metadata,created_at from private.platform_audit
 where organization_id=p_organization order by created_at desc,id desc limit 25 offset p_page*25
 ) x;
 return jsonb_build_object('rows',rows,'total',total);
end $$;
revoke all on function public.platform_organization_activity(uuid,integer) from public,anon;
grant execute on function public.platform_organization_activity(uuid,integer) to authenticated;
