-- Reviewable onboarding requests. Provisioning failures roll back their changes
-- inside a subtransaction while retaining a sanitized failure record for retry.
create table private.platform_onboarding_queue (
 id uuid primary key, owner_id uuid not null references auth.users(id),
 details jsonb not null, status text not null default 'PENDING' check(status in ('PENDING','COMPLETED','REJECTED','FAILED')),
 organization_id uuid references public.organizations(id), requested_by uuid not null references auth.users(id),
 decided_by uuid references auth.users(id), decision_note text, failure_code text, attempts integer not null default 0,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index platform_onboarding_owner_pending on private.platform_onboarding_queue(owner_id) where status in ('PENDING','FAILED');
revoke all on private.platform_onboarding_queue from public,anon,authenticated;

create function public.platform_submit_onboarding(p_id uuid,p_details jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare owner uuid; d jsonb; existing private.platform_onboarding_queue;
begin
 perform private.require_platform('organizations');
 if p_id is null or jsonb_typeof(p_details) is distinct from 'object' then raise exception 'Request ID and details required' using errcode='22023'; end if;
 d:=jsonb_build_object('email',lower(btrim(p_details->>'email')),'first',btrim(p_details->>'first'),'last',btrim(p_details->>'last'),'name',btrim(p_details->>'name'),'currency',p_details->>'currency','country',p_details->>'country','timezone',p_details->>'timezone');
 if coalesce(length(d->>'name'),0) not between 2 and 200 or coalesce(length(d->>'first'),0) not between 1 and 100 or coalesce(length(d->>'last'),0) not between 1 and 100 or coalesce(d->>'currency','') !~ '^[A-Z]{3}$' or coalesce(d->>'country','') !~ '^[A-Z]{2}$' or not exists(select 1 from pg_catalog.pg_timezone_names where name=d->>'timezone') then raise exception 'Invalid organization or owner details' using errcode='22023'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_id::text,1));
 select * into existing from private.platform_onboarding_queue where id=p_id;
 if found then
 if existing.details<>d then raise exception 'This request reference has different details' using errcode='22023'; end if;
 return existing.id;
 end if;
 select id into owner from auth.users u where lower(email)=d->>'email' and nullif(to_jsonb(u)->>'email_confirmed_at','') is not null for update;
 if owner is null then raise exception 'Verified owner account not found' using errcode='22023'; end if;
 if exists(select 1 from public.profiles where id=owner) then raise exception 'Owner already belongs to an organization' using errcode='22023'; end if;
 insert into private.platform_onboarding_queue(id,owner_id,details,requested_by) values(p_id,owner,d,auth.uid());
 insert into private.platform_audit(actor_id,action,target_id) values(auth.uid(),'onboarding.submitted',p_id);
 return p_id;
end $$;

create function public.platform_onboarding_requests(p_page integer default 0,p_status text default 'ALL') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare rows jsonb; total bigint;
begin
 perform private.require_platform('organizations');
 if p_page is null or p_page<0 or p_page>100000 or p_status is null or p_status not in ('ALL','PENDING','FAILED','COMPLETED','REJECTED') then raise exception 'Invalid request filter' using errcode='22023'; end if;
 select count(*) into total from private.platform_onboarding_queue where p_status='ALL' or status=p_status;
 select coalesce(jsonb_agg(x),'[]') into rows from (select id,details->>'name' name,details->>'email' owner_email,details,status,organization_id,requested_by,decided_by,decision_note,failure_code,attempts,created_at from private.platform_onboarding_queue where p_status='ALL' or status=p_status order by created_at desc,id limit 25 offset p_page*25) x;
 return jsonb_build_object('rows',rows,'total',total);
end $$;

create function public.platform_decide_onboarding(p_id uuid,p_approve boolean,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q private.platform_onboarding_queue; org uuid; code text;
begin
 perform private.require_platform('organizations');
 if p_approve is null or p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Approval decision and reason required' using errcode='22023'; end if;
 select * into q from private.platform_onboarding_queue where id=p_id for update;
 if not found then raise exception 'Onboarding request not found' using errcode='P0002'; end if;
 if q.status='COMPLETED' and p_approve then return jsonb_build_object('status',q.status,'organization_id',q.organization_id); end if;
 if q.status not in ('PENDING','FAILED') then raise exception 'This request has already been decided' using errcode='22023'; end if;
 if p_approve then
 begin
 org:=public.onboard_tenant(q.id,q.owner_id,q.details->>'first',q.details->>'last',q.details->>'name',q.details->>'currency',q.details->>'timezone',q.details->>'country');
 exception when others then
 get stacked diagnostics code=returned_sqlstate;
 end;
 end if;
 update private.platform_onboarding_queue set status=case when not p_approve then 'REJECTED' when org is not null then 'COMPLETED' else 'FAILED' end,
 organization_id=org,decided_by=auth.uid(),decision_note=btrim(p_reason),failure_code=code,attempts=attempts+case when p_approve then 1 else 0 end,updated_at=now() where id=p_id;
 insert into private.platform_audit(actor_id,organization_id,action,target_id,result,metadata) values(auth.uid(),org,case when not p_approve then 'onboarding.rejected' when org is not null then 'onboarding.completed' else 'onboarding.failed' end,p_id,case when code is null then 'SUCCESS' else 'FAILED' end,jsonb_build_object('reason',btrim(p_reason),'failure_code',code));
 return jsonb_build_object('status',case when not p_approve then 'REJECTED' when org is not null then 'COMPLETED' else 'FAILED' end,'organization_id',org,'failure_code',code);
end $$;
revoke all on function public.platform_submit_onboarding(uuid,jsonb),public.platform_onboarding_requests(integer,text),public.platform_decide_onboarding(uuid,boolean,text) from public,anon;
grant execute on function public.platform_submit_onboarding(uuid,jsonb),public.platform_onboarding_requests(integer,text),public.platform_decide_onboarding(uuid,boolean,text) to authenticated;
