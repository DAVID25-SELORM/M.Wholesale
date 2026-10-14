-- Phase 4 / 05: stock counts (cycle counts) with approval
--
-- A count takes a SNAPSHOT of the system quantities for a warehouse (optionally one location or a list of products), people
-- walk the shelves and enter what they counted, someone else reviews and approves, and approval posts ONE stock adjustment
-- (reason COUNT_VARIANCE) for the variances. Variance = counted - system quantity at the time the count was started; it is applied
-- to the stock as it is at approval, so movements during the count are not lost. Lines nobody counted are left alone.
--   OPEN -> SUBMITTED -> APPROVED          (SUBMITTED can be sent back to OPEN; OPEN / SUBMITTED can be CANCELLED)
-- Note: counters can see the system quantity in the database; a blind count is a UI concern for now.

create table public.stock_counts (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations (id) on delete restrict
                           default private.current_organization_id(),
  count_number           text not null,
  warehouse_id           uuid not null,
  branch_id              uuid not null,
  location_id            uuid references public.warehouse_locations (id) on delete restrict,
  status                 text not null default 'OPEN' check (status in ('OPEN', 'SUBMITTED', 'APPROVED', 'CANCELLED')),
  notes                  text check (notes is null or length(notes) <= 500),
  status_reason          text check (status_reason is null or length(status_reason) <= 500),
  line_count             integer not null check (line_count > 0),
  created_by             uuid default auth.uid(),
  submitted_by           uuid,
  submitted_at           timestamptz,
  approved_by            uuid,
  approved_at            timestamptz,
  adjustment_document_id uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint stock_counts_warehouse_fk foreign key (warehouse_id, organization_id)
    references public.warehouses (id, organization_id) on delete restrict,
  constraint stock_counts_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint stock_counts_adjustment_fk foreign key (adjustment_document_id, organization_id)
    references public.stock_documents (id, organization_id) on delete restrict,
  constraint stock_counts_number_key unique (organization_id, count_number),
  constraint stock_counts_id_org_key unique (id, organization_id)
);
create index stock_counts_org_created_idx on public.stock_counts (organization_id, created_at desc, id desc);
create index stock_counts_branch_status_idx on public.stock_counts (organization_id, branch_id, status);
create index stock_counts_warehouse_idx on public.stock_counts (warehouse_id);
create index stock_counts_location_idx on public.stock_counts (location_id) where location_id is not null;
create index stock_counts_adjustment_idx on public.stock_counts (adjustment_document_id) where adjustment_document_id is not null;

create trigger stock_counts_immutable before update on public.stock_counts
  for each row execute function private.prevent_column_change('organization_id', 'count_number', 'warehouse_id', 'branch_id', 'location_id', 'line_count');
create trigger stock_counts_set_updated_at before update on public.stock_counts
  for each row execute function private.set_updated_at();
create trigger stock_counts_audit after insert or update or delete on public.stock_counts
  for each row execute function private.audit_row_change('stock_count');

create table public.stock_count_lines (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict
                     default private.current_organization_id(),
  stock_count_id   uuid not null,
  branch_id        uuid not null,
  line_no          integer not null check (line_no > 0),
  product_id       uuid not null,
  batch_id         uuid,
  location_id      uuid references public.warehouse_locations (id) on delete restrict,
  stock_status     text not null check (stock_status in ('AVAILABLE', 'QUARANTINE', 'DAMAGED', 'EXPIRED')),
  system_quantity  numeric(18, 3) not null check (system_quantity > 0),
  counted_quantity numeric(18, 3) check (counted_quantity is null or counted_quantity >= 0),
  counted_by       uuid,
  counted_at       timestamptz,
  constraint stock_count_lines_count_fk foreign key (stock_count_id, organization_id)
    references public.stock_counts (id, organization_id) on delete restrict,
  constraint stock_count_lines_product_fk foreign key (product_id, organization_id)
    references public.products (id, organization_id) on delete restrict,
  constraint stock_count_lines_batch_fk foreign key (batch_id, product_id, organization_id)
    references public.batches (id, product_id, organization_id) on delete restrict,
  constraint stock_count_lines_line_key unique (stock_count_id, line_no)
);
create index stock_count_lines_product_idx on public.stock_count_lines (organization_id, product_id);
create index stock_count_lines_batch_idx on public.stock_count_lines (batch_id) where batch_id is not null;
create index stock_count_lines_location_idx on public.stock_count_lines (location_id) where location_id is not null;

