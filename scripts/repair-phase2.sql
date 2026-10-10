-- REPAIR + APPLY Phase 2 (inventory). Use ONLY because the first attempt was left half-applied
-- (public.batches exists without its siblings, and without RLS). Atomic: all or nothing.
-- Step 1 removes the partial Phase 2 objects (refuses if any stock data exists), step 2/3 are the two migrations verbatim.
begin;

do $repair$
declare n bigint := 0;
begin
  if to_regclass('public.stock_movements') is not null then execute 'select count(*) from public.stock_movements' into n; if n > 0 then raise exception 'stock data exists - stop'; end if; end if;
  if to_regclass('public.stock_documents') is not null then execute 'select count(*) from public.stock_documents' into n; if n > 0 then raise exception 'stock data exists - stop'; end if; end if;
  if to_regclass('public.stock_balances')  is not null then execute 'select count(*) from public.stock_balances'  into n; if n > 0 then raise exception 'stock data exists - stop'; end if; end if;
  if to_regclass('public.batches')         is not null then execute 'select count(*) from public.batches'         into n; if n > 0 then raise exception 'batch data exists - stop'; end if; end if;
end
$repair$;

drop function if exists public.post_stock_document(text, uuid, jsonb, uuid, text, text);
drop function if exists public.stock_summary(uuid, text, integer, integer, integer);
drop function if exists public.expiring_stock(integer, uuid);
drop function if exists public.suggest_fefo_allocation(uuid, uuid, numeric, integer);
drop table if exists public.stock_balances, public.stock_movements, public.stock_documents, public.batches cascade;
drop function if exists private.add_stock_movement(uuid, uuid, integer, text, uuid, uuid, uuid, uuid, text, numeric, uuid, numeric);
drop function if exists private.batches_before_write();
drop function if exists private.stock_block_mutation();
alter table public.warehouse_locations drop constraint if exists warehouse_locations_id_wh_key;

-- ===== migration 20261011000100_inventory_permissions =====
-- Phase 2 / 01: permissions for inventory
--
-- Inventory is BRANCH-scoped: every stock row belongs to a warehouse, a warehouse belongs to a branch, and a
-- permission only applies to the warehouses of the branches it was granted for (organization-wide grants cover all).

insert into public.permissions (code, module, action, description) values
  ('inventory.view',          'inventory', 'view',          'View stock, batches, expiry and the stock ledger'),
  ('inventory.opening_stock', 'inventory', 'opening_stock', 'Load opening stock balances'),
  ('inventory.adjust',        'inventory', 'adjust',        'Post stock adjustments (count variances, damages, write-offs)'),
  ('inventory.transfer',      'inventory', 'transfer',      'Transfer stock between warehouses'),
  ('inventory.quarantine',    'inventory', 'quarantine',    'Change stock status (quarantine, release, damaged, expired)')
on conflict (code) do update set description = excluded.description;

