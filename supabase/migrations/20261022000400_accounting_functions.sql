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
