-- Empty restrictions preserve existing access. Tenant role permissions still apply.
alter table private.platform_plans add column disabled_modules text[] not null default '{}';
create function private.plan_permission_allowed(p_code text) returns boolean
language sql stable security definer set search_path='' as $$
 select not exists(select 1 from private.platform_subscriptions s join private.platform_plans p on p.id=s.plan_id
 join public.permissions pm on pm.code=p_code
 where s.organization_id=private.current_organization_id() and s.status<>'CANCELLED' and pm.module=any(p.disabled_modules))
$$;
revoke all on function private.plan_permission_allowed(text) from public,anon,authenticated;

do $$ declare signature text; definition text; begin
 foreach signature in array array['private.has_permission(text,uuid)','private.has_permission_anywhere(text)','private.permitted_branches(text)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if position('and pm.code = p_code' in definition)=0 then raise exception 'Unexpected permission definition: %',signature; end if;
  execute replace(definition,'and pm.code = p_code','and pm.code = p_code and private.plan_permission_allowed(p_code)');
 end loop;
 definition:=pg_get_functiondef('public.get_session_context()'::regprocedure);
 if position('join public.permissions pm on pm.id = rp.permission_id' in definition)=0 then raise exception 'Unexpected session permissions definition'; end if;
 execute replace(definition,'join public.permissions pm on pm.id = rp.permission_id','join public.permissions pm on pm.id = rp.permission_id and private.plan_permission_allowed(pm.code)');
end $$;

create function public.platform_plan_features(p_plan uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare disabled text[];
begin
 perform private.require_platform('billing');
 select disabled_modules into disabled from private.platform_plans where id=p_plan;
 if not found then raise exception 'Plan not found' using errcode='P0002'; end if;
 return jsonb_build_object('disabled_modules',disabled,'modules',(select coalesce(jsonb_agg(module order by module),'[]') from (select distinct module from public.permissions where module not in ('organizations','users','roles','branches','warehouses','settings','audit')) x));
end $$;
create function public.platform_set_plan_features(p_plan uuid,p_disabled text[],p_reason text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform private.require_platform('billing');
 if p_reason is null or length(btrim(p_reason)) not between 5 and 500 or p_disabled is null or array_position(p_disabled,null) is not null then raise exception 'Feature selection and reason required' using errcode='22023'; end if;
 if exists(select 1 from unnest(p_disabled) m where m in ('organizations','users','roles','branches','warehouses','settings','audit') or not exists(select 1 from public.permissions where module=m)) then raise exception 'Unknown or foundational module cannot be disabled' using errcode='22023'; end if;
 update private.platform_plans set disabled_modules=array(select distinct m from unnest(p_disabled) m order by m) where id=p_plan;
 if not found then raise exception 'Plan not found' using errcode='P0002'; end if;
 insert into private.platform_audit(actor_id,action,target_id,metadata) values(auth.uid(),'plan.features_changed',p_plan,jsonb_build_object('disabled_modules',p_disabled,'reason',btrim(p_reason)));
end $$;
revoke all on function public.platform_plan_features(uuid),public.platform_set_plan_features(uuid,text[],text) from public,anon;
grant execute on function public.platform_plan_features(uuid),public.platform_set_plan_features(uuid,text[],text) to authenticated;
