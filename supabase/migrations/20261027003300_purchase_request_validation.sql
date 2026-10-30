-- Complete authorization and validation for the request intake workflow.
insert into public.role_permissions(role_id,permission_id)
select r.id,p.id from public.roles r cross join public.permissions p
where r.organization_id is null and
 ((p.code='purchasing.request' and r.code in ('SUPER_ADMIN','OWNER','GENERAL_MANAGER','BRANCH_MANAGER','WAREHOUSE_MANAGER','PHARMACIST'))
 or (p.code='purchasing.request_approve' and r.code in ('SUPER_ADMIN','OWNER','GENERAL_MANAGER','BRANCH_MANAGER')))
on conflict do nothing;

drop policy purchase_requests_read on public.purchase_requests;
create policy purchase_requests_read on public.purchase_requests for select to authenticated
using(organization_id=(select private.current_organization_id()) and
 (private.has_permission('purchasing.request',branch_id) or private.has_permission('purchasing.request_approve',branch_id)));

create function private.validate_purchase_request(p_branch uuid,p_warehouse uuid,p_date date,p_notes text,p_lines jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare v_org uuid:=private.current_organization_id(); x jsonb; q numeric;
begin
 if not exists(select 1 from public.branches where id=p_branch and organization_id=v_org and is_active) then
 raise exception 'Choose an active branch' using errcode='22023'; end if;
 if p_warehouse is not null and not exists(select 1 from public.warehouses where id=p_warehouse and organization_id=v_org and branch_id=p_branch and is_active) then
 raise exception 'Choose an active warehouse in the request branch' using errcode='22023'; end if;
 if p_date<current_date then raise exception 'Required date cannot be in the past' using errcode='22023'; end if;
 if length(p_notes)>2000 then raise exception 'Notes cannot exceed 2000 characters' using errcode='22023'; end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'Supply requested lines' using errcode='22023'; end if;
 if jsonb_array_length(p_lines) not between 1 and 100 then raise exception 'Supply 1 to 100 requested lines' using errcode='22023'; end if;
 for x in select value from jsonb_array_elements(p_lines) loop
  if jsonb_typeof(x)<>'object' or jsonb_typeof(x->'quantity') is distinct from 'number'
  or not exists(select 1 from public.products where id::text=x->>'product_id' and organization_id=v_org and is_active) then
   raise exception 'Each line requires an active product and numeric base-unit quantity' using errcode='22023'; end if;
  q:=(x->>'quantity')::numeric;
  if q<=0 or q>1000000000 or q<>round(q,3) then raise exception 'Quantity must be positive with at most three decimals' using errcode='22023'; end if;
 end loop;
 if (select count(distinct value->>'product_id') from jsonb_array_elements(p_lines))<>jsonb_array_length(p_lines) then
 raise exception 'Combine duplicate product lines' using errcode='22023'; end if;
end $$;
revoke all on function private.validate_purchase_request(uuid,uuid,date,text,jsonb) from public,anon,authenticated;

create or replace function public.create_purchase_request(p_branch_id uuid,p_warehouse_id uuid,p_needed_by date,p_notes text,p_lines jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_org uuid:=private.current_organization_id();
begin
 if not private.has_permission('purchasing.request',p_branch_id) then raise exception 'Purchase request permission required' using errcode='42501'; end if;
 perform private.validate_purchase_request(p_branch_id,p_warehouse_id,p_needed_by,p_notes,p_lines);
 insert into public.purchase_requests(organization_id,request_number,branch_id,warehouse_id,needed_by,notes,lines)
 values(v_org,private.generate_document_number(v_org,null,'PURCHASE_REQUEST','PRQ'),p_branch_id,p_warehouse_id,p_needed_by,nullif(btrim(p_notes),''),p_lines) returning id into v_id;
 return v_id;
end $$;

create or replace function public.submit_purchase_request(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare r public.purchase_requests;
begin
 select * into r from public.purchase_requests where id=p_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Request not found' using errcode='P0002'; end if;
 if r.requested_by<>auth.uid() or not private.has_permission('purchasing.request',r.branch_id) then raise exception 'Request permission required' using errcode='42501'; end if;
 if r.status<>'DRAFT' then raise exception 'Only drafts can be submitted' using errcode='22023'; end if;
 perform private.validate_purchase_request(r.branch_id,r.warehouse_id,r.needed_by,r.notes,r.lines);
 update public.purchase_requests set status='SUBMITTED',updated_at=now() where id=r.id;
end $$;

create or replace function public.decide_purchase_request(p_id uuid,p_approve boolean,p_note text) returns void language plpgsql security definer set search_path='' as $$
declare r public.purchase_requests;
begin
 select * into r from public.purchase_requests where id=p_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Request not found' using errcode='P0002'; end if;
 if not private.has_permission('purchasing.request_approve',r.branch_id) or r.requested_by=auth.uid() then raise exception 'An independent authorized approver is required' using errcode='42501'; end if;
 if r.status<>'SUBMITTED' then raise exception 'Only submitted requests can be decided' using errcode='22023'; end if;
 if p_approve is null or p_note is null or length(btrim(p_note)) not between 3 and 1000 then raise exception 'Give a decision and a note (3 to 1000 characters)' using errcode='22023'; end if;
 update public.purchase_requests set status=case when p_approve then 'APPROVED' else 'REJECTED' end,decision_note=btrim(p_note),decided_by=auth.uid(),decided_at=now(),updated_at=now() where id=r.id;
end $$;

create function public.cancel_purchase_request(p_id uuid,p_note text) returns void language plpgsql security definer set search_path='' as $$
declare r public.purchase_requests;
begin
 select * into r from public.purchase_requests where id=p_id and organization_id=private.current_organization_id() for update;
 if not found then raise exception 'Request not found' using errcode='P0002'; end if;
 if r.requested_by<>auth.uid() or not private.has_permission('purchasing.request',r.branch_id) then raise exception 'Request permission required' using errcode='42501'; end if;
 if r.status not in ('DRAFT','SUBMITTED') then raise exception 'Only draft or submitted requests can be cancelled' using errcode='22023'; end if;
 if p_note is null or length(btrim(p_note)) not between 3 and 1000 then raise exception 'Give a cancellation reason (3 to 1000 characters)' using errcode='22023'; end if;
 update public.purchase_requests set status='CANCELLED',decision_note=btrim(p_note),decided_by=auth.uid(),decided_at=now(),updated_at=now() where id=r.id;
end $$;
revoke all on function public.cancel_purchase_request(uuid,text) from public,anon;
grant execute on function public.cancel_purchase_request(uuid,text) to authenticated;

create or replace function private.numbered_documents()
returns table(document_type text,default_prefix text) language sql immutable set search_path='' as $$
 select * from (values
 ('SALES_QUOTATION','QUO'),('SALES_ORDER','SO'),('SALES_INVOICE','INV'),('CREDIT_NOTE','CRN'),('CUSTOMER_RECEIPT','RCP'),('CUSTOMER_REFUND','RFD'),
 ('DELIVERY_NOTE','DN'),('POS_SESSION','SHF'),('PURCHASE_ORDER','PO'),('GOODS_RECEIPT','GRN'),('PURCHASE_RETURN','PRN'),('SUPPLIER_INVOICE','SIN'),
 ('STOCK_TRANSFER','TRN'),('STOCK_COUNT','CNT'),('JOURNAL','JV'),('CONTROLLED_ADJUSTMENT','CDA'),('FULFILMENT_ORDER','FO'),('PACKAGE','PK'),('DELIVERY_RUN','RUN'),('RECALL','REC'),('PURCHASE_REQUEST','PRQ')
 ) d(document_type,default_prefix)
$$;