with matrix(role_code, pattern) as (values
  ('SUPER_ADMIN',         'inventory.%'),
  ('OWNER',               'inventory.%'),
  ('GENERAL_MANAGER',     'inventory.%'),
  ('WAREHOUSE_MANAGER',   'inventory.%'),
  ('BRANCH_MANAGER',      'inventory.view'),     ('BRANCH_MANAGER',      'inventory.transfer'),
  ('PHARMACIST',          'inventory.view'),     ('PHARMACIST',          'inventory.quarantine'),
  ('PROCUREMENT_MANAGER', 'inventory.view'),     ('PROCUREMENT_OFFICER', 'inventory.view'),
  ('WAREHOUSE_PICKER',    'inventory.view'),     ('WAREHOUSE_PACKER',    'inventory.view'),
  ('DISPATCHER',          'inventory.view'),
  ('SALES_MANAGER',       'inventory.view'),     ('SALES_REP',           'inventory.view'),
  ('CASHIER',             'inventory.view'),
  ('ACCOUNTS_MANAGER',    'inventory.view'),     ('ACCOUNTS_OFFICER',    'inventory.view'),
  ('AUDITOR',             'inventory.view'),     ('READ_ONLY',           'inventory.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code like m.pattern
on conflict do nothing;

-- ===== migration 20261011000200_inventory =====
-- Phase 2 / 02: inventory core - batches, stock ledger, balances, posting, FEFO, expiry
--
-- Model
--   batches          one row per (product, batch number); carries the expiry date.
--   stock_documents  one row per posting (opening stock, adjustment, transfer, status change), numbered.
--   stock_movements  the LEDGER: signed, append-only lines. Nothing is ever updated or deleted; a mistake is
--                    corrected by a new, opposite posting.
--   stock_balances   current quantity per (warehouse, location, product, batch, status). It is derived: only
--                    post_stock_document() writes it, always together with the ledger lines, in one transaction.
--                    sum(ledger) = balance is an invariant (checked by the tests).
-- All quantities are in the product's BASE unit; packs are converted on the way in (product_units.factor_to_base).
-- Clients have no INSERT/UPDATE/DELETE on any of these tables: the posting function is the only writer.
-- Negative stock is impossible (CHECK on the balance + a friendly pre-check).

-- A location must belong to the warehouse it is recorded against (composite FK target).
alter table public.warehouse_locations
  add constraint warehouse_locations_id_wh_key unique (id, warehouse_id);

-- ---------------------------------------------------------------------------------------------------------
-- batches
-- ---------------------------------------------------------------------------------------------------------
create table public.batches (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict
                     default private.current_organization_id(),
  product_id       uuid not null,
  batch_number     text not null check (btrim(batch_number) <> '' and length(batch_number) <= 60),
  manufacture_date date,
  expiry_date      date not null,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  constraint batches_product_fk foreign key (product_id, organization_id)
    references public.products (id, organization_id) on delete restrict,
  constraint batches_id_org_key unique (id, organization_id),
  constraint batches_ref_key unique (id, product_id, organization_id),
  constraint batches_dates_ordered check (manufacture_date is null or manufacture_date <= expiry_date)
);
-- "ab-123" and "AB-123 " are the same batch
create unique index batches_org_product_number_key
  on public.batches (organization_id, product_id, upper(btrim(batch_number)));
create index batches_org_expiry_idx on public.batches (organization_id, expiry_date);

create function private.batches_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.batch_number := btrim(new.batch_number);
  return new;
end;
$$;
create trigger batches_normalize before insert on public.batches
  for each row execute function private.batches_before_write();
create trigger batches_immutable before update on public.batches
  for each row execute function private.prevent_column_change(
    'organization_id', 'product_id', 'batch_number', 'manufacture_date', 'expiry_date');

-- ---------------------------------------------------------------------------------------------------------
-- stock documents
-- ---------------------------------------------------------------------------------------------------------
create table public.stock_documents (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict
                     default private.current_organization_id(),
  document_number  text not null,
  document_type    text not null check (document_type in ('OPENING', 'ADJUSTMENT', 'TRANSFER', 'STATUS_CHANGE')),
  branch_id        uuid not null,
  warehouse_id     uuid not null,
  to_warehouse_id  uuid,
  reason_code      text check (reason_code is null or reason_code in
                     ('OPENING', 'COUNT_VARIANCE', 'DAMAGE', 'EXPIRY_WRITE_OFF', 'THEFT_LOSS', 'FOUND', 'RETURN_TO_STOCK',
                      'QUALITY_HOLD', 'QUALITY_RELEASE', 'RECALL', 'REORGANISATION', 'OTHER')),
  notes            text check (notes is null or length(notes) <= 500),
  line_count       integer not null check (line_count > 0),
  posted_by        uuid default auth.uid(),
  posted_at        timestamptz not null default clock_timestamp(),
  constraint stock_documents_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint stock_documents_warehouse_fk foreign key (warehouse_id, organization_id)
    references public.warehouses (id, organization_id) on delete restrict,
  constraint stock_documents_to_warehouse_fk foreign key (to_warehouse_id, organization_id)
    references public.warehouses (id, organization_id) on delete restrict,
  constraint stock_documents_number_key unique (organization_id, document_number),
  constraint stock_documents_id_org_key unique (id, organization_id),
  constraint stock_documents_transfer_target check ((document_type = 'TRANSFER') = (to_warehouse_id is not null)),
  constraint stock_documents_transfer_distinct check (to_warehouse_id is null or to_warehouse_id <> warehouse_id)
);
create index stock_documents_org_posted_idx on public.stock_documents (organization_id, posted_at desc, id desc);
create index stock_documents_branch_idx on public.stock_documents (organization_id, branch_id, posted_at desc);
create index stock_documents_warehouse_idx on public.stock_documents (warehouse_id);

-- ---------------------------------------------------------------------------------------------------------
-- stock movements (ledger)
-- ---------------------------------------------------------------------------------------------------------
create table public.stock_movements (
  id               uuid primary key default gen_random_uuid(),
  seq              bigint generated always as identity,
  organization_id  uuid not null references public.organizations (id) on delete restrict,
  document_id      uuid not null,
  line_no          integer not null check (line_no > 0),
  movement_type    text not null check (movement_type in
                     ('OPENING', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER_OUT', 'TRANSFER_IN',
                      'STATUS_OUT', 'STATUS_IN')),
  warehouse_id     uuid not null,
  location_id      uuid,
  product_id       uuid not null,
  batch_id         uuid,
  stock_status     text not null check (stock_status in ('AVAILABLE', 'QUARANTINE', 'DAMAGED', 'EXPIRED')),
  quantity         numeric(18, 3) not null,           -- signed, in BASE units
  entered_unit_id  uuid,                              -- what the user typed it in (traceability only)
  entered_quantity numeric(18, 3),
  posted_at        timestamptz not null default clock_timestamp(),
  constraint stock_movements_document_fk foreign key (document_id, organization_id)
    references public.stock_documents (id, organization_id) on delete restrict,
  constraint stock_movements_warehouse_fk foreign key (warehouse_id, organization_id)
    references public.warehouses (id, organization_id) on delete restrict,
  constraint stock_movements_location_fk foreign key (location_id, warehouse_id)
    references public.warehouse_locations (id, warehouse_id) on delete restrict,
  constraint stock_movements_product_fk foreign key (product_id, organization_id)
    references public.products (id, organization_id) on delete restrict,
  constraint stock_movements_batch_fk foreign key (batch_id, product_id, organization_id)
    references public.batches (id, product_id, organization_id) on delete restrict,
  constraint stock_movements_unit_fk foreign key (entered_unit_id, product_id, organization_id)
    references public.product_units (id, product_id, organization_id) on delete restrict,
  constraint stock_movements_sign check (
    quantity <> 0 and (
      (movement_type in ('OPENING', 'ADJUSTMENT_IN', 'TRANSFER_IN', 'STATUS_IN') and quantity > 0) or
      (movement_type in ('ADJUSTMENT_OUT', 'TRANSFER_OUT', 'STATUS_OUT') and quantity < 0)))
);
create index stock_movements_org_product_idx on public.stock_movements (organization_id, product_id, seq desc);
create index stock_movements_org_warehouse_idx on public.stock_movements (organization_id, warehouse_id, seq desc);
create index stock_movements_document_idx on public.stock_movements (document_id, line_no);
create index stock_movements_batch_idx on public.stock_movements (batch_id) where batch_id is not null;

-- ---------------------------------------------------------------------------------------------------------
-- stock balances (derived)
-- ---------------------------------------------------------------------------------------------------------
create table public.stock_balances (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict,
  warehouse_id     uuid not null,
  location_id      uuid,
  product_id       uuid not null,
  batch_id         uuid,
  stock_status     text not null check (stock_status in ('AVAILABLE', 'QUARANTINE', 'DAMAGED', 'EXPIRED')),
  quantity         numeric(18, 3) not null check (quantity >= 0),
  updated_at       timestamptz not null default now(),
  constraint stock_balances_warehouse_fk foreign key (warehouse_id, organization_id)
    references public.warehouses (id, organization_id) on delete restrict,
  constraint stock_balances_location_fk foreign key (location_id, warehouse_id)
    references public.warehouse_locations (id, warehouse_id) on delete restrict,
  constraint stock_balances_product_fk foreign key (product_id, organization_id)
    references public.products (id, organization_id) on delete restrict,
  constraint stock_balances_batch_fk foreign key (batch_id, product_id, organization_id)
    references public.batches (id, product_id, organization_id) on delete restrict,
  constraint stock_balances_key unique nulls not distinct
    (organization_id, warehouse_id, location_id, product_id, batch_id, stock_status)
);
create index stock_balances_org_product_idx on public.stock_balances (organization_id, product_id);
create index stock_balances_org_warehouse_idx on public.stock_balances (organization_id, warehouse_id, product_id);
create index stock_balances_batch_idx on public.stock_balances (batch_id) where batch_id is not null;

-- ---------------------------------------------------------------------------------------------------------
-- the ledger and its documents are append-only, for everyone (including the table owner)
-- ---------------------------------------------------------------------------------------------------------
create function private.stock_block_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only: post a correcting document instead', tg_table_name
    using errcode = '42501';
end;
$$;
create trigger stock_documents_append_only before update or delete on public.stock_documents
  for each row execute function private.stock_block_mutation();
create trigger stock_documents_no_truncate before truncate on public.stock_documents
  for each statement execute function private.stock_block_mutation();
create trigger stock_movements_append_only before update or delete on public.stock_movements
  for each row execute function private.stock_block_mutation();
create trigger stock_movements_no_truncate before truncate on public.stock_movements
  for each statement execute function private.stock_block_mutation();

-- ---------------------------------------------------------------------------------------------------------
-- RLS and grants: read only. Writes happen exclusively in post_stock_document().
-- ---------------------------------------------------------------------------------------------------------
alter table public.batches          enable row level security;
alter table public.stock_documents  enable row level security;
alter table public.stock_movements  enable row level security;
alter table public.stock_balances   enable row level security;
revoke all on public.batches, public.stock_documents, public.stock_movements, public.stock_balances
  from public, anon, authenticated;
grant select on public.batches, public.stock_documents, public.stock_movements, public.stock_balances
  to authenticated;

create policy batches_select on public.batches
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission_anywhere('inventory.view'));

create policy stock_documents_select on public.stock_documents
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and (private.has_permission('inventory.view', branch_id)
              or (to_warehouse_id is not null
                  and private.has_permission('inventory.view', private.warehouse_branch_id(to_warehouse_id)))));

