import { supabase } from '@/lib/supabase'
import { sanitizeForOrFilter } from '@/lib/utils'
import type { PageParams, Paged, Tables } from '@/types/domain'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'

export const CREDIT_STATUSES = ['DRAFT', 'POSTED', 'CANCELLED'] as const
export type CreditStatus = (typeof CREDIT_STATUSES)[number]
export const CREDIT_STATUS_LABEL: Record<CreditStatus, string> = { DRAFT: 'Draft', POSTED: 'Posted', CANCELLED: 'Cancelled' }

export const CREDIT_REASONS = ['DAMAGED', 'EXPIRED', 'WRONG_ITEM', 'OVER_SUPPLY', 'QUALITY_COMPLAINT', 'RECALL', 'PRICE_ERROR', 'OTHER'] as const
export type CreditReason = (typeof CREDIT_REASONS)[number]
export const CREDIT_REASON_LABEL: Record<CreditReason, string> = {
  DAMAGED: 'Damaged goods', EXPIRED: 'Expired / short-dated', WRONG_ITEM: 'Wrong item sent', OVER_SUPPLY: 'More than ordered',
  QUALITY_COMPLAINT: 'Quality complaint', RECALL: 'Product recall', PRICE_ERROR: 'Price error / rebate', OTHER: 'Other',
}

export const RETURN_CONDITIONS = ['QUARANTINE', 'DAMAGED', 'AVAILABLE'] as const
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number]
export const RETURN_CONDITION_LABEL: Record<ReturnCondition, string> = {
  QUARANTINE: 'Quarantine - to be inspected', DAMAGED: 'Damaged - not sellable', AVAILABLE: 'Good - back into sellable stock',
}

export type CreditNote = Tables<'sales_credit_notes'> & {
  customer: { code: string; name: string } | null
  invoice: { invoice_number: string | null } | null
  warehouse: { code: string; name: string } | null
}

const NOTE_SELECT =
  '*, customer:customers!sales_credit_notes_customer_fk(code, name), invoice:sales_invoices!sales_credit_notes_invoice_fk(invoice_number), warehouse:warehouses!sales_credit_notes_warehouse_fk(code, name)'

export interface CreditListParams extends PageParams {
  search: string
  status: CreditStatus | ''
  customerId: string
  invoiceId: string
  /** only posted notes with credit still unused */
  unusedOnly: boolean
}

