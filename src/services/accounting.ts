import { supabase } from '@/lib/supabase'
import type { Json } from '@/types/database'
import { sanitizeForOrFilter } from '@/lib/utils'
import type { PageParams, Paged } from '@/types/domain'
import { rangeFor, unwrap, unwrapPaged } from './common'

const n = (v: unknown) => Number(v ?? 0)
const nullIfEmpty = <T extends string | null | undefined>(v: T) => (v === undefined || v === null || v.trim() === '' ? null : v) as unknown as string

// ---- chart of accounts ----------------------------------------------------------------------------------------------------
export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'
export const ACCOUNT_TYPES: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']
export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = { ASSET: 'Asset', LIABILITY: 'Liability', EQUITY: 'Equity', REVENUE: 'Revenue', EXPENSE: 'Expense' }

export interface GlAccount {
  id: string; code: string; name: string; account_type: AccountType; normal_side: 'DEBIT' | 'CREDIT'
  system_key: string | null; is_system: boolean; allow_manual: boolean; is_active: boolean
}

export async function listAccounts(): Promise<GlAccount[]> {
  const rows = unwrap(await supabase.from('gl_accounts').select('id, code, name, account_type, normal_side, system_key, is_system, allow_manual, is_active').order('code'), 'accounting.accounts')
  return rows as GlAccount[]
}

export async function saveAccount(i: { id: string | null; code: string; name: string; type: AccountType; active: boolean }): Promise<string> {
  return unwrap(await supabase.rpc('save_gl_account', { p_id: i.id as unknown as string, p_code: i.code.trim(), p_name: i.name.trim(), p_account_type: i.type, p_is_active: i.active }), 'accounting.saveAccount')
}

// ---- settings and starting accounting -------------------------------------------------------------------------------------
export interface AccountingSettings { go_live_date: string; locked_through: string | null }

export async function getAccountingSettings(): Promise<AccountingSettings | null> {
  const row = unwrap(await supabase.from('accounting_settings').select('go_live_date, locked_through').maybeSingle(), 'accounting.settings')
  return row
}

export interface OpeningSuggestion { account_id: string; code: string; name: string; suggested: number; basis: string }
export async function suggestOpeningBalances(): Promise<OpeningSuggestion[]> {
  return unwrap(await supabase.rpc('suggest_opening_balances'), 'accounting.suggest').map((r) => ({ ...r, suggested: n(r.suggested) }))
}

export async function startAccounting(goLive: string, lines: { account_id: string; debit: number; credit: number }[]): Promise<void> {
  unwrap(await supabase.rpc('start_accounting', { p_go_live: goLive, p_opening: lines }), 'accounting.start')
}

export async function setPeriodLock(through: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('set_period_lock', { p_through: through, p_reason: nullIfEmpty(reason) }), 'accounting.lock')
}

export interface AccountingCheck { check_code: string; label: string; ledger: number; operational: number; difference: number }
export async function getAccountingChecks(): Promise<AccountingCheck[]> {
  return unwrap(await supabase.rpc('accounting_checks'), 'accounting.checks').map((r) => ({ ...r, ledger: n(r.ledger), operational: n(r.operational), difference: n(r.difference) }))
}

// ---- journals -------------------------------------------------------------------------------------------------------------
export const SOURCE_LABEL: Record<string, string> = {
  OPENING: 'Opening balances', MANUAL: 'Manual journal', REVERSAL: 'Reversal', BANK_ENTRY: 'Bank entry', SALES_INVOICE: 'Sales invoice', CREDIT_NOTE: 'Credit note',
  RECEIPT: 'Customer receipt', REFUND: 'Customer refund', STOCK_DOCUMENT: 'Stock movement', SUPPLIER_INVOICE: 'Supplier invoice', PURCHASE_RETURN: 'Supplier credit',
}

export interface JournalRow {
  id: string; journal_number: string; journal_date: string; source_type: string; source_id: string | null; event: string; description: string; reason: string | null
  branch_id: string | null; reverses_journal_id: string | null; created_at: string
}
export interface JournalListParams extends PageParams { search: string; source: string; from: string; to: string }

export async function listJournals(p: JournalListParams): Promise<Paged<JournalRow>> {
  let q = supabase.from('gl_journals').select('id, journal_number, journal_date, source_type, source_id, event, description, reason, branch_id, reverses_journal_id, created_at', { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`journal_number.ilike.%${s}%,description.ilike.%${s}%`)
  if (p.source) q = q.eq('source_type', p.source)
  if (p.from) q = q.gte('journal_date', p.from)
  if (p.to) q = q.lte('journal_date', p.to)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('journal_date', { ascending: false }).order('created_at', { ascending: false }).order('id').range(from, to), 'accounting.journals', p)
  return { ...res, rows: res.rows as JournalRow[] }
}

export interface JournalLine { id: string; line_no: number; account_id: string; debit: number; credit: number; memo: string | null; branch_id: string | null }
export async function getJournalLines(journalId: string): Promise<JournalLine[]> {
  const rows = unwrap(await supabase.from('gl_journal_lines').select('id, line_no, account_id, debit, credit, memo, branch_id').eq('journal_id', journalId).order('line_no'), 'accounting.lines')
  return rows.map((r) => ({ ...r, debit: n(r.debit), credit: n(r.credit) }))
}