create policy stock_movements_select on public.stock_movements
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('inventory.view', private.warehouse_branch_id(warehouse_id)));

create policy stock_balances_select on public.stock_balances
  for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and private.has_permission('inventory.view', private.warehouse_branch_id(warehouse_id)));

-- ---------------------------------------------------------------------------------------------------------
-- posting
-- ---------------------------------------------------------------------------------------------------------
create function private.add_stock_movement(
  p_org uuid, p_document_id uuid, p_line_no integer, p_type text,
  p_warehouse_id uuid, p_location_id uuid, p_product_id uuid, p_batch_id uuid, p_status text,
  p_quantity numeric, p_unit_id uuid, p_entered numeric
)
returns void
language sql
set search_path = ''
as $$
  insert into public.stock_movements (
    organization_id, document_id, line_no, movement_type, warehouse_id, location_id, product_id, batch_id,
    stock_status, quantity, entered_unit_id, entered_quantity)
  values (p_org, p_document_id, p_line_no, p_type, p_warehouse_id, p_location_id, p_product_id, p_batch_id,
          p_status, p_quantity, p_unit_id, p_entered)
$$;

-- p_lines: array of objects
--   product_id        uuid     required
--   quantity          number   required, > 0, in the unit below
--   product_unit_id   uuid     optional (pack the quantity is expressed in); default = base unit
--   batch_id          uuid     an existing batch ... or
--   batch_number      text     ... a batch number (+ expiry_date, + optional manufacture_date, to create it)
--   location_id       uuid     optional (location inside p_warehouse_id)
--   status            text     stock status the line starts from; default AVAILABLE
--   direction         text     ADJUSTMENT only: 'IN' or 'OUT'
--   to_status         text     STATUS_CHANGE only
--   to_location_id    uuid     TRANSFER (in the destination warehouse) / STATUS_CHANGE (same warehouse), optional
create function public.post_stock_document(
  p_document_type text,
  p_warehouse_id uuid,
  p_lines jsonb,
  p_to_warehouse_id uuid default null,
  p_reason_code text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.current_organization_id();
  v_perm    text;
  v_prefix  text;
  v_wh      public.warehouses;
  v_to_wh   public.warehouses;
  v_doc     public.stock_documents;
  v_number  text;
  v_today   date;
  v_line    jsonb;
  v_n       integer;
  v_prod    public.products;
  v_unit    public.product_units;
  v_batch   public.batches;
  v_entered numeric;
  v_qty     numeric;
  v_status  text;
  v_to_status text;
  v_dir     text;
  v_loc     uuid;
  v_to_loc  uuid;
  v_bnum    text;
  v_exp     date;
  v_mfg     date;
  v_batch_id uuid;
  v_can_create boolean;
  v_short_sku text;
  v_short_batch text;
  v_short_status text;
  v_short_on_hand numeric;
  v_short_wanted numeric;
  v_d       record;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  v_perm := case p_document_type
    when 'OPENING'       then 'inventory.opening_stock'
    when 'ADJUSTMENT'    then 'inventory.adjust'
    when 'TRANSFER'      then 'inventory.transfer'
    when 'STATUS_CHANGE' then 'inventory.quarantine'
  end;
  if v_perm is null then
    raise exception 'unknown document type' using errcode = '22023';
  end if;
  v_prefix := case p_document_type when 'OPENING' then 'OPN' when 'ADJUSTMENT' then 'ADJ'
                                   when 'TRANSFER' then 'TRF' else 'STS' end;

  select * into v_wh from public.warehouses w
   where w.id = p_warehouse_id and w.organization_id = v_org and w.is_active;
  if not found then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;
  if not private.has_permission(v_perm, v_wh.branch_id) then
    raise exception 'insufficient privilege for this warehouse' using errcode = '42501';
  end if;

  if p_document_type = 'TRANSFER' then
    select * into v_to_wh from public.warehouses w
     where w.id = p_to_warehouse_id and w.organization_id = v_org and w.is_active;
    if not found then
      raise exception 'destination warehouse not found' using errcode = 'P0002';
    end if;
    if v_to_wh.id = v_wh.id then
      raise exception 'source and destination warehouse must differ' using errcode = '22023';
    end if;
  elsif p_to_warehouse_id is not null then
    raise exception 'destination warehouse only applies to transfers' using errcode = '22023';
  end if;

  if p_document_type = 'ADJUSTMENT' and (p_reason_code is null or p_reason_code in ('OPENING')) then
    raise exception 'a reason is required for an adjustment' using errcode = '22023';
  end if;
  if p_document_type = 'OPENING' then
    p_reason_code := 'OPENING';
  end if;
  if p_notes is not null and length(p_notes) > 500 then
    raise exception 'notes are limited to 500 characters' using errcode = '22023';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'at least one line is required' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'a document is limited to 200 lines' using errcode = '22023';
  end if;

  select (now() at time zone o.timezone)::date into v_today from public.organizations o where o.id = v_org;

  -- one sequence per organization (not per branch): document numbers are unique across the whole organization
  v_number := private.generate_document_number(v_org, null, 'STOCK_' || p_document_type, v_prefix);
  insert into public.stock_documents (
    organization_id, document_number, document_type, branch_id, warehouse_id, to_warehouse_id, reason_code, notes,
    line_count)
  values (v_org, v_number, p_document_type, v_wh.branch_id, v_wh.id, v_to_wh.id, p_reason_code,
          nullif(btrim(p_notes), ''), jsonb_array_length(p_lines))
  returning * into v_doc;

  v_n := 0;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'line %: invalid line', v_n using errcode = '22023';
    end if;

    -- product
    select * into v_prod from public.products p
     where p.id = nullif(v_line ->> 'product_id', '')::uuid and p.organization_id = v_org and p.is_active;
    if not found then
      raise exception 'line %: product not found or inactive', v_n using errcode = 'P0002';
    end if;

    -- quantity (entered in a pack level, stored in base units)
    if jsonb_typeof(v_line -> 'quantity') is distinct from 'number' or (v_line ->> 'quantity')::numeric <= 0 then
      raise exception 'line %: quantity must be a positive number', v_n using errcode = '22023';
    end if;
    v_entered := (v_line ->> 'quantity')::numeric;
    if nullif(v_line ->> 'product_unit_id', '') is null then
      select * into v_unit from public.product_units u where u.product_id = v_prod.id and u.is_base;
    else
      select * into v_unit from public.product_units u
       where u.id = (v_line ->> 'product_unit_id')::uuid and u.product_id = v_prod.id
         and u.organization_id = v_org and u.is_active;
    end if;
    if not found then
      raise exception 'line %: unit does not belong to this product', v_n using errcode = 'P0002';
    end if;
    v_qty := v_entered * v_unit.factor_to_base;
    if v_qty <> round(v_qty, 3) or v_qty <= 0 or v_qty >= 1000000000000 then
      raise exception 'line %: quantity is not a valid amount in the base unit', v_n using errcode = '22023';
    end if;

    -- status / locations
    v_status := coalesce(nullif(v_line ->> 'status', ''), 'AVAILABLE');
    if v_status not in ('AVAILABLE', 'QUARANTINE', 'DAMAGED', 'EXPIRED') then
      raise exception 'line %: invalid stock status', v_n using errcode = '22023';
    end if;
    v_loc := nullif(v_line ->> 'location_id', '')::uuid;
    if v_loc is not null and not exists (
         select 1 from public.warehouse_locations l
          where l.id = v_loc and l.warehouse_id = v_wh.id and l.organization_id = v_org and l.is_active) then
      raise exception 'line %: location not found in this warehouse', v_n using errcode = 'P0002';
    end if;
    v_to_loc := nullif(v_line ->> 'to_location_id', '')::uuid;
    if v_to_loc is not null and not exists (
         select 1 from public.warehouse_locations l
          where l.id = v_to_loc
            and l.warehouse_id = case p_document_type when 'TRANSFER' then v_to_wh.id else v_wh.id end
            and l.organization_id = v_org and l.is_active) then
      raise exception 'line %: destination location not found', v_n using errcode = 'P0002';
    end if;

    v_dir := upper(coalesce(v_line ->> 'direction', ''));
    if p_document_type = 'ADJUSTMENT' and v_dir not in ('IN', 'OUT') then
      raise exception 'line %: direction must be IN or OUT', v_n using errcode = '22023';
    end if;
    v_to_status := upper(coalesce(v_line ->> 'to_status', ''));
    if p_document_type = 'STATUS_CHANGE' then
      if v_to_status not in ('AVAILABLE', 'QUARANTINE', 'DAMAGED', 'EXPIRED') then
        raise exception 'line %: invalid target status', v_n using errcode = '22023';
      end if;
      if v_to_status = v_status and v_to_loc is not distinct from v_loc then
        raise exception 'line %: nothing to change (same status and location)', v_n using errcode = '22023';
      end if;
    end if;

    -- batch: existing (by id or number) or, for stock coming IN, created on the fly
    v_bnum := nullif(btrim(coalesce(v_line ->> 'batch_number', '')), '');
    v_exp := nullif(v_line ->> 'expiry_date', '')::date;
    v_mfg := nullif(v_line ->> 'manufacture_date', '')::date;
    v_can_create := p_document_type = 'OPENING' or (p_document_type = 'ADJUSTMENT' and v_dir = 'IN');
    v_batch_id := null;

    if not v_prod.track_batches then
      if v_bnum is not null or nullif(v_line ->> 'batch_id', '') is not null then
        raise exception 'line %: this product is not batch-tracked', v_n using errcode = '22023';
      end if;
    else
      v_batch := null;
      if nullif(v_line ->> 'batch_id', '') is not null then
        select * into v_batch from public.batches b
         where b.id = (v_line ->> 'batch_id')::uuid and b.product_id = v_prod.id and b.organization_id = v_org;
      elsif v_bnum is not null then
        select * into v_batch from public.batches b
         where b.product_id = v_prod.id and b.organization_id = v_org and upper(btrim(b.batch_number)) = upper(v_bnum);
      else
        raise exception 'line %: batch is required for this product', v_n using errcode = '22023';
      end if;

      if v_batch.id is null then
        if not v_can_create or v_bnum is null then
          raise exception 'line %: batch not found', v_n using errcode = 'P0002';
        end if;
        if v_exp is null then
          raise exception 'line %: expiry date is required for a new batch', v_n using errcode = '22023';
        end if;
        insert into public.batches (organization_id, product_id, batch_number, manufacture_date, expiry_date)
        values (v_org, v_prod.id, v_bnum, v_mfg, v_exp)
        returning * into v_batch;
      elsif v_exp is not null and v_exp <> v_batch.expiry_date then
        raise exception 'line %: batch % already exists with expiry %', v_n, v_batch.batch_number, v_batch.expiry_date
          using errcode = '22023';
      end if;
      v_batch_id := v_batch.id;
    end if;

    -- expired stock can never be put (back) into sellable status
    if v_batch_id is not null and v_batch.expiry_date < v_today then
      if (p_document_type in ('OPENING') and v_status = 'AVAILABLE')
         or (p_document_type = 'ADJUSTMENT' and v_dir = 'IN' and v_status = 'AVAILABLE')
         or (p_document_type = 'STATUS_CHANGE' and v_to_status = 'AVAILABLE') then
        raise exception 'line %: batch % expired on % and cannot be AVAILABLE', v_n, v_batch.batch_number, v_batch.expiry_date
          using errcode = '22023';
      end if;
    end if;

    -- the ledger lines
    if p_document_type = 'OPENING' then
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'OPENING', v_wh.id, v_loc, v_prod.id, v_batch_id,
                                         v_status, v_qty, v_unit.id, v_entered);
    elsif p_document_type = 'ADJUSTMENT' then
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'ADJUSTMENT_' || v_dir, v_wh.id, v_loc, v_prod.id,
                                         v_batch_id, v_status, case when v_dir = 'IN' then v_qty else -v_qty end,
                                         v_unit.id, v_entered);
    elsif p_document_type = 'TRANSFER' then
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'TRANSFER_OUT', v_wh.id, v_loc, v_prod.id, v_batch_id,
                                         v_status, -v_qty, v_unit.id, v_entered);
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'TRANSFER_IN', v_to_wh.id, v_to_loc, v_prod.id,
                                         v_batch_id, v_status, v_qty, v_unit.id, v_entered);
    else
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'STATUS_OUT', v_wh.id, v_loc, v_prod.id, v_batch_id,
                                         v_status, -v_qty, v_unit.id, v_entered);
      perform private.add_stock_movement(v_org, v_doc.id, v_n, 'STATUS_IN', v_wh.id, v_to_loc, v_prod.id, v_batch_id,
                                         v_to_status, v_qty, v_unit.id, v_entered);
    end if;
  end loop;

  -- friendly message before the CHECK constraint would reject it
  select p.sku, b.batch_number, d.stock_status, coalesce(sb.quantity, 0), -d.delta
    into v_short_sku, v_short_batch, v_short_status, v_short_on_hand, v_short_wanted
  from (
    select m.warehouse_id, m.location_id, m.product_id, m.batch_id, m.stock_status, sum(m.quantity) as delta
    from public.stock_movements m
    where m.document_id = v_doc.id
    group by m.warehouse_id, m.location_id, m.product_id, m.batch_id, m.stock_status
    having sum(m.quantity) < 0
  ) d
  join public.products p on p.id = d.product_id
  left join public.batches b on b.id = d.batch_id
  left join public.stock_balances sb
    on sb.organization_id = v_org and sb.warehouse_id = d.warehouse_id
   and sb.location_id is not distinct from d.location_id and sb.product_id = d.product_id
   and sb.batch_id is not distinct from d.batch_id and sb.stock_status = d.stock_status
  where coalesce(sb.quantity, 0) + d.delta < 0
  limit 1;
  if v_short_sku is not null then
    raise exception 'insufficient stock: % % [%] has % available, % requested',
      v_short_sku, coalesce('batch ' || v_short_batch, ''), v_short_status, v_short_on_hand, v_short_wanted
      using errcode = '23514';
  end if;

  -- apply to the balances in a fixed key order (concurrent postings cannot deadlock each other)
  for v_d in
    select m.warehouse_id, m.location_id, m.product_id, m.batch_id, m.stock_status, sum(m.quantity) as delta
    from public.stock_movements m
    where m.document_id = v_doc.id
    group by m.warehouse_id, m.location_id, m.product_id, m.batch_id, m.stock_status
    order by m.warehouse_id, m.product_id, m.batch_id nulls first, m.location_id nulls first, m.stock_status
  loop
    for i in 1..2 loop
      begin
        update public.stock_balances sb
           set quantity = sb.quantity + v_d.delta, updated_at = now()
         where sb.organization_id = v_org and sb.warehouse_id = v_d.warehouse_id
           and sb.location_id is not distinct from v_d.location_id and sb.product_id = v_d.product_id
           and sb.batch_id is not distinct from v_d.batch_id and sb.stock_status = v_d.stock_status;
        if found then
          exit;
        end if;
        insert into public.stock_balances (organization_id, warehouse_id, location_id, product_id, batch_id,
                                           stock_status, quantity)
        values (v_org, v_d.warehouse_id, v_d.location_id, v_d.product_id, v_d.batch_id, v_d.stock_status, v_d.delta);
        exit;
      exception
        when unique_violation then
          if i = 2 then raise; end if;   -- a concurrent posting created the row: go round and update it
        when check_violation then
          raise exception 'insufficient stock (changed while posting) - please retry' using errcode = '23514';
      end;
    end loop;
  end loop;

  perform private.write_audit(
    v_org, 'stock.' || lower(p_document_type) || '_posted', 'stock_document', v_doc.id::text, v_wh.branch_id,
    null,
    jsonb_build_object('document_number', v_number, 'document_type', p_document_type, 'lines', v_doc.line_count,
                       'warehouse_id', v_wh.id, 'to_warehouse_id', v_to_wh.id, 'reason_code', p_reason_code),
    null, nullif(btrim(p_notes), ''));

  return jsonb_build_object('document_id', v_doc.id, 'document_number', v_number);
