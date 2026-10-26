-- Phase 17e follow-up: expose safe substitute-batch choices to the supervisor UI.
create function public.substitution_batch_options(p_exception_id uuid)
returns table(id uuid,batch_number text,expiry_date date,available_quantity numeric)
language plpgsql stable security definer set search_path='' as $$
declare e public.fulfilment_exceptions; l public.pick_lines; o public.fulfilment_orders; c public.customers;
begin
 select * into e from public.fulfilment_exceptions where id=p_exception_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Exception not found' using errcode='P0002'; end if;
 o:=private.load_fulfilment_order(e.fulfilment_order_id,'fulfilment.exception');
 if e.status<>'OPEN' or e.kind<>'SHORT' then raise exception 'Only an open short pick can be substituted' using errcode='22023'; end if;
 select * into l from public.pick_lines where id=e.pick_line_id and organization_id=o.organization_id;
 if l.batch_id is null then raise exception 'Only batch-tracked lines can be substituted' using errcode='22023'; end if;
 select * into c from public.customers where id=o.customer_id and organization_id=o.organization_id;
 return query
 select b.id,b.batch_number,b.expiry_date,sum(sb.quantity)::numeric
 from public.batches b
 join public.stock_balances sb on sb.batch_id=b.id and sb.product_id=b.product_id and sb.organization_id=b.organization_id
 where b.organization_id=o.organization_id and b.product_id=l.product_id and b.id<>l.batch_id
   and b.expiry_date>=current_date+coalesce(c.min_shelf_life_days,0)
   and sb.warehouse_id=o.warehouse_id and sb.stock_status='AVAILABLE'
 group by b.id,b.batch_number,b.expiry_date
 having sum(sb.quantity)>=e.short_quantity
 order by b.expiry_date,b.batch_number;
end $$;
revoke all on function public.substitution_batch_options(uuid) from public,anon;
grant execute on function public.substitution_batch_options(uuid) to authenticated;
