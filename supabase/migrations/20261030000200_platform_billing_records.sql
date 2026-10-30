-- Billing records do not collect money. No authenticated RPC can mark an invoice
-- paid or insert a payment. Provider verification must be implemented server-side.
alter table private.platform_subscriptions add column agreed_currency text;
alter table private.platform_subscriptions add column agreed_amount numeric(18,2);
update private.platform_subscriptions s set agreed_currency=p.currency,agreed_amount=case s.cycle when 'MONTHLY' then p.monthly_price else p.annual_price end from private.platform_plans p where p.id=s.plan_id;
alter table private.platform_subscriptions alter column agreed_currency set not null;
alter table private.platform_subscriptions alter column agreed_amount set not null;
create function private.snapshot_subscription_price() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' then
 select currency,case new.cycle when 'MONTHLY' then monthly_price else annual_price end into new.agreed_currency,new.agreed_amount from private.platform_plans where id=new.plan_id;
 elsif new.plan_id is distinct from old.plan_id or new.cycle is distinct from old.cycle then
 select currency,case new.cycle when 'MONTHLY' then monthly_price else annual_price end into new.agreed_currency,new.agreed_amount from private.platform_plans where id=new.plan_id;
 end if;
 return new;
end $$;
revoke all on function private.snapshot_subscription_price() from public,anon,authenticated;
create trigger subscription_price_snapshot before insert or update on private.platform_subscriptions for each row execute function private.snapshot_subscription_price();
create table private.platform_invoices (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 plan_id uuid not null references private.platform_plans(id), period_start date not null, period_end date not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'), amount numeric(18,2) not null check(amount>=0 and amount<1000000000),
 status text not null default 'OPEN' check(status in ('OPEN','VOID','PAID')), created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 unique(organization_id,period_start,period_end), check(period_end>=period_start)
);
create table private.platform_payments (
 id uuid primary key default gen_random_uuid(), invoice_id uuid not null references private.platform_invoices(id),
 provider text not null, provider_reference text not null, amount numeric(18,2) not null check(amount>0 and amount<1000000000),
 currency text not null check(currency ~ '^[A-Z]{3}$'), verified_at timestamptz not null,
 unique(provider,provider_reference)
);
revoke all on private.platform_invoices,private.platform_payments from public,anon,authenticated;
create trigger platform_payments_immutable before update or delete on private.platform_payments for each row execute function private.stock_block_mutation();

create function public.platform_billing(p_section text,p_page integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rows jsonb; n bigint;
begin
 perform private.require_platform('billing');
 if p_page is null or p_page<0 or p_page>100000 then raise exception 'Invalid page'; end if;
 if p_section='invoices' then
 select count(*) into n from private.platform_invoices;
 select coalesce(jsonb_agg(x),'[]') into rows from (select i.*,o.name organization from private.platform_invoices i join public.organizations o on o.id=i.organization_id order by i.created_at desc,i.id limit 25 offset p_page*25) x;
 elsif p_section='payments' then
 select count(*) into n from private.platform_payments;
 select coalesce(jsonb_agg(x),'[]') into rows from (select * from private.platform_payments order by verified_at desc,id limit 25 offset p_page*25) x;
 elsif p_section='options' then
 return jsonb_build_object('organizations',(select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) order by o.name),'[]') from public.organizations o where archived_at is null),
 'plans',(select coalesce(jsonb_agg(p order by name),'[]') from private.platform_plans p where is_active));
 elsif p_section='revenue' then
 return jsonb_build_object('recurring',(select coalesce(jsonb_agg(x),'[]') from (select s.agreed_currency currency,sum(case s.cycle when 'MONTHLY' then s.agreed_amount else s.agreed_amount/12 end) monthly_recurring_value from private.platform_subscriptions s where s.status='ACTIVE' and current_date between starts_on and ends_on group by s.agreed_currency) x),
 'collected',(select coalesce(jsonb_agg(x),'[]') from (select currency,sum(amount) amount from private.platform_payments group by currency) x),
 'collection_status','UNCONFIGURED');
 else raise exception 'Unknown billing section'; end if;
 return jsonb_build_object('rows',rows,'total',n);
end $$;

create function public.platform_issue_invoice(p_organization uuid,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare s private.platform_subscriptions; p private.platform_plans; result uuid;
begin
 perform private.require_platform('billing');
 if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Invoice reason required'; end if;
 select * into s from private.platform_subscriptions where organization_id=p_organization for update;
 if not found or s.status<>'ACTIVE' then raise exception 'An active subscription is required'; end if;
 select * into p from private.platform_plans where id=s.plan_id;
 insert into private.platform_invoices(organization_id,plan_id,period_start,period_end,currency,amount,created_by)
 values(s.organization_id,s.plan_id,s.starts_on,s.ends_on,s.agreed_currency,s.agreed_amount,auth.uid())
 on conflict(organization_id,period_start,period_end) do nothing returning id into result;
 if result is null then select id into result from private.platform_invoices where organization_id=s.organization_id and period_start=s.starts_on and period_end=s.ends_on;
 else insert into private.platform_audit(actor_id,organization_id,action,target_id,metadata) values(auth.uid(),s.organization_id,'invoice.created',result,jsonb_build_object('reason',btrim(p_reason))); end if;
 return result;
end $$;
revoke all on function public.platform_billing(text,integer),public.platform_issue_invoice(uuid,text) from public,anon;
grant execute on function public.platform_billing(text,integer),public.platform_issue_invoice(uuid,text) to authenticated;