end;
$$;
revoke all on function public.post_stock_document(text, uuid, jsonb, uuid, text, text) from public, anon;
grant execute on function public.post_stock_document(text, uuid, jsonb, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- reads (SECURITY INVOKER: the caller's RLS applies, so branch scope and tenant isolation come for free)
-- ---------------------------------------------------------------------------------------------------------

-- Stock per product (all visible warehouses, or one). Near expiry = sellable stock expiring within p_near_days.
create function public.stock_summary(
  p_warehouse_id uuid default null,
  p_query text default null,
  p_near_days integer default 90,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  product_id      uuid,
  sku             text,
  brand_name      text,
  generic_name    text,
  strength_text   text,
  base_unit       text,
  available       numeric,
  quarantine      numeric,
  damaged         numeric,
  expired_status  numeric,
  expired_unsold  numeric,
  near_expiry     numeric,
  earliest_expiry date,
  total_count     bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with matched as (
    select s.product_id from public.search_products(p_query, 100, 0) s where nullif(btrim(p_query), '') is not null
  ),
  agg as (
    select b.product_id,
           sum(b.quantity) filter (where b.stock_status = 'AVAILABLE')  as available,
           sum(b.quantity) filter (where b.stock_status = 'QUARANTINE') as quarantine,
           sum(b.quantity) filter (where b.stock_status = 'DAMAGED')    as damaged,
           sum(b.quantity) filter (where b.stock_status = 'EXPIRED')    as expired_status,
           sum(b.quantity) filter (where b.stock_status = 'AVAILABLE' and ba.expiry_date < current_date) as expired_unsold,
           sum(b.quantity) filter (where b.stock_status = 'AVAILABLE' and ba.expiry_date >= current_date
                                     and ba.expiry_date <= current_date + greatest(coalesce(p_near_days, 90), 0)) as near_expiry,
           min(ba.expiry_date) filter (where b.stock_status <> 'EXPIRED' and b.quantity > 0) as earliest_expiry
    from public.stock_balances b
    left join public.batches ba on ba.id = b.batch_id
    where b.quantity > 0
      and (p_warehouse_id is null or b.warehouse_id = p_warehouse_id)
    group by b.product_id
  )
  select p.id, p.sku, p.brand_name, i.generic_name, i.strength_text, u.code,
         coalesce(a.available, 0), coalesce(a.quarantine, 0), coalesce(a.damaged, 0), coalesce(a.expired_status, 0),
         coalesce(a.expired_unsold, 0), coalesce(a.near_expiry, 0), a.earliest_expiry,
         count(*) over ()
  from agg a
  join public.products p on p.id = a.product_id
  join public.units_of_measure u on u.id = p.base_unit_id
  left join public.product_identities i on i.id = p.identity_id
  where nullif(btrim(p_query), '') is null or p.id in (select m.product_id from matched m)
  order by p.brand_name, p.sku
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0)
$$;
revoke all on function public.stock_summary(uuid, text, integer, integer, integer) from public, anon;
grant execute on function public.stock_summary(uuid, text, integer, integer, integer) to authenticated;

-- Stock that is expired or expires within p_within_days (excluding stock already segregated as EXPIRED).
create function public.expiring_stock(p_within_days integer default 90, p_warehouse_id uuid default null)
returns table (
  warehouse_id    uuid,
  warehouse_name  text,
  location_id     uuid,
  product_id      uuid,
  sku             text,
  brand_name      text,
  batch_id        uuid,
  batch_number    text,
  expiry_date     date,
  days_to_expiry  integer,
  stock_status    text,
  quantity        numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select b.warehouse_id, w.name, b.location_id, b.product_id, p.sku, p.brand_name, b.batch_id, ba.batch_number,
         ba.expiry_date, (ba.expiry_date - current_date)::integer, b.stock_status, b.quantity
  from public.stock_balances b
  join public.batches ba on ba.id = b.batch_id
  join public.products p on p.id = b.product_id
  join public.warehouses w on w.id = b.warehouse_id
  where b.quantity > 0
    and b.stock_status <> 'EXPIRED'
    and ba.expiry_date <= current_date + greatest(coalesce(p_within_days, 90), 0)
    and (p_warehouse_id is null or b.warehouse_id = p_warehouse_id)
  order by ba.expiry_date, p.brand_name, ba.batch_number
  limit 1000
$$;
revoke all on function public.expiring_stock(integer, uuid) from public, anon;
grant execute on function public.expiring_stock(integer, uuid) to authenticated;

-- FEFO: which batches to pick, earliest expiry first, from sellable (AVAILABLE, unexpired) stock.
-- Pure read: it reserves nothing (reservations arrive with sales orders). Rows add up to LEAST(requested, on hand);
-- the caller compares the sum with what it asked for to detect a shortfall.
create function public.suggest_fefo_allocation(
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric,
  p_min_shelf_life_days integer default 0
)
returns table (
  batch_id     uuid,
  batch_number text,
  expiry_date  date,
  location_id  uuid,
  on_hand      numeric,
  allocate     numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with candidates as (
    select b.batch_id, ba.batch_number, ba.expiry_date, b.location_id, b.quantity as on_hand,
           sum(b.quantity) over (order by ba.expiry_date, ba.created_at, ba.id, b.location_id nulls first
                                 rows between unbounded preceding and current row) as running
    from public.stock_balances b
    left join public.batches ba on ba.id = b.batch_id
    where b.product_id = p_product_id
      and b.warehouse_id = p_warehouse_id
      and b.stock_status = 'AVAILABLE'
      and b.quantity > 0
      and (ba.id is null or ba.expiry_date >= current_date + greatest(coalesce(p_min_shelf_life_days, 0), 0))
  )
  select c.batch_id, c.batch_number, c.expiry_date, c.location_id, c.on_hand,
         least(c.on_hand, p_quantity - (c.running - c.on_hand)) as allocate
  from candidates c
  where p_quantity > 0 and c.running - c.on_hand < p_quantity
  order by c.expiry_date nulls last, c.batch_number, c.location_id nulls first
$$;
revoke all on function public.suggest_fefo_allocation(uuid, uuid, numeric, integer) from public, anon;
grant execute on function public.suggest_fefo_allocation(uuid, uuid, numeric, integer) to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- private function privileges stay on the allow-list (new private functions start with none, see the catalog
-- migration); the posting helpers are only ever called from post_stock_document() running as its owner.
-- ---------------------------------------------------------------------------------------------------------
revoke all on function private.add_stock_movement(uuid, uuid, integer, text, uuid, uuid, uuid, uuid, text, numeric, uuid, numeric)
  from public, anon, authenticated;
revoke all on function private.batches_before_write() from public, anon, authenticated;
revoke all on function private.stock_block_mutation() from public, anon, authenticated;

commit;
