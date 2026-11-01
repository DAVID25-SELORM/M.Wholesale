-- Trials are inclusive of both dates; non-trial access keeps existing behavior.
create function private.trial_access_allowed(p_organization uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select not exists(select 1 from private.platform_subscriptions s where s.organization_id=p_organization and s.status='TRIAL' and current_date not between s.starts_on and s.ends_on)
$$;
revoke all on function private.trial_access_allowed(uuid) from public,anon,authenticated;

create or replace function private.current_organization_id() returns uuid
language sql stable security definer set search_path='' as $$
 select p.organization_id from public.profiles p join public.organizations o on o.id=p.organization_id
 where p.id=auth.uid() and p.is_active and o.is_active and private.trial_access_allowed(o.id)
$$;
create or replace function private.current_profile_id() returns uuid
language sql stable security definer set search_path='' as $$
 select p.id from public.profiles p where p.id=auth.uid() and p.is_active and p.organization_id=private.current_organization_id()
$$;

create function private.validate_trial_period() returns trigger
language plpgsql security definer set search_path='' as $$
declare days integer;
begin
 if new.status<>'TRIAL' then return new; end if;
 select trial_days into days from private.platform_plans where id=new.plan_id;
 if days is null or days=0 or new.ends_on-new.starts_on+1>days then
 raise exception 'Trial dates exceed the plan trial duration, or this plan does not offer a trial' using errcode='22023'; end if;
 return new;
end $$;
revoke all on function private.validate_trial_period() from public,anon,authenticated;
create trigger subscription_trial_period before insert or update on private.platform_subscriptions for each row execute function private.validate_trial_period();

do $$ declare definition text; begin
 definition:=pg_get_functiondef('public.get_session_context()'::regprocedure);
 if position('when not v_org.is_active then ''inactive_organization''' in definition)=0 then raise exception 'Unexpected session context definition'; end if;
 definition:=replace(definition,'when not v_org.is_active then ''inactive_organization''',
 'when not v_org.is_active then ''inactive_organization''
    when not private.trial_access_allowed(v_org.id) then ''trial_unavailable''');
 execute definition;
end $$;
