-- Record customer recovery/disposition against traced recall exposure.
create table public.recall_recoveries (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 recall_batch_scope_id uuid not null,
 sales_invoice_id uuid not null,
 customer_id uuid not null,
 batch_id uuid not null,
 quantity numeric not null check(quantity>0),
 status text not null default 'OPEN' check(status in ('OPEN','CONTACTED','RECOVERED','NOT_RECOVERABLE')),
 notes text not null check(length(btrim(notes)) between 3 and 1000),
 created_at timestamptz not null default now(), created_by uuid not null default auth.uid(),
 updated_at timestamptz not null default now(), updated_by uuid not null default auth.uid(),
 unique(organization_id,recall_batch_scope_id,sales_invoice_id), unique(id,organization_id),
 foreign key(recall_batch_scope_id,organization_id) references public.recall_batch_scope(id,organization_id),
 foreign key(sales_invoice_id,organization_id) references public.sales_invoices(id,organization_id),
 foreign key(customer_id,organization_id) references public.customers(id,organization_id),
 foreign key(batch_id,organization_id) references public.batches(id,organization_id),
 foreign key(created_by,organization_id) references public.profiles(id,organization_id),
 foreign key(updated_by,organization_id) references public.profiles(id,organization_id)
);
create index recall_recoveries_recall_idx on public.recall_recoveries(organization_id,recall_batch_scope_id,status);
alter table public.recall_recoveries enable row level security;
revoke all on public.recall_recoveries from public,anon,authenticated;
grant select on public.recall_recoveries to authenticated;
create policy recall_recovery_read on public.recall_recoveries for select to authenticated using(organization_id=(select private.current_organization_id()) and (select private.has_permission('recalls.view') or private.has_permission('recalls.manage')));
create trigger recall_recoveries_no_delete before delete on public.recall_recoveries for each row execute function private.stock_block_mutation();
create trigger recall_recoveries_audit after insert or update on public.recall_recoveries for each row execute function private.audit_row_change('recall_recovery');

create function public.record_recall_recovery(p_scope_id uuid,p_invoice_id uuid,p_quantity numeric,p_status text,p_notes text)
returns uuid language plpgsql security definer set search_path='' as $$
declare s public.recall_batch_scope; v_customer uuid; v_batch uuid; v_exposure numeric; v_id uuid; v_status text:=upper(btrim(p_status));
begin
 if not private.has_permission('recalls.manage') then raise exception 'Recall management permission required' using errcode='42501'; end if;
 if p_quantity is null or p_quantity<=0 then raise exception 'Recovery quantity must be positive' using errcode='22023'; end if;
 if v_status not in ('OPEN','CONTACTED','RECOVERED','NOT_RECOVERABLE') then raise exception 'Invalid recovery status' using errcode='22023'; end if;
 if p_notes is null or length(btrim(p_notes)) not between 3 and 1000 then raise exception 'Give recovery notes (3 to 1000 characters)' using errcode='22023'; end if;
 select * into s from public.recall_batch_scope where id=p_scope_id and organization_id=private.current_organization_id();
 if not found then raise exception 'Recall batch scope not found' using errcode='P0002'; end if;
 select i.customer_id into v_customer from public.sales_invoices i where i.id=p_invoice_id and i.organization_id=s.organization_id and i.status='POSTED';
 if v_customer is null then raise exception 'Posted invoice not found' using errcode='P0002'; end if;
 select coalesce(sum(x.quantity),0) into v_exposure from (
   select a.base_quantity quantity from public.sales_invoice_allocations a where a.sales_invoice_id=p_invoice_id and a.batch_id=s.batch_id and a.organization_id=s.organization_id
   union all select fs.quantity from public.fulfilment_substitutions fs join public.fulfilment_orders fo on fo.id=fs.fulfilment_order_id and fo.organization_id=fs.organization_id where fo.sales_invoice_id=p_invoice_id and fs.substitute_batch_id=s.batch_id and fs.organization_id=s.organization_id and fs.status='APPROVED'
 ) x;
 if v_exposure=0 or p_quantity>v_exposure then raise exception 'Recovery quantity exceeds traced invoice exposure' using errcode='22023'; end if;
 v_batch:=s.batch_id;
 insert into public.recall_recoveries(organization_id,recall_batch_scope_id,sales_invoice_id,customer_id,batch_id,quantity,status,notes)
 values(s.organization_id,s.id,p_invoice_id,v_customer,v_batch,p_quantity,v_status,btrim(p_notes))
 on conflict(organization_id,recall_batch_scope_id,sales_invoice_id) do update set quantity=excluded.quantity,status=excluded.status,notes=excluded.notes,updated_at=now(),updated_by=auth.uid()
 returning id into v_id;
 return v_id;
end $$;

revoke all on function public.record_recall_recovery(uuid,uuid,numeric,text,text) from public,anon;
grant execute on function public.record_recall_recovery(uuid,uuid,numeric,text,text) to authenticated;
