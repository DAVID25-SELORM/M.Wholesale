-- Release only quantities placed on hold by this recall, in their original bins.
-- If quarantine stock has since left a bin, provenance is ambiguous: require review.
create or replace function public.release_recall_batch(p_scope_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.recall_batch_scope; r public.recalls; b record; held record; doc jsonb; docs jsonb:='[]'; total numeric:=0;
begin
 if not private.has_permission('recalls.manage') then raise exception 'Recall management permission required' using errcode='42501'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 5 and 500 then raise exception 'Give a release reason (5 to 500 characters)' using errcode='22023'; end if;
 select * into s from public.recall_batch_scope where id=p_scope_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Recall batch scope not found' using errcode='P0002'; end if;
 select * into r from public.recalls where id=s.recall_id and organization_id=s.organization_id for update;
 select * into s from public.recall_batch_scope where id=p_scope_id and organization_id=r.organization_id for update;
 if r.status<>'CANCELLED' then raise exception 'Only a cancelled recall can release stock' using errcode='22023'; end if;
 if s.released_at is not null then return jsonb_build_object('released',0,'documents',docs,'already_released',true); end if;
 -- add_recall_batch takes this same lock before adding any new scope.
 perform 1 from public.batches where id=s.batch_id and organization_id=s.organization_id for update;
 if exists(select 1 from public.recall_batch_scope x join public.recalls y on y.id=x.recall_id and y.organization_id=x.organization_id where x.batch_id=s.batch_id and x.organization_id=s.organization_id and y.status<>'CANCELLED') then
  raise exception 'Another recall still affects this batch' using errcode='22023';
 end if;
 if exists(select 1 from public.stock_movements outgoing where outgoing.organization_id=s.organization_id and outgoing.batch_id=s.batch_id and outgoing.stock_status='QUARANTINE' and outgoing.quantity<0 and exists(
  select 1 from public.stock_movements incoming join public.stock_documents d on d.id=incoming.document_id and d.organization_id=incoming.organization_id
  where incoming.organization_id=s.organization_id and incoming.batch_id=s.batch_id and incoming.stock_status='QUARANTINE' and incoming.quantity>0 and incoming.warehouse_id=outgoing.warehouse_id and incoming.location_id is not distinct from outgoing.location_id and incoming.seq<outgoing.seq and d.source_type='RECALL' and d.source_id=r.id
 )) then raise exception 'Quarantine stock has moved since this recall; review disposition before release' using errcode='22023'; end if;
 for b in select sb.* from public.stock_balances sb where sb.organization_id=s.organization_id and sb.batch_id=s.batch_id and sb.product_id=s.product_id and sb.stock_status='QUARANTINE' and sb.quantity>0 order by sb.warehouse_id,sb.location_id nulls first,sb.id for update loop
  select sum(m.quantity) as quantity,min(m.seq) as first_seq into held
  from public.stock_movements m join public.stock_documents d on d.id=m.document_id and d.organization_id=m.organization_id
  where m.organization_id=s.organization_id and m.batch_id=s.batch_id and m.warehouse_id=b.warehouse_id and m.location_id is not distinct from b.location_id
   and m.stock_status='QUARANTINE' and d.source_type='RECALL' and d.source_id=r.id;
  if coalesce(held.quantity,0)<=0 then continue; end if;
  if held.quantity>b.quantity or exists(select 1 from public.stock_movements m where m.organization_id=s.organization_id and m.batch_id=s.batch_id and m.warehouse_id=b.warehouse_id and m.location_id is not distinct from b.location_id and m.stock_status='QUARANTINE' and m.quantity<0 and m.seq>held.first_seq) then
   raise exception 'Quarantine stock has moved since this recall; review disposition before release' using errcode='22023';
  end if;
  doc:=private.post_stock('STATUS_CHANGE',b.warehouse_id,jsonb_build_array(jsonb_build_object('product_id',s.product_id,'quantity',held.quantity,'batch_id',s.batch_id,'location_id',b.location_id,'to_location_id',b.location_id,'status','QUARANTINE','to_status','AVAILABLE')),null,'RECALL',btrim(p_reason),'RECALL',r.id);
  total:=total+held.quantity; docs:=docs||jsonb_build_array(doc);
 end loop;
 update public.recall_batch_scope set released_at=now(),release_reason=btrim(p_reason) where id=s.id and organization_id=s.organization_id;
 return jsonb_build_object('released',total,'documents',docs);
end $$;

create or replace function public.add_recall_batch(p_recall_id uuid,p_batch_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare r public.recalls; b public.batches; v_id uuid;
begin
 if not private.has_permission('recalls.manage') then raise exception 'Recall management permission required' using errcode='42501'; end if;
 select * into r from public.recalls where id=p_recall_id and organization_id=private.current_organization_id() for update;
 if not found or r.status in ('CLOSED','CANCELLED') then raise exception 'Recall is not open' using errcode='22023'; end if;
 select * into b from public.batches where id=p_batch_id and organization_id=r.organization_id for update;
 if not found then raise exception 'Batch not found' using errcode='P0002'; end if;
 insert into public.recall_batch_scope(organization_id,recall_id,batch_id,product_id) values(r.organization_id,r.id,b.id,b.product_id) returning id into v_id;
 return v_id;
end $$;