export async function listCreditNotes(p: CreditListParams): Promise<Paged<CreditNote>> {
  let q = supabase.from('sales_credit_notes').select(NOTE_SELECT, { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.ilike('credit_note_number', `%${s}%`)
  if (p.status) q = q.eq('status', p.status)
  if (p.customerId) q = q.eq('customer_id', p.customerId)
  if (p.invoiceId) q = q.eq('sales_invoice_id', p.invoiceId)
  if (p.unusedOnly) q = q.eq('status', 'POSTED').gt('unapplied_amount', 0)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('created_at', { ascending: false }).order('id').range(from, to), 'creditNotes.list', p)
  return { ...res, rows: res.rows as unknown as CreditNote[] }
}

export async function getCreditNote(id: string): Promise<CreditNote | null> {
  const res = await supabase.from('sales_credit_notes').select(NOTE_SELECT).eq('id', id).maybeSingle()
  return unwrap(res, 'creditNotes.get') as unknown as CreditNote | null
}

export type CreditNoteLine = Tables<'sales_credit_note_lines'> & {
  product: { sku: string; brand_name: string; base_unit: { code: string; name: string } | null } | null
  unit: { factor_to_base: number; unit: { code: string; name: string } | null } | null
  batch: { batch_number: string; expiry_date: string } | null
}

export async function listCreditNoteLines(noteId: string): Promise<CreditNoteLine[]> {
  const rows = unwrap(
    await supabase
      .from('sales_credit_note_lines')
      .select('*, product:products!sales_credit_note_lines_product_fk(sku, brand_name, base_unit:units_of_measure!products_base_unit_id_fkey(code, name)), unit:product_units!sales_credit_note_lines_unit_fk(factor_to_base, unit:units_of_measure(code, name)), batch:batches!sales_credit_note_lines_batch_fk(batch_number, expiry_date)')
      .eq('credit_note_id', noteId)
      .order('line_no'),
    'creditNotes.lines',
  )
  return rows as unknown as CreditNoteLine[]
}

export type CreditNoteReturn = Tables<'sales_credit_note_returns'> & { batch: { batch_number: string; expiry_date: string } | null }

/** Which sold batches the returned goods went back to (posted credit notes only). */
export async function listCreditNoteReturns(noteId: string): Promise<CreditNoteReturn[]> {
  const rows = unwrap(
    await supabase
      .from('sales_credit_note_returns')
      .select('*, batch:batches!sales_credit_note_returns_batch_fk(batch_number, expiry_date)')
      .eq('credit_note_id', noteId)
      .order('credit_note_line_id'),
    'creditNotes.returns',
  )
  return rows as unknown as CreditNoteReturn[]
}

export type CreditNoteAllocation = Tables<'credit_note_allocations'> & { invoice: { invoice_number: string | null } | null }

export async function listCreditNoteAllocations(noteId: string): Promise<CreditNoteAllocation[]> {
  const rows = unwrap(
    await supabase
      .from('credit_note_allocations')
      .select('*, invoice:sales_invoices!credit_note_allocations_invoice_fk(invoice_number)')
      .eq('credit_note_id', noteId)
      .order('created_at'),
    'creditNotes.allocations',
  )
  return rows as unknown as CreditNoteAllocation[]
}

/** A customer's posted credit notes with something still unused. */
export async function listUnusedCredit(customerId: string): Promise<CreditNote[]> {
  const rows = unwrap(
    await supabase.from('sales_credit_notes').select(NOTE_SELECT).eq('customer_id', customerId).eq('status', 'POSTED').gt('unapplied_amount', 0).order('posted_at').limit(100),
    'creditNotes.unused',
  )
  return rows as unknown as CreditNote[]
}

export interface Creditable {
  invoice_line_id: string
  line_no: number
  quantity: number
  returned_quantity: number
  remaining_quantity: number
  line_net: number
  credited_net: number
  remaining_net: number
  line_tax: number
  credited_tax: number
  remaining_tax: number
}

/** Per invoice line: what was sold, what has been credited, what is left. */
export async function getCreditable(invoiceId: string): Promise<Creditable[]> {
  const rows = unwrap(await supabase.rpc('invoice_creditable', { p_invoice_id: invoiceId }), 'creditNotes.creditable')
  return rows.map((r) => ({
    invoice_line_id: r.invoice_line_id, line_no: r.line_no, quantity: Number(r.quantity), returned_quantity: Number(r.returned_quantity),
    remaining_quantity: Number(r.remaining_quantity), line_net: Number(r.line_net), credited_net: Number(r.credited_net), remaining_net: Number(r.remaining_net),
    line_tax: Number(r.line_tax), credited_tax: Number(r.credited_tax), remaining_tax: Number(r.remaining_tax),
  }))
}

export type SaveCreditLine =
  | { type: 'RETURN'; invoice_line_id: string; quantity: number; condition?: ReturnCondition; batch_id?: string }
  | { type: 'PRICE'; invoice_line_id: string; amount: number; description?: string }

export interface SaveCreditInput {
  id: string | null
  invoiceId: string
  warehouseId: string
  reason: CreditReason
  notes?: string
  lines: SaveCreditLine[]
}

export async function saveCreditNote(i: SaveCreditInput): Promise<string> {
  return unwrap(
    await supabase.rpc('save_credit_note', {
      p_id: i.id as unknown as string, p_invoice_id: i.invoiceId, p_warehouse_id: i.warehouseId, p_reason_code: i.reason,
      p_notes: emptyToNull(i.notes) as unknown as string, p_lines: i.lines as unknown as never,
    }),
    'creditNotes.save',
  ) as string
}

export interface CreditPostResult { credit_note_number: string; total_amount: number; applied: number; unapplied: number; stock_document_number: string | null }

export async function postCreditNote(id: string): Promise<CreditPostResult> {
  return unwrap(await supabase.rpc('post_credit_note', { p_id: id }), 'creditNotes.post') as unknown as CreditPostResult
}

export async function cancelCreditNote(id: string, reason: string): Promise<void> {
  unwrap(await supabase.rpc('cancel_credit_note', { p_id: id, p_reason: reason }), 'creditNotes.cancel')
}

/** Applies unused credit to invoices: the chosen ones, or oldest-due-first when none are named. */
export async function applyCreditNote(id: string, allocations?: { invoice_id: string; amount: number }[]): Promise<number> {
  const r = unwrap(await supabase.rpc('apply_credit_note', { p_id: id, p_allocations: (allocations ?? undefined) as unknown as never }), 'creditNotes.apply') as unknown as { applied: number }
  return Number(r.applied)
}
