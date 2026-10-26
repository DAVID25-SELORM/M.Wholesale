-- Validate both ordinary and controlled approvals inside their posting transaction.
-- The current line model has one actual batch: never mislabel a partly picked line.
create function private.validate_substitution_approval()
returns trigger language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders; e public.fulfilment_exceptions; l public.pick_lines; b public.batches; shelf_days integer;
begin
 if new.status<>'APPROVED' or old.status='APPROVED' then return new; end if;
 select * into o from public.fulfilment_orders where id=new.fulfilment_order_id and organization_id=new.organization_id for update;
 select * into e from public.fulfilment_exceptions where id=new.exception_id and organization_id=new.organization_id for update;
 select * into l from public.pick_lines where id=new.pick_line_id and organization_id=new.organization_id for update;
 if o.status<>'PICKING' or e.status<>'OPEN' or l.status<>'SHORT'
 or e.fulfilment_order_id<>o.id or e.pick_line_id<>l.id or l.fulfilment_order_id<>o.id
 or l.batch_id is distinct from new.original_batch_id or new.quantity<>e.short_quantity then
   raise exception 'The order or short pick has changed; this substitution cannot be approved' using errcode='22023';
 end if;
 if l.picked_quantity<>0 or new.quantity<>l.expected_quantity then
   raise exception 'Partial-line substitution requires separate batch tracking. Ship the picked quantity short or review the pick with a supervisor.' using errcode='22023';
 end if;
 select * into b from public.batches where id=new.substitute_batch_id and product_id=l.product_id and organization_id=new.organization_id;
 select min_shelf_life_days into shelf_days from public.customers where id=o.customer_id and organization_id=o.organization_id;
 if b.id is null or b.expiry_date is null or b.expiry_date<current_date+coalesce(shelf_days,0) then
   raise exception 'The replacement batch no longer meets expiry and shelf-life requirements' using errcode='22023';
 end if;
 if exists(select 1 from public.recall_batch_scope s join public.recalls r on r.id=s.recall_id and r.organization_id=s.organization_id
   where s.batch_id=b.id and s.organization_id=b.organization_id and r.status<>'CANCELLED') then
   raise exception 'A recalled batch cannot be used as a substitute' using errcode='22023';
 end if;
 return new;
end $$;
create trigger fulfilment_substitutions_validate before update of status on public.fulfilment_substitutions
for each row execute function private.validate_substitution_approval();

-- Exception resolution is the last step of both approval paths, after the stock
-- document and actual batch have been recorded. Preserve the original reason in
-- the exception while bringing packing quantities and the queue into agreement.
create function private.complete_substitution_pick()
returns trigger language plpgsql security definer set search_path='' as $$
declare s public.fulfilment_substitutions;
begin
 if new.decision='SUBSTITUTED' and new.status='RESOLVED' and old.status='OPEN' then
   select * into s from public.fulfilment_substitutions where id=new.substitution_id and organization_id=new.organization_id;
   if s.id is null or s.status<>'APPROVED' or s.exception_id<>new.id or s.pick_line_id<>new.pick_line_id then
     raise exception 'An approved matching substitution is required' using errcode='22023';
   end if;
   update public.pick_lines set status='PICKED',picked_quantity=expected_quantity,actual_batch_id=s.substitute_batch_id,
     short_reason=null,short_note=null,picked_by=s.requested_by,picked_at=now()
   where id=new.pick_line_id and organization_id=new.organization_id;
   perform private.settle_fulfilment_order(new.fulfilment_order_id);
 end if;
 return null;
end $$;
create trigger fulfilment_exceptions_complete_substitution after update on public.fulfilment_exceptions
for each row execute function private.complete_substitution_pick();
revoke all on function private.validate_substitution_approval(),private.complete_substitution_pick() from public,anon,authenticated;

create function private.guard_resolved_pick_reset()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='PENDING' and old.status<>'PENDING' and exists(
   select 1 from public.fulfilment_exceptions e where e.pick_line_id=old.id and e.organization_id=old.organization_id
   and e.status='RESOLVED' and e.decision is distinct from 'WITHDRAWN'
 ) then
   raise exception 'A resolved short pick cannot be reset; its stock or credit evidence must be preserved' using errcode='22023';
 end if;
 return new;
end $$;
create trigger pick_lines_guard_resolved_reset before update of status on public.pick_lines
for each row execute function private.guard_resolved_pick_reset();
revoke all on function private.guard_resolved_pick_reset() from public,anon,authenticated;
