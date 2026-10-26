-- Serialize new recall scopes with sales and dispatch on the batch row.
create function private.lock_recall_scope_batch()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.batches where id=new.batch_id and organization_id=new.organization_id for update;
 return new;
end $$;
create trigger recall_scope_lock_batch before insert on public.recall_batch_scope
for each row execute function private.lock_recall_scope_batch();

create function private.block_recalled_sale()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.batch_id is null then return new; end if;
 if new.movement_type='SALE_OUT' or (new.movement_type='STATUS_IN' and new.stock_status='AVAILABLE') then
   perform 1 from public.batches where id=new.batch_id and organization_id=new.organization_id for share;
   if exists(select 1 from public.recall_batch_scope s join public.recalls r on r.id=s.recall_id and r.organization_id=s.organization_id
     where s.batch_id=new.batch_id and s.organization_id=new.organization_id and r.status<>'CANCELLED') then
     raise exception 'Recalled stock cannot be sold or released to available stock' using errcode='22023';
   end if;
 end if;
 return new;
end $$;
create trigger stock_movements_recall_guard before insert on public.stock_movements
for each row execute function private.block_recalled_sale();

create function private.block_recalled_dispatch()
returns trigger language plpgsql security definer set search_path='' as $$
declare b record;
begin
 -- Include substitutions and original invoice batches conservatively. A recall
 -- investigation must resolve an already allocated batch before dispatch.
 for b in
   select a.batch_id from public.sales_invoice_allocations a
   where a.sales_invoice_id=new.sales_invoice_id and a.organization_id=new.organization_id and a.batch_id is not null
   union
   select l.actual_batch_id from public.pick_lines l join public.fulfilment_orders o
     on o.id=l.fulfilment_order_id and o.organization_id=l.organization_id
   where o.sales_invoice_id=new.sales_invoice_id and o.organization_id=new.organization_id and o.status<>'CANCELLED' and l.actual_batch_id is not null
   order by 1
 loop
   perform 1 from public.batches where id=b.batch_id and organization_id=new.organization_id for share;
   if exists(select 1 from public.recall_batch_scope s join public.recalls r on r.id=s.recall_id and r.organization_id=s.organization_id
     where s.batch_id=b.batch_id and s.organization_id=new.organization_id and r.status<>'CANCELLED') then
     raise exception 'This delivery contains an allocated or substituted recalled batch; dispatch is blocked' using errcode='22023';
   end if;
 end loop;
 return new;
end $$;
create trigger delivery_notes_recall_guard before update of status on public.delivery_notes
for each row when(new.status='DISPATCHED' and old.status is distinct from 'DISPATCHED') execute function private.block_recalled_dispatch();
revoke all on function private.lock_recall_scope_batch(),private.block_recalled_sale(),private.block_recalled_dispatch() from public,anon,authenticated;
