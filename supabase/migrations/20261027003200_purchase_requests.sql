-- Purchasing requests: a controlled intake before purchase orders.
insert into public.permissions(code,module,action,description) values
 ('purchasing.request','purchasing','request','Create and submit purchase requests'),
 ('purchasing.request_approve','purchasing','request_approve','Approve or reject purchase requests')
on conflict(code) do update set description=excluded.description;

create table public.purchase_requests (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null default private.current_organization_id() references public.organizations(id),
 request_number text not null, branch_id uuid not null, warehouse_id uuid, requested_by uuid not null default auth.uid(),
 needed_by date, notes text, lines jsonb not null check(jsonb_typeof(lines)='array' and jsonb_array_length(lines)>0),
 status text not null default 'DRAFT' check(status in ('DRAFT','SUBMITTED','APPROVED','REJECTED','CANCELLED')),
 decision_note text, decided_by uuid, decided_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(organization_id,request_number), unique(id,organization_id),
 foreign key(branch_id,organization_id) references public.branches(id,organization_id), foreign key(warehouse_id,organization_id) references public.warehouses(id,organization_id),
 foreign key(requested_by,organization_id) references public.profiles(id,organization_id), foreign key(decided_by,organization_id) references public.profiles(id,organization_id)
);
alter table public.purchase_requests enable row level security;
revoke all on public.purchase_requests from public,anon,authenticated; grant select on public.purchase_requests to authenticated;
create policy purchase_requests_read on public.purchase_requests for select to authenticated using(organization_id=(select private.current_organization_id()) and (select private.has_permission('purchasing.request') or private.has_permission('purchasing.request_approve')));
create trigger purchase_requests_no_delete before delete on public.purchase_requests for each row execute function private.stock_block_mutation();
create trigger purchase_requests_audit after insert or update on public.purchase_requests for each row execute function private.audit_row_change('purchase_request');

create function public.create_purchase_request(p_branch_id uuid,p_warehouse_id uuid,p_needed_by date,p_notes text,p_lines jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_org uuid:=private.current_organization_id();
begin
 if not private.has_permission('purchasing.request',p_branch_id) then raise exception 'Purchase request permission required' using errcode='42501'; end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'Add at least one requested line' using errcode='22023'; end if;
 insert into public.purchase_requests(organization_id,request_number,branch_id,warehouse_id,needed_by,notes,lines) values(v_org,private.generate_document_number(v_org,p_branch_id,'PURCHASE_REQUEST','PRQ'),p_branch_id,p_warehouse_id,p_needed_by,nullif(btrim(p_notes),''),p_lines) returning id into v_id;
 return v_id;
end $$;
create function public.submit_purchase_request(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 update public.purchase_requests set status='SUBMITTED',updated_at=now() where id=p_id and organization_id=private.current_organization_id() and requested_by=auth.uid() and status='DRAFT';
 if not found then raise exception 'Draft purchase request not found' using errcode='P0002'; end if;
end $$;
create function public.decide_purchase_request(p_id uuid,p_approve boolean,p_note text) returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.has_permission('purchasing.request_approve') then raise exception 'Purchase request approval permission required' using errcode='42501'; end if;
 if p_note is null or length(btrim(p_note))<3 then raise exception 'Give a decision note' using errcode='22023'; end if;
 update public.purchase_requests set status=case when p_approve then 'APPROVED' else 'REJECTED' end,decision_note=btrim(p_note),decided_by=auth.uid(),decided_at=now(),updated_at=now() where id=p_id and organization_id=private.current_organization_id() and status='SUBMITTED';
 if not found then raise exception 'Submitted purchase request not found' using errcode='P0002'; end if;
end $$;
revoke all on function public.create_purchase_request(uuid,uuid,date,text,jsonb),public.submit_purchase_request(uuid),public.decide_purchase_request(uuid,boolean,text) from public,anon;
grant execute on function public.create_purchase_request(uuid,uuid,date,text,jsonb),public.submit_purchase_request(uuid),public.decide_purchase_request(uuid,boolean,text) to authenticated;
