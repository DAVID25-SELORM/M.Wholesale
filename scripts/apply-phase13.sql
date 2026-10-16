-- Apply Phase 13 (accounting ledger and bank reconciliation) to the hosted database in ONE atomic paste: the Phase 13 migrations, verbatim, inside a single transaction.
-- Run it once in the Supabase SQL editor. If anything fails, nothing is changed. Nothing posts to the ledger until the owner starts accounting in the app.
begin;

-- ===== migration 20261022000200_phase13_permissions =====
-- Phase 13 / 01: permissions for the accounting ledger and bank reconciliation
--
--   accounting.view    see the chart of accounts, journals, trial balance, profit and loss, balance sheet, account ledgers and the control checks
--   accounting.manage  edit the chart of accounts, start accounting (go-live date and opening balances), lock a closed period
--   journals.create    post and reverse manual journals
--   bank.view          see bank accounts, imported statements and reconciliations
--   bank.reconcile     add bank accounts, import statements, match, book bank charges and interest, finish a reconciliation

insert into public.permissions (code, module, action, description) values
  ('accounting.view',   'accounting', 'view',      'View the ledger, journals and financial statements'),
  ('accounting.manage', 'accounting', 'manage',    'Manage the chart of accounts, opening balances and period lock'),
  ('journals.create',   'journals',   'create',    'Post and reverse manual journals'),
  ('bank.view',         'bank',       'view',      'View bank accounts, statements and reconciliations'),
  ('bank.reconcile',    'bank',       'reconcile', 'Import statements and reconcile bank accounts')
on conflict (code) do update set description = excluded.description;

