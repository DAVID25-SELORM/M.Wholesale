-- Driver temperature capture on delivery runs.
-- The reading rules move into one private function so warehouse staff and drivers get identical
-- range and excursion behaviour. Drivers no longer hold the broad temperature permissions: they can
-- record only through run_temperature(), and only for cold-chain packages on a run on the road that
-- is assigned to them (or that a run manager is working). No stock or financial movement is made.

create function private.write_temperature_reading(p_order public.fulfilment_orders,p_package public.packages,p_stage text,p_temperature numeric,p_note text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_cond text; v_min numeric; v_max numeric; v_ok boolean; v_reading uuid; v_exc uuid; v_temp numeric;
begin
 if p_order.status='CANCELLED' or p_package.voided_at is not null then raise exception 'This package is not active' using errcode='22023'; end if;
 if not p_package.cold_chain then raise exception 'Temperature is recorded only for cold-chain packages' using errcode='22023'; end if;
 if p_stage is null or p_stage not in ('PACKING','DISPATCH','TRANSIT','DELIVERY') then raise exception 'Choose a valid stage' using errcode='22023'; end if;
 if p_temperature is null or p_temperature='NaN'::numeric or p_temperature not between -60 and 60 then raise exception 'Enter a temperature between -60 and 60 degrees C' using errcode='22023'; end if;
 if p_note is not null and length(btrim(p_note)) not between 1 and 500 then raise exception 'The note must be 1 to 500 characters' using errcode='22023'; end if;
 select (array['AMBIENT','COOL','REFRIGERATED','FROZEN'])[max(case pr.storage_condition when 'FROZEN' then 4 when 'REFRIGERATED' then 3 when 'COOL' then 2 else 1 end)] into v_cond
 from public.package_lines l join public.pick_lines pl on pl.id=l.pick_line_id and pl.organization_id=l.organization_id
 join public.products pr on pr.id=pl.product_id and pr.organization_id=pl.organization_id
 where l.package_id=p_package.id and l.organization_id=p_order.organization_id;
 if v_cond is null then raise exception 'Pack goods into the package before recording its temperature' using errcode='22023'; end if;
 select min_c,max_c into v_min,v_max from private.temperature_limits(v_cond);
 v_temp:=round(p_temperature,1);
 v_ok:=v_temp between v_min and v_max;
 insert into public.temperature_readings(organization_id,branch_id,fulfilment_order_id,package_id,stage,temperature_c,storage_condition,limit_min_c,limit_max_c,within_range,note)
 values(p_order.organization_id,p_order.branch_id,p_order.id,p_package.id,p_stage,v_temp,v_cond,v_min,v_max,v_ok,nullif(btrim(p_note),'')) returning id into v_reading;
 if not v_ok then
   insert into public.temperature_excursions(organization_id,branch_id,fulfilment_order_id,package_id,reading_id)
   values(p_order.organization_id,p_order.branch_id,p_order.id,p_package.id,v_reading) returning id into v_exc;
 end if;
 return jsonb_build_object('reading_id',v_reading,'within_range',v_ok,'excursion_id',v_exc,'limit_min_c',v_min,'limit_max_c',v_max,'storage_condition',v_cond);
end $$;
revoke all on function private.write_temperature_reading(public.fulfilment_orders,public.packages,text,numeric,text) from public,anon,authenticated;

create or replace function public.record_temperature_reading(p_package_id uuid,p_stage text,p_temperature numeric,p_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare pk public.packages; o public.fulfilment_orders;
begin
 select * into pk from public.packages where id=p_package_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Package not found' using errcode='P0002'; end if;
 o:=private.load_temperature_order(pk.fulfilment_order_id,'temperature.record');
 select * into pk from public.packages where id=p_package_id and organization_id=o.organization_id;
 return private.write_temperature_reading(o,pk,p_stage,p_temperature,p_note);
end $$;

-- Cold-chain packages on the stops of one run, with their latest reading. Readable by whoever can read the run.
create function public.run_cold_packages(p_run_id uuid)
returns table(stop_id uuid,stop_position integer,stop_status text,customer_name text,package_id uuid,package_number text,
 latest_temperature_c numeric,latest_within_range boolean,latest_stage text,latest_recorded_at timestamptz,open_excursions integer,rejected_excursions integer)
language plpgsql stable security definer set search_path='' as $$
#variable_conflict use_column
declare v_org uuid:=private.current_organization_id();
begin
 if v_org is null or not private.can_read_run(p_run_id) then raise exception 'Run not found' using errcode='P0002'; end if;
 return query
 select s.id,s.position,s.status,c.name::text,pk.id,pk.package_number,lr.temperature_c,lr.within_range,lr.stage,lr.recorded_at,
  (select count(*)::integer from public.temperature_excursions x where x.package_id=pk.id and x.organization_id=v_org and x.status='OPEN'),
  (select count(*)::integer from public.temperature_excursions x where x.package_id=pk.id and x.organization_id=v_org and x.decision='REJECT_GOODS')
 from public.delivery_run_stops s
 join public.delivery_notes d on d.id=s.delivery_note_id and d.organization_id=s.organization_id
 join public.fulfilment_orders o on o.sales_invoice_id=d.sales_invoice_id and o.organization_id=d.organization_id and o.status<>'CANCELLED'
 join public.customers c on c.id=o.customer_id and c.organization_id=o.organization_id
 join public.packages pk on pk.fulfilment_order_id=o.id and pk.organization_id=o.organization_id and pk.cold_chain and pk.voided_at is null
 left join lateral (select r.temperature_c,r.within_range,r.stage,r.recorded_at from public.temperature_readings r where r.package_id=pk.id and r.organization_id=v_org order by r.recorded_at desc,r.id limit 1) lr on true
 where s.run_id=p_run_id and s.organization_id=v_org and s.status<>'REMOVED'
 order by s.position,pk.package_number;
end $$;

-- Record a temperature from the road. The run must be on the road, the package must be a cold-chain
-- package on one of its stops, and the caller must be the assigned driver or a run manager.
create function public.record_run_temperature(p_run_id uuid,p_package_id uuid,p_stage text,p_temperature numeric,p_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.delivery_runs; pk public.packages; o public.fulfilment_orders;
begin
 r:=private.load_run(p_run_id,false);
 if not private.has_permission('runs.manage',r.branch_id) and not (private.has_permission('runs.drive',r.branch_id)
   and exists(select 1 from public.drivers where id=r.driver_id and organization_id=r.organization_id and profile_id=auth.uid() and is_active)) then
   raise exception 'Only the assigned driver or a run manager can record temperatures for this run' using errcode='42501';
 end if;
 if r.status<>'ON_ROAD' then raise exception 'Temperatures are recorded while the run is on the road' using errcode='22023'; end if;
 if p_stage is null or p_stage not in ('TRANSIT','DELIVERY') then raise exception 'Choose in transit or at delivery' using errcode='22023'; end if;
 select p.* into pk from public.packages p
 join public.fulfilment_orders fo on fo.id=p.fulfilment_order_id and fo.organization_id=p.organization_id and fo.status<>'CANCELLED'
 join public.delivery_notes d on d.sales_invoice_id=fo.sales_invoice_id and d.organization_id=fo.organization_id
 join public.delivery_run_stops s on s.delivery_note_id=d.id and s.organization_id=d.organization_id and s.run_id=r.id and s.status<>'REMOVED'
 where p.id=p_package_id and p.organization_id=r.organization_id;
 if not found then raise exception 'That package is not on this run' using errcode='P0002'; end if;
 select * into o from public.fulfilment_orders where id=pk.fulfilment_order_id and organization_id=r.organization_id for update;
 return private.write_temperature_reading(o,pk,p_stage,p_temperature,p_note);
end $$;

revoke all on function public.run_cold_packages(uuid),public.record_run_temperature(uuid,uuid,text,numeric,text) from public,anon;
grant execute on function public.run_cold_packages(uuid),public.record_run_temperature(uuid,uuid,text,numeric,text) to authenticated;

-- Drivers work through the run functions only.
delete from public.role_permissions rp using public.roles r,public.permissions p
where rp.role_id=r.id and rp.permission_id=p.id and r.organization_id is null and r.code='DRIVER' and p.code in ('temperature.view','temperature.record');
