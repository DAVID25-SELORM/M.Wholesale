-- Phase 18a: recall register and batch quarantine. No silent stock updates.
insert into public.permissions(code,module,action,description) values
 ('recalls.view','recalls','view','View product recalls and affected batches'),
 ('recalls.manage','recalls','manage','Create recalls, scope batches and quarantine affected stock')
on conflict (code) do update set description=excluded.description;
insert into public.role_permissions(role_id,permission_id)
select r.id,p.id from public.roles r cross join public.permissions p
where r.organization_id is null
  and ((r.code in ('SUPER_ADMIN','OWNER','GENERAL_MANAGER','BRANCH_MANAGER','PHARMACIST') and p.code in ('recalls.view','recalls.manage'))
       or (r.code in ('WAREHOUSE_MANAGER','AUDITOR') and p.code='recalls.view'))
on conflict do nothing;

create table public.recalls (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 recall_number text not null, source text not null check(source in ('FDA','MANUFACTURER','SUPPLIER','INTERNAL','OTHER')),
 recall_class text not null check(recall_class in ('I','II','III','OTHER')), title text not null check(length(btrim(title)) between 3 and 200),
 instructions text not null check(length(btrim(instructions)) between 3 and 2000), status text not null default 'OPEN' check(status in ('OPEN','QUARANTINED','CLOSED','CANCELLED')),
 opened_at timestamptz not null default now(), opened_by uuid not null default auth.uid(), closed_at timestamptz, closed_by uuid,
 unique(organization_id,recall_number), unique(id,organization_id),
 foreign key(opened_by,organization_id) references public.profiles(id,organization_id), foreign key(closed_by,organization_id) references public.profiles(id,organization_id),
 check((status in ('CLOSED','CANCELLED')) = (closed_at is not null and closed_by is not null))
);
create table public.recall_batch_scope (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 recall_id uuid not null, batch_id uuid not null, product_id uuid not null, added_at timestamptz not null default now(), added_by uuid not null default auth.uid(), quarantined_at timestamptz,
 unique(recall_id,batch_id), unique(id,organization_id),
 foreign key(recall_id,organization_id) references public.recalls(id,organization_id), foreign key(batch_id,product_id,organization_id) references public.batches(id,product_id,organization_id),
 foreign key(added_by,organization_id) references public.profiles(id,organization_id)
);
create index recall_batch_scope_batch_idx on public.recall_batch_scope(organization_id,batch_id);
do $$ declare n text; def text; fixed text; begin
 select conname into n from pg_constraint where conrelid='public.stock_documents'::regclass and contype='c' and conname='stock_documents_source_type_check';
 if n is not null then execute format('alter table public.stock_documents drop constraint %I',n); end if;
 alter table public.stock_documents add constraint stock_documents_source_type_check check(source_type is null or source_type=any(array['PURCHASE_ORDER','PURCHASE_RETURN','STOCK_COUNT','STOCK_TRANSFER','SALES_INVOICE','CREDIT_NOTE','CONTROLLED_ADJUSTMENT','FULFILMENT_SUBSTITUTION','RECALL']));
 def:=pg_get_functiondef('private.post_stock(text, uuid, jsonb, uuid, text, text, text, uuid)'::regprocedure);
 fixed:=replace(def, 'p_source_type is distinct from ''FULFILMENT_SUBSTITUTION'' and not private.has_permission', 'p_source_type is distinct from ''FULFILMENT_SUBSTITUTION'' and p_source_type is distinct from ''RECALL'' and not private.has_permission');
 if fixed<>def then execute fixed; end if;
end $$;
alter table public.recalls enable row level security; alter table public.recall_batch_scope enable row level security;
revoke all on public.recalls,public.recall_batch_scope from public,anon,authenticated;
grant select on public.recalls,public.recall_batch_scope to authenticated;
create policy recalls_read on public.recalls for select to authenticated using(organization_id=(select private.current_organization_id()) and ((select private.has_permission('recalls.view')) or (select private.has_permission('recalls.manage'))));
create policy recall_scope_read on public.recall_batch_scope for select to authenticated using(organization_id=(select private.current_organization_id()) and ((select private.has_permission('recalls.view')) or (select private.has_permission('recalls.manage'))));
create trigger recalls_no_delete before delete on public.recalls for each row execute function private.stock_block_mutation();
create trigger recall_scope_no_delete before delete on public.recall_batch_scope for each row execute function private.stock_block_mutation();
create trigger recalls_audit after insert or update on public.recalls for each row execute function private.audit_row_change('recall');
create trigger recall_scope_audit after insert or update on public.recall_batch_scope for each row execute function private.audit_row_change('recall_batch_scope');

