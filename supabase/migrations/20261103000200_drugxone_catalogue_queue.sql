-- Queue a deterministic catalogue snapshot for a trusted DrugXone adapter.
-- Queueing never changes ERP stock or prices and never calls the external service.
create function public.drugxone_queue_catalogue(p_product_ids uuid[] default null,p_reason text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare org uuid:=private.current_organization_id(); c public.drugxone_connections; m record; payload jsonb; event_id uuid; event_ids jsonb:='[]'; queued integer:=0;
begin
 if org is null or not private.has_permission_anywhere('integrations.manage') then raise exception 'Integration management permission required' using errcode='42501'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 5 and 500 then raise exception 'Give a catalogue sync reason (5 to 500 characters)' using errcode='22023'; end if;
 select * into c from public.drugxone_connections where organization_id=org and status='READY' for update;
 if not found then raise exception 'A ready DrugXone connection is required' using errcode='22023'; end if;
 for m in
   select pm.id mapping_id,pm.product_id,pm.external_product_id,pm.external_offer_id,pm.external_sku,pm.external_name,pm.status mapping_status,
          p.sku,p.brand_name,p.description,p.product_class,p.storage_condition,p.requires_prescription,p.is_controlled,p.track_batches,
          bu.code base_unit,
          coalesce((select sum(sb.quantity) from public.stock_balances sb where sb.organization_id=org and sb.product_id=p.id and sb.stock_status='AVAILABLE'),0) available_quantity
   from public.drugxone_product_mappings pm join public.products p on p.id=pm.product_id and p.organization_id=pm.organization_id
   join public.units_of_measure bu on bu.id=p.base_unit_id
   where pm.organization_id=org and pm.connection_id=c.id and pm.status in ('PENDING','ACTIVE') and p.is_active
     and (p_product_ids is null or p.id=any(p_product_ids))
   order by pm.external_offer_id,pm.id
 loop
   payload:=jsonb_build_object('mapping_id',m.mapping_id,'product_id',m.product_id,'external_product_id',m.external_product_id,'external_offer_id',m.external_offer_id,'external_sku',m.external_sku,'name',m.external_name,'erp_sku',m.sku,'brand_name',m.brand_name,'description',m.description,'product_class',m.product_class,'storage_condition',m.storage_condition,'requires_prescription',m.requires_prescription,'controlled',m.is_controlled,'track_batches',m.track_batches,'base_unit',m.base_unit,'available_quantity',m.available_quantity,'reason',btrim(p_reason));
   event_id:=private.drugxone_enqueue_event(org,c.id,'ERP_TO_DRUGXONE','CATALOGUE',m.product_id,m.external_offer_id,'catalogue:'||m.mapping_id::text||':'||md5(payload::text),md5(payload::text),payload);
   event_ids:=event_ids||jsonb_build_array(event_id); queued:=queued+1;
 end loop;
 return jsonb_build_object('queued',queued,'event_ids',event_ids);
end $$;

revoke all on function public.drugxone_queue_catalogue(uuid[],text) from public,anon;
grant execute on function public.drugxone_queue_catalogue(uuid[],text) to authenticated;