-- Separation of duties: the accounts officer prepares bank reconciliations but cannot post journals; only the accounts manager (and the owner roles) can do both.
with matrix(role_code, code) as (values
  ('SUPER_ADMIN','accounting.view'),('SUPER_ADMIN','accounting.manage'),('SUPER_ADMIN','journals.create'),('SUPER_ADMIN','bank.view'),('SUPER_ADMIN','bank.reconcile'),
  ('OWNER','accounting.view'),('OWNER','accounting.manage'),('OWNER','journals.create'),('OWNER','bank.view'),('OWNER','bank.reconcile'),
  ('GENERAL_MANAGER','accounting.view'),('GENERAL_MANAGER','accounting.manage'),('GENERAL_MANAGER','bank.view'),
  ('ACCOUNTS_MANAGER','accounting.view'),('ACCOUNTS_MANAGER','accounting.manage'),('ACCOUNTS_MANAGER','journals.create'),('ACCOUNTS_MANAGER','bank.view'),('ACCOUNTS_MANAGER','bank.reconcile'),
  ('ACCOUNTS_OFFICER','accounting.view'),('ACCOUNTS_OFFICER','bank.view'),('ACCOUNTS_OFFICER','bank.reconcile'),
  ('AUDITOR','accounting.view'),('AUDITOR','bank.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, pm.id
from matrix m
join public.roles r on r.organization_id is null and r.code = m.role_code
join public.permissions pm on pm.code = m.code
on conflict do nothing;

-- ===== migration 20261022000300_accounting_ledger =====
-- Phase 13 / 02: the accounting ledger
--
-- A double-entry general ledger kept alongside the operational records. Nothing posts until the owner STARTS ACCOUNTING (go-live date + opening balances, see
-- the next migration), so existing data and every existing screen behave exactly as before.
--
--   CHART OF ACCOUNTS  a standard wholesale-pharmacy chart is created for every organization; the accountant edits names and adds accounts. Accounts the system
--                      posts to (receivables, inventory, payables, sales ...) are SYSTEM accounts: they can be renamed but not removed or retyped, and nobody can
--                      post to the control accounts by hand (that would make the ledger disagree with the customer, stock and supplier records).
--   JOURNALS           append-only (even the table owner cannot edit or delete): a mistake is corrected by a reversing journal. Every journal balances; this is enforced
--                      by the database at commit. Journals come from the operational documents automatically, in the same transaction, so the books cannot miss an event:
--        sales invoice               Dr Receivables          Cr Sales, Cr VAT output
--        credit note                 Dr Sales returns, Dr VAT output     Cr Receivables
--        customer receipt            Dr Cash / Mobile money / Bank / Card clearing     Cr Receivables
--        customer refund             Dr Receivables          Cr Cash / Mobile money / Bank / Card clearing
--        stock movements (by document, valued at batch cost, so the ledger ties to the stock records)
--            goods received          Dr Inventory            Cr Goods received not invoiced
--            sale / sale return / reversals     Dr Cost of goods sold <-> Cr Inventory (in the direction of the stock movement)
--            adjustment / write-off  Dr Stock adjustments <-> Cr Inventory
--            return to supplier      Dr Supplier returns awaiting credit   Cr Inventory
--            opening stock after go-live   Dr Inventory  Cr Opening balance equity
--        supplier invoice approved   Dr Goods received not invoiced (at order cost), Dr/Cr Purchase price variance, Dr VAT input     Cr Payables
--        supplier invoice paid       Dr Payables             Cr Bank
--        supplier credit recorded    Dr Payables             Cr Supplier returns awaiting credit (and price variance)
--      Reversals (reversed invoices and credit notes, voided receipts, cancelled supplier invoices) post the mirror journal on the day they happen.
--   PERIOD LOCK        'locked through' date: manual journals cannot be dated in a locked period; an automatic journal for a document dated inside it is posted on the
--                      first open day instead, so a closed month never changes.
--   REPORTS            trial balance, profit and loss, balance sheet, account ledger, and control checks (ledger vs the customer, stock and supplier records).
--
-- Documents dated before the go-live date are not journalled (the opening balances carry them). Everything is in the organization's base currency.

-- ---------------------------------------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------------------------------------
create table public.gl_accounts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict default private.current_organization_id(),
  code             text not null check (code ~ '^[A-Za-z0-9.-]{2,12}$'),
  name             text not null check (length(btrim(name)) between 2 and 120),
  account_type     text not null check (account_type in ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  normal_side      text not null check (normal_side in ('DEBIT', 'CREDIT')),
  system_key       text check (system_key is null or system_key ~ '^[A-Z_]{2,30}$'),
  is_system        boolean not null default false,
  allow_manual     boolean not null default true,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint gl_accounts_code_key unique (organization_id, code),
  constraint gl_accounts_id_org_key unique (id, organization_id),
  constraint gl_accounts_system_key_key unique (organization_id, system_key),
  constraint gl_accounts_system_has_key check (is_system = (system_key is not null))
);
create trigger gl_accounts_immutable before update on public.gl_accounts
  for each row execute function private.prevent_column_change('organization_id', 'system_key', 'is_system');
create trigger gl_accounts_set_updated_at before update on public.gl_accounts
  for each row execute function private.set_updated_at();
create trigger gl_accounts_audit after insert or update on public.gl_accounts
  for each row execute function private.audit_row_change('gl_account');
create trigger gl_accounts_no_delete before delete on public.gl_accounts
  for each row execute function private.stock_block_mutation();

create table public.accounting_settings (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null unique references public.organizations (id) on delete restrict default private.current_organization_id(),
  go_live_date     date not null,
  locked_through   date,
  started_by       uuid default auth.uid(),
  started_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint accounting_settings_lock_after_golive check (locked_through is null or locked_through >= go_live_date - 1)
);
create trigger accounting_settings_immutable before update on public.accounting_settings
  for each row execute function private.prevent_column_change('organization_id', 'go_live_date', 'started_by', 'started_at');
create trigger accounting_settings_set_updated_at before update on public.accounting_settings
  for each row execute function private.set_updated_at();
create trigger accounting_settings_audit after insert or update on public.accounting_settings
  for each row execute function private.audit_row_change('accounting_settings');
create trigger accounting_settings_no_delete before delete on public.accounting_settings
  for each row execute function private.stock_block_mutation();

create table public.gl_journals (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete restrict,
  journal_number       text not null,
  journal_date         date not null,
  source_type          text not null check (source_type in (
                         'OPENING', 'MANUAL', 'REVERSAL', 'BANK_ENTRY', 'SALES_INVOICE', 'CREDIT_NOTE', 'RECEIPT', 'REFUND', 'STOCK_DOCUMENT',
                         'SUPPLIER_INVOICE', 'PURCHASE_RETURN')),
  source_id            uuid,
  event                text not null default 'POST' check (event in ('POST', 'REVERSE', 'APPROVE', 'PAY', 'CANCEL', 'CREDIT')),
  description          text not null check (length(description) between 3 and 300),
  reason               text check (reason is null or length(reason) <= 500),
  branch_id            uuid,
  reverses_journal_id  uuid,
  created_by           uuid default auth.uid(),
  created_at           timestamptz not null default now(),
  constraint gl_journals_number_key unique (organization_id, journal_number),
  constraint gl_journals_id_org_key unique (id, organization_id),
  constraint gl_journals_branch_fk foreign key (branch_id, organization_id) references public.branches (id, organization_id) on delete restrict,
  constraint gl_journals_reverses_fk foreign key (reverses_journal_id, organization_id) references public.gl_journals (id, organization_id) on delete restrict
);
create unique index gl_journals_source_key on public.gl_journals (source_type, source_id, event) where source_id is not null;
create unique index gl_journals_reverses_key on public.gl_journals (reverses_journal_id) where reverses_journal_id is not null;
create index gl_journals_org_date_idx on public.gl_journals (organization_id, journal_date desc, created_at desc, id desc);
create index gl_journals_branch_idx on public.gl_journals (organization_id, branch_id, journal_date desc);
create trigger gl_journals_audit after insert on public.gl_journals
  for each row when (new.source_type in ('OPENING', 'MANUAL', 'REVERSAL', 'BANK_ENTRY'))
  execute function private.audit_row_change('gl_journal');

create table public.gl_journal_lines (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  journal_id       uuid not null,
  line_no          integer not null,
  account_id       uuid not null,
  journal_date     date not null,
  branch_id        uuid,
  debit            numeric(16, 2) not null default 0 check (debit >= 0),
  credit           numeric(16, 2) not null default 0 check (credit >= 0),
  memo             text check (memo is null or length(memo) <= 300),
  constraint gl_journal_lines_one_side check ((debit = 0) <> (credit = 0)),
  constraint gl_journal_lines_journal_fk foreign key (journal_id, organization_id) references public.gl_journals (id, organization_id) on delete restrict,
  constraint gl_journal_lines_account_fk foreign key (account_id, organization_id) references public.gl_accounts (id, organization_id) on delete restrict,
  constraint gl_journal_lines_branch_fk foreign key (branch_id, organization_id) references public.branches (id, organization_id) on delete restrict,
  constraint gl_journal_lines_line_key unique (journal_id, line_no),
  constraint gl_journal_lines_id_org_key unique (id, organization_id)
);
create index gl_journal_lines_account_idx on public.gl_journal_lines (organization_id, account_id, journal_date);
create index gl_journal_lines_branch_idx on public.gl_journal_lines (organization_id, branch_id, journal_date);

-- evidence: nobody, including the table owner, edits or deletes a journal
create trigger gl_journals_append_only before update or delete on public.gl_journals
  for each row execute function private.stock_block_mutation();
create trigger gl_journals_no_truncate before truncate on public.gl_journals
  for each statement execute function private.stock_block_mutation();
create trigger gl_journal_lines_append_only before update or delete on public.gl_journal_lines
  for each row execute function private.stock_block_mutation();
create trigger gl_journal_lines_no_truncate before truncate on public.gl_journal_lines
  for each statement execute function private.stock_block_mutation();

-- every journal balances, checked at commit once all its lines are in
create function private.gl_check_balanced()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_diff numeric;
begin
  select coalesce(sum(debit), 0) - coalesce(sum(credit), 0) into v_diff from public.gl_journal_lines where journal_id = new.journal_id;
  if v_diff <> 0 then
    raise exception 'journal does not balance (debits differ from credits by %)', v_diff using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger gl_journal_lines_balanced after insert on public.gl_journal_lines
  deferrable initially deferred for each row execute function private.gl_check_balanced();

-- ---------------------------------------------------------------------------------------------------------
-- row-level security: read-only for users; all writes go through the checked functions below
-- ---------------------------------------------------------------------------------------------------------
alter table public.gl_accounts enable row level security;
alter table public.accounting_settings enable row level security;
alter table public.gl_journals enable row level security;
alter table public.gl_journal_lines enable row level security;

create policy gl_accounts_select on public.gl_accounts for select to authenticated
  using (organization_id = (select private.current_organization_id()) and (select private.has_permission_anywhere('accounting.view')));
create policy accounting_settings_select on public.accounting_settings for select to authenticated
  using (organization_id = (select private.current_organization_id()) and (select private.has_permission_anywhere('accounting.view')));
create policy gl_journals_select on public.gl_journals for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and ((select private.has_permission('accounting.view')) or branch_id in (select private.permitted_branches('accounting.view'))));
create policy gl_journal_lines_select on public.gl_journal_lines for select to authenticated
  using (organization_id = (select private.current_organization_id())
         and ((select private.has_permission('accounting.view')) or branch_id in (select private.permitted_branches('accounting.view'))));

revoke all on public.gl_accounts, public.accounting_settings, public.gl_journals, public.gl_journal_lines from public, anon, authenticated;
grant select on public.gl_accounts, public.accounting_settings, public.gl_journals, public.gl_journal_lines to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- the standard chart of accounts
-- ---------------------------------------------------------------------------------------------------------
create function private.gl_seed_chart(p_org uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.gl_accounts (organization_id, code, name, account_type, normal_side, system_key, is_system, allow_manual)
  select p_org, v.code, v.name, v.account_type, v.normal_side, v.system_key, v.system_key is not null, v.allow_manual
  from (values
    ('1000', 'Cash on hand',                            'ASSET',     'DEBIT',  'CASH',              true),
    ('1010', 'Main bank account',                       'ASSET',     'DEBIT',  'BANK',              true),
    ('1020', 'Mobile money wallet',                     'ASSET',     'DEBIT',  'MOBILE_MONEY',      true),
    ('1030', 'Card settlements (not yet banked)',       'ASSET',     'DEBIT',  'CARD_CLEARING',     true),
    ('1100', 'Accounts receivable (customers)',         'ASSET',     'DEBIT',  'AR',                false),
    ('1200', 'Inventory',                               'ASSET',     'DEBIT',  'INVENTORY',         false),
    ('1300', 'VAT input (recoverable)',                 'ASSET',     'DEBIT',  'VAT_INPUT',         true),
    ('1400', 'Supplier returns awaiting credit',        'ASSET',     'DEBIT',  'SUPPLIER_RETURNS',  false),
    ('2000', 'Accounts payable (suppliers)',            'LIABILITY', 'CREDIT', 'AP',                false),
    ('2010', 'Goods received not invoiced',             'LIABILITY', 'CREDIT', 'GRNI',              false),
    ('2100', 'VAT output (payable)',                    'LIABILITY', 'CREDIT', 'VAT_OUTPUT',        true),
    ('3000', 'Owner''s capital',                        'EQUITY',    'CREDIT', null,               true),
    ('3100', 'Opening balance equity',                  'EQUITY',    'CREDIT', 'OPENING_EQUITY',    true),
    ('3200', 'Retained earnings',                       'EQUITY',    'CREDIT', 'RETAINED',          true),
    ('4000', 'Sales',                                   'REVENUE',   'CREDIT', 'SALES',             false),
    ('4100', 'Sales returns and allowances',            'REVENUE',   'DEBIT',  'SALES_RETURNS',     false),
    ('4900', 'Other income',                            'REVENUE',   'CREDIT', null,               true),
    ('5000', 'Cost of goods sold',                      'EXPENSE',   'DEBIT',  'COGS',              false),
    ('5100', 'Stock adjustments and write-offs',        'EXPENSE',   'DEBIT',  'STOCK_ADJUSTMENTS', true),
    ('5200', 'Purchase price variance',                 'EXPENSE',   'DEBIT',  'PURCHASE_VARIANCE', true),
    ('5900', 'Rounding differences',                    'EXPENSE',   'DEBIT',  'ROUNDING',          true),
    ('6000', 'Salaries and wages',                      'EXPENSE',   'DEBIT',  null,               true),
    ('6100', 'Rent',                                    'EXPENSE',   'DEBIT',  null,               true),
    ('6200', 'Utilities',                               'EXPENSE',   'DEBIT',  null,               true),
    ('6300', 'Transport and delivery',                  'EXPENSE',   'DEBIT',  null,               true),
    ('6400', 'Bank charges',                            'EXPENSE',   'DEBIT',  'BANK_CHARGES',      true),
    ('6900', 'Other expenses',                          'EXPENSE',   'DEBIT',  null,               true)
  ) as v(code, name, account_type, normal_side, system_key, allow_manual)
  on conflict do nothing;
end;
$$;
revoke all on function private.gl_seed_chart(uuid) from public, anon, authenticated;

create function private.organizations_default_chart()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.gl_seed_chart(new.id);
  return null;
end;
$$;
create trigger organizations_default_chart after insert on public.organizations
  for each row execute function private.organizations_default_chart();

select private.gl_seed_chart(o.id) from public.organizations o;

-- ---------------------------------------------------------------------------------------------------------
-- posting engine (private: only the triggers and the checked functions below use it)
-- ---------------------------------------------------------------------------------------------------------
create function private.gl_acct(p_org uuid, p_key text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.gl_accounts where organization_id = p_org and system_key = p_key;
  if v_id is null then
    raise exception 'accounting: system account % is missing from the chart of accounts', p_key using errcode = '23514';
  end if;
  return v_id;
end;
$$;

create function private.gl_ln(p_org uuid, p_key text, p_amount numeric, p_memo text default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('account_id', private.gl_acct(p_org, p_key), 'amount', p_amount, 'memo', p_memo)
$$;

create function private.gl_negate(p_lines jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_set(e, '{amount}', to_jsonb(-(e ->> 'amount')::numeric))), '[]'::jsonb) from jsonb_array_elements(p_lines) e
$$;

-- money received or paid by a method lands in its own account; bank transfers and cheques go to the default bank account (next migration)
create function private.gl_method_key(p_method text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_method when 'CASH' then 'CASH' when 'MOBILE_MONEY' then 'MOBILE_MONEY' when 'CARD' then 'CARD_CLEARING' else 'BANK' end
$$;

-- p_lines: [{account_id, amount (positive = debit, negative = credit), memo, branch_id}]. Writes one balanced journal, once per (source, event).
create function private.gl_post(
  p_org uuid, p_date date, p_source_type text, p_source_id uuid, p_event text, p_description text, p_branch uuid, p_lines jsonb, p_reason text default null,
  p_reverses uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lock    date;
  v_date    date := p_date;
  v_total   numeric;
  v_journal uuid;
  v_lines   jsonb := p_lines;
begin
  if p_source_id is not null and exists (select 1 from public.gl_journals where source_type = p_source_type and source_id = p_source_id and event = p_event) then
    return null;
  end if;
  select locked_through into v_lock from public.accounting_settings where organization_id = p_org;
  if v_lock is not null and v_date <= v_lock then
    v_date := v_lock + 1;
  end if;

  select coalesce(sum(round((e ->> 'amount')::numeric, 2)), 0) into v_total from jsonb_array_elements(v_lines) e;
  if v_total <> 0 then
    if abs(v_total) > 0.05 then
      raise exception 'accounting: journal for % does not balance (off by %)', p_description, v_total using errcode = '23514';
    end if;
    v_lines := v_lines || jsonb_build_array(private.gl_ln(p_org, 'ROUNDING', -v_total, 'Rounding'));
  end if;
  if not exists (select 1 from jsonb_array_elements(v_lines) e where round((e ->> 'amount')::numeric, 2) <> 0) then
    return null;
  end if;

  insert into public.gl_journals (organization_id, journal_number, journal_date, source_type, source_id, event, description, reason, branch_id, reverses_journal_id)
  values (p_org, private.generate_document_number(p_org, null, 'JOURNAL', 'JV'), v_date, p_source_type, p_source_id, p_event, left(p_description, 300), p_reason, p_branch, p_reverses)
  returning id into v_journal;

  insert into public.gl_journal_lines (organization_id, journal_id, line_no, account_id, journal_date, branch_id, debit, credit, memo)
  select p_org, v_journal, row_number() over (order by ord), (e ->> 'account_id')::uuid, v_date, coalesce((e ->> 'branch_id')::uuid, p_branch),
         greatest(round((e ->> 'amount')::numeric, 2), 0), greatest(-round((e ->> 'amount')::numeric, 2), 0), left(e ->> 'memo', 300)
  from jsonb_array_elements(v_lines) with ordinality as t(e, ord)
  where round((e ->> 'amount')::numeric, 2) <> 0;
  return v_journal;
end;
$$;
revoke all on function private.gl_post(uuid, date, text, uuid, text, text, uuid, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function private.gl_acct(uuid, text) from public, anon, authenticated;
revoke all on function private.gl_ln(uuid, text, numeric, text) from public, anon, authenticated;
revoke all on function private.gl_negate(jsonb) from public, anon, authenticated;
revoke all on function private.gl_method_key(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- capture: one deferred trigger per operational document (deferred so every figure is final when it runs)
-- ---------------------------------------------------------------------------------------------------------
create function private.gl_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind    text := tg_argv[0];
  v_org     uuid := new.organization_id;
  v_go      date;
  v_date    date;
  v_event   text := 'POST';
  v_desc    text;
  v_branch  uuid;
  v_lines   jsonb;
  v_flip    boolean := false;
  v_delta   numeric;
  v_counter text;
  v_grni    numeric;
  v_cost    numeric;
begin
  select go_live_date into v_go from public.accounting_settings where organization_id = v_org;
  if v_go is null then
    return null;
  end if;

  if v_kind = 'SALES_INVOICE' then
    v_flip := new.status = 'REVERSED';
    v_event := case when v_flip then 'REVERSE' else 'POST' end;
    v_date := case when v_flip then coalesce(new.reversed_at::date, current_date) else new.invoice_date end;
    v_desc := case when v_flip then 'Reversal of invoice ' else 'Invoice ' end || new.invoice_number;
    v_branch := new.branch_id;
    v_lines := jsonb_build_array(private.gl_ln(v_org, 'AR', new.total_amount), private.gl_ln(v_org, 'SALES', -new.subtotal), private.gl_ln(v_org, 'VAT_OUTPUT', -new.tax_total));

  elsif v_kind = 'CREDIT_NOTE' then
    v_flip := new.status = 'REVERSED';
    v_event := case when v_flip then 'REVERSE' else 'POST' end;
    v_date := case when v_flip then coalesce(new.reversed_at::date, current_date) else new.credit_date end;
    v_desc := case when v_flip then 'Reversal of credit note ' else 'Credit note ' end || new.credit_note_number;
    v_branch := new.branch_id;
    v_lines := jsonb_build_array(private.gl_ln(v_org, 'SALES_RETURNS', new.subtotal), private.gl_ln(v_org, 'VAT_OUTPUT', new.tax_total), private.gl_ln(v_org, 'AR', -new.total_amount));

  elsif v_kind = 'RECEIPT' then
    v_flip := new.status = 'VOID';
    v_event := case when v_flip then 'REVERSE' else 'POST' end;
    v_date := case when v_flip then coalesce(new.voided_at::date, current_date) else new.receipt_date end;
    v_desc := case when v_flip then 'Void of receipt ' else 'Receipt ' end || new.receipt_number;
    v_branch := new.branch_id;
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', case private.gl_method_key(new.method) when 'BANK' then private.gl_default_bank(v_org) else private.gl_acct(v_org, private.gl_method_key(new.method)) end,
                         'amount', new.amount, 'memo', new.method),
      private.gl_ln(v_org, 'AR', -new.amount));

  elsif v_kind = 'REFUND' then
    v_date := new.refund_date;
    v_desc := 'Refund ' || new.refund_number;
    v_branch := new.branch_id;
    v_lines := jsonb_build_array(
      private.gl_ln(v_org, 'AR', new.amount),
      jsonb_build_object('account_id', case private.gl_method_key(new.method) when 'BANK' then private.gl_default_bank(v_org) else private.gl_acct(v_org, private.gl_method_key(new.method)) end,
                         'amount', -new.amount, 'memo', new.method));

  elsif v_kind = 'STOCK_DOCUMENT' then
    v_counter := case new.document_type
      when 'OPENING' then 'OPENING_EQUITY' when 'RECEIPT' then 'GRNI' when 'ADJUSTMENT' then 'STOCK_ADJUSTMENTS' when 'RETURN' then 'SUPPLIER_RETURNS'
      when 'SALE' then 'COGS' when 'SALE_RETURN' then 'COGS' when 'SALE_REVERSAL' then 'COGS' when 'SALE_RETURN_REVERSAL' then 'COGS' else null end;
    if v_counter is null then
      return null;                       -- transfers and status changes move stock without changing its value
    end if;
    select round(coalesce(sum(m.quantity * coalesce(bc.unit_cost_base, 0)), 0), 2) into v_delta
    from public.stock_movements m left join public.batch_costs bc on bc.batch_id = m.batch_id
    where m.document_id = new.id;
    v_date := new.posted_at::date;
    v_desc := 'Stock ' || lower(replace(new.document_type, '_', ' ')) || ' ' || new.document_number;
    v_branch := new.branch_id;
    v_lines := jsonb_build_array(private.gl_ln(v_org, 'INVENTORY', v_delta), private.gl_ln(v_org, v_counter, -v_delta));

  elsif v_kind = 'SUPPLIER_INVOICE' then
    v_branch := new.branch_id;
    if new.status = 'APPROVED' then
      v_event := 'APPROVE';
      v_date := coalesce(new.approved_at::date, current_date);
      v_desc := 'Supplier invoice ' || new.invoice_number || ' approved';
      select coalesce(sum(round(l.quantity * coalesce(l.po_unit_cost, l.unit_price), 2)), 0) into v_grni from public.supplier_invoice_lines l where l.supplier_invoice_id = new.id;
      v_lines := jsonb_build_array(
        private.gl_ln(v_org, 'GRNI', v_grni), private.gl_ln(v_org, 'PURCHASE_VARIANCE', new.subtotal - v_grni), private.gl_ln(v_org, 'VAT_INPUT', new.tax_amount),
        private.gl_ln(v_org, 'AP', -new.total_amount));
    elsif new.status = 'PAID' then
      v_event := 'PAY';
      v_date := new.paid_on;
      v_desc := 'Supplier invoice ' || new.invoice_number || ' paid';
      v_lines := jsonb_build_array(
        private.gl_ln(v_org, 'AP', new.total_amount),
        jsonb_build_object('account_id', private.gl_default_bank(v_org), 'amount', -new.total_amount, 'memo', new.payment_reference));
    else   -- CANCELLED after approval: the approval journal reversed
      v_event := 'CANCEL';
      v_date := current_date;
      v_desc := 'Supplier invoice ' || new.invoice_number || ' cancelled';
      select coalesce(sum(round(l.quantity * coalesce(l.po_unit_cost, l.unit_price), 2)), 0) into v_grni from public.supplier_invoice_lines l where l.supplier_invoice_id = new.id;
      v_lines := private.gl_negate(jsonb_build_array(
        private.gl_ln(v_org, 'GRNI', v_grni), private.gl_ln(v_org, 'PURCHASE_VARIANCE', new.subtotal - v_grni), private.gl_ln(v_org, 'VAT_INPUT', new.tax_amount),
        private.gl_ln(v_org, 'AP', -new.total_amount)));
    end if;

  elsif v_kind = 'PURCHASE_RETURN' then
    v_event := 'CREDIT';
    v_date := coalesce(new.credited_at::date, current_date);
    v_desc := 'Supplier credit for return ' || new.return_number;
    v_branch := new.branch_id;
    select round(coalesce(sum(rl.returned_base * rl.unit_cost_base), 0), 2) into v_cost from public.purchase_return_lines rl where rl.purchase_return_id = new.id;
    v_lines := jsonb_build_array(
      private.gl_ln(v_org, 'AP', new.credit_amount), private.gl_ln(v_org, 'SUPPLIER_RETURNS', -v_cost), private.gl_ln(v_org, 'PURCHASE_VARIANCE', -(new.credit_amount - v_cost)));
  end if;

  if v_date is null or v_date < v_go then
    return null;                         -- before go-live: carried by the opening balances
  end if;
  if v_flip then
    v_lines := private.gl_negate(v_lines);
  end if;
  perform private.gl_post(v_org, v_date, v_kind, new.id, v_event, v_desc, v_branch, v_lines);
  return null;
end;
$$;
revoke all on function private.gl_capture() from public, anon, authenticated;

create constraint trigger gl_capture_invoice_ins after insert on public.sales_invoices deferrable initially deferred for each row
  when (new.status = 'POSTED') execute function private.gl_capture('SALES_INVOICE');
create constraint trigger gl_capture_invoice_upd after update on public.sales_invoices deferrable initially deferred for each row
  when (old.status is distinct from new.status and new.status in ('POSTED', 'REVERSED')) execute function private.gl_capture('SALES_INVOICE');
create constraint trigger gl_capture_credit_note_ins after insert on public.sales_credit_notes deferrable initially deferred for each row
  when (new.status = 'POSTED') execute function private.gl_capture('CREDIT_NOTE');
create constraint trigger gl_capture_credit_note_upd after update on public.sales_credit_notes deferrable initially deferred for each row
  when (old.status is distinct from new.status and new.status in ('POSTED', 'REVERSED')) execute function private.gl_capture('CREDIT_NOTE');
create constraint trigger gl_capture_receipt_ins after insert on public.customer_receipts deferrable initially deferred for each row
  when (new.status = 'POSTED') execute function private.gl_capture('RECEIPT');
create constraint trigger gl_capture_receipt_upd after update on public.customer_receipts deferrable initially deferred for each row
  when (old.status = 'POSTED' and new.status = 'VOID') execute function private.gl_capture('RECEIPT');
create constraint trigger gl_capture_refund after insert on public.customer_refunds deferrable initially deferred for each row
  execute function private.gl_capture('REFUND');
create constraint trigger gl_capture_stock_document after insert on public.stock_documents deferrable initially deferred for each row
  execute function private.gl_capture('STOCK_DOCUMENT');
create constraint trigger gl_capture_supplier_invoice after update on public.supplier_invoices deferrable initially deferred for each row
  when (old.status is distinct from new.status and (new.status in ('APPROVED', 'PAID') or (new.status = 'CANCELLED' and old.status = 'APPROVED')))
  execute function private.gl_capture('SUPPLIER_INVOICE');
create constraint trigger gl_capture_purchase_return after update on public.purchase_returns deferrable initially deferred for each row
  when (old.credit_status = 'PENDING' and new.credit_status = 'CREDITED') execute function private.gl_capture('PURCHASE_RETURN');

-- ===== migration 20261022000400_accounting_functions =====
-- Phase 13 / 03: bank accounts, starting accounting, chart of accounts, manual journals, period lock, financial statements, control checks
--
-- START ACCOUNTING  `start_accounting(go_live_date, opening_balances)`: the owner picks the go-live date and types the opening balances of the real-world accounts (cash, bank,
--                   mobile money, VAT, capital ...). `suggest_opening_balances()` fills in receivables, inventory and payables from the operational records. The
--                   balancing figure goes to "Opening balance equity", so the opening journal always balances. Done once; journals start from that date.
-- MANUAL JOURNALS  for what the documents do not cover (salaries, rent, utilities, owner's drawings ...). Never to the control accounts. Corrected only by reversal.
-- BANK ACCOUNTS    a bank account (or mobile-money wallet) is a ledger account plus its statement details; the default one receives bank transfers, cheques
--                   and supplier payments. Reconciliation is in the next migration.

-- ---------------------------------------------------------------------------------------------------------
-- bank tables
-- ---------------------------------------------------------------------------------------------------------
create table public.bank_accounts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete restrict default private.current_organization_id(),
  gl_account_id    uuid not null,
  name             text not null check (length(btrim(name)) between 2 and 120),
  bank_name        text check (bank_name is null or length(bank_name) <= 120),
  account_ref      text check (account_ref is null or length(account_ref) <= 40),
  is_default       boolean not null default false,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint bank_accounts_gl_fk foreign key (gl_account_id, organization_id) references public.gl_accounts (id, organization_id) on delete restrict,
  constraint bank_accounts_gl_key unique (organization_id, gl_account_id),
  constraint bank_accounts_id_org_key unique (id, organization_id)
);
create unique index bank_accounts_one_default on public.bank_accounts (organization_id) where is_default;
create trigger bank_accounts_immutable before update on public.bank_accounts
  for each row execute function private.prevent_column_change('organization_id', 'gl_account_id');
create trigger bank_accounts_set_updated_at before update on public.bank_accounts
  for each row execute function private.set_updated_at();
create trigger bank_accounts_audit after insert or update on public.bank_accounts
  for each row execute function private.audit_row_change('bank_account');
create trigger bank_accounts_no_delete before delete on public.bank_accounts
  for each row execute function private.stock_block_mutation();

create table public.bank_statements (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null default private.current_organization_id(),
  bank_account_id  uuid not null,
  period_from      date not null,
  period_to        date not null,
  opening_balance  numeric(16, 2) not null,
  closing_balance  numeric(16, 2) not null,
  file_name        text check (file_name is null or length(file_name) <= 200),
  status           text not null default 'OPEN' check (status in ('OPEN', 'RECONCILED')),
  imported_by      uuid default auth.uid(),
  imported_at      timestamptz not null default now(),
  reconciled_by    uuid,
  reconciled_at    timestamptz,
  constraint bank_statements_period check (period_from <= period_to),
  constraint bank_statements_reconciled_complete check ((status = 'RECONCILED') = (reconciled_at is not null and reconciled_by is not null)),
  constraint bank_statements_account_fk foreign key (bank_account_id, organization_id) references public.bank_accounts (id, organization_id) on delete restrict,
  constraint bank_statements_id_org_key unique (id, organization_id)
);
create index bank_statements_account_idx on public.bank_statements (bank_account_id, period_to desc);
create trigger bank_statements_audit after insert or update on public.bank_statements
  for each row execute function private.audit_row_change('bank_statement');
create trigger bank_statements_no_delete before delete on public.bank_statements
  for each row execute function private.stock_block_mutation();

create table public.bank_statement_lines (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null default private.current_organization_id(),
  statement_id     uuid not null,
  bank_account_id  uuid not null,
  line_no          integer not null,
  txn_date         date not null,
  description      text check (description is null or length(description) <= 300),
  reference        text check (reference is null or length(reference) <= 100),
  amount           numeric(16, 2) not null check (amount <> 0),
  matched          boolean not null default false,
  created_at       timestamptz not null default now(),
  constraint bank_statement_lines_statement_fk foreign key (statement_id, organization_id) references public.bank_statements (id, organization_id) on delete restrict,
  constraint bank_statement_lines_line_key unique (statement_id, line_no),
  constraint bank_statement_lines_id_org_key unique (id, organization_id)
);
create index bank_statement_lines_account_idx on public.bank_statement_lines (bank_account_id, txn_date);
create trigger bank_statement_lines_no_delete before delete on public.bank_statement_lines
  for each row execute function private.stock_block_mutation();

-- a ledger line cleared against a statement line, or cleared on its own with a note (opening balances, reversed entries)
create table public.bank_matches (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null default private.current_organization_id(),
  bank_account_id    uuid not null,
  journal_line_id    uuid not null,
  statement_line_id  uuid,
  note               text check (note is null or length(note) <= 300),
  matched_by         uuid default auth.uid(),
  matched_at         timestamptz not null default now(),
  constraint bank_matches_line_key unique (journal_line_id),
  constraint bank_matches_journal_line_fk foreign key (journal_line_id, organization_id) references public.gl_journal_lines (id, organization_id) on delete restrict,
  constraint bank_matches_statement_line_fk foreign key (statement_line_id, organization_id) references public.bank_statement_lines (id, organization_id) on delete restrict,
  constraint bank_matches_account_fk foreign key (bank_account_id, organization_id) references public.bank_accounts (id, organization_id) on delete restrict,
  constraint bank_matches_cleared_has_note check (statement_line_id is not null or note is not null)
);
create index bank_matches_statement_line_idx on public.bank_matches (statement_line_id) where statement_line_id is not null;
create index bank_matches_account_idx on public.bank_matches (bank_account_id);
create trigger bank_matches_audit after insert or delete on public.bank_matches
  for each row execute function private.audit_row_change('bank_match');

alter table public.bank_accounts enable row level security;
alter table public.bank_statements enable row level security;
alter table public.bank_statement_lines enable row level security;
alter table public.bank_matches enable row level security;
create policy bank_accounts_select on public.bank_accounts for select to authenticated
  using (organization_id = (select private.current_organization_id()) and (select private.has_permission('bank.view')));
create policy bank_statements_select on public.bank_statements for select to authenticated
  using (organization_id = (select private.current_organization_id()) and (select private.has_permission('bank.view')));
create policy bank_statement_lines_select on public.bank_statement_lines for select to authenticated
  using (organization_id = (select private.current_organization_id()) and (select private.has_permission('bank.view')));
create policy bank_matches_select on public.bank_matches for select to authenticated
  using (organization_id = (select private.current_organization_id()) and (select private.has_permission('bank.view')));
revoke all on public.bank_accounts, public.bank_statements, public.bank_statement_lines, public.bank_matches from public, anon, authenticated;
grant select on public.bank_accounts, public.bank_statements, public.bank_statement_lines, public.bank_matches to authenticated;

-- every organization starts with its main bank account and mobile-money wallet (their ledger accounts exist already)
create function private.bank_seed(p_org uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.bank_accounts (organization_id, gl_account_id, name, is_default)
  select p_org, a.id, 'Main bank account', true from public.gl_accounts a where a.organization_id = p_org and a.system_key = 'BANK'
  on conflict do nothing;
  insert into public.bank_accounts (organization_id, gl_account_id, name, is_default)
  select p_org, a.id, 'Mobile money wallet', false from public.gl_accounts a where a.organization_id = p_org and a.system_key = 'MOBILE_MONEY'
  on conflict do nothing;
end;
$$;
revoke all on function private.bank_seed(uuid) from public, anon, authenticated;
create function private.organizations_default_bank()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.bank_seed(new.id);
  return null;
end;
$$;
-- trigger names fire alphabetically: the chart trigger ("..._chart") runs before this one
create trigger organizations_default_chart_bank after insert on public.organizations
  for each row execute function private.organizations_default_bank();
select private.bank_seed(o.id) from public.organizations o;

create function private.gl_default_bank(p_org uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select b.gl_account_id from public.bank_accounts b where b.organization_id = p_org and b.is_default and b.is_active),
    private.gl_acct(p_org, 'BANK'))
$$;
revoke all on function private.gl_default_bank(uuid) from public, anon, authenticated;

-- caller context: the organization, after checking an organization-wide right
create function private.gl_ctx(p_permission text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
begin
  if v_org is null or not private.has_permission(p_permission) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  return v_org;
end;
$$;
revoke all on function private.gl_ctx(text) from public, anon, authenticated;

-- what customers owe net of what they hold in credit (same definition as the receivables report), for one organization: written out with the organization filter
-- because these callers are SECURITY DEFINER and so bypass row-level security
create function private.gl_operational_ar(p_org uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select sum(i.balance_due) from public.sales_invoices i where i.organization_id = p_org and i.status = 'POSTED' and i.balance_due > 0), 0)
       - coalesce((select sum(r.unallocated_amount) from public.customer_receipts r where r.organization_id = p_org and r.status = 'POSTED' and r.unallocated_amount > 0), 0)
       - coalesce((select sum(n.unapplied_amount) from public.sales_credit_notes n where n.organization_id = p_org and n.status = 'POSTED' and n.unapplied_amount > 0), 0)
$$;
revoke all on function private.gl_operational_ar(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- chart of accounts
-- ---------------------------------------------------------------------------------------------------------
create function public.save_gl_account(p_id uuid, p_code text, p_name text, p_account_type text, p_is_active boolean default true)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.gl_ctx('accounting.manage');
  v_acc public.gl_accounts;
begin
  if p_code is null or p_name is null or p_account_type not in ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE') then
    raise exception 'code, name and a valid account type are required' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.gl_accounts (organization_id, code, name, account_type, normal_side, is_active)
    values (v_org, btrim(p_code), btrim(p_name), p_account_type, case when p_account_type in ('ASSET', 'EXPENSE') then 'DEBIT' else 'CREDIT' end, coalesce(p_is_active, true))
    returning id into p_id;
    return p_id;
  end if;
  select * into v_acc from public.gl_accounts where id = p_id and organization_id = v_org for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if p_account_type <> v_acc.account_type and (v_acc.is_system or exists (select 1 from public.gl_journal_lines where account_id = p_id)) then
    raise exception 'this account is a system account or already has postings: its type cannot change' using errcode = '23514';
  end if;
  if v_acc.is_system and not coalesce(p_is_active, true) then
    raise exception 'a system account cannot be deactivated' using errcode = '23514';
  end if;
  update public.gl_accounts set code = btrim(p_code), name = btrim(p_name), account_type = p_account_type, is_active = coalesce(p_is_active, true) where id = p_id;
  return p_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- starting accounting
-- ---------------------------------------------------------------------------------------------------------
create function public.suggest_opening_balances()
returns table (account_id uuid, code text, name text, suggested numeric, basis text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.gl_ctx('accounting.manage');
begin
  return query
  select a.id, a.code, a.name,
         case a.system_key
           when 'AR' then private.gl_operational_ar(v_org)
           when 'INVENTORY' then coalesce((select sum(sb.quantity * coalesce(bc.unit_cost_base, 0)) from public.stock_balances sb
                                           left join public.batch_costs bc on bc.batch_id = sb.batch_id where sb.organization_id = v_org), 0)
           when 'AP' then coalesce((select sum(si.total_amount) from public.supplier_invoices si where si.organization_id = v_org and si.status = 'APPROVED'), 0)
         end,
         case a.system_key
           when 'AR' then 'Customer balances today (invoices less receipts and credit notes)'
           when 'INVENTORY' then 'Stock on hand at batch cost'
           when 'AP' then 'Approved, unpaid supplier invoices'
         end
  from public.gl_accounts a
  where a.organization_id = v_org and a.system_key in ('AR', 'INVENTORY', 'AP')
  order by a.code;
end;
$$;

-- p_opening: [{account_id, debit, credit}] for the real accounts; the balancing figure goes to Opening balance equity
create function public.start_accounting(p_go_live date, p_opening jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.gl_ctx('accounting.manage');
  v_equity  uuid;
  v_lines   jsonb := '[]'::jsonb;
  v_total   numeric := 0;
  v_amt     numeric;
  e         jsonb;
  v_acc     uuid;
  v_journal uuid;
begin
  if exists (select 1 from public.accounting_settings where organization_id = v_org) then
    raise exception 'accounting has already been started' using errcode = '23505';
  end if;
  if p_go_live is null or p_go_live > current_date + 31 or p_go_live < current_date - 400 then
    raise exception 'choose a go-live date within the last 13 months or the next month' using errcode = '22023';
  end if;
  v_equity := private.gl_acct(v_org, 'OPENING_EQUITY');
  if p_opening is not null and jsonb_typeof(p_opening) <> 'array' then
    raise exception 'opening balances must be a list' using errcode = '22023';
  end if;
  for e in select * from jsonb_array_elements(coalesce(p_opening, '[]'::jsonb)) loop
    v_acc := (e ->> 'account_id')::uuid;
    if coalesce((e ->> 'debit')::numeric, 0) < 0 or coalesce((e ->> 'credit')::numeric, 0) < 0
       or (coalesce((e ->> 'debit')::numeric, 0) <> 0 and coalesce((e ->> 'credit')::numeric, 0) <> 0) then
      raise exception 'each opening balance is either a debit or a credit' using errcode = '22023';
    end if;
    if not exists (select 1 from public.gl_accounts where id = v_acc and organization_id = v_org and is_active) then
      raise exception 'unknown or inactive account in the opening balances' using errcode = '22023';
    end if;
    if v_acc = v_equity then
      continue;                            -- computed below
    end if;
    v_amt := round(coalesce((e ->> 'debit')::numeric, 0) - coalesce((e ->> 'credit')::numeric, 0), 2);
    v_total := v_total + v_amt;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_acc, 'amount', v_amt, 'memo', 'Opening balance'));
  end loop;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_equity, 'amount', -v_total, 'memo', 'Balancing figure'));

  insert into public.accounting_settings (organization_id, go_live_date) values (v_org, p_go_live);
  v_journal := private.gl_post(v_org, p_go_live, 'OPENING', null, 'POST', 'Opening balances at go-live', null, v_lines);
  if v_journal is not null then
    -- opening bank and wallet balances are the statement's starting point: cleared, not waiting for a statement line
    insert into public.bank_matches (organization_id, bank_account_id, journal_line_id, note)
    select v_org, b.id, l.id, 'Opening balance'
    from public.gl_journal_lines l join public.bank_accounts b on b.gl_account_id = l.account_id and b.organization_id = l.organization_id
    where l.journal_id = v_journal;
  end if;
  return v_journal;
end;
$$;

create function public.set_period_lock(p_through date, p_reason text default null)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.gl_ctx('accounting.manage');
  v_set public.accounting_settings;
begin
  select * into v_set from public.accounting_settings where organization_id = v_org for update;
  if not found then
    raise exception 'start accounting first' using errcode = '55000';
  end if;
  if p_through is null or p_through < v_set.go_live_date - 1 or p_through > current_date then
    raise exception 'the lock date must be between the day before go-live and today' using errcode = '22023';
  end if;
  if v_set.locked_through is not null and p_through < v_set.locked_through and length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'give a reason for reopening a locked period' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', coalesce(p_reason, ''), true);
  update public.accounting_settings set locked_through = p_through where organization_id = v_org;
  return p_through;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- manual journals
-- ---------------------------------------------------------------------------------------------------------
-- p_lines: [{account_id, debit, credit, memo}]
create function public.post_manual_journal(p_date date, p_description text, p_lines jsonb, p_branch_id uuid default null, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid := private.current_organization_id();
  v_set   public.accounting_settings;
  v_lines jsonb := '[]'::jsonb;
  e       jsonb;
  v_amt   numeric;
  v_sum   numeric := 0;
  v_acc   public.gl_accounts;
begin
  if v_org is null or not private.has_permission('journals.create', p_branch_id) then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if p_branch_id is not null and not exists (select 1 from public.branches where id = p_branch_id and organization_id = v_org) then
    raise exception 'unknown branch' using errcode = '22023';
  end if;
  select * into v_set from public.accounting_settings where organization_id = v_org;
  if not found then
    raise exception 'start accounting first' using errcode = '55000';
  end if;
  if p_date is null or p_date < v_set.go_live_date or p_date > current_date then
    raise exception 'the journal date must be between the go-live date and today' using errcode = '22023';
  end if;
  if v_set.locked_through is not null and p_date <= v_set.locked_through then
    raise exception 'that period is locked (through %)', v_set.locked_through using errcode = '55000';
  end if;
  if length(btrim(coalesce(p_description, ''))) < 3 then
    raise exception 'a description is required' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 2 and 60 then
    raise exception 'a journal needs between 2 and 60 lines' using errcode = '22023';
  end if;
  for e in select * from jsonb_array_elements(p_lines) loop
    select * into v_acc from public.gl_accounts where id = (e ->> 'account_id')::uuid and organization_id = v_org;
    if not found or not v_acc.is_active then
      raise exception 'unknown or inactive account in the journal' using errcode = '22023';
    end if;
    if not v_acc.allow_manual then
      raise exception 'account % % is a control account: it is posted by documents, not by hand', v_acc.code, v_acc.name using errcode = '23514';
    end if;
    if coalesce((e ->> 'debit')::numeric, 0) < 0 or coalesce((e ->> 'credit')::numeric, 0) < 0
       or (coalesce((e ->> 'debit')::numeric, 0) <> 0) = (coalesce((e ->> 'credit')::numeric, 0) <> 0) then
      raise exception 'each journal line is either a debit or a credit, and not zero' using errcode = '22023';
    end if;
    v_amt := round(coalesce((e ->> 'debit')::numeric, 0) - coalesce((e ->> 'credit')::numeric, 0), 2);
    v_sum := v_sum + v_amt;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_acc.id, 'amount', v_amt, 'memo', e ->> 'memo'));
  end loop;
  if v_sum <> 0 then
    raise exception 'the journal does not balance: debits differ from credits by %', v_sum using errcode = '23514';
  end if;
  return private.gl_post(v_org, p_date, 'MANUAL', null, 'POST', btrim(p_description), p_branch_id, v_lines, p_reason);
end;
$$;

create function public.reverse_journal(p_journal_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
  v_j   public.gl_journals;
  v_set public.accounting_settings;
  v_lines jsonb;
begin
  if v_org is null or not private.has_permission('journals.create') then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'give a reason for the reversal' using errcode = '22023';
  end if;
  select * into v_j from public.gl_journals where id = p_journal_id and organization_id = v_org;
  if not found then
    raise exception 'journal not found' using errcode = 'P0002';
  end if;
  if v_j.source_type not in ('MANUAL', 'BANK_ENTRY') then
    raise exception 'only manual and bank-entry journals can be reversed here; documents are reversed on the document itself' using errcode = '23514';
  end if;
  if exists (select 1 from public.gl_journals where reverses_journal_id = v_j.id) then
    raise exception 'this journal has already been reversed' using errcode = '23505';
  end if;
  select * into v_set from public.accounting_settings where organization_id = v_org;
  select jsonb_agg(jsonb_build_object('account_id', l.account_id, 'amount', l.credit - l.debit, 'memo', l.memo, 'branch_id', l.branch_id) order by l.line_no) into v_lines
  from public.gl_journal_lines l where l.journal_id = v_j.id;
  return private.gl_post(v_org, current_date, 'REVERSAL', v_j.id, 'REVERSE', 'Reversal of ' || v_j.journal_number || ': ' || v_j.description, v_j.branch_id, v_lines,
                         btrim(p_reason), v_j.id);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- financial statements (SECURITY INVOKER: row-level security decides which journals the caller sees, so a branch-scoped accountant gets that branch)
-- ---------------------------------------------------------------------------------------------------------
create function public.trial_balance(p_from date, p_to date, p_branch_id uuid default null)
returns table (account_id uuid, code text, name text, account_type text, normal_side text, opening numeric, period_debit numeric, period_credit numeric, closing numeric)
language sql
stable
set search_path = ''
as $$
  select a.id, a.code::text, a.name::text, a.account_type::text, a.normal_side::text,
         coalesce(sum(l.debit - l.credit) filter (where l.journal_date < p_from), 0),
         coalesce(sum(l.debit) filter (where l.journal_date >= p_from), 0),
         coalesce(sum(l.credit) filter (where l.journal_date >= p_from), 0),
         coalesce(sum(l.debit - l.credit), 0)
  from public.gl_accounts a
  left join public.gl_journal_lines l on l.account_id = a.id and l.organization_id = a.organization_id and l.journal_date <= p_to
                                      and (p_branch_id is null or l.branch_id = p_branch_id)
  where a.organization_id = (select private.current_organization_id()) and p_from <= p_to
  group by a.id
  order by a.code
$$;

create function public.income_statement(p_from date, p_to date, p_branch_id uuid default null)
returns table (account_id uuid, code text, name text, account_type text, amount numeric)
language sql
stable
set search_path = ''
as $$
  select a.id, a.code::text, a.name::text, a.account_type::text,
         case when a.account_type = 'REVENUE' then coalesce(sum(l.credit - l.debit), 0) else coalesce(sum(l.debit - l.credit), 0) end
  from public.gl_accounts a
  left join public.gl_journal_lines l on l.account_id = a.id and l.organization_id = a.organization_id and l.journal_date between p_from and p_to
                                      and (p_branch_id is null or l.branch_id = p_branch_id)
  where a.organization_id = (select private.current_organization_id()) and a.account_type in ('REVENUE', 'EXPENSE') and p_from <= p_to
  group by a.id
  order by a.code
$$;

create function public.balance_sheet(p_as_of date, p_branch_id uuid default null)
returns table (section text, account_id uuid, code text, name text, amount numeric)
language sql
stable
set search_path = ''
as $$
  with bal as (
    select a.id, a.code, a.name, a.account_type, coalesce(sum(l.debit - l.credit), 0) as net
    from public.gl_accounts a
    left join public.gl_journal_lines l on l.account_id = a.id and l.organization_id = a.organization_id and l.journal_date <= p_as_of
                                        and (p_branch_id is null or l.branch_id = p_branch_id)
    where a.organization_id = (select private.current_organization_id())
    group by a.id
  )
  select 'ASSET'::text, b.id, b.code::text, b.name::text, b.net from bal b where b.account_type = 'ASSET'
  union all
  select 'LIABILITY'::text, b.id, b.code::text, b.name::text, -b.net from bal b where b.account_type = 'LIABILITY'
  union all
  select 'EQUITY'::text, b.id, b.code::text, b.name::text, -b.net from bal b where b.account_type = 'EQUITY'
  union all
  select 'EQUITY'::text, null::uuid, ''::text, 'Profit to date (not yet closed to retained earnings)'::text, -coalesce(sum(b.net) filter (where b.account_type in ('REVENUE', 'EXPENSE')), 0) from bal b
  order by 1, 3
$$;

create function public.account_ledger(p_account_id uuid, p_from date, p_to date, p_branch_id uuid default null, p_limit integer default 2000)
returns table (line_id uuid, journal_id uuid, journal_date date, journal_number text, description text, memo text, debit numeric, credit numeric, running numeric)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_open numeric;
begin
  select coalesce(sum(l.debit - l.credit), 0) into v_open from public.gl_journal_lines l
  where l.account_id = p_account_id and l.journal_date < p_from and (p_branch_id is null or l.branch_id = p_branch_id);
  return query
  with rows as (
    select l.id as lid, l.journal_id as jid, l.journal_date as jd, j.journal_number as jn, j.description as jdesc, l.memo as lmemo, l.debit as d, l.credit as c,
           j.created_at as jc, l.line_no as ln
    from public.gl_journal_lines l join public.gl_journals j on j.id = l.journal_id and j.organization_id = l.organization_id
    where l.account_id = p_account_id and l.journal_date between p_from and p_to and (p_branch_id is null or l.branch_id = p_branch_id)
    order by l.journal_date, j.created_at, l.line_no
    limit greatest(1, least(coalesce(p_limit, 2000), 20000))
  ), all_rows as (
    select null::uuid as lid, null::uuid as jid, p_from as jd, null::text as jn, 'Opening balance'::text as jdesc, null::text as lmemo, 0::numeric as d, 0::numeric as c,
           'epoch'::timestamptz as jc, 0 as ln, v_open as run
    union all
    select r.lid, r.jid, r.jd, r.jn, r.jdesc, r.lmemo, r.d, r.c, r.jc, r.ln, v_open + sum(r.d - r.c) over (order by r.jd, r.jc, r.ln rows unbounded preceding)
    from rows r
  )
  select a.lid, a.jid, a.jd, a.jn, a.jdesc, a.lmemo, a.d, a.c, a.run from all_rows a order by a.jd, a.jc, a.ln;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- control checks: the ledger against the customer, stock and supplier records (a non-zero difference means something was posted outside the documents
-- or the opening balances were entered wrongly)
-- ---------------------------------------------------------------------------------------------------------
create function public.accounting_checks()
returns table (check_code text, label text, ledger numeric, operational numeric, difference numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.current_organization_id();
begin
  if v_org is null or not private.has_permission('accounting.view') then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;
  return query
  with led as (
    select a.system_key, coalesce(sum(l.debit - l.credit), 0) as bal
    from public.gl_accounts a left join public.gl_journal_lines l on l.account_id = a.id and l.organization_id = a.organization_id
    where a.organization_id = v_org group by a.system_key, a.id
  ), checks as (
    select 'AR'::text as code, 'Receivables: ledger vs customer balances'::text as lbl,
           (select coalesce(sum(bal), 0) from led where system_key = 'AR') as lg,
           private.gl_operational_ar(v_org) as op
    union all
    select 'INVENTORY', 'Inventory: ledger vs stock on hand at batch cost',
           (select coalesce(sum(bal), 0) from led where system_key = 'INVENTORY'),
           coalesce((select sum(sb.quantity * coalesce(bc.unit_cost_base, 0)) from public.stock_balances sb left join public.batch_costs bc on bc.batch_id = sb.batch_id
                     where sb.organization_id = v_org), 0)
    union all
    select 'AP', 'Payables: ledger vs approved, unpaid supplier invoices',
           -(select coalesce(sum(bal), 0) from led where system_key = 'AP'),
           coalesce((select sum(si.total_amount) from public.supplier_invoices si where si.organization_id = v_org and si.status = 'APPROVED'), 0)
    union all
    select 'TRIAL', 'Trial balance: total debits less total credits (always zero)',
           coalesce((select sum(l.debit - l.credit) from public.gl_journal_lines l where l.organization_id = v_org), 0), 0::numeric
  )
  select c.code, c.lbl, round(c.lg, 2), round(c.op, 2), round(c.lg - c.op, 2) from checks c;
end;
$$;

revoke all on function public.save_gl_account(uuid, text, text, text, boolean) from public, anon;
revoke all on function public.suggest_opening_balances() from public, anon;
revoke all on function public.start_accounting(date, jsonb) from public, anon;
revoke all on function public.set_period_lock(date, text) from public, anon;
revoke all on function public.post_manual_journal(date, text, jsonb, uuid, text) from public, anon;
revoke all on function public.reverse_journal(uuid, text) from public, anon;
revoke all on function public.trial_balance(date, date, uuid) from public, anon;
revoke all on function public.income_statement(date, date, uuid) from public, anon;
revoke all on function public.balance_sheet(date, uuid) from public, anon;
revoke all on function public.account_ledger(uuid, date, date, uuid, integer) from public, anon;
revoke all on function public.accounting_checks() from public, anon;
grant execute on function public.save_gl_account(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.suggest_opening_balances() to authenticated;
grant execute on function public.start_accounting(date, jsonb) to authenticated;
grant execute on function public.set_period_lock(date, text) to authenticated;
grant execute on function public.post_manual_journal(date, text, jsonb, uuid, text) to authenticated;
grant execute on function public.reverse_journal(uuid, text) to authenticated;
grant execute on function public.trial_balance(date, date, uuid) to authenticated;
grant execute on function public.income_statement(date, date, uuid) to authenticated;
grant execute on function public.balance_sheet(date, uuid) to authenticated;
grant execute on function public.account_ledger(uuid, date, date, uuid, integer) to authenticated;
grant execute on function public.accounting_checks() to authenticated;

-- ===== migration 20261022000500_bank_reconciliation =====
-- Phase 13 / 04: bank reconciliation
--
-- Import a bank (or mobile-money) statement, match each statement line to the ledger entry the system already made (a receipt, a supplier payment, a refund),
-- book what the bank did that the books do not know about (charges, interest, direct deposits), and finish when the difference is nil.
--
--   STATEMENT      imported with its opening and closing balance; opening + lines must equal closing, the opening must equal the previous statement's closing,
--                  and periods cannot overlap, so nothing is imported twice and nothing is skipped.
--   MATCHING       a statement line matches one or more ledger lines of the same bank account whose total equals it exactly. `suggest_bank_matches` proposes
--                  by amount, date and reference; `auto_match_statement` accepts only unambiguous pairs (same amount, within 3 days, nobody else could fit).
--   BANK ENTRIES   a statement line with no ledger entry (bank charges, interest) is booked against a chosen account and matched in one step.
--   CLEARING       ledger lines that will never appear on a statement (reversed entries, opening differences) are cleared with a note.
--   RECONCILIATION statement closing + deposits not yet on the statement - payments not yet on the statement = ledger balance + bank items not yet booked.
--                  Finish only when the difference is nil, every line is matched, and earlier statements are done; a finished statement is locked.

create function private.bank_ctx(p_bank_account_id uuid)
returns public.bank_accounts
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.gl_ctx('bank.reconcile');
  v_ba  public.bank_accounts;
begin
  select * into v_ba from public.bank_accounts where id = p_bank_account_id and organization_id = v_org;
  if not found then
    raise exception 'bank account not found' using errcode = 'P0002';
  end if;
  return v_ba;
end;
$$;
revoke all on function private.bank_ctx(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- bank accounts
-- ---------------------------------------------------------------------------------------------------------
create function public.create_bank_account(p_name text, p_bank_name text default null, p_account_ref text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid := private.gl_ctx('bank.reconcile');
  v_code text;
  v_gl   uuid;
  v_id   uuid;
begin
  if length(btrim(coalesce(p_name, ''))) < 2 then
    raise exception 'a name is required' using errcode = '22023';
  end if;
  select c.n::text into v_code from generate_series(1040, 1099) c(n)
  where not exists (select 1 from public.gl_accounts a where a.organization_id = v_org and a.code = c.n::text) order by c.n limit 1;
  if v_code is null then
    raise exception 'no free account code left in 1040-1099' using errcode = '53400';
  end if;
  insert into public.gl_accounts (organization_id, code, name, account_type, normal_side) values (v_org, v_code, btrim(p_name), 'ASSET', 'DEBIT') returning id into v_gl;
  insert into public.bank_accounts (organization_id, gl_account_id, name, bank_name, account_ref)
  values (v_org, v_gl, btrim(p_name), nullif(btrim(coalesce(p_bank_name, '')), ''), nullif(btrim(coalesce(p_account_ref, '')), '')) returning id into v_id;
  return v_id;
end;
$$;

create function public.save_bank_account(p_id uuid, p_name text, p_bank_name text, p_account_ref text, p_is_active boolean default true, p_make_default boolean default false)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.gl_ctx('accounting.manage');
  v_ba  public.bank_accounts;
begin
  select * into v_ba from public.bank_accounts where id = p_id and organization_id = v_org for update;
  if not found then
    raise exception 'bank account not found' using errcode = 'P0002';
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then
    raise exception 'a name is required' using errcode = '22023';
  end if;
  if not coalesce(p_is_active, true) and (v_ba.is_default and not p_make_default) then
    raise exception 'the default bank account cannot be deactivated: choose another default first' using errcode = '23514';
  end if;
  if coalesce(p_make_default, false) then
    update public.bank_accounts set is_default = false where organization_id = v_org and is_default and id <> p_id;
  end if;
  update public.bank_accounts
     set name = btrim(p_name), bank_name = nullif(btrim(coalesce(p_bank_name, '')), ''), account_ref = nullif(btrim(coalesce(p_account_ref, '')), ''),
         is_active = coalesce(p_is_active, true), is_default = case when coalesce(p_make_default, false) then true else is_default end
   where id = p_id;
  return p_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- importing a statement. p_lines: [{date, description, reference, amount}]  (amount: money in positive, money out negative)
-- ---------------------------------------------------------------------------------------------------------
create function public.import_bank_statement(
  p_bank_account_id uuid, p_period_from date, p_period_to date, p_opening numeric, p_closing numeric, p_lines jsonb, p_file_name text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ba    public.bank_accounts := private.bank_ctx(p_bank_account_id);
  v_sum   numeric;
  v_prev  public.bank_statements;
  v_id    uuid;
  e       jsonb;
begin
  if not v_ba.is_active then
    raise exception 'this bank account is not active' using errcode = '55000';
  end if;
  if p_period_from is null or p_period_to is null or p_period_from > p_period_to or p_opening is null or p_closing is null then
    raise exception 'give the statement period and its opening and closing balances' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 5000 then
    raise exception 'a statement needs between 1 and 5000 lines' using errcode = '22023';
  end if;
  for e in select * from jsonb_array_elements(p_lines) loop
    if (e ->> 'date') is null or (e ->> 'amount') is null or (e ->> 'amount')::numeric = 0
       or (e ->> 'date')::date not between p_period_from and p_period_to then
      raise exception 'every line needs a date inside the statement period and a non-zero amount' using errcode = '22023';
    end if;
  end loop;
  select sum(round((x ->> 'amount')::numeric, 2)) into v_sum from jsonb_array_elements(p_lines) x;
  if round(p_opening + v_sum, 2) <> round(p_closing, 2) then
    raise exception 'the statement does not add up: opening % plus the lines % is %, but the closing balance is %', p_opening, v_sum, round(p_opening + v_sum, 2), p_closing
      using errcode = '22023';
  end if;
  if exists (select 1 from public.bank_statements s where s.bank_account_id = p_bank_account_id and s.period_from <= p_period_to and s.period_to >= p_period_from) then
    raise exception 'this period overlaps a statement already imported for this account' using errcode = '23505';
  end if;
  select * into v_prev from public.bank_statements s where s.bank_account_id = p_bank_account_id and s.period_to < p_period_from order by s.period_to desc limit 1;
  if found and round(v_prev.closing_balance, 2) <> round(p_opening, 2) then
    raise exception 'the opening balance % does not match the previous statement''s closing balance % (%)', p_opening, v_prev.closing_balance, v_prev.period_to using errcode = '22023';
  end if;

  insert into public.bank_statements (organization_id, bank_account_id, period_from, period_to, opening_balance, closing_balance, file_name)
  values (v_ba.organization_id, p_bank_account_id, p_period_from, p_period_to, round(p_opening, 2), round(p_closing, 2), left(p_file_name, 200))
  returning id into v_id;
  insert into public.bank_statement_lines (organization_id, statement_id, bank_account_id, line_no, txn_date, description, reference, amount)
  select v_ba.organization_id, v_id, p_bank_account_id, row_number() over (order by (x.e ->> 'date')::date, x.ord), (x.e ->> 'date')::date,
         left(x.e ->> 'description', 300), left(x.e ->> 'reference', 100), round((x.e ->> 'amount')::numeric, 2)
  from jsonb_array_elements(p_lines) with ordinality as x(e, ord);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- matching
-- ---------------------------------------------------------------------------------------------------------
create function public.suggest_bank_matches(p_statement_id uuid)
returns table (statement_line_id uuid, journal_line_id uuid, journal_number text, journal_date date, description text, amount numeric, score integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.gl_ctx('bank.reconcile');
  v_st  public.bank_statements;
  v_gl  uuid;
begin
  select * into v_st from public.bank_statements where id = p_statement_id and organization_id = v_org;
  if not found then
    raise exception 'statement not found' using errcode = 'P0002';
  end if;
  select gl_account_id into v_gl from public.bank_accounts where id = v_st.bank_account_id;
  return query
  select r.slid, r.jlid, r.jn, r.jd, r.jdesc, r.amt, r.sc
  from (
    select sl.id as slid, l.id as jlid, j.journal_number as jn, l.journal_date as jd, j.description as jdesc, sl.amount as amt,
           (100 - 5 * abs(l.journal_date - sl.txn_date)
              + case when sl.reference is not null and length(btrim(sl.reference)) >= 3
                      and (position(lower(btrim(sl.reference)) in lower(coalesce(l.memo, '') || ' ' || j.description)) > 0) then 30 else 0 end)::integer as sc,
           row_number() over (partition by sl.id order by abs(l.journal_date - sl.txn_date), l.journal_date, l.id) as rn
    from public.bank_statement_lines sl
    join public.gl_journal_lines l on l.organization_id = sl.organization_id and l.account_id = v_gl and (l.debit - l.credit) = sl.amount
                                  and abs(l.journal_date - sl.txn_date) <= 10
    join public.gl_journals j on j.id = l.journal_id and j.organization_id = l.organization_id
    where sl.statement_id = p_statement_id and not sl.matched
      and not exists (select 1 from public.bank_matches m where m.journal_line_id = l.id)
  ) r
  where r.rn <= 3
  order by r.slid, r.sc desc;
end;
$$;

create function public.match_bank_line(p_statement_line_id uuid, p_journal_line_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.gl_ctx('bank.reconcile');
  v_sl  public.bank_statement_lines;
  v_st  public.bank_statements;
  v_gl  uuid;
  v_sum numeric;
  v_n   integer;
begin
  select * into v_sl from public.bank_statement_lines where id = p_statement_line_id and organization_id = v_org for update;
  if not found then
    raise exception 'statement line not found' using errcode = 'P0002';
  end if;
  select * into v_st from public.bank_statements where id = v_sl.statement_id;
  if v_st.status = 'RECONCILED' then
    raise exception 'this statement is reconciled and locked' using errcode = '55000';
  end if;
  if v_sl.matched then
    raise exception 'this statement line is already matched' using errcode = '23505';
  end if;
  if p_journal_line_ids is null or cardinality(p_journal_line_ids) = 0 then
    raise exception 'choose the ledger lines to match' using errcode = '22023';
  end if;
  select gl_account_id into v_gl from public.bank_accounts where id = v_sl.bank_account_id;
  select coalesce(sum(l.debit - l.credit), 0), count(*) into v_sum, v_n
  from public.gl_journal_lines l
  where l.id = any (p_journal_line_ids) and l.organization_id = v_org and l.account_id = v_gl
    and not exists (select 1 from public.bank_matches m where m.journal_line_id = l.id);
  if v_n <> cardinality(array(select distinct x from unnest(p_journal_line_ids) x)) then
    raise exception 'some ledger lines are not on this bank account or are already matched' using errcode = '22023';
  end if;
  if round(v_sum, 2) <> v_sl.amount then
    raise exception 'the ledger lines total % but the statement line is %', round(v_sum, 2), v_sl.amount using errcode = '22023';
  end if;
  insert into public.bank_matches (organization_id, bank_account_id, journal_line_id, statement_line_id)
  select v_org, v_sl.bank_account_id, x, v_sl.id from (select distinct unnest(p_journal_line_ids) as x) d;
  update public.bank_statement_lines set matched = true where id = v_sl.id;
end;
$$;

create function public.auto_match_statement(p_statement_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.gl_ctx('bank.reconcile');
  v_st  public.bank_statements;
  v_gl  uuid;
  v_n   integer;
begin
  select * into v_st from public.bank_statements where id = p_statement_id and organization_id = v_org;
  if not found then
    raise exception 'statement not found' using errcode = 'P0002';
  end if;
  if v_st.status = 'RECONCILED' then
    raise exception 'this statement is reconciled and locked' using errcode = '55000';
  end if;
  select gl_account_id into v_gl from public.bank_accounts where id = v_st.bank_account_id;
  with pairs as (
    select sl.id as slid, l.id as jlid
    from public.bank_statement_lines sl
    join public.gl_journal_lines l on l.organization_id = sl.organization_id and l.account_id = v_gl and (l.debit - l.credit) = sl.amount
                                  and abs(l.journal_date - sl.txn_date) <= 3
    where sl.statement_id = p_statement_id and not sl.matched
      and not exists (select 1 from public.bank_matches m where m.journal_line_id = l.id)
  ), unique_pairs as (
    select p.slid, p.jlid from pairs p
    where (select count(*) from pairs q where q.slid = p.slid) = 1 and (select count(*) from pairs q where q.jlid = p.jlid) = 1
  ), ins as (
    insert into public.bank_matches (organization_id, bank_account_id, journal_line_id, statement_line_id)
    select v_org, v_st.bank_account_id, u.jlid, u.slid from unique_pairs u returning statement_line_id
  )
  update public.bank_statement_lines set matched = true where id in (select statement_line_id from ins);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create function public.unmatch_bank_line(p_statement_line_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.gl_ctx('bank.reconcile');
  v_sl  public.bank_statement_lines;
begin
  select * into v_sl from public.bank_statement_lines where id = p_statement_line_id and organization_id = v_org for update;
  if not found then
    raise exception 'statement line not found' using errcode = 'P0002';
  end if;
  if (select status from public.bank_statements where id = v_sl.statement_id) = 'RECONCILED' then
    raise exception 'this statement is reconciled and locked' using errcode = '55000';
  end if;
  delete from public.bank_matches where statement_line_id = p_statement_line_id;
  update public.bank_statement_lines set matched = false where id = p_statement_line_id;
end;
$$;

-- a statement line the books do not know about (bank charges, interest, a direct deposit): book it against p_account_id and match it
create function public.post_bank_entry(p_statement_line_id uuid, p_account_id uuid, p_description text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.gl_ctx('bank.reconcile');
  v_sl      public.bank_statement_lines;
  v_ba      public.bank_accounts;
  v_acc     public.gl_accounts;
  v_set     public.accounting_settings;
  v_journal uuid;
  v_line    uuid;
begin
  select * into v_sl from public.bank_statement_lines where id = p_statement_line_id and organization_id = v_org for update;
  if not found then
    raise exception 'statement line not found' using errcode = 'P0002';
  end if;
  if v_sl.matched then
    raise exception 'this statement line is already matched' using errcode = '23505';
  end if;
  if (select status from public.bank_statements where id = v_sl.statement_id) = 'RECONCILED' then
    raise exception 'this statement is reconciled and locked' using errcode = '55000';
  end if;
  select * into v_set from public.accounting_settings where organization_id = v_org;
  if not found or v_sl.txn_date < v_set.go_live_date then
    raise exception 'this line is dated before accounting started: clear it instead of booking it' using errcode = '55000';
  end if;
  select * into v_ba from public.bank_accounts where id = v_sl.bank_account_id;
  select * into v_acc from public.gl_accounts where id = p_account_id and organization_id = v_org;
  if not found or not v_acc.is_active or not v_acc.allow_manual or v_acc.id = v_ba.gl_account_id then
    raise exception 'choose an active, non-control account other than the bank account itself' using errcode = '22023';
  end if;

  v_journal := private.gl_post(v_org, v_sl.txn_date, 'BANK_ENTRY', v_sl.id, 'POST',
    coalesce(nullif(btrim(coalesce(p_description, '')), ''), 'Bank: ' || coalesce(v_sl.description, v_sl.reference, 'statement line ' || v_sl.line_no)), null,
    jsonb_build_array(
      jsonb_build_object('account_id', v_ba.gl_account_id, 'amount', v_sl.amount, 'memo', coalesce(v_sl.reference, v_sl.description)),
      jsonb_build_object('account_id', v_acc.id, 'amount', -v_sl.amount, 'memo', coalesce(v_sl.reference, v_sl.description))));
  select l.id into v_line from public.gl_journal_lines l where l.journal_id = v_journal and l.account_id = v_ba.gl_account_id;
  insert into public.bank_matches (organization_id, bank_account_id, journal_line_id, statement_line_id) values (v_org, v_sl.bank_account_id, v_line, v_sl.id);
  update public.bank_statement_lines set matched = true where id = v_sl.id;
  return v_journal;
end;
$$;

create function public.clear_ledger_lines(p_bank_account_id uuid, p_journal_line_ids uuid[], p_note text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ba public.bank_accounts := private.bank_ctx(p_bank_account_id);
  v_n  integer;
begin
  if length(btrim(coalesce(p_note, ''))) < 5 then
    raise exception 'give a reason for clearing these lines' using errcode = '22023';
  end if;
  if exists (select 1 from public.gl_journal_lines l join public.bank_statements s on s.bank_account_id = p_bank_account_id and s.status = 'RECONCILED' and s.period_to >= l.journal_date
             where l.id = any (p_journal_line_ids) and l.organization_id = v_ba.organization_id) then
    raise exception 'a reconciled statement already covers one of these lines' using errcode = '55000';
  end if;
  insert into public.bank_matches (organization_id, bank_account_id, journal_line_id, note)
  select v_ba.organization_id, p_bank_account_id, l.id, btrim(p_note)
  from public.gl_journal_lines l
  where l.id = any (p_journal_line_ids) and l.organization_id = v_ba.organization_id and l.account_id = v_ba.gl_account_id
    and not exists (select 1 from public.bank_matches m where m.journal_line_id = l.id);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create function public.unclear_ledger_line(p_journal_line_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.gl_ctx('bank.reconcile');
  v_m   public.bank_matches;
  v_jd  date;
begin
  select * into v_m from public.bank_matches where journal_line_id = p_journal_line_id and organization_id = v_org and statement_line_id is null;
  if not found then
    raise exception 'that line is not cleared by note' using errcode = 'P0002';
  end if;
  select journal_date into v_jd from public.gl_journal_lines where id = p_journal_line_id;
  if exists (select 1 from public.bank_statements s where s.bank_account_id = v_m.bank_account_id and s.status = 'RECONCILED' and s.period_to >= v_jd) then
    raise exception 'a reconciled statement already covers this line' using errcode = '55000';
  end if;
  delete from public.bank_matches where id = v_m.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- the ledger side of a bank account, and the reconciliation statement
-- ---------------------------------------------------------------------------------------------------------
create function public.bank_ledger_lines(p_bank_account_id uuid, p_from date default null, p_to date default null, p_only_open boolean default true)
returns table (journal_line_id uuid, journal_id uuid, journal_number text, journal_date date, description text, memo text, amount numeric, cleared boolean, note text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.gl_ctx('bank.view');
  v_gl  uuid;
begin
  select gl_account_id into v_gl from public.bank_accounts where id = p_bank_account_id and organization_id = v_org;
  if v_gl is null then
    raise exception 'bank account not found' using errcode = 'P0002';
  end if;
  return query
  select l.id, l.journal_id, j.journal_number::text, l.journal_date, j.description::text, l.memo::text, l.debit - l.credit, m.id is not null, m.note::text
  from public.gl_journal_lines l
  join public.gl_journals j on j.id = l.journal_id and j.organization_id = l.organization_id
  left join public.bank_matches m on m.journal_line_id = l.id
  where l.organization_id = v_org and l.account_id = v_gl
    and (p_from is null or l.journal_date >= p_from) and (p_to is null or l.journal_date <= p_to)
    and (not coalesce(p_only_open, true) or m.id is null)
  order by l.journal_date, j.created_at, l.line_no
  limit 5000;
end;
$$;

create function public.bank_reconciliation(p_statement_id uuid)
returns table (item text, label text, amount numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org     uuid := private.gl_ctx('bank.view');
  v_st      public.bank_statements;
  v_gl      uuid;
  v_ledger  numeric;
  v_transit numeric;
  v_outst   numeric;
  v_in      numeric;
  v_out     numeric;
  v_bank    numeric;
  v_book    numeric;
  v_open    integer;
begin
  select * into v_st from public.bank_statements where id = p_statement_id and organization_id = v_org;
  if not found then
    raise exception 'statement not found' using errcode = 'P0002';
  end if;
  select gl_account_id into v_gl from public.bank_accounts where id = v_st.bank_account_id;

  select coalesce(sum(l.debit - l.credit), 0) into v_ledger from public.gl_journal_lines l
  where l.organization_id = v_org and l.account_id = v_gl and l.journal_date <= v_st.period_to;

  with open_lines as (
    select l.debit - l.credit as amt from public.gl_journal_lines l
    where l.organization_id = v_org and l.account_id = v_gl and l.journal_date <= v_st.period_to
      and not exists (
        select 1 from public.bank_matches m
        where m.journal_line_id = l.id
          and (m.statement_line_id is null
               or exists (select 1 from public.bank_statement_lines sl join public.bank_statements s on s.id = sl.statement_id
                          where sl.id = m.statement_line_id and s.period_to <= v_st.period_to)))
  )
  select coalesce(sum(amt) filter (where amt > 0), 0), coalesce(sum(amt) filter (where amt < 0), 0) into v_transit, v_outst from open_lines;

  select coalesce(sum(sl.amount) filter (where sl.amount > 0), 0), coalesce(sum(sl.amount) filter (where sl.amount < 0), 0) into v_in, v_out
  from public.bank_statement_lines sl join public.bank_statements s on s.id = sl.statement_id
  where s.bank_account_id = v_st.bank_account_id and s.period_to <= v_st.period_to and not sl.matched;

  select count(*) into v_open from public.bank_statement_lines sl where sl.statement_id = p_statement_id and not sl.matched;

  v_bank := v_st.closing_balance + v_transit + v_outst;
  v_book := v_ledger + v_in + v_out;
  return query values
    ('STATEMENT_CLOSING'::text,   'Closing balance on the statement'::text,                                  v_st.closing_balance),
    ('IN_TRANSIT',                'Add: receipts in the books, not yet on the statement',                      v_transit),
    ('OUTSTANDING',               'Less: payments in the books, not yet on the statement',                     v_outst),
    ('ADJUSTED_BANK',             'Adjusted bank balance',                                                     v_bank),
    ('LEDGER',                    'Balance in the books at the end of the statement period',                   v_ledger),
    ('UNBOOKED_IN',               'Add: money in on the statement, not yet in the books',                      v_in),
    ('UNBOOKED_OUT',              'Less: money out on the statement, not yet in the books',                    v_out),
    ('ADJUSTED_BOOK',             'Adjusted book balance',                                                     v_book),
    ('DIFFERENCE',                'Difference (must be nil to finish)',                                        round(v_bank - v_book, 2)),
    ('UNMATCHED_LINES',           'Statement lines still unmatched on this statement (count)',                 v_open::numeric);
end;
$$;

create function public.finalize_reconciliation(p_statement_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := private.gl_ctx('bank.reconcile');
  v_st  public.bank_statements;
  v_diff numeric;
  v_open numeric;
begin
  select * into v_st from public.bank_statements where id = p_statement_id and organization_id = v_org for update;
  if not found then
    raise exception 'statement not found' using errcode = 'P0002';
  end if;
  if v_st.status = 'RECONCILED' then
    raise exception 'this statement is already reconciled' using errcode = '55000';
  end if;
  if exists (select 1 from public.bank_statements s where s.bank_account_id = v_st.bank_account_id and s.period_to < v_st.period_from and s.status <> 'RECONCILED') then
    raise exception 'reconcile the earlier statements first' using errcode = '55000';
  end if;
  select r.amount into v_open from public.bank_reconciliation(p_statement_id) r where r.item = 'UNMATCHED_LINES';
  select r.amount into v_diff from public.bank_reconciliation(p_statement_id) r where r.item = 'DIFFERENCE';
  if v_open > 0 then
    raise exception '% statement line(s) are still unmatched', v_open using errcode = '55000';
  end if;
  if v_diff <> 0 then
    raise exception 'the reconciliation does not balance: the difference is %', v_diff using errcode = '55000';
  end if;
  update public.bank_statements set status = 'RECONCILED', reconciled_by = auth.uid(), reconciled_at = now() where id = p_statement_id;
end;
$$;

revoke all on function public.create_bank_account(text, text, text) from public, anon;
revoke all on function public.save_bank_account(uuid, text, text, text, boolean, boolean) from public, anon;
revoke all on function public.import_bank_statement(uuid, date, date, numeric, numeric, jsonb, text) from public, anon;
revoke all on function public.suggest_bank_matches(uuid) from public, anon;
revoke all on function public.match_bank_line(uuid, uuid[]) from public, anon;
revoke all on function public.auto_match_statement(uuid) from public, anon;
revoke all on function public.unmatch_bank_line(uuid) from public, anon;
revoke all on function public.post_bank_entry(uuid, uuid, text) from public, anon;
revoke all on function public.clear_ledger_lines(uuid, uuid[], text) from public, anon;
revoke all on function public.unclear_ledger_line(uuid) from public, anon;
revoke all on function public.bank_ledger_lines(uuid, date, date, boolean) from public, anon;
revoke all on function public.bank_reconciliation(uuid) from public, anon;
revoke all on function public.finalize_reconciliation(uuid) from public, anon;
grant execute on function public.create_bank_account(text, text, text) to authenticated;
grant execute on function public.save_bank_account(uuid, text, text, text, boolean, boolean) to authenticated;
grant execute on function public.import_bank_statement(uuid, date, date, numeric, numeric, jsonb, text) to authenticated;
grant execute on function public.suggest_bank_matches(uuid) to authenticated;
grant execute on function public.match_bank_line(uuid, uuid[]) to authenticated;
grant execute on function public.auto_match_statement(uuid) to authenticated;
grant execute on function public.unmatch_bank_line(uuid) to authenticated;
grant execute on function public.post_bank_entry(uuid, uuid, text) to authenticated;
grant execute on function public.clear_ledger_lines(uuid, uuid[], text) to authenticated;
grant execute on function public.unclear_ledger_line(uuid) to authenticated;
grant execute on function public.bank_ledger_lines(uuid, date, date, boolean) to authenticated;
grant execute on function public.bank_reconciliation(uuid) to authenticated;
grant execute on function public.finalize_reconciliation(uuid) to authenticated;

commit;
