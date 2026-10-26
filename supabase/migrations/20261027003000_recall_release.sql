-- Allow a cancelled recall to be released through an explicit, audited workflow.
alter table public.recall_batch_scope add column released_at timestamptz;
alter table public.recall_batch_scope add column release_reason text;
alter table public.recall_batch_scope add constraint recall_scope_release_reason_check
  check (released_at is null or (release_reason is not null and length(btrim(release_reason)) between 5 and 500));

create function public.cancel_recall(p_recall_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare r public.recalls;
begin
 if not private.has_permission('recalls.manage') then raise exception 'Recall management permission required' using errcode='42501'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 5 and 500 then raise exception 'Give a cancellation reason (5 to 500 characters)' using errcode='22023'; end if;
 select * into r from public.recalls where id=p_recall_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Recall not found' using errcode='P0002'; end if;
 if r.status not in ('OPEN','QUARANTINED') then raise exception 'Recall is already %',lower(r.status) using errcode='22023'; end if;
 update public.recalls set status='CANCELLED',closed_at=now(),closed_by=auth.uid(),instructions=instructions||E'\n\nCancellation: '||btrim(p_reason)
 where id=r.id and organization_id=r.organization_id;
end $$;

create function public.release_recall_batch(p_scope_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.recall_batch_scope; r public.recalls; b record; doc jsonb; docs jsonb := '[]'; total numeric := 0;
begin
 if not private.has_permission('recalls.manage') then raise exception 'Recall management permission required' using errcode='42501'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 5 and 500 then raise exception 'Give a release reason (5 to 500 characters)' using errcode='22023'; end if;
 select * into s from public.recall_batch_scope where id=p_scope_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Recall batch scope not found' using errcode='P0002'; end if;
 select * into r from public.recalls where id=s.recall_id and organization_id=s.organization_id;
 if r.status<>'CANCELLED' then raise exception 'Only a cancelled recall can release stock' using errcode='22023'; end if;
 if exists(select 1 from public.recall_batch_scope x join public.recalls y on y.id=x.recall_id and y.organization_id=x.organization_id where x.batch_id=s.batch_id and x.organization_id=s.organization_id and y.status not in ('CANCELLED','CLOSED')) then
   raise exception 'Another active recall still affects this batch' using errcode='22023';
 end if;
 for b in select sb.* from public.stock_balances sb where sb.organization_id=s.organization_id and sb.batch_id=s.batch_id and sb.product_id=s.product_id and sb.stock_status='QUARANTINE' and sb.quantity>0 order by sb.warehouse_id,sb.location_id nulls first,sb.id for update loop
   doc:=private.post_stock('STATUS_CHANGE',b.warehouse_id,jsonb_build_array(jsonb_build_object('product_id',s.product_id,'quantity',b.quantity,'batch_id',s.batch_id,'location_id',b.location_id,'to_location_id',b.location_id,'status','QUARANTINE','to_status','AVAILABLE')),null,'RECALL: '||r.recall_number,left(btrim(p_reason),500),'RECALL',r.id);
   total:=total+b.quantity; docs:=docs||jsonb_build_array(doc);
 end loop;
 update public.recall_batch_scope set released_at=now(),release_reason=btrim(p_reason) where id=s.id and organization_id=s.organization_id;
 return jsonb_build_object('released',total,'documents',docs);
end $$;

revoke all on function public.cancel_recall(uuid,text),public.release_recall_batch(uuid,text) from public,anon;
grant execute on function public.cancel_recall(uuid,text),public.release_recall_batch(uuid,text) to authenticated;
