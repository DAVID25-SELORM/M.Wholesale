-- Complete recall batch selection, preserve locations and make closure check current stock.
create or replace function public.recall_batch_options()
returns table(id uuid,batch_number text,product_name text,sku text,expiry_date date)
language sql stable security definer set search_path='' as $$
 select b.id,b.batch_number,p.brand_name::text,p.sku::text,b.expiry_date
 from public.batches b join public.products p on p.id=b.product_id and p.organization_id=b.organization_id
 where b.organization_id=private.current_organization_id()
 and (private.has_permission('recalls.manage') or private.has_permission('recalls.view'))
 order by b.expiry_date,b.batch_number,b.id
$$;

create or replace function public.quarantine_recall_batch(p_scope_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.recall_batch_scope; r public.recalls; b record; doc jsonb; docs jsonb := '[]'; total numeric := 0;
begin
 if private.current_organization_id() is null or not private.has_permission('recalls.manage') then
   raise exception 'Organization-wide recall management permission required' using errcode='42501';
 end if;
 if p_reason is null or length(btrim(p_reason)) not between 5 and 500 then
   raise exception 'Give a quarantine reason (5 to 500 characters)' using errcode='22023';
 end if;
 select * into s from public.recall_batch_scope where id=p_scope_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Recall batch scope not found' using errcode='P0002'; end if;
 select * into r from public.recalls where id=s.recall_id and organization_id=s.organization_id for update;
 if r.status not in ('OPEN','QUARANTINED') then raise exception 'Recall is closed' using errcode='22023'; end if;
 select * into s from public.recall_batch_scope where id=p_scope_id and organization_id=r.organization_id for update;
 -- One line per posting avoids the engine line limit, retains the original bin and
 -- returns every document reference. The whole RPC remains one transaction.
 for b in select sb.* from public.stock_balances sb
 where sb.organization_id=s.organization_id and sb.batch_id=s.batch_id and sb.product_id=s.product_id
 and sb.stock_status='AVAILABLE' and sb.quantity>0
 order by sb.warehouse_id,sb.location_id nulls first,sb.id for update loop
   doc := private.post_stock('STATUS_CHANGE',b.warehouse_id,
     jsonb_build_array(jsonb_build_object('product_id',s.product_id,'quantity',b.quantity,
       'batch_id',s.batch_id,'location_id',b.location_id,'to_location_id',b.location_id,
       'status','AVAILABLE','to_status','QUARANTINE')),null,'RECALL',left(r.recall_number||': '||btrim(p_reason),500),'RECALL',r.id);
   total := total+b.quantity;
   docs := docs||jsonb_build_array(doc);
 end loop;
 update public.recall_batch_scope set quarantined_at=now() where id=s.id and organization_id=s.organization_id;
 update public.recalls set status=case when exists(
   select 1 from public.recall_batch_scope x where x.recall_id=r.id and x.organization_id=r.organization_id and x.quarantined_at is null
 ) then 'OPEN' else 'QUARANTINED' end where id=r.id and organization_id=r.organization_id;
 return jsonb_build_object('quarantined',total,'documents',docs);
end $$;

create or replace function public.close_recall(p_recall_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r public.recalls;
begin
 if private.current_organization_id() is null or not private.has_permission('recalls.manage') then
   raise exception 'Recall management permission required' using errcode='42501';
 end if;
 select * into r from public.recalls where id=p_recall_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Recall not found' using errcode='P0002'; end if;
 if r.status not in ('OPEN','QUARANTINED') then raise exception 'Recall is already closed' using errcode='22023'; end if;
 if not exists(select 1 from public.recall_batch_scope where recall_id=r.id and organization_id=r.organization_id) then
   raise exception 'Add affected batches before closing the recall' using errcode='22023';
 end if;
 if exists(select 1 from public.recall_batch_scope where recall_id=r.id and organization_id=r.organization_id and quarantined_at is null)
 or exists(select 1 from public.recall_batch_scope s join public.stock_balances b on b.organization_id=s.organization_id and b.batch_id=s.batch_id
 where s.recall_id=r.id and s.organization_id=r.organization_id and b.stock_status='AVAILABLE' and b.quantity>0) then
   raise exception 'Quarantine all available affected stock before closing the recall' using errcode='22023';
 end if;
 update public.recalls set status='CLOSED',closed_at=now(),closed_by=auth.uid() where id=r.id and organization_id=r.organization_id;
end $$;
revoke all on function public.recall_batch_options(),public.quarantine_recall_batch(uuid,text),public.close_recall(uuid) from public,anon;
grant execute on function public.recall_batch_options(),public.quarantine_recall_batch(uuid,text),public.close_recall(uuid) to authenticated;
