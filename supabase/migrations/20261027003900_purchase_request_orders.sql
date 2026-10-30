-- Preserve approved demand and create one auditable draft order per request.
alter table public.purchase_requests add column purchase_order_id uuid;
alter table public.purchase_requests add constraint purchase_request_order_org_fk
 foreign key(purchase_order_id,organization_id) references public.purchase_orders(id,organization_id);
create function public.convert_purchase_request(p_id uuid,p_supplier uuid,p_warehouse uuid,p_costs jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare r public.purchase_requests; result uuid; line jsonb; cost numeric; lines jsonb:='[]';
begin
 select * into r from public.purchase_requests where id=p_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Purchase request not found' using errcode='P0002'; end if;
 if not private.has_permission('purchasing.create',r.branch_id) or not private.has_permission('purchasing.request',r.branch_id) then raise exception 'Request and purchasing permissions required' using errcode='42501'; end if;
 if r.status<>'APPROVED' then raise exception 'Approve the request before creating an order' using errcode='22023'; end if;
 if r.purchase_order_id is not null then return r.purchase_order_id; end if;
 if not exists(select 1 from public.warehouses where id=p_warehouse and organization_id=r.organization_id and branch_id=r.branch_id and is_active)
 or (r.warehouse_id is not null and r.warehouse_id<>p_warehouse) then raise exception 'Choose the requested warehouse in the request branch' using errcode='22023'; end if;
 if p_costs is null or jsonb_typeof(p_costs)<>'object' then raise exception 'Supply a cost for every requested product' using errcode='22023'; end if;
 for line in select value from jsonb_array_elements(r.lines) loop
  if jsonb_typeof(p_costs->(line->>'product_id')) is distinct from 'number' then raise exception 'Supply a numeric cost for every requested product' using errcode='22023'; end if;
  cost:=(p_costs->>(line->>'product_id'))::numeric;
  if cost<0 or cost>1000000000 or cost<>round(cost,4) then raise exception 'Cost must be nonnegative with at most four decimals' using errcode='22023'; end if;
  lines:=lines||jsonb_build_array(jsonb_build_object('product_id',line->>'product_id','quantity',line->'quantity','unit_cost',cost));
 end loop;
 result:=public.save_purchase_order(null,p_supplier,p_warehouse,r.needed_by,left('Purchase request: '||r.request_number||E'\n'||coalesce(r.notes,''),1000),lines,null);
 update public.purchase_requests set purchase_order_id=result,updated_at=now() where id=r.id;
 return result;
end $$;
revoke all on function public.convert_purchase_request(uuid,uuid,uuid,jsonb) from public,anon;
grant execute on function public.convert_purchase_request(uuid,uuid,uuid,jsonb) to authenticated;
