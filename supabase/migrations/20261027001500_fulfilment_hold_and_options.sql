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
 group by b.id,b.batch_number,b.expiry_date
 having sum(sb.quantity)>=e.short_quantity
 order by b.expiry_date,b.batch_number;
end $$;

create or replace function public.release_fulfilment_hold(p_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders;
begin
 o:=private.load_fulfilment_order(p_id,'fulfilment.exception');
 if o.status<>'HOLD' then raise exception 'This order is not on hold' using errcode='22023'; end if;
 update public.fulfilment_orders set status='PICKING',hold_reason=null,held_by=null,held_at=null where id=o.id and organization_id=o.organization_id;
 perform private.settle_fulfilment_order(o.id);
 if not exists(select 1 from public.pick_lines where fulfilment_order_id=o.id and organization_id=o.organization_id and status<>'PENDING') then
 update public.fulfilment_orders set status='RELEASED' where id=o.id and organization_id=o.organization_id;
 end if;
end $$;
create or replace function private.cancel_fulfilment_on_reversal()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.fulfilment_orders set status='CANCELLED',cancelled_at=now(),cancel_reason='The invoice was reversed',picker_id=null,
 hold_reason=null,held_by=null,held_at=null
 where sales_invoice_id=new.id and organization_id=new.organization_id and status<>'CANCELLED';
 return null;
end $$;
revoke all on function public.substitution_batch_options(uuid),public.release_fulfilment_hold(uuid) from public,anon;
grant execute on function public.substitution_batch_options(uuid),public.release_fulfilment_hold(uuid) to authenticated;
revoke all on function private.cancel_fulfilment_on_reversal() from public,anon,authenticated;
