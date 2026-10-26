-- Shortage disposition is recorded in the stock document, never returned to AVAILABLE.
-- NOT_FOUND/OTHER: no physical receipt is asserted. DAMAGED/EXPIRED: quarantine.
create function private.substitution_stock_lines(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s public.fulfilment_substitutions; l public.pick_lines; e public.fulfilment_exceptions; result jsonb;
begin
 select * into s from public.fulfilment_substitutions where id=p_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Substitution not found' using errcode='P0002'; end if;
 select * into l from public.pick_lines where id=s.pick_line_id and organization_id=s.organization_id;
 select * into e from public.fulfilment_exceptions where id=s.exception_id and organization_id=s.organization_id;
 if s.status<>'PENDING' or e.status<>'OPEN' or e.pick_line_id<>l.id then raise exception 'Substitution is no longer pending against an open shortage' using errcode='22023'; end if;
 result:=jsonb_build_array(jsonb_build_object('product_id',l.product_id,'quantity',s.quantity,'batch_id',s.substitute_batch_id,'location_id',l.location_id,'direction','OUT','status','AVAILABLE'));
 if e.reason in ('DAMAGED','EXPIRED') then
   result:=jsonb_build_array(jsonb_build_object('product_id',l.product_id,'quantity',s.quantity,'batch_id',s.original_batch_id,'location_id',l.location_id,'direction','IN','status','QUARANTINE')) || result;
 end if;
 return result;
end $$;
revoke all on function private.substitution_stock_lines(uuid) from public,anon,authenticated;

create or replace function public.approve_batch_substitution(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.fulfilment_substitutions; l public.pick_lines; o public.fulfilment_orders; p public.products; doc jsonb; e public.fulfilment_exceptions;
begin
 select * into s from public.fulfilment_substitutions where id=p_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Substitution not found' using errcode='P0002'; end if;
 o:=private.load_fulfilment_order(s.fulfilment_order_id,'fulfilment.exception');
 select * into s from public.fulfilment_substitutions where id=p_id and organization_id=o.organization_id for update;
 if s.status<>'PENDING' then raise exception 'This substitution is already %',lower(s.status) using errcode='22023'; end if;
 select * into l from public.pick_lines where id=s.pick_line_id and organization_id=o.organization_id for update;
 select * into p from public.products where id=l.product_id and organization_id=o.organization_id;
 if p.is_controlled or p.product_class='CONTROLLED' then raise exception 'Controlled substitutions require the controlled-adjustment approval workflow' using errcode='22023'; end if;
 doc:=private.post_stock('ADJUSTMENT',o.warehouse_id,private.substitution_stock_lines(s.id),null,'OTHER','Substitution '||s.id,'FULFILMENT_SUBSTITUTION',s.id);
 update public.fulfilment_substitutions set status='APPROVED',stock_document_id=(doc->>'document_id')::uuid,decided_by=auth.uid(),decided_at=now() where id=s.id;
 update public.pick_lines set actual_batch_id=s.substitute_batch_id where id=l.id;
 update public.fulfilment_exceptions set status='RESOLVED',decision='SUBSTITUTED',resolution_reason='Batch substituted',substitution_id=s.id,resolved_by=auth.uid(),resolved_at=now() where id=s.exception_id;
 return doc;
end $$;

create or replace function public.request_controlled_batch_substitution(p_substitution_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare s public.fulfilment_substitutions; l public.pick_lines; o public.fulfilment_orders; p public.products; v_id uuid; v_no text;
begin
 select * into s from public.fulfilment_substitutions where id=p_substitution_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Substitution not found' using errcode='P0002'; end if;
 o:=private.load_fulfilment_order(s.fulfilment_order_id,'fulfilment.exception');
 select * into s from public.fulfilment_substitutions where id=p_substitution_id and organization_id=o.organization_id for update;
 if not private.has_permission('inventory.adjust',o.branch_id) then raise exception 'Inventory adjustment permission required' using errcode='42501'; end if;
 if s.status<>'PENDING' then raise exception 'This substitution is already %',lower(s.status) using errcode='22023'; end if;
 select * into l from public.pick_lines where id=s.pick_line_id and organization_id=o.organization_id for update;
 select * into p from public.products where id=l.product_id and organization_id=o.organization_id;
 if not (p.is_controlled or p.product_class='CONTROLLED') then raise exception 'Use the ordinary substitution approval for non-controlled products' using errcode='22023'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 5 and 500 then raise exception 'Explain the controlled substitution (5 to 500 characters)' using errcode='22023'; end if;
 v_no:=private.generate_document_number(o.organization_id,null,'CONTROLLED_ADJUSTMENT','CDA');
 insert into public.controlled_adjustments(organization_id,request_number,branch_id,warehouse_id,reason_code,notes,lines,fulfilment_substitution_id)
 values(o.organization_id,v_no,o.branch_id,o.warehouse_id,'OTHER',btrim(p_reason),private.substitution_stock_lines(s.id),s.id) returning id into v_id;
 update public.fulfilment_substitutions set controlled_adjustment_id=v_id where id=s.id;
 return v_id;
end $$;

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
  if v_req.fulfilment_substitution_id is not null and v_req.lines is distinct from private.substitution_stock_lines(v_req.fulfilment_substitution_id) then
    raise exception 'The pending request uses obsolete shortage stock lines; withdraw it for supervisor review' using errcode='22023';
  end if;
  v_doc := private.post_stock('ADJUSTMENT', v_req.warehouse_id, v_req.lines, null, v_req.reason_code, left(v_req.request_number || ': ' || v_req.notes, 500),
                              'CONTROLLED_ADJUSTMENT', v_req.id);
  update public.controlled_adjustments set status = 'APPROVED', decided_by = auth.uid(), decided_at = now(), stock_document_id = (v_doc ->> 'document_id')::uuid where id = v_req.id;
  return v_doc;
end;
$$;
