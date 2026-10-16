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
