-- Preserve rejected/withdrawn attempts while allowing a new request on an open exception.
alter table public.fulfilment_substitutions drop constraint fulfilment_substitutions_exception_id_key;
create unique index fulfilment_substitutions_active_exception_key
 on public.fulfilment_substitutions(exception_id) where status in ('PENDING','APPROVED');

-- Keep request creation and its approval handoff in one transaction. A failed
-- approval must not leave a unique pending request that the screen cannot retry.
create or replace function public.submit_batch_substitution(p_exception_id uuid,p_substitute_batch_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare e public.fulfilment_exceptions; o public.fulfilment_orders; s public.fulfilment_substitutions; v_id uuid; v_controlled boolean;
begin
 select * into e from public.fulfilment_exceptions where id=p_exception_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Exception not found' using errcode='P0002'; end if;
 o:=private.load_fulfilment_order(e.fulfilment_order_id,'fulfilment.exception');
 select * into e from public.fulfilment_exceptions where id=p_exception_id and organization_id=o.organization_id for update;
 if o.status<>'PICKING' or e.status<>'OPEN' then raise exception 'Only an open short pick on an order being picked can be substituted' using errcode='22023'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 5 and 500 then raise exception 'Give a substitution reason (5 to 500 characters)' using errcode='22023'; end if;
 if exists(select 1 from public.pick_lines where id=e.pick_line_id and organization_id=o.organization_id and picked_quantity<>0) then
   raise exception 'Partial-line substitution requires separate batch tracking. Ship the picked quantity short or review the pick with a supervisor.' using errcode='22023';
 end if;
 select * into s from public.fulfilment_substitutions where exception_id=e.id and organization_id=o.organization_id and status in ('PENDING','APPROVED') for update;
 if found then
   if s.status<>'PENDING' or s.substitute_batch_id<>p_substitute_batch_id then raise exception 'This exception already has a different substitution request' using errcode='22023'; end if;
   if s.controlled_adjustment_id is not null then return s.id; end if;
   v_id:=s.id;
 else
   v_id:=public.request_batch_substitution(e.id,p_substitute_batch_id,p_reason);
 end if;
 select (p.is_controlled or p.product_class='CONTROLLED') into v_controlled
 from public.pick_lines l join public.products p on p.id=l.product_id and p.organization_id=l.organization_id
 where l.id=e.pick_line_id and l.organization_id=o.organization_id;
 if v_controlled then
   perform public.request_controlled_batch_substitution(v_id,p_reason);
 else
   perform public.approve_batch_substitution(v_id);
 end if;
 return v_id;
end $$;
revoke all on function public.submit_batch_substitution(uuid,uuid,text) from public,anon;
grant execute on function public.submit_batch_substitution(uuid,uuid,text) to authenticated;
