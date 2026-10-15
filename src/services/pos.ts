import { supabase } from '@/lib/supabase'
import type { PageParams, Paged, Tables } from '@/types/domain'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'
import type { ReceiptMethod, SaveSalesLine } from './sales'

export type PosSession = Tables<'pos_sessions'> & {
  warehouse: { code: string; name: string } | null
  branch: { name: string } | null
}

const SESSION_SELECT = '*, warehouse:warehouses!pos_sessions_warehouse_fk(code, name), branch:branches!pos_sessions_branch_fk(name)'

/** The signed-in cashier's open till session, if any. */
export async function getMyOpenSession(userId: string): Promise<PosSession | null> {
  const res = await supabase.from('pos_sessions').select(SESSION_SELECT).eq('cashier_id', userId).eq('status', 'OPEN').maybeSingle()
  return unwrap(res, 'pos.mySession') as unknown as PosSession | null
}

export async function getPosSession(id: string): Promise<PosSession | null> {
  const res = await supabase.from('pos_sessions').select(SESSION_SELECT).eq('id', id).maybeSingle()
  return unwrap(res, 'pos.session') as unknown as PosSession | null
}

export interface SessionListParams extends PageParams {
  status: 'OPEN' | 'CLOSED' | ''
  /** only sessions whose cash did not match */
  varianceOnly: boolean
}

export async function listPosSessions(p: SessionListParams): Promise<Paged<PosSession>> {
  let q = supabase.from('pos_sessions').select(SESSION_SELECT, { count: 'exact' })
  if (p.status) q = q.eq('status', p.status)
  if (p.varianceOnly) q = q.eq('status', 'CLOSED').neq('variance', 0)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('opened_at', { ascending: false }).order('id').range(from, to), 'pos.sessions', p)
  return { ...res, rows: res.rows as unknown as PosSession[] }
}

export async function openPosSession(warehouseId: string, openingFloat: number): Promise<string> {
  return unwrap(await supabase.rpc('open_pos_session', { p_warehouse_id: warehouseId, p_opening_float: openingFloat }), 'pos.open') as string
}

export interface SessionSummary {
  sales_count: number
  sales_total: number
  cash_in: number
  opening_float: number
  expected_cash: number
  by_method: { method: ReceiptMethod; payments: number; amount: number }[]
}

export async function getSessionSummary(sessionId: string): Promise<SessionSummary> {
  const r = unwrap(await supabase.rpc('pos_session_summary', { p_session_id: sessionId }), 'pos.summary') as unknown as SessionSummary
  return {
    sales_count: Number(r.sales_count), sales_total: Number(r.sales_total), cash_in: Number(r.cash_in), opening_float: Number(r.opening_float),
    expected_cash: Number(r.expected_cash), by_method: (r.by_method ?? []).map((m) => ({ method: m.method, payments: Number(m.payments), amount: Number(m.amount) })),
  }
}

export interface CloseResult { expected_cash: number; counted_cash: number; variance: number; sales_count: number; sales_total: number }

export async function closePosSession(id: string, countedCash: number, notes?: string): Promise<CloseResult> {
  return unwrap(await supabase.rpc('close_pos_session', { p_id: id, p_counted_cash: countedCash, p_notes: emptyToNull(notes) ?? undefined }), 'pos.close') as unknown as CloseResult
}

export type PosSaleRow = Tables<'pos_sales'> & {
  invoice: { invoice_number: string | null } | null
  customer: { name: string } | null
}

export async function listPosSales(sessionId: string): Promise<PosSaleRow[]> {
  const rows = unwrap(
    await supabase
      .from('pos_sales')
      .select('*, invoice:sales_invoices!pos_sales_invoice_fk(invoice_number), customer:customers!pos_sales_customer_fk(name)')
      .eq('pos_session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(200),
    'pos.sales',
  )
  return rows as unknown as PosSaleRow[]
}

/** The built-in cash customer. */
export async function getWalkInCustomer(): Promise<{ id: string; name: string } | null> {
  const res = await supabase.from('customers').select('id, name').eq('is_walk_in', true).maybeSingle()
  return unwrap(res, 'pos.walkIn')
}

export interface PosPayment { method: ReceiptMethod; amount: number; reference?: string }

export interface CheckoutResult {
  pos_sale_id: string
  invoice_id: string
  invoice_number: string
  total_amount: number
  paid: number
  owed: number
  cash_tendered: number
  change: number
  receipt_numbers: string[]
  overridden: boolean
}

export async function posCheckout(i: {
  sessionId: string
  customerId: string | null
  lines: SaveSalesLine[]
  payments: PosPayment[]
  overrideReason?: string
}): Promise<CheckoutResult> {
  const r = unwrap(
    await supabase.rpc('pos_checkout', {
      p_session_id: i.sessionId, p_customer_id: i.customerId as unknown as string, p_lines: i.lines as unknown as never, p_payments: i.payments as unknown as never,
      p_override_reason: emptyToNull(i.overrideReason) ?? undefined,
    }),
    'pos.checkout',
  ) as unknown as CheckoutResult
  return { ...r, total_amount: Number(r.total_amount), paid: Number(r.paid), owed: Number(r.owed), cash_tendered: Number(r.cash_tendered), change: Number(r.change) }
}
