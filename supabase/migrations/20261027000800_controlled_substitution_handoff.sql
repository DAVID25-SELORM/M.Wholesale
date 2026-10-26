-- Connect controlled batch substitutions to the existing second-person approval workflow.
alter table public.controlled_adjustments add column fulfilment_substitution_id uuid;
alter table public.controlled_adjustments add constraint controlled_adjustments_substitution_fk
  foreign key (fulfilment_substitution_id,organization_id)
  references public.fulfilment_substitutions(id,organization_id);
create unique index controlled_adjustments_substitution_key
  on public.controlled_adjustments(fulfilment_substitution_id) where fulfilment_substitution_id is not null;

create function public.request_controlled_batch_substitution(p_substitution_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare s public.fulfilment_substitutions; l public.pick_lines; o public.fulfilment_orders; p public.products; v_id uuid; v_no text;
begin
 select * into s from public.fulfilment_substitutions where id=p_substitution_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Substitution not found' using errcode='P0002'; end if;
 o:=private.load_fulfilment_order(s.fulfilment_order_id,'fulfilment.exception');
 if not private.has_permission('inventory.adjust',o.branch_id) then raise exception 'Inventory adjustment permission required' using errcode='42501'; end if;
 if s.status<>'PENDING' then raise exception 'This substitution is already %',lower(s.status) using errcode='22023'; end if;
 select * into l from public.pick_lines where id=s.pick_line_id and organization_id=o.organization_id for update;
 select * into p from public.products where id=l.product_id and organization_id=o.organization_id;
 if not (p.is_controlled or p.product_class='CONTROLLED') then raise exception 'Use the ordinary substitution approval for non-controlled products' using errcode='22023'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 5 and 500 then raise exception 'Explain the controlled substitution (5 to 500 characters)' using errcode='22023'; end if;
 v_no:=private.generate_document_number(o.organization_id,null,'CONTROLLED_ADJUSTMENT','CDA');
 insert into public.controlled_adjustments(organization_id,request_number,branch_id,warehouse_id,reason_code,notes,lines,fulfilment_substitution_id)
 values(o.organization_id,v_no,o.branch_id,o.warehouse_id,'OTHER',btrim(p_reason),jsonb_build_array(
   jsonb_build_object('product_id',l.product_id,'quantity',s.quantity,'batch_id',s.original_batch_id,'location_id',l.location_id,'direction','IN'),
   jsonb_build_object('product_id',l.product_id,'quantity',s.quantity,'batch_id',s.substitute_batch_id,'location_id',l.location_id,'direction','OUT')
 ),s.id) returning id into v_id;
 update public.fulfilment_substitutions set controlled_adjustment_id=v_id where id=s.id;
 return v_id;
end $$;

create function private.sync_controlled_substitution()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.fulfilment_substitution_id is null or new.status='PENDING' then return new; end if;
 if new.status='APPROVED' then
   update public.fulfilment_substitutions set status='APPROVED',stock_document_id=new.stock_document_id,decided_by=new.decided_by,decided_at=new.decided_at,decision_note=new.decision_note where id=new.fulfilment_substitution_id and organization_id=new.organization_id;
   update public.pick_lines l set actual_batch_id=s.substitute_batch_id from public.fulfilment_substitutions s where s.id=new.fulfilment_substitution_id and s.organization_id=new.organization_id and l.id=s.pick_line_id and l.organization_id=s.organization_id;
   update public.fulfilment_exceptions e set status='RESOLVED',decision='SUBSTITUTED',resolution_reason=coalesce(new.decision_note,'Controlled batch substitution approved'),substitution_id=new.fulfilment_substitution_id,resolved_by=new.decided_by,resolved_at=new.decided_at where e.id=(select s.exception_id from public.fulfilment_substitutions s where s.id=new.fulfilment_substitution_id and s.organization_id=new.organization_id) and e.organization_id=new.organization_id;
 elsif new.status in ('REJECTED','CANCELLED') then
   update public.fulfilment_substitutions set status=new.status,decided_by=new.decided_by,decided_at=new.decided_at,decision_note=new.decision_note where id=new.fulfilment_substitution_id and organization_id=new.organization_id;
 end if;
 return new;
end $$;
create trigger controlled_adjustments_sync_substitution after update of status on public.controlled_adjustments
 for each row when (new.status is distinct from old.status) execute function private.sync_controlled_substitution();

revoke all on function public.request_controlled_batch_substitution(uuid,text),private.sync_controlled_substitution() from public,anon;
grant execute on function public.request_controlled_batch_substitution(uuid,text) to authenticated;
