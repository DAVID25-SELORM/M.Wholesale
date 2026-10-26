-- Phase 17e: short-pick resolution, batch substitution and fulfilment holds.
-- Substitution corrects the ledger with an auditable stock adjustment; ship-short
-- uses the existing credit-note flow; holds pause the fulfilment workflow.

insert into public.permissions(code,module,action,description) values
 ('fulfilment.exception','fulfilment','exception','Resolve short picks, substitutions and fulfilment holds')
on conflict (code) do update set description=excluded.description;
insert into public.role_permissions(role_id,permission_id)
select r.id,p.id from public.roles r cross join public.permissions p
where r.organization_id is null and p.code='fulfilment.exception'
  and r.code in ('SUPER_ADMIN','OWNER','GENERAL_MANAGER','BRANCH_MANAGER','WAREHOUSE_MANAGER')
on conflict do nothing;

alter table public.fulfilment_orders drop constraint fulfilment_orders_status_check;
alter table public.fulfilment_orders add constraint fulfilment_orders_status_check
  check(status in ('RELEASED','PICKING','PICKED','HOLD','PACKING','PACKED','READY','CANCELLED'));
alter table public.fulfilment_orders add column hold_reason text;
alter table public.fulfilment_orders add column held_by uuid;
alter table public.fulfilment_orders add column held_at timestamptz;
alter table public.fulfilment_orders add constraint fulfilment_orders_hold_complete
  check ((status='HOLD') = (hold_reason is not null and held_by is not null and held_at is not null));
alter table public.fulfilment_orders add constraint fulfilment_orders_hold_actor_fk
  foreign key (held_by,organization_id) references public.profiles(id,organization_id);
alter table public.controlled_adjustments add constraint controlled_adjustments_id_org_key unique(id,organization_id);

alter table public.pick_lines add column actual_batch_id uuid;
alter table public.pick_lines add constraint pick_lines_actual_batch_fk
  foreign key (actual_batch_id,product_id,organization_id) references public.batches(id,product_id,organization_id);

alter table public.fulfilment_exceptions drop constraint fulfilment_exceptions_decision_check;
alter table public.fulfilment_exceptions add constraint fulfilment_exceptions_decision_check
  check (decision in ('ACCEPT_SHORT','WITHDRAWN','SHIP_SHORT','SUBSTITUTED','HOLD'));
alter table public.fulfilment_exceptions add column credit_note_id uuid;
alter table public.fulfilment_exceptions add column substitution_id uuid;
alter table public.fulfilment_exceptions add constraint fulfilment_exceptions_id_org_key unique(id,organization_id);
alter table public.fulfilment_exceptions add constraint fulfilment_exceptions_credit_fk
  foreign key (credit_note_id,organization_id) references public.sales_credit_notes(id,organization_id);

create table public.fulfilment_substitutions (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 fulfilment_order_id uuid not null, pick_line_id uuid not null, exception_id uuid not null, branch_id uuid not null,
 original_batch_id uuid not null, substitute_batch_id uuid not null, quantity numeric(18,3) not null check(quantity>0),
 status text not null default 'PENDING' check(status in ('PENDING','APPROVED','REJECTED','CANCELLED')),
 stock_document_id uuid, controlled_adjustment_id uuid, requested_by uuid not null default auth.uid(), requested_at timestamptz not null default now(),
 decided_by uuid, decided_at timestamptz, decision_note text, created_at timestamptz not null default now(),
 foreign key(fulfilment_order_id,organization_id) references public.fulfilment_orders(id,organization_id),
 foreign key(pick_line_id,organization_id) references public.pick_lines(id,organization_id),
 foreign key(exception_id,organization_id) references public.fulfilment_exceptions(id,organization_id),
 foreign key(branch_id,organization_id) references public.branches(id,organization_id),
 foreign key(original_batch_id,organization_id) references public.batches(id,organization_id),
 foreign key(substitute_batch_id,organization_id) references public.batches(id,organization_id),
 foreign key(requested_by,organization_id) references public.profiles(id,organization_id),
 foreign key(decided_by,organization_id) references public.profiles(id,organization_id),
 foreign key(stock_document_id,organization_id) references public.stock_documents(id,organization_id),
 foreign key(controlled_adjustment_id,organization_id) references public.controlled_adjustments(id,organization_id),
 unique(exception_id), check(original_batch_id<>substitute_batch_id),
 check((status='PENDING' and decided_at is null) or (status<>'PENDING' and decided_at is not null))
);
alter table public.fulfilment_substitutions add constraint fulfilment_substitutions_id_org_key unique(id,organization_id);
alter table public.fulfilment_exceptions add constraint fulfilment_exceptions_substitution_fk
  foreign key (substitution_id,organization_id) references public.fulfilment_substitutions(id,organization_id);