create function public.create_recall(p_source text,p_class text,p_title text,p_instructions text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 if not private.has_permission('recalls.manage') then raise exception 'Recall management permission required' using errcode='42501'; end if;
 insert into public.recalls(organization_id,recall_number,source,recall_class,title,instructions)
 values(private.current_organization_id(),private.generate_document_number(private.current_organization_id(),null,'RECALL','REC'),upper(p_source),upper(p_class),btrim(p_title),btrim(p_instructions)) returning id into v_id;
 return v_id;
end $$;
create function public.add_recall_batch(p_recall_id uuid,p_batch_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare r public.recalls; b public.batches; v_id uuid;
begin
 if not private.has_permission('recalls.manage') then raise exception 'Recall management permission required' using errcode='42501'; end if;
 select * into r from public.recalls where id=p_recall_id and organization_id=private.current_organization_id() for update;
 if not found or r.status in ('CLOSED','CANCELLED') then raise exception 'Recall is not open' using errcode='22023'; end if;
 select * into b from public.batches where id=p_batch_id and organization_id=r.organization_id;
 if not found then raise exception 'Batch not found' using errcode='P0002'; end if;
 insert into public.recall_batch_scope(organization_id,recall_id,batch_id,product_id) values(r.organization_id,r.id,b.id,b.product_id) returning id into v_id;
 return v_id;
end $$;
create function public.quarantine_recall_batch(p_scope_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.recall_batch_scope; r public.recalls; b public.batches; w record; v_lines jsonb; doc jsonb; total numeric := 0;
begin
 if not private.has_permission('recalls.manage') then raise exception 'Recall management permission required' using errcode='42501'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 5 and 500 then raise exception 'Give a quarantine reason (5 to 500 characters)' using errcode='22023'; end if;
 select * into s from public.recall_batch_scope where id=p_scope_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Recall batch scope not found' using errcode='P0002'; end if;
 if s.quarantined_at is not null then raise exception 'This batch has already been quarantined for the recall' using errcode='22023'; end if;
 select * into r from public.recalls where id=s.recall_id and organization_id=s.organization_id for update;
 select * into b from public.batches where id=s.batch_id and organization_id=s.organization_id;
 for w in select distinct warehouse_id from public.stock_balances where organization_id=s.organization_id and batch_id=s.batch_id and product_id=s.product_id and stock_status='AVAILABLE' and quantity>0 loop
   select coalesce(jsonb_agg(jsonb_build_object('product_id',s.product_id,'quantity',sb.quantity,'batch_id',s.batch_id,'location_id',sb.location_id,'status','AVAILABLE','to_status','QUARANTINE')),'[]'::jsonb),coalesce(sum(sb.quantity),0)
     into v_lines,total from public.stock_balances sb where sb.organization_id=s.organization_id and sb.warehouse_id=w.warehouse_id and sb.batch_id=s.batch_id and sb.product_id=s.product_id and sb.stock_status='AVAILABLE' and sb.quantity>0;
   doc:=private.post_stock('STATUS_CHANGE',w.warehouse_id,v_lines,null,'RECALL: '||r.recall_number,left(btrim(p_reason),500),'RECALL',r.id);
 end loop;
 if total=0 then update public.recall_batch_scope set quarantined_at=now() where id=s.id; return jsonb_build_object('quarantined',0); end if;
 update public.recall_batch_scope set quarantined_at=now() where id=s.id;
 update public.recalls set status='QUARANTINED' where id=r.id and status='OPEN';
 return doc;
end $$;

revoke all on function public.create_recall(text,text,text,text),public.add_recall_batch(uuid,uuid),public.quarantine_recall_batch(uuid,text) from public,anon;
grant execute on function public.create_recall(text,text,text,text),public.add_recall_batch(uuid,uuid),public.quarantine_recall_batch(uuid,text) to authenticated;
