-- Explicit renewal retains agreed pricing and never records receipt of money.
create function public.platform_renew_subscription(p_organization uuid,p_expected_end date,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare s private.platform_subscriptions; next_start date; next_end date; invoice uuid;
begin
 perform private.require_platform('billing');
 if p_expected_end is null or p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Expected period end and reason required' using errcode='22023'; end if;
 perform 1 from public.organizations where id=p_organization and is_active and archived_at is null for update;
 if not found then raise exception 'Active organization required' using errcode='22023'; end if;
 select * into s from private.platform_subscriptions where organization_id=p_organization for update;
 if not found or s.status<>'ACTIVE' then raise exception 'Only active subscriptions can renew' using errcode='22023'; end if;
 if s.ends_on<>p_expected_end then raise exception 'Subscription period changed; refresh before renewing' using errcode='22023'; end if;
 if s.ends_on>=current_date then raise exception 'Renewal is available after the current period ends' using errcode='22023'; end if;
 if not exists(select 1 from private.platform_plans where id=s.plan_id and is_active) then raise exception 'Choose an active plan before renewing' using errcode='22023'; end if;
 next_start:=s.ends_on+1;
 next_end:=(next_start + case s.cycle when 'MONTHLY' then interval '1 month' else interval '1 year' end)::date-1;
 if exists(select 1 from private.platform_invoices where organization_id=p_organization and period_start<=next_end and period_end>=next_start) then
 raise exception 'An invoice already covers the renewal period; review billing history first' using errcode='22023'; end if;
 update private.platform_subscriptions set starts_on=next_start,ends_on=next_end,updated_at=now() where organization_id=p_organization;
 invoice:=public.platform_issue_invoice(p_organization,p_reason);
 insert into private.platform_audit(actor_id,organization_id,action,target_id,metadata) values(auth.uid(),p_organization,'subscription.renewed',invoice,jsonb_build_object('previous_end',p_expected_end,'starts_on',next_start,'ends_on',next_end,'reason',btrim(p_reason)));
 return invoice;
end $$;
revoke all on function public.platform_renew_subscription(uuid,date,text) from public,anon;
grant execute on function public.platform_renew_subscription(uuid,date,text) to authenticated;