export async function isJournalReversed(journalId: string): Promise<boolean> {
  const rows = unwrap(await supabase.from('gl_journals').select('id').eq('reverses_journal_id', journalId).limit(1), 'accounting.reversed')
  return rows.length > 0
}

export async function postManualJournal(i: { date: string; description: string; reason: string; branchId: string | null; lines: { account_id: string; debit: number; credit: number; memo: string }[] }): Promise<void> {
  unwrap(await supabase.rpc('post_manual_journal', {
    p_date: i.date, p_description: i.description.trim(), p_lines: i.lines.map((l) => ({ account_id: l.account_id, debit: l.debit || 0, credit: l.credit || 0, memo: l.memo.trim() || null })),
    p_branch_id: i.branchId as unknown as string, p_reason: nullIfEmpty(i.reason),
  }), 'accounting.manualJournal')
}

export async function reverseJournal(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('reverse_journal', { p_journal_id: id, p_reason: reason.trim() }), 'accounting.reverse')
}

// ---- statements -----------------------------------------------------------------------------------------------------------
export interface TrialRow { account_id: string; code: string; name: string; account_type: AccountType; normal_side: 'DEBIT' | 'CREDIT'; opening: number; period_debit: number; period_credit: number; closing: number }
export async function getTrialBalance(from: string, to: string, branchId: string | null): Promise<TrialRow[]> {
  return unwrap(await supabase.rpc('trial_balance', { p_from: from, p_to: to, p_branch_id: branchId as unknown as string }), 'accounting.trial')
    .map((r) => ({ ...r, account_type: r.account_type as AccountType, normal_side: r.normal_side as TrialRow['normal_side'], opening: n(r.opening), period_debit: n(r.period_debit), period_credit: n(r.period_credit), closing: n(r.closing) }))
}

export interface IncomeRow { account_id: string; code: string; name: string; account_type: 'REVENUE' | 'EXPENSE'; amount: number }
export async function getIncomeStatement(from: string, to: string, branchId: string | null): Promise<IncomeRow[]> {
  return unwrap(await supabase.rpc('income_statement', { p_from: from, p_to: to, p_branch_id: branchId as unknown as string }), 'accounting.income')
    .map((r) => ({ ...r, account_type: r.account_type as IncomeRow['account_type'], amount: n(r.amount) }))
}

export interface BalanceRow { section: 'ASSET' | 'LIABILITY' | 'EQUITY'; account_id: string | null; code: string; name: string; amount: number }
export async function getBalanceSheet(asOf: string, branchId: string | null): Promise<BalanceRow[]> {
  return unwrap(await supabase.rpc('balance_sheet', { p_as_of: asOf, p_branch_id: branchId as unknown as string }), 'accounting.balance')
    .map((r) => ({ ...r, section: r.section as BalanceRow['section'], amount: n(r.amount) }))
}

export interface LedgerRow { line_id: string | null; journal_id: string | null; journal_date: string; journal_number: string | null; description: string; memo: string | null; debit: number; credit: number; running: number }
export async function getAccountLedger(accountId: string, from: string, to: string, branchId: string | null): Promise<LedgerRow[]> {
  return unwrap(await supabase.rpc('account_ledger', { p_account_id: accountId, p_from: from, p_to: to, p_branch_id: branchId as unknown as string }), 'accounting.ledger')
    .map((r) => ({ ...r, debit: n(r.debit), credit: n(r.credit), running: n(r.running) }))
}

// ---- bank accounts and reconciliation -------------------------------------------------------------------------------------
export interface BankAccount { id: string; gl_account_id: string; name: string; bank_name: string | null; account_ref: string | null; is_default: boolean; is_active: boolean }
export async function listBankAccounts(): Promise<BankAccount[]> {
  return unwrap(await supabase.from('bank_accounts').select('id, gl_account_id, name, bank_name, account_ref, is_default, is_active').order('name'), 'bank.accounts') as BankAccount[]
}

export async function createBankAccount(name: string, bankName: string, accountRef: string): Promise<string> {
  return unwrap(await supabase.rpc('create_bank_account', { p_name: name.trim(), p_bank_name: nullIfEmpty(bankName), p_account_ref: nullIfEmpty(accountRef) }), 'bank.create')
}

export async function saveBankAccount(i: { id: string; name: string; bankName: string; accountRef: string; active: boolean; makeDefault: boolean }): Promise<void> {
  unwrap(await supabase.rpc('save_bank_account', { p_id: i.id, p_name: i.name.trim(), p_bank_name: nullIfEmpty(i.bankName), p_account_ref: nullIfEmpty(i.accountRef), p_is_active: i.active, p_make_default: i.makeDefault }), 'bank.save')
}

