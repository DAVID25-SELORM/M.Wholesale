-- Resolve under the order lock and re-read after waiting. Base-unit shortages
-- must be converted to the original invoice unit before drafting a credit.
create or replace function public.resolve_short_pick(p_exception_id uuid,p_reason text)
returns text language plpgsql security definer set search_path='' as $$
declare e public.fulfilment_exceptions; o public.fulfilment_orders;
begin
 select * into e from public.fulfilment_exceptions where id=p_exception_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Exception not found' using errcode='P0002'; end if;
 o:=private.load_fulfilment_order(e.fulfilment_order_id,'picking.assign');
 select * into e from public.fulfilment_exceptions where id=p_exception_id and organization_id=o.organization_id for update;
 if e.status<>'OPEN' then raise exception 'This short pick has already been resolved' using errcode='22023'; end if;
 if o.status<>'PICKING' then raise exception 'Only a short pick on an order being picked can be resolved' using errcode='22023'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Give a reason (3 to 500 characters)' using errcode='22023'; end if;
 update public.fulfilment_exceptions set status='RESOLVED',decision='ACCEPT_SHORT',resolution_reason=btrim(p_reason),resolved_by=auth.uid(),resolved_at=now()
 where id=e.id and organization_id=o.organization_id;
 return private.settle_fulfilment_order(o.id);
end $$;

create or replace function public.ship_short_fulfilment_order(p_exception_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare e public.fulfilment_exceptions; l public.pick_lines; o public.fulfilment_orders; a public.sales_invoice_allocations;
 il public.sales_invoice_lines; n uuid; qty numeric; invoice_id uuid;
begin
 select * into e from public.fulfilment_exceptions where id=p_exception_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Exception not found' using errcode='P0002'; end if;
 select sales_invoice_id into invoice_id from public.fulfilment_orders where id=e.fulfilment_order_id and organization_id=e.organization_id;
 perform 1 from public.sales_invoices where id=invoice_id and organization_id=e.organization_id for update;
 o:=private.load_fulfilment_order(e.fulfilment_order_id,'fulfilment.exception');
 select * into e from public.fulfilment_exceptions where id=p_exception_id and organization_id=o.organization_id for update;
 if o.status<>'PICKING' or e.status<>'OPEN' or e.kind<>'SHORT' then raise exception 'Only an open short pick on an order being picked can be shipped short' using errcode='22023'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Give a reason (3 to 500 characters)' using errcode='22023'; end if;
 select * into l from public.pick_lines where id=e.pick_line_id and organization_id=o.organization_id;
 select * into a from public.sales_invoice_allocations where id=l.allocation_id and organization_id=o.organization_id;
 select * into il from public.sales_invoice_lines where id=a.sales_invoice_line_id and organization_id=o.organization_id;
 qty:=round(e.short_quantity*il.quantity/il.base_quantity,3);
 if qty<=0 or round(qty*il.base_quantity/il.quantity,3)<>e.short_quantity then
   raise exception 'This shortage cannot be represented exactly in the invoiced pack unit; finance must review the credit' using errcode='22023';
 end if;
 n:=public.save_credit_note(null,o.sales_invoice_id,o.warehouse_id,'OTHER',btrim(p_reason),
   jsonb_build_array(jsonb_build_object('type','RETURN','invoice_line_id',il.id,'quantity',qty,'condition','QUARANTINE','batch_id',a.batch_id)));
 update public.fulfilment_exceptions set status='RESOLVED',decision='SHIP_SHORT',credit_note_id=n,resolution_reason=btrim(p_reason),resolved_by=auth.uid(),resolved_at=now()
 where id=e.id and organization_id=o.organization_id;
 perform private.settle_fulfilment_order(o.id);
 return n;
end $$;
revoke all on function public.resolve_short_pick(uuid,text),public.ship_short_fulfilment_order(uuid,text) from public,anon;
grant execute on function public.resolve_short_pick(uuid,text),public.ship_short_fulfilment_order(uuid,text) to authenticated;
