-- Phase 14 / 01: second-person approval for adjustments of controlled medicines
--
-- From the access review (docs/ACCESS_REVIEW.md, finding 4): a warehouse manager could adjust controlled stock and read the controlled-drugs register with
-- nobody checking. Now an adjustment of a CONTROLLED product is a REQUEST that a second person (a pharmacist, or an owner role) approves; the stock document is
-- posted only on approval, by the approver's decision, and the requester can never approve their own request. Other products are adjusted directly as before.
-- Stock counts keep their own existing approval. Transfers and status changes are unchanged.

insert into public.permissions (code, module, action, description) values
  ('inventory.controlled_approve', 'inventory', 'controlled_approve', 'Approve or reject adjustments of controlled medicines')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, code) as (values
  ('SUPER_ADMIN', 'inventory.controlled_approve'), ('OWNER', 'inventory.controlled_approve'), ('GENERAL_MANAGER', 'inventory.controlled_approve'), ('PHARMACIST', 'inventory.controlled_approve')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------------
-- requests
-- ---------------------------------------------------------------------------------------------------------
create table public.controlled_adjustments (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete restrict default private.current_organization_id(),
  request_number    text not null,
  branch_id         uuid not null,
  warehouse_id      uuid not null,
  reason_code       text not null check (reason_code in ('COUNT_VARIANCE', 'DAMAGE', 'EXPIRY_WRITE_OFF', 'THEFT_LOSS', 'FOUND', 'RETURN_TO_STOCK', 'RECALL', 'OTHER')),
  notes             text not null check (length(btrim(notes)) between 5 and 500),
  lines             jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 50),
  status            text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  requested_by      uuid not null default auth.uid(),
  requested_at      timestamptz not null default now(),
  decided_by        uuid,
  decided_at        timestamptz,
  decision_note     text check (decision_note is null or length(decision_note) <= 500),
  stock_document_id uuid references public.stock_documents (id) on delete restrict,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint controlled_adjustments_branch_fk foreign key (branch_id, organization_id) references public.branches (id, organization_id) on delete restrict,
  constraint controlled_adjustments_warehouse_fk foreign key (warehouse_id, organization_id) references public.warehouses (id, organization_id) on delete restrict,
  constraint controlled_adjustments_number_key unique (organization_id, request_number),
  constraint controlled_adjustments_decided_complete check ((status = 'PENDING') = (decided_at is null)),
  constraint controlled_adjustments_approved_has_document check ((status = 'APPROVED') = (stock_document_id is not null)),
  constraint controlled_adjustments_second_person check (status <> 'APPROVED' or decided_by is distinct from requested_by)
);
create index controlled_adjustments_org_idx on public.controlled_adjustments (organization_id, requested_at desc, id desc);
create index controlled_adjustments_branch_status_idx on public.controlled_adjustments (organization_id, branch_id, status);
create trigger controlled_adjustments_immutable before update on public.controlled_adjustments
  for each row execute function private.prevent_column_change('organization_id', 'request_number', 'branch_id', 'warehouse_id', 'reason_code', 'notes', 'lines', 'requested_by', 'requested_at');
create trigger controlled_adjustments_set_updated_at before update on public.controlled_adjustments
  for each row execute function private.set_updated_at();
create trigger controlled_adjustments_audit after insert or update on public.controlled_adjustments
  for each row execute function private.audit_row_change('controlled_adjustment');
create trigger controlled_adjustments_no_delete before delete on public.controlled_adjustments
  for each row execute function private.stock_block_mutation();

alter table public.controlled_adjustments enable row level security;
create policy controlled_adjustments_select on public.controlled_adjustments for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and ((select private.has_permission('inventory.adjust')) or (select private.has_permission('inventory.controlled_approve'))
              or branch_id in (select private.permitted_branches('inventory.adjust')) or branch_id in (select private.permitted_branches('inventory.controlled_approve'))));
revoke all on public.controlled_adjustments from public, anon, authenticated;
grant select on public.controlled_adjustments to authenticated;

-- a stock document can now come from an approved request
do $$
declare
  v_name text;
begin
  select conname into v_name from pg_constraint
  where conrelid = 'public.stock_documents'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%PURCHASE_ORDER%';
  if v_name is null then raise exception 'stock_documents source_type constraint not found'; end if;
  execute format('alter table public.stock_documents drop constraint %I', v_name);
  alter table public.stock_documents add constraint stock_documents_source_type_check check (
    source_type is null or source_type = any (array['PURCHASE_ORDER', 'PURCHASE_RETURN', 'STOCK_COUNT', 'STOCK_TRANSFER', 'SALES_INVOICE', 'CREDIT_NOTE', 'CONTROLLED_ADJUSTMENT']));
end $$;

-- the stock engine does not re-check the adjuster's right for an approved request (the approver's right was checked by approve_controlled_adjustment)
do $$
declare
  def text := pg_get_functiondef('private.post_stock(text, uuid, jsonb, uuid, text, text, text, uuid)'::regprocedure);
  fixed text;
begin
  fixed := replace(def, 'p_source_type is distinct from ''STOCK_COUNT'' and not private.has_permission', 'p_source_type is distinct from ''STOCK_COUNT'' and p_source_type is distinct from ''CONTROLLED_ADJUSTMENT'' and not private.has_permission');
  if fixed = def then raise exception 'post_stock definition not as expected'; end if;
  execute fixed;
end $$;