create trigger stock_count_lines_immutable before update on public.stock_count_lines
  for each row execute function private.prevent_column_change(
    'organization_id', 'stock_count_id', 'branch_id', 'line_no', 'product_id', 'batch_id', 'location_id', 'stock_status', 'system_quantity');
create trigger stock_count_lines_no_delete before delete on public.stock_count_lines
  for each row execute function private.stock_block_mutation();

alter table public.stock_counts      enable row level security;
alter table public.stock_count_lines enable row level security;
revoke all on public.stock_counts, public.stock_count_lines from public, anon, authenticated;
grant select on public.stock_counts, public.stock_count_lines to authenticated;

create policy stock_counts_select on public.stock_counts
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('inventory.view', branch_id));
create policy stock_count_lines_select on public.stock_count_lines
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('inventory.view', branch_id));

-- ---------------------------------------------------------------------------------------------------------
create function public.start_stock_count(
  p_warehouse_id uuid,
  p_location_id uuid default null,
  p_product_ids uuid[] default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_wh    public.warehouses;
  v_id    uuid := gen_random_uuid();
  v_n     integer;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_wh from public.warehouses w where w.id = p_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.count', v_wh.branch_id) then
    raise exception 'insufficient privilege for this warehouse' using errcode = '42501';
  end if;
  if p_location_id is not null and not exists (
       select 1 from public.warehouse_locations l where l.id = p_location_id and l.warehouse_id = v_wh.id and l.organization_id = v_org) then
    raise exception 'location not found in this warehouse' using errcode = 'P0002';
  end if;
  if p_notes is not null and length(p_notes) > 500 then
    raise exception 'notes are limited to 500 characters' using errcode = '22023';
  end if;

  create temporary table pg_temp.count_snapshot on commit drop as
  select b.product_id, b.batch_id, b.location_id, b.stock_status, b.quantity,
         row_number() over (order by coalesce(l.code, ''), p.brand_name, ba.expiry_date nulls last, b.stock_status) as rn
  from public.stock_balances b
  join public.products p on p.id = b.product_id
  left join public.batches ba on ba.id = b.batch_id
  left join public.warehouse_locations l on l.id = b.location_id
  where b.organization_id = v_org and b.warehouse_id = v_wh.id and b.quantity > 0
    and (p_location_id is null or b.location_id = p_location_id)
    and (p_product_ids is null or b.product_id = any (p_product_ids));
  select count(*) into v_n from pg_temp.count_snapshot;
  if v_n = 0 then
    drop table pg_temp.count_snapshot;
    raise exception 'there is no stock in that scope to count' using errcode = '22023';
  end if;
  if v_n > 5000 then
    drop table pg_temp.count_snapshot;
    raise exception 'that is % stock lines - narrow the count to a location or a list of products (limit 5000)', v_n using errcode = '22023';
  end if;

  insert into public.stock_counts (id, organization_id, count_number, warehouse_id, branch_id, location_id, notes, line_count)
  values (v_id, v_org, private.generate_document_number(v_org, null, 'STOCK_COUNT', 'CNT'), v_wh.id, v_wh.branch_id,
          p_location_id, nullif(btrim(p_notes), ''), v_n);
  insert into public.stock_count_lines (organization_id, stock_count_id, branch_id, line_no, product_id, batch_id, location_id, stock_status, system_quantity)
  select v_org, v_id, v_wh.branch_id, s.rn, s.product_id, s.batch_id, s.location_id, s.stock_status, s.quantity
  from pg_temp.count_snapshot s;
  drop table pg_temp.count_snapshot;
  return v_id;
end;
$$;

-- p_entries: [{ line_id, counted_quantity }]  (counted_quantity null clears the entry)
create function public.save_count_entries(p_id uuid, p_entries jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_cnt public.stock_counts;
  v_e   jsonb;
  v_qty numeric;
  v_done integer := 0;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_cnt from public.stock_counts c where c.id = p_id and c.organization_id = v_org for update;
  if not found then
    raise exception 'stock count not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.count', v_cnt.branch_id) then
    raise exception 'insufficient privilege for this warehouse' using errcode = '42501';
  end if;
  if v_cnt.status <> 'OPEN' then
    raise exception 'counted quantities can only be entered while the count is open (this one is %)', v_cnt.status using errcode = '22023';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then
    raise exception 'no entries to save' using errcode = '22023';
  end if;
  if jsonb_array_length(p_entries) > 5000 then
    raise exception 'too many entries in one save' using errcode = '22023';
  end if;
  for v_e in select value from jsonb_array_elements(p_entries) loop
    if jsonb_typeof(v_e) <> 'object' then
      raise exception 'invalid entry' using errcode = '22023';
    end if;
    if jsonb_typeof(v_e -> 'counted_quantity') = 'null' or (v_e -> 'counted_quantity') is null then
      v_qty := null;
    elsif jsonb_typeof(v_e -> 'counted_quantity') = 'number' then
      v_qty := (v_e ->> 'counted_quantity')::numeric;
      if v_qty < 0 or v_qty <> round(v_qty, 3) or v_qty >= 1000000000000 then
        raise exception 'a counted quantity must be 0 or more with at most 3 decimals' using errcode = '22023';
      end if;
    else
      raise exception 'a counted quantity must be a number' using errcode = '22023';
    end if;
    update public.stock_count_lines l
       set counted_quantity = v_qty,
           counted_by = case when v_qty is null then null else auth.uid() end,
           counted_at = case when v_qty is null then null else now() end
     where l.id = nullif(v_e ->> 'line_id', '')::uuid and l.stock_count_id = v_cnt.id;
    if not found then
      raise exception 'a line does not belong to this count' using errcode = 'P0002';
    end if;
    v_done := v_done + 1;
  end loop;
  return v_done;
end;
$$;

create function public.submit_stock_count(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_cnt public.stock_counts;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_cnt from public.stock_counts c where c.id = p_id and c.organization_id = v_org for update;
  if not found then
    raise exception 'stock count not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.count', v_cnt.branch_id) then
    raise exception 'insufficient privilege for this warehouse' using errcode = '42501';
  end if;
  if v_cnt.status <> 'OPEN' then
    raise exception 'only an open count can be submitted (this one is %)', v_cnt.status using errcode = '22023';
  end if;
  if not exists (select 1 from public.stock_count_lines l where l.stock_count_id = v_cnt.id and l.counted_quantity is not null) then
    raise exception 'enter at least one counted quantity before submitting' using errcode = '22023';
  end if;
  update public.stock_counts set status = 'SUBMITTED', submitted_by = auth.uid(), submitted_at = now(), status_reason = null where id = v_cnt.id;
end;
$$;

create function public.return_stock_count(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_cnt public.stock_counts;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_cnt from public.stock_counts c where c.id = p_id and c.organization_id = v_org for update;
  if not found then
    raise exception 'stock count not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.count_approve', v_cnt.branch_id) then
    raise exception 'insufficient privilege for this warehouse' using errcode = '42501';
  end if;
  if v_cnt.status <> 'SUBMITTED' then
    raise exception 'only a submitted count can be sent back (this one is %)', v_cnt.status using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.stock_counts set status = 'OPEN', status_reason = btrim(p_reason) where id = v_cnt.id;
end;
$$;

create function public.cancel_stock_count(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_cnt public.stock_counts;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_cnt from public.stock_counts c where c.id = p_id and c.organization_id = v_org for update;
  if not found then
    raise exception 'stock count not found' using errcode = 'P0002';
  end if;
  if v_cnt.status not in ('OPEN', 'SUBMITTED') then
    raise exception 'a count that is % cannot be cancelled', v_cnt.status using errcode = '22023';
  end if;
  if not private.has_permission(case when v_cnt.status = 'OPEN' then 'inventory.count' else 'inventory.count_approve' end, v_cnt.branch_id) then
    raise exception 'insufficient privilege for this warehouse' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'give a reason (up to 500 characters)' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.stock_counts set status = 'CANCELLED', status_reason = btrim(p_reason) where id = v_cnt.id;
end;
$$;

create function public.approve_stock_count(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_cnt   public.stock_counts;
  v_lines jsonb;
  v_stock jsonb;
  v_doc   uuid;
  v_vars  integer;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select * into v_cnt from public.stock_counts c where c.id = p_id and c.organization_id = v_org for update;
  if not found then
    raise exception 'stock count not found' using errcode = 'P0002';
  end if;
  if not private.has_permission('inventory.count_approve', v_cnt.branch_id) then
    raise exception 'insufficient privilege for this warehouse' using errcode = '42501';
  end if;
  if v_cnt.status <> 'SUBMITTED' then
    raise exception 'only a submitted count can be approved (this one is %)', v_cnt.status using errcode = '22023';
  end if;
  if v_cnt.submitted_by = auth.uid() and private.other_holder_exists('inventory.count_approve', v_cnt.branch_id) then
    raise exception 'a count you submitted must be approved by someone else' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(
           jsonb_strip_nulls(jsonb_build_object(
             'product_id', l.product_id, 'batch_id', l.batch_id, 'location_id', l.location_id, 'status', l.stock_status,
             'direction', case when l.counted_quantity > l.system_quantity then 'IN' else 'OUT' end,
             'quantity', abs(l.counted_quantity - l.system_quantity)))
           order by l.line_no), '[]'::jsonb),
         count(*)
    into v_lines, v_vars
  from public.stock_count_lines l
  where l.stock_count_id = v_cnt.id and l.counted_quantity is not null and l.counted_quantity <> l.system_quantity;

  if v_vars > 0 then
    v_stock := private.post_stock('ADJUSTMENT', v_cnt.warehouse_id, v_lines, null, 'COUNT_VARIANCE',
                                  'Stock count ' || v_cnt.count_number, 'STOCK_COUNT', v_cnt.id);
    v_doc := (v_stock ->> 'document_id')::uuid;
  end if;

  update public.stock_counts
     set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), adjustment_document_id = v_doc, status_reason = null
   where id = v_cnt.id;
  return jsonb_build_object('variances', v_vars, 'stock_document_number', v_stock ->> 'document_number');
end;
$$;

revoke all on function public.start_stock_count(uuid, uuid, uuid[], text) from public, anon;
revoke all on function public.save_count_entries(uuid, jsonb) from public, anon;
revoke all on function public.submit_stock_count(uuid) from public, anon;
revoke all on function public.return_stock_count(uuid, text) from public, anon;
revoke all on function public.cancel_stock_count(uuid, text) from public, anon;
revoke all on function public.approve_stock_count(uuid) from public, anon;
grant execute on function public.start_stock_count(uuid, uuid, uuid[], text) to authenticated;
grant execute on function public.save_count_entries(uuid, jsonb) to authenticated;
grant execute on function public.submit_stock_count(uuid) to authenticated;
grant execute on function public.return_stock_count(uuid, text) to authenticated;
grant execute on function public.cancel_stock_count(uuid, text) to authenticated;
grant execute on function public.approve_stock_count(uuid) to authenticated;
