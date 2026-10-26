-- A resolved pick may contain quantities from both original and replacement batches.
-- Derive components from immutable allocation and approved substitution evidence.
create function private.pick_batch_components(p_line uuid)
returns table(batch_id uuid,location_id uuid,quantity numeric)
language sql stable security definer set search_path='' as $$
 with picked as (select l.*,s.quantity as replacement_quantity,s.substitute_batch_id,s.substitute_location_id
 from public.pick_lines l left join public.fulfilment_substitutions s on s.pick_line_id=l.id and s.organization_id=l.organization_id and s.status='APPROVED'
 where l.id=p_line and l.organization_id=private.current_organization_id())
 select p.batch_id,p.location_id,p.picked_quantity-coalesce(p.replacement_quantity,0) from picked p where p.picked_quantity-coalesce(p.replacement_quantity,0)>0
 union all select p.substitute_batch_id,p.substitute_location_id,p.replacement_quantity from picked p where p.replacement_quantity>0
$$;
revoke all on function private.pick_batch_components(uuid) from public,anon,authenticated;
alter table public.package_lines add column batch_id uuid;
alter table public.package_lines add constraint package_lines_batch_org_fk foreign key(batch_id,organization_id) references public.batches(id,organization_id);
-- Existing packed lines were restricted to a single actual batch.
-- Temporarily remove the mutation guard only for this deterministic migration backfill.
drop trigger package_lines_immutable on public.package_lines;
update public.package_lines pl set batch_id=coalesce(l.actual_batch_id,l.batch_id) from public.pick_lines l where l.id=pl.pick_line_id and l.organization_id=pl.organization_id;
create trigger package_lines_immutable before update or delete on public.package_lines for each row execute function private.stock_block_mutation();
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
 if l.status<>'SHORT' or l.picked_quantity is null or e.short_quantity<>l.expected_quantity-l.picked_quantity then
   raise exception 'The shortage must match the unpicked quantity' using errcode='22023';
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
create or replace function private.validate_substitution_approval()
returns trigger language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders; e public.fulfilment_exceptions; l public.pick_lines; b public.batches; shelf_days integer;
begin
 if new.status<>'APPROVED' or old.status='APPROVED' then return new; end if;
 select * into o from public.fulfilment_orders where id=new.fulfilment_order_id and organization_id=new.organization_id for update;
 select * into e from public.fulfilment_exceptions where id=new.exception_id and organization_id=new.organization_id for update;
 select * into l from public.pick_lines where id=new.pick_line_id and organization_id=new.organization_id for update;
 if o.status<>'PICKING' or e.status<>'OPEN' or l.status<>'SHORT'
 or e.fulfilment_order_id<>o.id or e.pick_line_id<>l.id or l.fulfilment_order_id<>o.id
 or l.batch_id is distinct from new.original_batch_id or new.quantity<>e.short_quantity then
   raise exception 'The order or short pick has changed; this substitution cannot be approved' using errcode='22023';
 end if;
 if l.picked_quantity is null or new.quantity<>l.expected_quantity-l.picked_quantity then
   raise exception 'Replacement quantity must equal the outstanding shortage.' using errcode='22023';
 end if;
 select * into b from public.batches where id=new.substitute_batch_id and product_id=l.product_id and organization_id=new.organization_id;
 select min_shelf_life_days into shelf_days from public.customers where id=o.customer_id and organization_id=o.organization_id;
 if b.id is null or b.expiry_date is null or b.expiry_date<current_date+coalesce(shelf_days,0) then
   raise exception 'The replacement batch no longer meets expiry and shelf-life requirements' using errcode='22023';
 end if;
 if exists(select 1 from public.recall_batch_scope s join public.recalls r on r.id=s.recall_id and r.organization_id=s.organization_id
   where s.batch_id=b.id and s.organization_id=b.organization_id and r.status<>'CANCELLED') then
   raise exception 'A recalled batch cannot be used as a substitute' using errcode='22023';
 end if;
 return new;
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
   update public.pick_lines set status='PICKED',picked_quantity=expected_quantity,actual_batch_id=case when s.quantity=expected_quantity then s.substitute_batch_id end,actual_location_id=case when s.quantity=expected_quantity then s.substitute_location_id end,
     short_reason=null,short_note=null,picked_by=case when s.quantity=expected_quantity then s.requested_by else picked_by end,picked_at=now()
   where id=new.pick_line_id and organization_id=new.organization_id;
   perform private.settle_fulfilment_order(new.fulfilment_order_id);
 end if;
 return null;
