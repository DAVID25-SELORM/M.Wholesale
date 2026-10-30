alter table private.platform_invoices add column voided_at timestamptz;
alter table private.platform_invoices add column voided_by uuid references auth.users(id);
alter table private.platform_invoices add column void_reason text;
create function public.platform_void_invoice(p_id uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare i private.platform_invoices;
begin
 perform private.require_platform('billing');
 if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Give a void reason (3 to 500 characters)' using errcode='22023'; end if;
 select * into i from private.platform_invoices where id=p_id for update;
 if not found then raise exception 'Invoice not found' using errcode='P0002'; end if;
 if i.status='VOID' then return; end if;
 if i.status<>'OPEN' or exists(select 1 from private.platform_payments where invoice_id=i.id) then raise exception 'An invoice with payment evidence cannot be voided' using errcode='22023'; end if;
 update private.platform_invoices set status='VOID',voided_at=now(),voided_by=auth.uid(),void_reason=btrim(p_reason) where id=i.id;
 insert into private.platform_audit(actor_id,organization_id,action,target_id,metadata) values(auth.uid(),i.organization_id,'invoice.voided',i.id,jsonb_build_object('reason',btrim(p_reason)));
end $$;
revoke all on function public.platform_void_invoice(uuid,text) from public,anon;
grant execute on function public.platform_void_invoice(uuid,text) to authenticated;
