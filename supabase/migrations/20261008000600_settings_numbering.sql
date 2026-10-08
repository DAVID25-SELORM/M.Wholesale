-- Phase 0 / 06: system settings and document numbering

-- ---------------------------------------------------------------------------
-- system_settings: one row per (organization, optional branch, category, key).
-- Normalized on purpose - no giant JSON blob. A branch row overrides the
-- organization-wide row (resolution happens in the reader). NEVER store secrets
-- here; integration credentials belong in a secrets manager / Edge Function secrets.
-- ---------------------------------------------------------------------------
create table public.system_settings (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid,
  category        text not null check (category in
    ('company', 'inventory', 'sales', 'purchasing', 'credit',
     'invoice', 'notifications', 'security', 'integrations')),
  key             text not null check (key ~ '^[a-z][a-z0-9_.]{0,63}$'),
  value           jsonb not null check (octet_length(value::text) <= 16384),
  description     text,
  updated_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint system_settings_org_fk foreign key (organization_id)
    references public.organizations (id) on delete restrict,
  constraint system_settings_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint system_settings_scope_key unique nulls not distinct
    (organization_id, branch_id, category, key)
);
create index system_settings_branch_idx on public.system_settings (branch_id) where branch_id is not null;

create function private.system_settings_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_by := auth.uid();
  return new;
end;
$$;
create trigger system_settings_stamp before insert or update on public.system_settings
  for each row execute function private.system_settings_stamp();
create trigger system_settings_immutable before update on public.system_settings
  for each row execute function private.prevent_column_change(
    'organization_id', 'branch_id', 'category', 'key');
create trigger system_settings_set_updated_at before update on public.system_settings
  for each row execute function private.set_updated_at();
create trigger system_settings_audit after insert or update or delete on public.system_settings
  for each row execute function private.audit_row_change('system_setting');

-- ---------------------------------------------------------------------------
-- number_sequences: gap-free, race-free document numbers.
-- Numbers are produced by private.generate_document_number() under a row lock,
-- inside the caller's transaction: if that transaction rolls back, the number is
-- released again (no gaps); concurrent callers are serialized by the row lock.
-- ---------------------------------------------------------------------------
create table public.number_sequences (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid,
  document_type   text not null check (document_type ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  prefix          text not null check (prefix ~ '^[A-Z0-9-]{1,16}$'),
  next_number     bigint not null default 1 check (next_number >= 1),
  padding         smallint not null default 6 check (padding between 1 and 12),
  reset_period    text not null default 'YEARLY' check (reset_period in ('NEVER', 'YEARLY', 'MONTHLY')),
  current_period  text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint number_sequences_org_fk foreign key (organization_id)
    references public.organizations (id) on delete restrict,
  constraint number_sequences_branch_fk foreign key (branch_id, organization_id)
    references public.branches (id, organization_id) on delete restrict,
  constraint number_sequences_scope_key unique nulls not distinct
    (organization_id, branch_id, document_type)
);
create trigger number_sequences_immutable before update on public.number_sequences
  for each row execute function private.prevent_column_change(
    'organization_id', 'branch_id', 'document_type');

-- Returns e.g. 'INV-2026-000042' (YEARLY), 'GRN-202610-000007' (MONTHLY), 'PO-000015' (NEVER).
-- The year/month is taken in the organization's own time zone. The sequence row is
-- created on first use. Only trusted server code may call this (see grants).
create function private.generate_document_number(
  p_organization_id uuid,
  p_branch_id uuid,
  p_document_type text,
  p_default_prefix text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz     text;
  v_seq    public.number_sequences;
  v_period text;
  v_number bigint;
  v_digits text;
begin
  select o.timezone into v_tz from public.organizations o where o.id = p_organization_id;
  if not found then
    raise exception 'unknown organization' using errcode = '23503';
  end if;

  insert into public.number_sequences (organization_id, branch_id, document_type, prefix)
  values (p_organization_id, p_branch_id, p_document_type,
          coalesce(p_default_prefix, left(p_document_type, 3)))
  on conflict do nothing;

  -- Row lock: concurrent callers queue here and each re-reads the updated row.
  select * into v_seq
  from public.number_sequences s
  where s.organization_id = p_organization_id
    and s.branch_id is not distinct from p_branch_id
    and s.document_type = p_document_type
  for update;

  v_period := case v_seq.reset_period
    when 'YEARLY'  then to_char(now() at time zone v_tz, 'YYYY')
    when 'MONTHLY' then to_char(now() at time zone v_tz, 'YYYYMM')
    else ''
  end;

  v_number := case when v_seq.current_period is distinct from v_period
                   then 1 else v_seq.next_number end;

  update public.number_sequences
     set next_number = v_number + 1,
         current_period = v_period,
         updated_at = now()
   where id = v_seq.id;

  v_digits := v_number::text;
  if length(v_digits) < v_seq.padding then
    v_digits := lpad(v_digits, v_seq.padding, '0');
  end if;

  return v_seq.prefix || '-' || case when v_period <> '' then v_period || '-' else '' end || v_digits;
end;
$$;
revoke all on function private.generate_document_number(uuid, uuid, text, text) from public;
grant execute on function private.generate_document_number(uuid, uuid, text, text) to service_role;