-- direct adjustment of a controlled medicine is refused: it goes through a request
create or replace function public.post_stock_document(
  p_document_type text, p_warehouse_id uuid, p_lines jsonb, p_to_warehouse_id uuid default null, p_reason_code text default null, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_document_type = 'RECEIPT' then
    raise exception 'goods are received against a purchase order' using errcode = '42501';
  end if;
  if p_document_type = 'ADJUSTMENT' and jsonb_typeof(p_lines) = 'array' and exists (
       select 1 from jsonb_array_elements(p_lines) e join public.products p on p.id = (e ->> 'product_id')::uuid
       where p.organization_id = private.current_organization_id() and (p.is_controlled or p.product_class = 'CONTROLLED')) then
    raise exception 'adjusting a controlled medicine needs a second person''s approval: request the adjustment instead' using errcode = '42501';
  end if;
  return private.post_stock(p_document_type, p_warehouse_id, p_lines, p_to_warehouse_id, p_reason_code, p_notes);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- request / approve / reject / cancel
-- ---------------------------------------------------------------------------------------------------------
create function public.request_controlled_adjustment(p_warehouse_id uuid, p_lines jsonb, p_reason_code text, p_notes text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_wh  public.warehouses;
  v_id  uuid;
  v_no  text;
  e     jsonb;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_wh from public.warehouses w where w.id = p_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.adjust', v_wh.branch_id) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if p_reason_code is null or p_reason_code not in ('COUNT_VARIANCE', 'DAMAGE', 'EXPIRY_WRITE_OFF', 'THEFT_LOSS', 'FOUND', 'RETURN_TO_STOCK', 'RECALL', 'OTHER') then
    raise exception 'choose a reason for the adjustment' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_notes, ''))) < 5 or length(p_notes) > 500 then
    raise exception 'explain the adjustment (5 to 500 characters): the approver needs to know why' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 50 then
    raise exception 'an adjustment request needs between 1 and 50 lines' using errcode = '22023';
  end if;
  for e in select * from jsonb_array_elements(p_lines) loop
    if not exists (select 1 from public.products p where p.organization_id = v_org and p.id = (e ->> 'product_id')::uuid and (p.is_controlled or p.product_class = 'CONTROLLED')) then
      raise exception 'only controlled medicines go through an approval request: adjust other products directly' using errcode = '22023';
    end if;
  end loop;
  v_no := private.generate_document_number(v_org, null, 'CONTROLLED_ADJUSTMENT', 'CDA');
  insert into public.controlled_adjustments (organization_id, request_number, branch_id, warehouse_id, reason_code, notes, lines)
  values (v_org, v_no, v_wh.branch_id, v_wh.id, p_reason_code, btrim(p_notes), p_lines) returning id into v_id;
  return jsonb_build_object('id', v_id, 'request_number', v_no);
end;
$$;

create function public.approve_controlled_adjustment(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_req public.controlled_adjustments;
  v_doc jsonb;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_req from public.controlled_adjustments where id = p_id and organization_id = v_org for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.controlled_approve', v_req.branch_id) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if v_req.status <> 'PENDING' then
    raise exception 'this request is already %', lower(v_req.status) using errcode = '22023';
  end if;
  if v_req.requested_by = auth.uid() then
    raise exception 'a second person must approve: you cannot approve your own request' using errcode = '42501';
  end if;
  v_doc := private.post_stock('ADJUSTMENT', v_req.warehouse_id, v_req.lines, null, v_req.reason_code, left(v_req.request_number || ': ' || v_req.notes, 500),
                              'CONTROLLED_ADJUSTMENT', v_req.id);
  update public.controlled_adjustments set status = 'APPROVED', decided_by = auth.uid(), decided_at = now(), stock_document_id = (v_doc ->> 'document_id')::uuid where id = v_req.id;
  return v_doc;
end;
$$;

create function public.reject_controlled_adjustment(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_req public.controlled_adjustments;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_req from public.controlled_adjustments where id = p_id and organization_id = v_org for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.controlled_approve', v_req.branch_id) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if v_req.status <> 'PENDING' then
    raise exception 'this request is already %', lower(v_req.status) using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 or length(p_reason) > 500 then
    raise exception 'give a reason for rejecting (5 to 500 characters)' using errcode = '22023';
  end if;
  update public.controlled_adjustments set status = 'REJECTED', decided_by = auth.uid(), decided_at = now(), decision_note = btrim(p_reason) where id = v_req.id;
end;
$$;

create function public.cancel_controlled_adjustment(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_req public.controlled_adjustments;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_req from public.controlled_adjustments where id = p_id and organization_id = v_org for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if v_req.requested_by <> auth.uid() then
    raise exception 'only the person who made the request can withdraw it' using errcode = '42501';
  end if;
  if v_req.status <> 'PENDING' then
    raise exception 'this request is already %', lower(v_req.status) using errcode = '22023';
  end if;
  update public.controlled_adjustments set status = 'CANCELLED', decided_by = auth.uid(), decided_at = now(), decision_note = 'Withdrawn by the requester' where id = v_req.id;
end;
$$;

revoke all on function public.request_controlled_adjustment(uuid, jsonb, text, text) from public, anon;
revoke all on function public.approve_controlled_adjustment(uuid) from public, anon;
revoke all on function public.reject_controlled_adjustment(uuid, text) from public, anon;
revoke all on function public.cancel_controlled_adjustment(uuid) from public, anon;
grant execute on function public.request_controlled_adjustment(uuid, jsonb, text, text) to authenticated;
grant execute on function public.approve_controlled_adjustment(uuid) to authenticated;
grant execute on function public.reject_controlled_adjustment(uuid, text) to authenticated;
grant execute on function public.cancel_controlled_adjustment(uuid) to authenticated;
