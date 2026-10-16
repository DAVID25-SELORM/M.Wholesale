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