end $$;
drop function public.pack_line(uuid,uuid,numeric);
create or replace function public.pack_line(p_package_id uuid,p_line_id uuid,p_quantity numeric,p_batch_id uuid default null) returns void language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders; pk public.packages; l public.pick_lines; v_total numeric; v_batch uuid; v_limit numeric; v_count integer;
begin
 select * into pk from public.packages where id=p_package_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Package not found' using errcode='P0002'; end if;
 o := private.load_fulfilment_order(pk.fulfilment_order_id,'packing.work');
 select * into pk from public.packages where id=p_package_id and organization_id=o.organization_id;
 if o.status <> 'PACKING' or pk.voided_at is not null then raise exception 'Package is not open for packing' using errcode='22023'; end if;
 select * into l from public.pick_lines where id=p_line_id and fulfilment_order_id=o.id and organization_id=o.organization_id;
 if not found then raise exception 'Pick line not found' using errcode='P0002'; end if;
 if exists(select 1 from public.packing_verifications where pick_line_id=l.id and organization_id=o.organization_id) then raise exception 'Verified contents cannot change' using errcode='22023'; end if;
 select count(*) into v_count from private.pick_batch_components(l.id);
 v_batch:=p_batch_id;
 if v_batch is null and v_count=1 then select c.batch_id into v_batch from private.pick_batch_components(l.id) c; end if;
 select c.quantity into v_limit from private.pick_batch_components(l.id) c where c.batch_id is not distinct from v_batch;
 if v_limit is null then raise exception 'Choose the specific picked batch to pack' using errcode='22023'; end if;
 select coalesce(sum(pl.quantity),0) into v_total from public.package_lines pl join public.packages p on p.id=pl.package_id and p.organization_id=pl.organization_id
 where pl.batch_id is not distinct from v_batch and pl.pick_line_id=l.id and pl.organization_id=o.organization_id and p.voided_at is null;
 if p_quantity is null or p_quantity='NaN'::numeric or p_quantity<=0 or p_quantity<>round(p_quantity,3) or l.picked_quantity is null or v_total+p_quantity>v_limit then
 raise exception 'Quantity must be positive, at most three decimals, and cannot exceed the unpacked picked quantity' using errcode='22023'; end if;
 insert into public.package_lines(organization_id,fulfilment_order_id,branch_id,package_id,pick_line_id,quantity,batch_id)
 values(o.organization_id,o.id,o.branch_id,pk.id,l.id,p_quantity,v_batch);
