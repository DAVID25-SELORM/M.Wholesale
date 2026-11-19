-- A partial substitution leaves pick_lines.actual_batch_id empty, so the dispatch
-- guard only saw the original batch. Also check every approved replacement batch
-- on the order being dispatched. Same tenant scoping and locking as before.
create or replace function private.block_recalled_dispatch()
returns trigger language plpgsql security definer set search_path='' as $$
declare b record;
begin
 for b in
   select a.batch_id from public.sales_invoice_allocations a
   where a.sales_invoice_id=new.sales_invoice_id and a.organization_id=new.organization_id and a.batch_id is not null
   union
   select l.actual_batch_id from public.pick_lines l join public.fulfilment_orders o
     on o.id=l.fulfilment_order_id and o.organization_id=l.organization_id
   where o.sales_invoice_id=new.sales_invoice_id and o.organization_id=new.organization_id and o.status<>'CANCELLED' and l.actual_batch_id is not null
   union
   select s.substitute_batch_id from public.fulfilment_substitutions s join public.fulfilment_orders o
     on o.id=s.fulfilment_order_id and o.organization_id=s.organization_id
   where o.sales_invoice_id=new.sales_invoice_id and o.organization_id=new.organization_id and o.status<>'CANCELLED' and s.status='APPROVED'
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
revoke all on function private.block_recalled_dispatch() from public,anon,authenticated;
