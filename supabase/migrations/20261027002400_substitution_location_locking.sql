-- Align replacement eligibility with the location consumed by both posting paths.
-- Cross-bin replacement requires an explicit location model and remains unsupported.
-- Read identifiers first, then lock the order before exception/substitution rows.
create or replace function public.substitution_batch_options(p_exception_id uuid)
returns table(id uuid,batch_number text,expiry_date date,available_quantity numeric,is_controlled boolean)
language plpgsql stable security definer set search_path='' as $$
declare e public.fulfilment_exceptions; l public.pick_lines; o public.fulfilment_orders; c public.customers; p public.products;
begin
 select x.* into e from public.fulfilment_exceptions x where x.id=p_exception_id and x.organization_id=private.current_organization_id();
 if not found then raise exception 'Exception not found' using errcode='P0002'; end if;
 select x.* into o from public.fulfilment_orders x where x.id=e.fulfilment_order_id and x.organization_id=private.current_organization_id();
 if not found or not private.has_permission('fulfilment.view',o.branch_id) or not private.has_permission('fulfilment.exception',o.branch_id) then
 raise exception 'Insufficient branch permission' using errcode='42501'; end if;
 if e.status<>'OPEN' or e.kind<>'SHORT' then raise exception 'Only an open short pick can be substituted' using errcode='22023'; end if;
 select x.* into l from public.pick_lines x where x.id=e.pick_line_id and x.organization_id=o.organization_id;
 if l.batch_id is null then raise exception 'Only batch-tracked lines can be substituted' using errcode='22023'; end if;
 select x.* into c from public.customers x where x.id=o.customer_id and x.organization_id=o.organization_id;
 select x.* into p from public.products x where x.id=l.product_id and x.organization_id=o.organization_id;
 return query
 select b.id,b.batch_number,b.expiry_date,sum(sb.quantity)::numeric,(p.is_controlled or p.product_class='CONTROLLED')
 from public.batches b
 join public.stock_balances sb on sb.batch_id=b.id and sb.product_id=b.product_id and sb.organization_id=b.organization_id
 where b.organization_id=o.organization_id and b.product_id=l.product_id and b.id<>l.batch_id
   and b.expiry_date>=current_date+coalesce(c.min_shelf_life_days,0)
   and sb.warehouse_id=o.warehouse_id and sb.stock_status='AVAILABLE'
   and sb.location_id is not distinct from l.location_id
   and not exists (select 1 from public.recall_batch_scope rs join public.recalls r on r.id=rs.recall_id and r.organization_id=rs.organization_id where rs.batch_id=b.id and rs.organization_id=b.organization_id and r.status<>'CANCELLED')
 group by b.id,b.batch_number,b.expiry_date
 having sum(sb.quantity)>=e.short_quantity
 order by b.expiry_date,b.batch_number;
end $$;

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
 if l.batch_id is null then raise exception 'Only batch-tracked lines can be substituted' using errcode='22023'; end if;
 select * into old from public.batches where id=l.batch_id and organization_id=o.organization_id;
 select * into b from public.batches where id=p_substitute_batch_id and organization_id=o.organization_id and product_id=l.product_id;
 if not found or b.id=old.id or b.expiry_date < current_date then raise exception 'Choose a different, non-expired batch of the same product' using errcode='22023'; end if;
 select * into c from public.customers where id=o.customer_id and organization_id=o.organization_id;
 if c.min_shelf_life_days is not null and b.expiry_date < current_date + c.min_shelf_life_days then raise exception 'The substitute batch does not meet this customer''s minimum shelf life' using errcode='22023'; end if;
 select * into p from public.products where id=l.product_id and organization_id=o.organization_id;
 select coalesce(sum(sb.quantity),0) into v_on_hand from public.stock_balances sb where sb.warehouse_id=o.warehouse_id and sb.product_id=l.product_id and sb.batch_id=b.id and sb.stock_status='AVAILABLE' and sb.organization_id=o.organization_id and sb.location_id is not distinct from l.location_id;
 if v_on_hand<e.short_quantity then raise exception 'The substitute batch does not have enough available stock at the pick location' using errcode='22023'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Give a substitution reason (3 to 500 characters)' using errcode='22023'; end if;
 insert into public.fulfilment_substitutions(organization_id,fulfilment_order_id,pick_line_id,exception_id,branch_id,original_batch_id,substitute_batch_id,quantity)
 values(o.organization_id,o.id,l.id,e.id,o.branch_id,old.id,b.id,e.short_quantity) returning id into v_id;
 return v_id;
end $$;

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
 doc:=private.post_stock('ADJUSTMENT',o.warehouse_id,jsonb_build_array(jsonb_build_object('product_id',l.product_id,'quantity',s.quantity,'batch_id',s.original_batch_id,'location_id',l.location_id,'direction','IN'),jsonb_build_object('product_id',l.product_id,'quantity',s.quantity,'batch_id',s.substitute_batch_id,'location_id',l.location_id,'direction','OUT')),null,'OTHER','Substitution '||s.id,'FULFILMENT_SUBSTITUTION',s.id);
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
 values(o.organization_id,v_no,o.branch_id,o.warehouse_id,'OTHER',btrim(p_reason),jsonb_build_array(
   jsonb_build_object('product_id',l.product_id,'quantity',s.quantity,'batch_id',s.original_batch_id,'location_id',l.location_id,'direction','IN'),
   jsonb_build_object('product_id',l.product_id,'quantity',s.quantity,'batch_id',s.substitute_batch_id,'location_id',l.location_id,'direction','OUT')
 ),s.id) returning id into v_id;
 update public.fulfilment_substitutions set controlled_adjustment_id=v_id where id=s.id;
 return v_id;
end $$;
