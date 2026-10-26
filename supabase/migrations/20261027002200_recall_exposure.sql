-- Trace original allocations and approved replacements without rewriting invoices.
-- Quantities are base units. Contacts are restricted to organization-wide recall staff.
create function public.recall_customer_exposure(p_recall_id uuid)
returns table(invoice_id uuid,invoice_number text,customer_id uuid,customer_name text,contact_name text,phone text,email text,
 batch_id uuid,batch_number text,product_name text,quantity numeric,source text,delivery_status text)
language plpgsql stable security definer set search_path='' as $$
declare v_org uuid:=private.current_organization_id();
begin
 if v_org is null or not (private.has_permission('recalls.manage') or private.has_permission('recalls.view')) then
   raise exception 'Recall access required' using errcode='42501';
 end if;
 if not exists(select 1 from public.recalls r where r.id=p_recall_id and r.organization_id=v_org) then
   raise exception 'Recall not found' using errcode='P0002';
 end if;
 return query
 with exposure as (
   select a.sales_invoice_id,a.batch_id,a.product_id,a.base_quantity as qty,'INVOICE_ALLOCATION'::text as origin
   from public.sales_invoice_allocations a join public.recall_batch_scope s on s.batch_id=a.batch_id and s.organization_id=a.organization_id
   where s.recall_id=p_recall_id and s.organization_id=v_org
   union all
   select o.sales_invoice_id,s.substitute_batch_id,l.product_id,s.quantity,'APPROVED_SUBSTITUTION'::text
   from public.fulfilment_substitutions s
   join public.fulfilment_orders o on o.id=s.fulfilment_order_id and o.organization_id=s.organization_id
   join public.pick_lines l on l.id=s.pick_line_id and l.organization_id=s.organization_id
   join public.recall_batch_scope r on r.batch_id=s.substitute_batch_id and r.organization_id=s.organization_id
   where r.recall_id=p_recall_id and r.organization_id=v_org and s.status='APPROVED'
 )
 select i.id,i.invoice_number::text,c.id,c.name::text,c.contact_name::text,c.phone::text,c.email::text,
 b.id,b.batch_number::text,p.brand_name::text,sum(x.qty),x.origin,
 coalesce((select d.status from public.delivery_notes d where d.sales_invoice_id=i.id and d.organization_id=v_org order by d.created_at desc,d.id limit 1),'NO_DELIVERY_NOTE')::text
 from exposure x
 join public.sales_invoices i on i.id=x.sales_invoice_id and i.organization_id=v_org and i.status='POSTED'
 join public.customers c on c.id=i.customer_id and c.organization_id=v_org
 join public.batches b on b.id=x.batch_id and b.organization_id=v_org
 join public.products p on p.id=x.product_id and p.organization_id=v_org
 group by i.id,c.id,b.id,p.id,x.origin
 order by c.name,i.invoice_number,b.batch_number;
end $$;
revoke all on function public.recall_customer_exposure(uuid) from public,anon;
grant execute on function public.recall_customer_exposure(uuid) to authenticated;
