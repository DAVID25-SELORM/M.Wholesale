-- Complete the recall lifecycle and register its document numbering.
create or replace function private.numbered_documents()
returns table(document_type text,default_prefix text) language sql immutable set search_path='' as $$
 select * from (values
 ('SALES_QUOTATION','QUO'),('SALES_ORDER','SO'),('SALES_INVOICE','INV'),('CREDIT_NOTE','CRN'),('CUSTOMER_RECEIPT','RCP'),('CUSTOMER_REFUND','RFD'),
 ('DELIVERY_NOTE','DN'),('POS_SESSION','SHF'),('PURCHASE_ORDER','PO'),('GOODS_RECEIPT','GRN'),('PURCHASE_RETURN','PRN'),('SUPPLIER_INVOICE','SIN'),
 ('STOCK_TRANSFER','TRN'),('STOCK_COUNT','CNT'),('JOURNAL','JV'),('CONTROLLED_ADJUSTMENT','CDA'),('FULFILMENT_ORDER','FO'),('PACKAGE','PK'),('DELIVERY_RUN','RUN'),('RECALL','REC')
 ) d(document_type,default_prefix)
$$;

create function public.close_recall(p_recall_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r public.recalls; open_count integer;
begin
 if not private.has_permission('recalls.manage') then raise exception 'Recall management permission required' using errcode='42501'; end if;
 select * into r from public.recalls where id=p_recall_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Recall not found' using errcode='P0002'; end if;
 if r.status not in ('QUARANTINED','OPEN') then raise exception 'Recall is already %',lower(r.status) using errcode='22023'; end if;
 select count(*) into open_count from public.recall_batch_scope where recall_id=r.id and organization_id=r.organization_id and quarantined_at is null;
 if open_count>0 then raise exception 'Quarantine every scoped batch before closing the recall' using errcode='22023'; end if;
 update public.recalls set status='CLOSED',closed_at=now(),closed_by=auth.uid() where id=r.id and organization_id=r.organization_id;
end $$;

revoke all on function public.close_recall(uuid) from public,anon;
grant execute on function public.close_recall(uuid) to authenticated;