end $$;
revoke all on function public.pack_line(uuid,uuid,numeric,uuid) from public,anon;
grant execute on function public.pack_line(uuid,uuid,numeric,uuid) to authenticated;
create or replace function public.packing_detail(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare o public.fulfilment_orders;
begin
 select * into o from public.fulfilment_orders where id=p_id and organization_id=private.current_organization_id();
 if not found or not private.has_permission('fulfilment.view',o.branch_id) then raise exception 'Order not found' using errcode='P0002'; end if;
 return jsonb_build_object('components',coalesce((select jsonb_agg(jsonb_build_object('pick_line_id',l.id,'batch_id',c.batch_id,'location_id',c.location_id,'quantity',c.quantity,'batch_number',b.batch_number,'expiry_date',b.expiry_date)) from public.pick_lines l cross join lateral private.pick_batch_components(l.id) c left join public.batches b on b.id=c.batch_id and b.organization_id=l.organization_id where l.fulfilment_order_id=o.id and l.organization_id=o.organization_id),'[]'::jsonb),'packages',coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at,p.id) from public.packages p where p.fulfilment_order_id=o.id and p.organization_id=o.organization_id),'[]'::jsonb),
 'contents',coalesce((select jsonb_agg(to_jsonb(l)) from public.package_lines l where l.fulfilment_order_id=o.id and l.organization_id=o.organization_id),'[]'::jsonb),
 'lines',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'product_name',p.brand_name,'controlled',p.is_controlled,'verified',exists(select 1 from public.packing_verifications v where v.pick_line_id=l.id and v.organization_id=o.organization_id))) from public.pick_lines l join public.products p on p.id=l.product_id and p.organization_id=l.organization_id where l.fulfilment_order_id=o.id and l.organization_id=o.organization_id),'[]'::jsonb));
end $$;
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
 select l.id,l.line_no,l.status,p.sku::text,p.brand_name::text,l.expected_quantity,l.picked_quantity,bu.name::text,case when parts.n>1 then 'Multiple batches (see packing)' else ba.batch_number::text end,
        case when parts.n>1 then null else ba.expiry_date end,
        case when parts.n>1 then 'Multiple locations (see packing)' else loc.code::text end,
        case when parts.n>1 then null else loc.picking_sequence end,l.short_reason,l.short_note,e.id,e.status
 from public.pick_lines l
 join public.products p on p.id=l.product_id
 join public.units_of_measure bu on bu.id=p.base_unit_id
 cross join lateral (select count(*) as n from private.pick_batch_components(l.id)) parts
 left join public.batches ba on ba.id=coalesce(l.actual_batch_id,l.batch_id)
 left join public.warehouse_locations loc on loc.id=case when l.actual_batch_id is not null then l.actual_location_id else l.location_id end
 left join lateral (select x.id,x.status from public.fulfilment_exceptions x where x.pick_line_id=l.id and x.decision is distinct from 'WITHDRAWN' order by x.raised_at desc limit 1) e on true
 where l.fulfilment_order_id=p_id and l.organization_id=v_org
 order by l.line_no;
end $$;

-- Verify independently of both the original picker and replacement picker.
create or replace function public.verify_packed_line(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders; l public.pick_lines; v_total numeric;
begin
 select * into l from public.pick_lines where id=p_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Pick line not found' using errcode='P0002'; end if;
 o := private.load_fulfilment_order(l.fulfilment_order_id,'packing.verify');
 if o.status <> 'PACKING' then raise exception 'Order must be packing' using errcode='22023'; end if;
 if l.picked_by=auth.uid() or exists(select 1 from public.fulfilment_substitutions s where s.pick_line_id=l.id and s.organization_id=o.organization_id and s.status='APPROVED' and s.requested_by=auth.uid()) or exists(select 1 from public.package_lines pl join public.packages pk on pk.id=pl.package_id and pk.organization_id=pl.organization_id
 where pl.pick_line_id=l.id and pl.organization_id=o.organization_id and pk.voided_at is null and pl.packed_by=auth.uid()) then
 raise exception 'A different person must verify picked and packed goods' using errcode='42501'; end if;
 select coalesce(sum(pl.quantity),0) into v_total from public.package_lines pl join public.packages pk on pk.id=pl.package_id and pk.organization_id=pl.organization_id
 where pl.pick_line_id=l.id and pl.organization_id=o.organization_id and pk.voided_at is null;
 if l.picked_quantity is null or l.picked_quantity<=0 or v_total<>l.picked_quantity then raise exception 'Pack the full picked quantity before verification' using errcode='22023'; end if;
 insert into public.packing_verifications(organization_id,fulfilment_order_id,branch_id,pick_line_id) values(o.organization_id,o.id,o.branch_id,l.id);
end $$;

