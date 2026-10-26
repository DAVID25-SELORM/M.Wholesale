create or replace function public.approve_batch_substitution(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.fulfilment_substitutions; l public.pick_lines; o public.fulfilment_orders; p public.products; doc jsonb; e public.fulfilment_exceptions;
begin
 select * into s from public.fulfilment_substitutions where id=p_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Substitution not found' using errcode='P0002'; end if;
 o:=private.load_fulfilment_order(s.fulfilment_order_id,'fulfilment.exception');
 if s.status<>'PENDING' then raise exception 'This substitution is already %',lower(s.status) using errcode='22023'; end if;
 select * into l from public.pick_lines where id=s.pick_line_id and organization_id=o.organization_id for update;
 select * into p from public.products where id=l.product_id and organization_id=o.organization_id;
 if p.is_controlled or p.product_class='CONTROLLED' then raise exception 'Controlled substitutions require the controlled-adjustment approval workflow' using errcode='22023'; end if;
 doc:=private.post_stock('ADJUSTMENT',o.warehouse_id,jsonb_build_array(jsonb_build_object('product_id',l.product_id,'quantity',s.quantity,'batch_id',s.original_batch_id,'location_id',l.location_id,'direction','IN'),jsonb_build_object('product_id',l.product_id,'quantity',s.quantity,'batch_id',s.substitute_batch_id,'location_id',l.location_id,'direction','OUT')),null,'OTHER','Substitution '||s.id,'FULFILMENT_SUBSTITUTION',s.id);
 update public.fulfilment_substitutions set status='APPROVED',stock_document_id=(doc->>'document_id')::uuid,decided_by=auth.uid(),decided_at=now() where id=s.id;
 update public.pick_lines set actual_batch_id=s.substitute_batch_id where id=l.id;
 update public.fulfilment_exceptions set status='RESOLVED',decision='SUBSTITUTED',resolution_reason='Batch substituted',substitution_id=s.id,resolved_by=auth.uid(),resolved_at=now() where id=s.exception_id;
 return doc;
end $$;

