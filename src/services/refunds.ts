import { supabase } from '@/lib/supabase'
import { sanitizeForOrFilter } from '@/lib/utils'
import type { PageParams, Paged, Tables } from '@/types/domain'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'
import type { ReceiptMethod } from './sales'

export type CustomerRefund = Tables<'customer_refunds'> & {
  customer: { code: string; name: string } | null
  credit_note: { credit_note_number: string | null } | null
  receipt: { receipt_number: string } | null
}

const SELECT =
  '*, customer:customers!customer_refunds_customer_fk(code, name), credit_note:sales_credit_notes!customer_refunds_credit_note_fk(credit_note_number), receipt:customer_receipts!customer_refunds_receipt_fk(receipt_number)'

export interface RefundListParams extends PageParams {
  search: string
  customerId: string
}

export async function listRefunds(p: RefundListParams): Promise<Paged<CustomerRefund>> {
  let q = supabase.from('customer_refunds').select(SELECT, { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`refund_number.ilike.%${s}%,reference.ilike.%${s}%`)
  if (p.customerId) q = q.eq('customer_id', p.customerId)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('created_at', { ascending: false }).order('id').range(from, to), 'refunds.list', p)
  return { ...res, rows: res.rows as unknown as CustomerRefund[] }
}

export type RefundSource = 'CREDIT_NOTE' | 'RECEIPT'

export async function refundCustomer(i: {
  sourceType: RefundSource
  sourceId: string
  amount: number
  method: ReceiptMethod
  reference?: string
  notes?: string
  posSessionId?: string | null
}): Promise<{ refund_number: string; amount: number }> {
  const r = unwrap(
    await supabase.rpc('refund_customer', {
      p_source_type: i.sourceType, p_source_id: i.sourceId, p_amount: i.amount, p_method: i.method,
      p_reference: emptyToNull(i.reference) as unknown as string, p_notes: emptyToNull(i.notes) ?? undefined, p_pos_session_id: (i.posSessionId ?? undefined) as string | undefined,
    }),
    'refunds.create',
  ) as unknown as { refund_number: string; amount: number }
  return { refund_number: r.refund_number, amount: Number(r.amount) }
}

/** A customer's posted payments with money not applied to any invoice and not refunded. */
export async function listUnallocatedReceipts(customerId: string): Promise<Tables<'customer_receipts'>[]> {
  return unwrap(
    await supabase.from('customer_receipts').select('*').eq('customer_id', customerId).eq('status', 'POSTED').gt('unallocated_amount', 0).order('created_at').limit(100),
    'refunds.unallocated',
  )
}
