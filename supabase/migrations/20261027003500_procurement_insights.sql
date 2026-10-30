-- Aggregate only the caller's visible purchase orders; keep currencies separate.
create function public.procurement_insights(p_from date,p_to date,p_branch uuid default null)
returns table(supplier_id uuid,supplier_name text,currency_code text,orders bigint,ordered_value numeric,open_orders bigint,overdue_orders bigint)
language plpgsql stable security invoker set search_path='' as $$
begin
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>3660 then raise exception 'Choose a valid reporting period of at most ten years' using errcode='22023'; end if;
 return query select o.supplier_id,s.name,o.currency_code,count(*),sum(o.total_amount),
 count(*) filter(where o.status in ('APPROVED','PARTIALLY_RECEIVED')),
 count(*) filter(where o.status in ('APPROVED','PARTIALLY_RECEIVED') and o.expected_date<current_date)
 from public.purchase_orders o join public.suppliers s on s.id=o.supplier_id and s.organization_id=o.organization_id
 where o.organization_id=private.current_organization_id() and private.has_permission('purchasing.view',o.branch_id)
 and o.order_date between p_from and p_to and (p_branch is null or o.branch_id=p_branch)
 and o.status in ('APPROVED','PARTIALLY_RECEIVED','RECEIVED','CLOSED')
 group by o.supplier_id,s.name,o.currency_code order by sum(o.total_amount) desc,s.name;
end $$;
revoke all on function public.procurement_insights(date,date,uuid) from public,anon;
grant execute on function public.procurement_insights(date,date,uuid) to authenticated;
