-- Apply the Settings module (validated settings registry, document numbering configuration) to the hosted database in ONE atomic paste: the migration, verbatim, inside a single transaction.
-- Run it once in the Supabase SQL editor. If anything fails, nothing is changed.
begin;

-- ===== migration 20261026000100_settings =====
-- Phase 0 completion / 01: the Settings module
--
-- system_settings has existed since Phase 0 but nothing read it and any key was accepted. This migration makes it a real, validated configuration store:
--   * REGISTRY   private.setting_defs() is the single list of settings the system supports. Every one has a type, bounds, a default and a flag for branch scope and
--                for "sensitive". A trigger rejects anything not in the registry (unknown keys, wrong types, out-of-range values, a warehouse of another branch), for
--                every writer, including direct table writes.
--   * AUTHORITY  writing needs settings.manage (organization-wide for organization settings, at that branch for branch settings); reading the effective values is
--                open to every signed-in member of the organization (app_settings) because screens need them (a cashier's receipt shows the invoice footer); the
--                Settings screen itself needs settings.view. No setting may hold a secret: they are visible to every member.
--   * AUDIT      every change is audited by the existing system_settings audit trigger (who, what changed, before and after). Settings marked SENSITIVE (the idle
--                time-out) cannot be changed without a reason, which is stored with the audit entry.
--   * CONSUMERS  each setting is read by real behaviour: document footers and payment instructions (invoice PDFs, receipts), default payment terms and credit limit
--                for new customers and suppliers, quotation validity, the near-expiry window, the default sales warehouse of a branch, and the idle sign-out.
-- Document numbering (prefix, padding, reset period) is configured through configure_document_numbering, with rules that cannot cause a duplicate number.

-- ---------------------------------------------------------------------------------------------------------
-- the registry
-- ---------------------------------------------------------------------------------------------------------
create function private.setting_defs()
returns table (category text, key text, kind text, min_num numeric, max_num numeric, min_nonzero numeric, max_len integer, branch_scoped boolean, sensitive boolean, default_value jsonb)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('invoice',    'footer',                     'text',      null::numeric, null::numeric, null::numeric, 300,  false, false, '""'::jsonb),
    ('invoice',    'payment_instructions',       'text',      null,          null,          null,          500,  false, false, '""'::jsonb),
    ('sales',      'default_payment_terms_days', 'int',       0,             365,           null,          null, false, false, '0'::jsonb),
    ('sales',      'quotation_validity_days',    'int',       1,             365,           null,          null, false, false, '30'::jsonb),
    ('credit',     'default_credit_limit',       'number',    0,             1000000000,    null,          null, false, false, '0'::jsonb),
    ('purchasing', 'default_payment_terms_days', 'int',       0,             365,           null,          null, false, false, '30'::jsonb),
    ('inventory',  'near_expiry_days',           'int',       1,             730,           null,          null, false, false, '90'::jsonb),
    ('inventory',  'default_sales_warehouse',    'warehouse', null,          null,          null,          null, true,  false, 'null'::jsonb),
    ('security',   'idle_timeout_minutes',       'int',       0,             480,           5,             null, false, true,  '0'::jsonb)
  ) as d(category, key, kind, min_num, max_num, min_nonzero, max_len, branch_scoped, sensitive, default_value)
$$;
revoke all on function private.setting_defs() from public, anon, authenticated;

-- every write of system_settings is checked against the registry
create function private.system_settings_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d   record;
  v_n numeric;
  v_reason text := coalesce(current_setting('app.audit_reason', true), '');
