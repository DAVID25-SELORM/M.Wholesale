-- Capacity enforcement for assigned plans. Organizations without a subscription
-- retain their existing behavior; limits apply to active users/sites only.
create function private.enforce_platform_capacity() returns trigger
language plpgsql security definer set search_path='' as $$
declare cap integer; used bigint; s private.platform_subscriptions; p private.platform_plans;
begin
 if not new.is_active then return new; end if;
 if tg_op='UPDATE' then if old.is_active then return new; end if; end if;
 -- Serialize capacity checks across concurrent inserts and subscription changes.
 perform 1 from public.organizations where id=new.organization_id for update;
 select * into s from private.platform_subscriptions where organization_id=new.organization_id;
 if not found or s.status='CANCELLED' then return new; end if;
 select * into p from private.platform_plans where id=s.plan_id;
 if tg_table_name='profiles' then
 cap:=p.user_limit; select count(*) into used from public.profiles where organization_id=new.organization_id and is_active and id<>new.id;
 elsif tg_table_name='branches' then
 cap:=p.branch_limit; select count(*) into used from public.branches where organization_id=new.organization_id and is_active and id<>new.id;
 else
 cap:=p.warehouse_limit; select count(*) into used from public.warehouses where organization_id=new.organization_id and is_active and id<>new.id;
 end if;
 if used>=cap then raise exception 'The subscription % limit (%) has been reached',tg_table_name,cap using errcode='22023'; end if;
 return new;
end $$;
revoke all on function private.enforce_platform_capacity() from public,anon,authenticated;
create trigger profiles_platform_capacity before insert or update of is_active on public.profiles for each row execute function private.enforce_platform_capacity();
create trigger branches_platform_capacity before insert or update of is_active on public.branches for each row execute function private.enforce_platform_capacity();
create trigger warehouses_platform_capacity before insert or update of is_active on public.warehouses for each row execute function private.enforce_platform_capacity();

create function private.validate_platform_capacity() returns trigger
language plpgsql security definer set search_path='' as $$
declare p private.platform_plans;
begin
 perform 1 from public.organizations where id=new.organization_id for update;
 select * into p from private.platform_plans where id=new.plan_id;
 if new.status<>'CANCELLED' and ((select count(*) from public.profiles where organization_id=new.organization_id and is_active)>p.user_limit
 or (select count(*) from public.branches where organization_id=new.organization_id and is_active)>p.branch_limit
 or (select count(*) from public.warehouses where organization_id=new.organization_id and is_active)>p.warehouse_limit) then
 raise exception 'Current usage exceeds this plan. Reduce active users or sites before assigning it' using errcode='22023'; end if;
 return new;
end $$;
revoke all on function private.validate_platform_capacity() from public,anon,authenticated;
create trigger subscriptions_capacity before insert or update on private.platform_subscriptions for each row execute function private.validate_platform_capacity();

-- Plan capacity cannot silently shrink beneath existing subscribed usage.
create function private.guard_plan_capacity() returns trigger
language plpgsql security definer set search_path='' as $$
declare s record;
begin
 if new.user_limit>=old.user_limit and new.branch_limit>=old.branch_limit and new.warehouse_limit>=old.warehouse_limit then return new; end if;
 for s in select organization_id from private.platform_subscriptions where plan_id=new.id and status<>'CANCELLED' order by organization_id loop
 perform 1 from public.organizations where id=s.organization_id for update;
 if (select count(*) from public.profiles where organization_id=s.organization_id and is_active)>new.user_limit
 or (select count(*) from public.branches where organization_id=s.organization_id and is_active)>new.branch_limit
 or (select count(*) from public.warehouses where organization_id=s.organization_id and is_active)>new.warehouse_limit then
 raise exception 'Existing subscribed usage exceeds the proposed limits' using errcode='22023'; end if;
 end loop;
 return new;
end $$;
revoke all on function private.guard_plan_capacity() from public,anon,authenticated;
create trigger plans_capacity before update on private.platform_plans for each row execute function private.guard_plan_capacity();
