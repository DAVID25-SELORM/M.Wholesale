create table public.supplier_quotations (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 supplier_id uuid not null, warehouse_id uuid not null, branch_id uuid not null,
 supplier_reference text not null check(length(btrim(supplier_reference)) between 1 and 100),
 valid_until date not null, notes text check(length(notes)<=1000), lines jsonb not null,
 status text not null default 'OPEN' check(status in ('OPEN','CONVERTED','CANCELLED')),
 purchase_order_id uuid, created_at timestamptz not null default now(), created_by uuid not null default auth.uid(),
 unique(id,organization_id), unique(organization_id,supplier_id,supplier_reference),
 foreign key(supplier_id,organization_id) references public.suppliers(id,organization_id),
 foreign key(warehouse_id,organization_id) references public.warehouses(id,organization_id),
 foreign key(branch_id,organization_id) references public.branches(id,organization_id),
 foreign key(purchase_order_id,organization_id) references public.purchase_orders(id,organization_id)
);
alter table public.supplier_quotations enable row level security;
revoke all on public.supplier_quotations from public,anon,authenticated;
grant select on public.supplier_quotations to authenticated;
create policy quotation_read on public.supplier_quotations for select to authenticated using(organization_id=(select private.current_organization_id()) and private.has_permission('purchasing.view',branch_id));
create trigger quotation_audit after insert or update on public.supplier_quotations for each row execute function private.audit_row_change('supplier_quotation');
create trigger quotation_no_delete before delete on public.supplier_quotations for each row execute function private.stock_block_mutation();

create function public.record_supplier_quotation(p_supplier uuid,p_warehouse uuid,p_reference text,p_valid_until date,p_notes text,p_lines jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare org uuid:=private.current_organization_id(); wh public.warehouses; line jsonb; result uuid; qty numeric; cost numeric;
begin
 select * into wh from public.warehouses where id=p_warehouse and organization_id=org and is_active;
 if not found or not private.has_permission('purchasing.create',wh.branch_id) then raise exception 'Warehouse or purchasing permission unavailable' using errcode='42501'; end if;
 if not exists(select 1 from public.suppliers where id=p_supplier and organization_id=org and is_active) then raise exception 'Choose an active supplier' using errcode='22023'; end if;
 if p_valid_until is null or p_valid_until<current_date then raise exception 'Quotation must not be expired' using errcode='22023'; end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'Supply quotation lines' using errcode='22023'; end if;
 if jsonb_array_length(p_lines) not between 1 and 100 then raise exception 'Supply 1 to 100 lines' using errcode='22023'; end if;
 for line in select value from jsonb_array_elements(p_lines) loop
  if jsonb_typeof(line)<>'object' or jsonb_typeof(line->'quantity') is distinct from 'number' or jsonb_typeof(line->'unit_cost') is distinct from 'number' then raise exception 'Numeric quantity and cost required' using errcode='22023'; end if;
  qty:=(line->>'quantity')::numeric; cost:=(line->>'unit_cost')::numeric;
  if qty<=0 or qty>1000000000 or qty<>round(qty,3) or cost<0 or cost>1000000000 or cost<>round(cost,4) then raise exception 'Invalid quantity or cost precision' using errcode='22023'; end if;
  if not exists(select 1 from public.products where id::text=line->>'product_id' and organization_id=org and is_active) then raise exception 'Choose an active product in this organization' using errcode='22023'; end if;
 end loop;
 if (select count(distinct value->>'product_id') from jsonb_array_elements(p_lines))<>jsonb_array_length(p_lines) then raise exception 'Combine duplicate products' using errcode='22023'; end if;
 insert into public.supplier_quotations(supplier_id,warehouse_id,branch_id,supplier_reference,valid_until,notes,lines)
 values(p_supplier,wh.id,wh.branch_id,btrim(p_reference),p_valid_until,p_notes,p_lines) returning id into result;
 return result;
end $$;

create function public.convert_supplier_quotation(p_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare q public.supplier_quotations; result uuid;
begin
 select * into q from public.supplier_quotations where id=p_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Quotation not found' using errcode='P0002'; end if;
 if not private.has_permission('purchasing.create',q.branch_id) then raise exception 'Purchasing permission required' using errcode='42501'; end if;
 if q.status='CONVERTED' then return q.purchase_order_id; end if;
 if q.status<>'OPEN' or q.valid_until<current_date then raise exception 'Only an open unexpired quotation can be converted' using errcode='22023'; end if;
 result:=public.save_purchase_order(null,q.supplier_id,q.warehouse_id,null,left('Supplier quotation: '||q.supplier_reference||E'\n'||coalesce(q.notes,''),1000),q.lines,null);
 update public.supplier_quotations set status='CONVERTED',purchase_order_id=result where id=q.id;
 return result;
end $$;
create function public.cancel_supplier_quotation(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare q public.supplier_quotations;
begin
 select * into q from public.supplier_quotations where id=p_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Quotation not found' using errcode='P0002'; end if;
 if not private.has_permission('purchasing.create',q.branch_id) then raise exception 'Purchasing permission required' using errcode='42501'; end if;
 if q.status<>'OPEN' then raise exception 'Only open quotations can be cancelled' using errcode='22023'; end if;
 update public.supplier_quotations set status='CANCELLED' where id=q.id;
end $$;
revoke all on function public.record_supplier_quotation(uuid,uuid,text,date,text,jsonb),public.convert_supplier_quotation(uuid),public.cancel_supplier_quotation(uuid) from public,anon;
grant execute on function public.record_supplier_quotation(uuid,uuid,text,date,text,jsonb),public.convert_supplier_quotation(uuid),public.cancel_supplier_quotation(uuid) to authenticated;