create index fulfilment_substitutions_order_idx on public.fulfilment_substitutions(organization_id,fulfilment_order_id,status);
alter table public.fulfilment_substitutions enable row level security;
revoke all on public.fulfilment_substitutions from public,anon,authenticated;
grant select on public.fulfilment_substitutions to authenticated;
create policy fulfilment_substitutions_read on public.fulfilment_substitutions for select to authenticated
 using(organization_id=(select private.current_organization_id()) and ((select private.has_permission('fulfilment.view')) or branch_id in (select private.permitted_branches('fulfilment.view'))));
create trigger fulfilment_substitutions_no_delete before delete on public.fulfilment_substitutions for each row execute function private.stock_block_mutation();
create trigger fulfilment_substitutions_audit after insert or update on public.fulfilment_substitutions for each row execute function private.audit_row_change('fulfilment_substitution');

-- Permit the substitution source label in the existing stock document constraint.
do $$ declare n text; begin
 select conname into n from pg_constraint where conrelid='public.stock_documents'::regclass and contype='c' and conname='stock_documents_source_type_check';
 if n is not null then execute format('alter table public.stock_documents drop constraint %I',n); end if;
 alter table public.stock_documents add constraint stock_documents_source_type_check check(source_type is null or source_type=any(array['PURCHASE_ORDER','PURCHASE_RETURN','STOCK_COUNT','STOCK_TRANSFER','SALES_INVOICE','CREDIT_NOTE','CONTROLLED_ADJUSTMENT','FULFILMENT_SUBSTITUTION']));
end $$;

do $$ declare def text; fixed text; begin
 def:=pg_get_functiondef('private.post_stock(text, uuid, jsonb, uuid, text, text, text, uuid)'::regprocedure);
 fixed:=replace(def, 'p_source_type is distinct from ''CONTROLLED_ADJUSTMENT'' and not private.has_permission', 'p_source_type is distinct from ''CONTROLLED_ADJUSTMENT'' and p_source_type is distinct from ''FULFILMENT_SUBSTITUTION'' and not private.has_permission');
 if fixed<>def then execute fixed; end if;
end $$;

