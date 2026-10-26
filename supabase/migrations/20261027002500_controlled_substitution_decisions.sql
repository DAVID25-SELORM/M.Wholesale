-- Serialize linked controlled decisions with fulfilment operations before locking the request.
create or replace function public.approve_controlled_adjustment(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_req public.controlled_adjustments;
  v_doc jsonb;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_req from public.controlled_adjustments where id = p_id and organization_id = v_org;
  if not found then raise exception 'request not found' using errcode='P0002'; end if;
  if v_req.fulfilment_substitution_id is not null then
    perform o.id from public.fulfilment_orders o join public.fulfilment_substitutions s
      on s.fulfilment_order_id=o.id and s.organization_id=o.organization_id
      where s.id=v_req.fulfilment_substitution_id and s.organization_id=v_org for update of o;
  end if;
  select * into v_req from public.controlled_adjustments where id = p_id and organization_id = v_org for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.controlled_approve', v_req.branch_id) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if v_req.status <> 'PENDING' then
    raise exception 'this request is already %', lower(v_req.status) using errcode = '22023';
  end if;
  if v_req.requested_by = auth.uid() then
    raise exception 'a second person must approve: you cannot approve your own request' using errcode = '42501';
  end if;
  v_doc := private.post_stock('ADJUSTMENT', v_req.warehouse_id, v_req.lines, null, v_req.reason_code, left(v_req.request_number || ': ' || v_req.notes, 500),
                              'CONTROLLED_ADJUSTMENT', v_req.id);
  update public.controlled_adjustments set status = 'APPROVED', decided_by = auth.uid(), decided_at = now(), stock_document_id = (v_doc ->> 'document_id')::uuid where id = v_req.id;
  return v_doc;
end;
$$;

create or replace function public.reject_controlled_adjustment(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_req public.controlled_adjustments;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_req from public.controlled_adjustments where id = p_id and organization_id = v_org;
  if not found then raise exception 'request not found' using errcode='P0002'; end if;
  if v_req.fulfilment_substitution_id is not null then
    perform o.id from public.fulfilment_orders o join public.fulfilment_substitutions s
      on s.fulfilment_order_id=o.id and s.organization_id=o.organization_id
      where s.id=v_req.fulfilment_substitution_id and s.organization_id=v_org for update of o;
  end if;
  select * into v_req from public.controlled_adjustments where id = p_id and organization_id = v_org for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.controlled_approve', v_req.branch_id) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if v_req.status <> 'PENDING' then
    raise exception 'this request is already %', lower(v_req.status) using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 or length(p_reason) > 500 then
    raise exception 'give a reason for rejecting (5 to 500 characters)' using errcode = '22023';
  end if;
  update public.controlled_adjustments set status = 'REJECTED', decided_by = auth.uid(), decided_at = now(), decision_note = btrim(p_reason) where id = v_req.id;
end;
$$;

create or replace function public.cancel_controlled_adjustment(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_req public.controlled_adjustments;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_req from public.controlled_adjustments where id = p_id and organization_id = v_org;
  if not found then raise exception 'request not found' using errcode='P0002'; end if;
  if v_req.fulfilment_substitution_id is not null then
    perform o.id from public.fulfilment_orders o join public.fulfilment_substitutions s
      on s.fulfilment_order_id=o.id and s.organization_id=o.organization_id
      where s.id=v_req.fulfilment_substitution_id and s.organization_id=v_org for update of o;
  end if;
  select * into v_req from public.controlled_adjustments where id = p_id and organization_id = v_org for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if v_req.requested_by <> auth.uid() then
    raise exception 'only the person who made the request can withdraw it' using errcode = '42501';
  end if;
  if v_req.status <> 'PENDING' then
    raise exception 'this request is already %', lower(v_req.status) using errcode = '22023';
  end if;
  update public.controlled_adjustments set status = 'CANCELLED', decided_by = auth.uid(), decided_at = now(), decision_note = 'Withdrawn by the requester' where id = v_req.id;
end;
$$;

-- Preserve the request explanation separately from the eventual decision. Historical reasons are unknown.
alter table public.fulfilment_substitutions add column request_reason text check(request_reason is null or length(btrim(request_reason)) between 3 and 500);
create or replace function public.request_batch_substitution(p_exception_id uuid,p_substitute_batch_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare e public.fulfilment_exceptions; l public.pick_lines; o public.fulfilment_orders; b public.batches; old public.batches; p public.products; c public.customers; v_id uuid; v_on_hand numeric;
begin
 select * into e from public.fulfilment_exceptions where id=p_exception_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Exception not found' using errcode='P0002'; end if;
 o:=private.load_fulfilment_order(e.fulfilment_order_id,'fulfilment.exception');
 select * into e from public.fulfilment_exceptions where id=p_exception_id and organization_id=o.organization_id for update;
 if o.status<>'PICKING' then raise exception 'Order must be picking' using errcode='22023'; end if;
 if e.status<>'OPEN' or e.kind<>'SHORT' then raise exception 'Only an open short pick can be substituted' using errcode='22023'; end if;
 select * into l from public.pick_lines where id=e.pick_line_id and organization_id=o.organization_id for update;
 if l.status<>'SHORT' or l.picked_quantity is distinct from 0::numeric or e.short_quantity<>l.expected_quantity then
   raise exception 'Only an entirely unpicked short line can be substituted' using errcode='22023';
 end if;
 if l.batch_id is null then raise exception 'Only batch-tracked lines can be substituted' using errcode='22023'; end if;
 select * into old from public.batches where id=l.batch_id and organization_id=o.organization_id;
 select * into b from public.batches where id=p_substitute_batch_id and organization_id=o.organization_id and product_id=l.product_id;
 if not found or b.id=old.id or b.expiry_date is null or b.expiry_date < current_date then raise exception 'Choose a different, non-expired batch of the same product' using errcode='22023'; end if;
 if exists(select 1 from public.recall_batch_scope rs join public.recalls r on r.id=rs.recall_id and r.organization_id=rs.organization_id where rs.batch_id=b.id and rs.organization_id=b.organization_id and r.status<>'CANCELLED') then
   raise exception 'A recalled batch cannot be used as a substitute' using errcode='22023';
 end if;
 select * into c from public.customers where id=o.customer_id and organization_id=o.organization_id;
 if c.min_shelf_life_days is not null and b.expiry_date < current_date + c.min_shelf_life_days then raise exception 'The substitute batch does not meet this customer''s minimum shelf life' using errcode='22023'; end if;
 select * into p from public.products where id=l.product_id and organization_id=o.organization_id;
 select coalesce(sum(sb.quantity),0) into v_on_hand from public.stock_balances sb where sb.warehouse_id=o.warehouse_id and sb.product_id=l.product_id and sb.batch_id=b.id and sb.stock_status='AVAILABLE' and sb.organization_id=o.organization_id and sb.location_id is not distinct from l.location_id;
 if v_on_hand<e.short_quantity then raise exception 'The substitute batch does not have enough available stock at the pick location' using errcode='22023'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Give a substitution reason (3 to 500 characters)' using errcode='22023'; end if;
 insert into public.fulfilment_substitutions(organization_id,fulfilment_order_id,pick_line_id,exception_id,branch_id,original_batch_id,substitute_batch_id,quantity,request_reason)
 values(o.organization_id,o.id,l.id,e.id,o.branch_id,old.id,b.id,e.short_quantity,btrim(p_reason)) returning id into v_id;
 return v_id;
end $$;
