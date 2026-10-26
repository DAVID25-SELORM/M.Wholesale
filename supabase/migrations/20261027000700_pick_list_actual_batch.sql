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
 left join public.warehouse_locations loc on loc.id=l.location_id
 left join lateral (select x.id,x.status from public.fulfilment_exceptions x where x.pick_line_id=l.id and x.decision is distinct from 'WITHDRAWN' order by x.raised_at desc limit 1) e on true
 where l.fulfilment_order_id=p_id and l.organization_id=v_org
 order by l.line_no;
end $$;
