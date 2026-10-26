-- Explicit replacement location; original allocation/location remain immutable.
alter table public.fulfilment_substitutions add column substitute_location_id uuid references public.warehouse_locations(id);
update public.fulfilment_substitutions s set substitute_location_id=l.location_id from public.pick_lines l where l.id=s.pick_line_id and l.organization_id=s.organization_id;
alter table public.pick_lines add column actual_location_id uuid references public.warehouse_locations(id);
update public.pick_lines set actual_location_id=location_id where actual_batch_id is not null;
drop function public.request_batch_substitution(uuid,uuid,text);
create or replace function public.request_batch_substitution(p_exception_id uuid,p_substitute_batch_id uuid,p_reason text,p_stock_balance_id uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare e public.fulfilment_exceptions; l public.pick_lines; o public.fulfilment_orders; b public.batches; old public.batches; p public.products; c public.customers; v_id uuid; v_on_hand numeric; v_location uuid;
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
 v_location:=l.location_id;
 if p_stock_balance_id is not null then
   select sb.location_id into v_location from public.stock_balances sb where sb.id=p_stock_balance_id and sb.organization_id=o.organization_id and sb.warehouse_id=o.warehouse_id and sb.product_id=l.product_id and sb.batch_id=b.id and sb.stock_status='AVAILABLE';
   if not found then raise exception 'Replacement stock location not found' using errcode='22023'; end if;
 end if;
 select coalesce(sum(sb.quantity),0) into v_on_hand from public.stock_balances sb where sb.warehouse_id=o.warehouse_id and sb.product_id=l.product_id and sb.batch_id=b.id and sb.stock_status='AVAILABLE' and sb.organization_id=o.organization_id and sb.location_id is not distinct from v_location;
 if v_on_hand<e.short_quantity then raise exception 'The substitute batch does not have enough available stock at the pick location' using errcode='22023'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Give a substitution reason (3 to 500 characters)' using errcode='22023'; end if;
 insert into public.fulfilment_substitutions(organization_id,fulfilment_order_id,pick_line_id,exception_id,branch_id,original_batch_id,substitute_batch_id,quantity,request_reason,substitute_location_id)
 values(o.organization_id,o.id,l.id,e.id,o.branch_id,old.id,b.id,e.short_quantity,btrim(p_reason),v_location) returning id into v_id;
 return v_id;
end $$;
drop function public.submit_batch_substitution(uuid,uuid,text);
create or replace function public.submit_batch_substitution(p_exception_id uuid,p_substitute_batch_id uuid,p_reason text,p_stock_balance_id uuid default null)
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
   if p_stock_balance_id is not null and not exists(select 1 from public.stock_balances sb where sb.id=p_stock_balance_id and sb.organization_id=o.organization_id and sb.warehouse_id=o.warehouse_id and sb.batch_id=s.substitute_batch_id and sb.location_id is not distinct from s.substitute_location_id and sb.stock_status='AVAILABLE') then raise exception 'This request uses a different replacement location' using errcode='22023'; end if;
   if s.controlled_adjustment_id is not null then return s.id; end if;
   v_id:=s.id;
 else
   v_id:=public.request_batch_substitution(e.id,p_substitute_batch_id,p_reason,p_stock_balance_id);
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
create or replace function private.substitution_stock_lines(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s public.fulfilment_substitutions; l public.pick_lines; e public.fulfilment_exceptions; result jsonb;
begin
 select * into s from public.fulfilment_substitutions where id=p_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Substitution not found' using errcode='P0002'; end if;
 select * into l from public.pick_lines where id=s.pick_line_id and organization_id=s.organization_id;
 select * into e from public.fulfilment_exceptions where id=s.exception_id and organization_id=s.organization_id;
 if s.status<>'PENDING' or e.status<>'OPEN' or e.pick_line_id<>l.id then raise exception 'Substitution is no longer pending against an open shortage' using errcode='22023'; end if;
 result:=jsonb_build_array(jsonb_build_object('product_id',l.product_id,'quantity',s.quantity,'batch_id',s.substitute_batch_id,'location_id',s.substitute_location_id,'direction','OUT','status','AVAILABLE'));
 if e.reason in ('DAMAGED','EXPIRED') then
   result:=jsonb_build_array(jsonb_build_object('product_id',l.product_id,'quantity',s.quantity,'batch_id',s.original_batch_id,'location_id',l.location_id,'direction','IN','status','QUARANTINE')) || result;
 end if;
 return result;
end $$;

drop function public.substitution_batch_options(uuid);
create or replace function public.substitution_batch_options(p_exception_id uuid)
returns table(id uuid,batch_number text,expiry_date date,available_quantity numeric,is_controlled boolean,stock_balance_id uuid,location_code text)
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
 select b.id,b.batch_number,b.expiry_date,sum(sb.quantity)::numeric,(p.is_controlled or p.product_class='CONTROLLED'),sb.id,coalesce(loc.code,'Unlocated')::text
 from public.batches b
 join public.stock_balances sb on sb.batch_id=b.id and sb.product_id=b.product_id and sb.organization_id=b.organization_id
 left join public.warehouse_locations loc on loc.id=sb.location_id and loc.organization_id=sb.organization_id
 where b.organization_id=o.organization_id and b.product_id=l.product_id and b.id<>l.batch_id
   and b.expiry_date>=current_date+coalesce(c.min_shelf_life_days,0)
   and sb.warehouse_id=o.warehouse_id and sb.stock_status='AVAILABLE'
   and not exists (select 1 from public.recall_batch_scope rs join public.recalls r on r.id=rs.recall_id and r.organization_id=rs.organization_id where rs.batch_id=b.id and rs.organization_id=b.organization_id and r.status<>'CANCELLED')
 group by b.id,b.batch_number,b.expiry_date,sb.id,loc.code
 having sum(sb.quantity)>=e.short_quantity
 order by b.expiry_date,b.batch_number;
end $$;
create or replace function private.complete_substitution_pick()
returns trigger language plpgsql security definer set search_path='' as $$
declare s public.fulfilment_substitutions;
begin
 if new.decision='SUBSTITUTED' and new.status='RESOLVED' and old.status='OPEN' then
   select * into s from public.fulfilment_substitutions where id=new.substitution_id and organization_id=new.organization_id;
   if s.id is null or s.status<>'APPROVED' or s.exception_id<>new.id or s.pick_line_id<>new.pick_line_id then
     raise exception 'An approved matching substitution is required' using errcode='22023';
   end if;
   update public.pick_lines set status='PICKED',picked_quantity=expected_quantity,actual_batch_id=s.substitute_batch_id,actual_location_id=s.substitute_location_id,
     short_reason=null,short_note=null,picked_by=s.requested_by,picked_at=now()
   where id=new.pick_line_id and organization_id=new.organization_id;
   perform private.settle_fulfilment_order(new.fulfilment_order_id);
 end if;
 return null;
end $$;
revoke all on function public.substitution_batch_options(uuid),public.request_batch_substitution(uuid,uuid,text,uuid),public.submit_batch_substitution(uuid,uuid,text,uuid) from public,anon;
grant execute on function public.substitution_batch_options(uuid),public.request_batch_substitution(uuid,uuid,text,uuid),public.submit_batch_substitution(uuid,uuid,text,uuid) to authenticated;

-- Show the batch physically picked after an approved substitution.
create or replace function public.fulfilment_pick_list(p_id uuid)
returns table (
 line_id uuid, line_no integer, status text, sku text, product_name text, expected_quantity numeric, picked_quantity numeric, base_unit text, batch_number text,
 expiry_date date, location_code text, picking_sequence integer, short_reason text, short_note text, exception_id uuid, exception_status text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
 v_org uuid := private.current_organization_id();
 v_o public.fulfilment_orders;
begin
 if v_org is null then raise exception 'insufficient privilege' using errcode = '42501'; end if;
 select * into v_o from public.fulfilment_orders o where o.id=p_id and o.organization_id=v_org;
 if not found or not private.has_permission('fulfilment.view',v_o.branch_id) then raise exception 'fulfilment order not found' using errcode = 'P0002'; end if;
 return query
 select l.id,l.line_no,l.status,p.sku::text,p.brand_name::text,l.expected_quantity,l.picked_quantity,bu.name::text,ba.batch_number::text,ba.expiry_date,
        loc.code::text,loc.picking_sequence,l.short_reason,l.short_note,e.id,e.status
 from public.pick_lines l
 join public.products p on p.id=l.product_id
 join public.units_of_measure bu on bu.id=p.base_unit_id
 left join public.batches ba on ba.id=coalesce(l.actual_batch_id,l.batch_id)
 left join public.warehouse_locations loc on loc.id=case when l.actual_batch_id is not null then l.actual_location_id else l.location_id end
 left join lateral (select x.id,x.status from public.fulfilment_exceptions x where x.pick_line_id=l.id and x.decision is distinct from 'WITHDRAWN' order by x.raised_at desc limit 1) e on true
 where l.fulfilment_order_id=p_id and l.organization_id=v_org
 order by l.line_no;
end $$;