begin
  select * into d from private.setting_defs() x where x.category = new.category and x.key = new.key;
  if not found then
    raise exception 'unknown setting %.%', new.category, new.key using errcode = '22023';
  end if;
  if d.branch_scoped and new.branch_id is null then
    raise exception 'the setting %.% belongs to a branch', new.category, new.key using errcode = '22023';
  end if;
  if not d.branch_scoped and new.branch_id is not null then
    raise exception 'the setting %.% applies to the whole organization, not to a branch', new.category, new.key using errcode = '22023';
  end if;

  if d.kind = 'text' then
    if jsonb_typeof(new.value) <> 'string' or length(new.value #>> '{}') > d.max_len then
      raise exception '%.% must be text of at most % characters', new.category, new.key, d.max_len using errcode = '22023';
    end if;
  elsif d.kind in ('int', 'number') then
    if jsonb_typeof(new.value) <> 'number' then
      raise exception '%.% must be a number', new.category, new.key using errcode = '22023';
    end if;
    v_n := (new.value #>> '{}')::numeric;
    if v_n < d.min_num or v_n > d.max_num then
      raise exception '%.% must be between % and %', new.category, new.key, d.min_num, d.max_num using errcode = '22023';
    end if;
    if d.kind = 'int' and v_n <> trunc(v_n) then
      raise exception '%.% must be a whole number', new.category, new.key using errcode = '22023';
    end if;
    if d.kind = 'number' and v_n <> round(v_n, 2) then
      raise exception '%.% allows at most 2 decimals', new.category, new.key using errcode = '22023';
    end if;
    if d.min_nonzero is not null and v_n <> 0 and v_n < d.min_nonzero then
      raise exception '%.% must be 0 (off) or at least %', new.category, new.key, d.min_nonzero using errcode = '22023';
    end if;
  elsif d.kind = 'warehouse' then
    if jsonb_typeof(new.value) <> 'string' or not exists (
         select 1 from public.warehouses w
         where w.id::text = (new.value #>> '{}') and w.organization_id = new.organization_id and w.branch_id = new.branch_id and w.is_active) then
      raise exception '%.% must be an active warehouse of that branch', new.category, new.key using errcode = '22023';
    end if;
  end if;

  if d.sensitive and length(btrim(v_reason)) < 5 then
    raise exception 'give a reason for changing %.% (it is kept with the audit entry)', new.category, new.key using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger system_settings_validate before insert or update on public.system_settings
  for each row execute function private.system_settings_validate();

-- ---------------------------------------------------------------------------------------------------------
-- reading and writing (the screens use these; the checks are the same as for direct table access)
-- ---------------------------------------------------------------------------------------------------------
-- effective values for the caller's organization (and branch overrides when a branch they can access is given): defaults, then organization, then branch.
-- Open to every signed-in member, because screens need them; settings never hold secrets.
create function public.app_settings(p_branch_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_out jsonb;
begin
  if v_org is null then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select coalesce(jsonb_object_agg(d.category || '.' || d.key, d.default_value), '{}'::jsonb) into v_out from private.setting_defs() d;
  select v_out || coalesce(jsonb_object_agg(s.category || '.' || s.key, s.value), '{}'::jsonb) into v_out
  from public.system_settings s where s.organization_id = v_org and s.branch_id is null;
  if p_branch_id is not null and private.can_access_branch(p_branch_id) then
    select v_out || coalesce(jsonb_object_agg(s.category || '.' || s.key, s.value), '{}'::jsonb) into v_out
    from public.system_settings s where s.organization_id = v_org and s.branch_id = p_branch_id;
  end if;
  return v_out;
end;
$$;

-- the Settings screen: every setting with its rules, default, and where the effective value comes from
create function public.settings_overview(p_branch_id uuid default null)
returns table (category text, key text, kind text, min_num numeric, max_num numeric, min_nonzero numeric, max_len integer, branch_scoped boolean, sensitive boolean,
               default_value jsonb, value jsonb, source text, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
begin
  if v_org is null or not private.has_permission_anywhere('settings.view') then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  return query
  select d.category, d.key, d.kind, d.min_num, d.max_num, d.min_nonzero, d.max_len, d.branch_scoped, d.sensitive, d.default_value,
         coalesce(s.value, d.default_value), case when s.id is null then 'default' when s.branch_id is null then 'organization' else 'branch' end, s.updated_at
  from private.setting_defs() d
  left join public.system_settings s on s.organization_id = v_org and s.category = d.category and s.key = d.key
       and s.branch_id is not distinct from (case when d.branch_scoped then p_branch_id else null end)
       and (not d.branch_scoped or private.can_access_branch(p_branch_id))
  order by d.category, d.key;
end;
$$;

create function public.save_setting(p_category text, p_key text, p_value jsonb, p_branch_id uuid default null, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
begin
  if v_org is null or not private.has_permission('settings.manage', p_branch_id) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if p_branch_id is not null and not exists (select 1 from public.branches b where b.id = p_branch_id and b.organization_id = v_org) then
    raise exception 'unknown branch' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', coalesce(btrim(p_reason), ''), true);
  if p_value is null or p_value = 'null'::jsonb then
    -- JSON null means "back to the default": the saved value is removed (audited as a deletion, with the reason for sensitive settings)
    if not exists (select 1 from private.setting_defs() d where d.category = p_category and d.key = p_key) then
      raise exception 'unknown setting %.%', p_category, p_key using errcode = '22023';
    end if;
    if exists (select 1 from private.setting_defs() d where d.category = p_category and d.key = p_key and d.sensitive) and length(btrim(coalesce(p_reason, ''))) < 5 then
      raise exception 'give a reason for changing %.% (it is kept with the audit entry)', p_category, p_key using errcode = '22023';
    end if;
    delete from public.system_settings s where s.organization_id = v_org and s.branch_id is not distinct from p_branch_id and s.category = p_category and s.key = p_key;
    return;
  end if;
  insert into public.system_settings (organization_id, branch_id, category, key, value)
  values (v_org, p_branch_id, p_category, p_key, p_value)
  on conflict (organization_id, branch_id, category, key) do update set value = excluded.value;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- document numbering
-- ---------------------------------------------------------------------------------------------------------
-- the documents whose numbers an organization may format, with the prefix each uses until configured
create function private.numbered_documents()
returns table (document_type text, default_prefix text)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('SALES_QUOTATION', 'QUO'), ('SALES_ORDER', 'SO'), ('SALES_INVOICE', 'INV'), ('CREDIT_NOTE', 'CRN'), ('CUSTOMER_RECEIPT', 'RCP'), ('CUSTOMER_REFUND', 'RFD'),
    ('DELIVERY_NOTE', 'DN'), ('POS_SESSION', 'SHF'), ('PURCHASE_ORDER', 'PO'), ('GOODS_RECEIPT', 'GRN'), ('PURCHASE_RETURN', 'PRN'), ('SUPPLIER_INVOICE', 'SIN'),
    ('STOCK_TRANSFER', 'TRN'), ('STOCK_COUNT', 'CNT'), ('JOURNAL', 'JV'), ('CONTROLLED_ADJUSTMENT', 'CDA')
  ) as d(document_type, default_prefix)
$$;
revoke all on function private.numbered_documents() from public, anon, authenticated;

create function public.numbering_overview()
returns table (document_type text, prefix text, padding integer, reset_period text, next_number bigint, configured boolean, in_use boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
begin
  if v_org is null or not private.has_permission_anywhere('settings.view') then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  return query
  select n.document_type, coalesce(s.prefix, n.default_prefix), coalesce(s.padding, 6), coalesce(s.reset_period, 'YEARLY'), coalesce(s.next_number, 1::bigint),
         s.id is not null, coalesce(s.next_number, 1) > 1
  from private.numbered_documents() n
  left join public.number_sequences s on s.organization_id = v_org and s.branch_id is null and s.document_type = n.document_type
  order by n.document_type;
end;
$$;

-- Rules that make a duplicate number impossible: the counter never goes back (it is not touched), the prefix may not be another document's prefix, and the reset period
-- may only change before the first number is issued (switching an in-use sequence between periods could reissue a number).
create function public.configure_document_numbering(p_document_type text, p_prefix text, p_padding integer, p_reset_period text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org    uuid := private.current_organization_id();
  v_prefix text := upper(btrim(coalesce(p_prefix, '')));
  v_default text;
  v_seq    public.number_sequences;
begin
  if v_org is null or not private.has_permission('settings.manage') then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  select n.default_prefix into v_default from private.numbered_documents() n where n.document_type = p_document_type;
  if not found then
    raise exception 'unknown document type' using errcode = '22023';
  end if;
  if v_prefix !~ '^[A-Z0-9][A-Z0-9-]{0,14}[A-Z0-9]$|^[A-Z0-9]$' then
    raise exception 'the prefix is 1 to 16 letters, digits or dashes, and cannot start or end with a dash' using errcode = '22023';
  end if;
  if p_padding is null or p_padding not between 3 and 12 then
    raise exception 'the number length is between 3 and 12 digits' using errcode = '22023';
  end if;
  if p_reset_period is null or p_reset_period not in ('NEVER', 'YEARLY', 'MONTHLY') then
    raise exception 'the reset period is NEVER, YEARLY or MONTHLY' using errcode = '22023';
  end if;
  if exists (
       select 1 from private.numbered_documents() n
       left join public.number_sequences s on s.organization_id = v_org and s.branch_id is null and s.document_type = n.document_type
       where n.document_type <> p_document_type and coalesce(s.prefix, n.default_prefix) = v_prefix) then
    raise exception 'another document already uses the prefix %', v_prefix using errcode = '23514';   -- a validation error: the screens show this message as written
  end if;

  select * into v_seq from public.number_sequences s where s.organization_id = v_org and s.branch_id is null and s.document_type = p_document_type for update;
  if not found then
    insert into public.number_sequences (organization_id, branch_id, document_type, prefix, padding, reset_period)
    values (v_org, null, p_document_type, v_prefix, p_padding, p_reset_period);
    perform private.write_audit(v_org, 'numbering.configured', 'number_sequence', p_document_type, null, null,
      jsonb_build_object('prefix', v_prefix, 'padding', p_padding, 'reset_period', p_reset_period), null, null);
    return;
  end if;
  if p_reset_period <> v_seq.reset_period and v_seq.next_number > 1 then
    raise exception 'numbers have already been issued: the reset period can only be changed before the first one' using errcode = '22023';
  end if;
  update public.number_sequences set prefix = v_prefix, padding = p_padding, reset_period = p_reset_period where id = v_seq.id;
  perform private.write_audit(v_org, 'numbering.configured', 'number_sequence', p_document_type, null,
    jsonb_build_object('prefix', v_seq.prefix, 'padding', v_seq.padding, 'reset_period', v_seq.reset_period),
    jsonb_build_object('prefix', v_prefix, 'padding', p_padding, 'reset_period', p_reset_period), null, null);
end;
$$;

revoke all on function public.app_settings(uuid) from public, anon;
revoke all on function public.settings_overview(uuid) from public, anon;
revoke all on function public.save_setting(text, text, jsonb, uuid, text) from public, anon;
revoke all on function public.numbering_overview() from public, anon;
revoke all on function public.configure_document_numbering(text, text, integer, text) from public, anon;
grant execute on function public.app_settings(uuid) to authenticated;
grant execute on function public.settings_overview(uuid) to authenticated;
grant execute on function public.save_setting(text, text, jsonb, uuid, text) to authenticated;
grant execute on function public.numbering_overview() to authenticated;
grant execute on function public.configure_document_numbering(text, text, integer, text) to authenticated;

commit;
