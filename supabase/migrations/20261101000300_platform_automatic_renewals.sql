alter table private.platform_subscriptions add column auto_renew boolean not null default false;
alter table private.platform_subscriptions add column auto_renew_by uuid references auth.users(id);
alter table private.platform_subscriptions add column renewal_checked_at timestamptz;
alter table private.platform_subscriptions add column renewal_error text;

create function public.platform_set_auto_renew(p_organization uuid,p_enabled boolean,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform private.require_platform('billing');
 if p_enabled is null or p_reason is null or length(btrim(p_reason)) not between 5 and 500 then raise exception 'Decision and reason required' using errcode='22023'; end if;
 perform 1 from public.organizations where id=p_organization for update;
 update private.platform_subscriptions set auto_renew=p_enabled,auto_renew_by=case when p_enabled then auth.uid() end,renewal_error=null where organization_id=p_organization;
 if not found then raise exception 'Subscription not found' using errcode='P0002'; end if;
 insert into private.platform_audit(actor_id,organization_id,action,metadata) values(auth.uid(),p_organization,'subscription.auto_renew_changed',jsonb_build_object('enabled',p_enabled,'reason',btrim(p_reason)));
end $$;
revoke all on function public.platform_set_auto_renew(uuid,boolean,text) from public,anon;
grant execute on function public.platform_set_auto_renew(uuid,boolean,text) to authenticated;

-- Called by a trusted scheduler. One period per subscription per run, bounded work,
-- row locks and overlapping-period checks make concurrent/repeated runs safe.
create function private.run_subscription_renewals() returns integer
language plpgsql security definer set search_path='' as $$
declare candidate record; s private.platform_subscriptions; next_start date; next_end date; invoice uuid; done integer:=0; failure text;
begin
 for candidate in select organization_id from private.platform_subscriptions where auto_renew and status='ACTIVE' and ends_on<current_date order by renewal_checked_at nulls first,ends_on,organization_id limit 100 loop
  begin
   perform 1 from public.organizations where id=candidate.organization_id and is_active and archived_at is null for update skip locked;
   if not found then continue; end if;
   select * into s from private.platform_subscriptions where organization_id=candidate.organization_id for update;
   if not s.auto_renew or s.status<>'ACTIVE' or s.ends_on>=current_date then continue; end if;
   if not exists(select 1 from private.platform_operators o join auth.users u on u.id=o.user_id where o.user_id=s.auto_renew_by and o.is_active and 'billing'=any(o.permissions) and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null) then raise exception 'Renewal authorizer unavailable' using errcode='42501'; end if;
   if not exists(select 1 from private.platform_plans where id=s.plan_id and is_active) then raise exception 'Plan inactive' using errcode='22023'; end if;
   next_start:=s.ends_on+1;
   next_end:=(next_start+case s.cycle when 'MONTHLY' then interval '1 month' else interval '1 year' end)::date-1;
   if exists(select 1 from private.platform_invoices where organization_id=s.organization_id and period_start<=next_end and period_end>=next_start) then raise exception 'Overlapping invoice' using errcode='23505'; end if;
   insert into private.platform_invoices(organization_id,plan_id,period_start,period_end,currency,amount,created_by) values(s.organization_id,s.plan_id,next_start,next_end,s.agreed_currency,s.agreed_amount,s.auto_renew_by) returning id into invoice;
   update private.platform_subscriptions set starts_on=next_start,ends_on=next_end,updated_at=now(),renewal_checked_at=now(),renewal_error=null where organization_id=s.organization_id;
   insert into private.platform_audit(actor_id,organization_id,action,target_id,metadata) values(null,s.organization_id,'subscription.automatically_renewed',invoice,jsonb_build_object('authorized_by',s.auto_renew_by,'starts_on',next_start,'ends_on',next_end));
   done:=done+1;
  exception when others then
   get stacked diagnostics failure=returned_sqlstate;
   update private.platform_subscriptions set renewal_checked_at=now(),renewal_error=failure where organization_id=candidate.organization_id;
   insert into private.platform_audit(organization_id,action,result,metadata) values(candidate.organization_id,'subscription.automatic_renewal_failed','FAILED',jsonb_build_object('failure_code',failure));
  end;
 end loop;
 return done;
end $$;
revoke all on function private.run_subscription_renewals() from public,anon,authenticated;

-- Install the daily job only where the operator has already enabled pg_cron.
-- The health endpoint reports whether scheduling is actually installed.
do $$ begin
 if exists(select 1 from pg_extension where extname='pg_cron') then
  perform cron.schedule('platform-subscription-renewals','15 0 * * *','select private.run_subscription_renewals()');
 end if;
end $$;

create function public.platform_renewal_scheduler() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare scheduled boolean:=false;
begin
 perform private.require_platform('billing');
 if exists(select 1 from pg_extension where extname='pg_cron') then
  execute 'select exists(select 1 from cron.job where jobname=''platform-subscription-renewals'' and active)' into scheduled;
 end if;
 return jsonb_build_object('scheduled',scheduled,'schedule','Daily at 00:15 (scheduler timezone)','enabled_subscriptions',(select count(*) from private.platform_subscriptions where auto_renew),'failed_subscriptions',(select count(*) from private.platform_subscriptions where auto_renew and renewal_error is not null));
end $$;
revoke all on function public.platform_renewal_scheduler() from public,anon;
grant execute on function public.platform_renewal_scheduler() to authenticated;