create function public.request_batch_substitution(p_exception_id uuid,p_substitute_batch_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare e public.fulfilment_exceptions; l public.pick_lines; o public.fulfilment_orders; b public.batches; old public.batches; p public.products; c public.customers; v_id uuid; v_on_hand numeric;
begin
 select * into e from public.fulfilment_exceptions where id=p_exception_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Exception not found' using errcode='P0002'; end if;
 o:=private.load_fulfilment_order(e.fulfilment_order_id,'fulfilment.exception');
 if e.status<>'OPEN' or e.kind<>'SHORT' then raise exception 'Only an open short pick can be substituted' using errcode='22023'; end if;
 select * into l from public.pick_lines where id=e.pick_line_id and organization_id=o.organization_id for update;
 if l.batch_id is null then raise exception 'Only batch-tracked lines can be substituted' using errcode='22023'; end if;
 select * into old from public.batches where id=l.batch_id and organization_id=o.organization_id;
 select * into b from public.batches where id=p_substitute_batch_id and organization_id=o.organization_id and product_id=l.product_id;
 if not found or b.id=old.id or b.expiry_date < current_date then raise exception 'Choose a different, non-expired batch of the same product' using errcode='22023'; end if;
 select * into c from public.customers where id=o.customer_id and organization_id=o.organization_id;
 if c.min_shelf_life_days is not null and b.expiry_date < current_date + c.min_shelf_life_days then raise exception 'The substitute batch does not meet this customer''s minimum shelf life' using errcode='22023'; end if;
 select * into p from public.products where id=l.product_id and organization_id=o.organization_id;
 select coalesce(sum(sb.quantity),0) into v_on_hand from public.stock_balances sb where sb.warehouse_id=o.warehouse_id and sb.product_id=l.product_id and sb.batch_id=b.id and sb.stock_status='AVAILABLE';
 if v_on_hand<e.short_quantity then raise exception 'The substitute batch does not have enough available stock' using errcode='22023'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Give a substitution reason (3 to 500 characters)' using errcode='22023'; end if;
 insert into public.fulfilment_substitutions(organization_id,fulfilment_order_id,pick_line_id,exception_id,branch_id,original_batch_id,substitute_batch_id,quantity)
 values(o.organization_id,o.id,l.id,e.id,o.branch_id,old.id,b.id,e.short_quantity) returning id into v_id;
 return v_id;
end $$;

create function public.approve_batch_substitution(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.fulfilment_substitutions; l public.pick_lines; o public.fulfilment_orders; p public.products; doc jsonb; e public.fulfilment_exceptions;
begin
 select * into s from public.fulfilment_substitutions where id=p_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Substitution not found' using errcode='P0002'; end if;
 o:=private.load_fulfilment_order(s.fulfilment_order_id,'fulfilment.exception');
 if s.status<>'PENDING' then raise exception 'This substitution is already %',lower(s.status) using errcode='22023'; end if;
 select * into l from public.pick_lines where id=s.pick_line_id and organization_id=o.organization_id for update;
 select * into p from public.products where id=l.product_id and organization_id=o.organization_id;
 if p.is_controlled or p.product_class='CONTROLLED' then raise exception 'Controlled substitutions require the controlled-adjustment approval workflow' using errcode='22023'; end if;
 doc:=private.post_stock('ADJUSTMENT',o.warehouse_id,jsonb_build_array(jsonb_build_object('product_id',l.product_id,'quantity',s.quantity,'batch_id',s.original_batch_id,'location_id',l.location_id,'direction','IN'),jsonb_build_object('product_id',l.product_id,'quantity',s.quantity,'batch_id',s.substitute_batch_id,'location_id',l.location_id,'direction','OUT')),null,'FULFILMENT_SUBSTITUTION','Substitution '||s.id,'FULFILMENT_SUBSTITUTION',s.id);
 update public.fulfilment_substitutions set status='APPROVED',stock_document_id=(doc->>'document_id')::uuid,decided_by=auth.uid(),decided_at=now() where id=s.id;
 update public.pick_lines set actual_batch_id=s.substitute_batch_id where id=l.id;
 update public.fulfilment_exceptions set status='RESOLVED',decision='SUBSTITUTED',resolution_reason='Batch substituted',substitution_id=s.id,resolved_by=auth.uid(),resolved_at=now() where id=s.exception_id;
 return doc;
end $$;

create function public.ship_short_fulfilment_order(p_exception_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare e public.fulfilment_exceptions; l public.pick_lines; o public.fulfilment_orders; a public.sales_invoice_allocations; n uuid;
begin
 select * into e from public.fulfilment_exceptions where id=p_exception_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Exception not found' using errcode='P0002'; end if;
 o:=private.load_fulfilment_order(e.fulfilment_order_id,'fulfilment.exception');
 if e.status<>'OPEN' or e.kind<>'SHORT' then raise exception 'Only an open short pick can be shipped short' using errcode='22023'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Give a reason (3 to 500 characters)' using errcode='22023'; end if;
 select * into l from public.pick_lines where id=e.pick_line_id and organization_id=o.organization_id;
 select * into a from public.sales_invoice_allocations where id=l.allocation_id and organization_id=o.organization_id;
 n:=public.save_credit_note(null,o.sales_invoice_id,o.warehouse_id,'OTHER',btrim(p_reason),jsonb_build_array(jsonb_build_object('type','RETURN','invoice_line_id',a.sales_invoice_line_id,'quantity',e.short_quantity,'condition','QUARANTINE','batch_id',a.batch_id)));
 update public.fulfilment_exceptions set status='RESOLVED',decision='SHIP_SHORT',credit_note_id=n,resolution_reason=btrim(p_reason),resolved_by=auth.uid(),resolved_at=now() where id=e.id;
 perform private.settle_fulfilment_order(o.id);
 return n;
end $$;

create function public.hold_fulfilment_order(p_id uuid,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders;
begin o:=private.load_fulfilment_order(p_id,'fulfilment.exception'); if o.status not in ('RELEASED','PICKING','PICKED') or p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Only an active order can be held, with a reason' using errcode='22023'; end if; update public.fulfilment_orders set status='HOLD',hold_reason=btrim(p_reason),held_by=auth.uid(),held_at=now(),picker_id=null where id=o.id; end $$;
create function public.release_fulfilment_hold(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare o public.fulfilment_orders;
begin o:=private.load_fulfilment_order(p_id,'fulfilment.exception'); if o.status<>'HOLD' then raise exception 'This order is not on hold' using errcode='22023'; end if; update public.fulfilment_orders set status='RELEASED',hold_reason=null,held_by=null,held_at=null where id=o.id; end $$;

revoke all on function public.request_batch_substitution(uuid,uuid,text),public.approve_batch_substitution(uuid),public.ship_short_fulfilment_order(uuid,text),public.hold_fulfilment_order(uuid,text),public.release_fulfilment_hold(uuid) from public,anon;
grant execute on function public.request_batch_substitution(uuid,uuid,text),public.approve_batch_substitution(uuid),public.ship_short_fulfilment_order(uuid,text),public.hold_fulfilment_order(uuid,text),public.release_fulfilment_hold(uuid) to authenticated;