export interface BankStatement {
  id: string; bank_account_id: string; period_from: string; period_to: string; opening_balance: number; closing_balance: number; file_name: string | null
  status: 'OPEN' | 'RECONCILED'; imported_at: string; reconciled_at: string | null
}
export async function listStatements(bankAccountId: string | null): Promise<BankStatement[]> {
  let q = supabase.from('bank_statements').select('id, bank_account_id, period_from, period_to, opening_balance, closing_balance, file_name, status, imported_at, reconciled_at')
  if (bankAccountId) q = q.eq('bank_account_id', bankAccountId)
  const rows = unwrap(await q.order('period_to', { ascending: false }).limit(200), 'bank.statements')
  return rows.map((r) => ({ ...r, opening_balance: n(r.opening_balance), closing_balance: n(r.closing_balance), status: r.status as BankStatement['status'] }))
}

export async function getStatement(id: string): Promise<BankStatement | null> {
  const row = unwrap(await supabase.from('bank_statements').select('id, bank_account_id, period_from, period_to, opening_balance, closing_balance, file_name, status, imported_at, reconciled_at').eq('id', id).limit(1), 'bank.statement')[0]
  return row ? { ...row, opening_balance: n(row.opening_balance), closing_balance: n(row.closing_balance), status: row.status as BankStatement['status'] } : null
}

export interface StatementLine { id: string; line_no: number; txn_date: string; description: string | null; reference: string | null; amount: number; matched: boolean }
export async function getStatementLines(statementId: string): Promise<StatementLine[]> {
  const rows = unwrap(await supabase.from('bank_statement_lines').select('id, line_no, txn_date, description, reference, amount, matched').eq('statement_id', statementId).order('line_no'), 'bank.lines')
  return rows.map((r) => ({ ...r, amount: n(r.amount) }))
}

export interface ImportLine { date: string; description: string; reference: string; amount: number }
export async function importStatement(i: { bankAccountId: string; from: string; to: string; opening: number; closing: number; lines: ImportLine[]; fileName: string }): Promise<string> {
  return unwrap(await supabase.rpc('import_bank_statement', {
    p_bank_account_id: i.bankAccountId, p_period_from: i.from, p_period_to: i.to, p_opening: i.opening, p_closing: i.closing, p_lines: i.lines as unknown as Json, p_file_name: nullIfEmpty(i.fileName),
  }), 'bank.import')
}

export interface MatchSuggestion { statement_line_id: string; journal_line_id: string; journal_number: string; journal_date: string; description: string; amount: number; score: number }
export async function suggestMatches(statementId: string): Promise<MatchSuggestion[]> {
  return unwrap(await supabase.rpc('suggest_bank_matches', { p_statement_id: statementId }), 'bank.suggest').map((r) => ({ ...r, amount: n(r.amount), score: n(r.score) }))
}

export async function matchLine(statementLineId: string, journalLineIds: string[]): Promise<void> {
  unwrap(await supabase.rpc('match_bank_line', { p_statement_line_id: statementLineId, p_journal_line_ids: journalLineIds }), 'bank.match')
}
export async function autoMatch(statementId: string): Promise<number> {
  return n(unwrap(await supabase.rpc('auto_match_statement', { p_statement_id: statementId }), 'bank.autoMatch'))
}
export async function unmatchLine(statementLineId: string): Promise<void> {
  unwrap(await supabase.rpc('unmatch_bank_line', { p_statement_line_id: statementLineId }), 'bank.unmatch')
}
export async function postBankEntry(statementLineId: string, accountId: string, description: string): Promise<void> {
  unwrap(await supabase.rpc('post_bank_entry', { p_statement_line_id: statementLineId, p_account_id: accountId, p_description: nullIfEmpty(description) ?? undefined }), 'bank.entry')
}
export async function clearLedgerLines(bankAccountId: string, ids: string[], note: string): Promise<number> {
  return n(unwrap(await supabase.rpc('clear_ledger_lines', { p_bank_account_id: bankAccountId, p_journal_line_ids: ids, p_note: note.trim() }), 'bank.clear'))
}

export interface BankLedgerLine { journal_line_id: string; journal_id: string; journal_number: string; journal_date: string; description: string; memo: string | null; amount: number; cleared: boolean; note: string | null }
export async function getBankLedgerLines(bankAccountId: string, onlyOpen: boolean, from: string | null = null, to: string | null = null): Promise<BankLedgerLine[]> {
  return unwrap(await supabase.rpc('bank_ledger_lines', { p_bank_account_id: bankAccountId, p_from: from as unknown as string, p_to: to as unknown as string, p_only_open: onlyOpen }), 'bank.ledger')
    .map((r) => ({ ...r, amount: n(r.amount) }))
}

export interface ReconciliationItem { item: string; label: string; amount: number }
export async function getReconciliation(statementId: string): Promise<ReconciliationItem[]> {
  return unwrap(await supabase.rpc('bank_reconciliation', { p_statement_id: statementId }), 'bank.reconciliation').map((r) => ({ ...r, amount: n(r.amount) }))
}
export async function finalizeReconciliation(statementId: string): Promise<void> {
  unwrap(await supabase.rpc('finalize_reconciliation', { p_statement_id: statementId }), 'bank.finalize')
}
