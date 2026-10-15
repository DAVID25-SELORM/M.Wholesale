import { supabase } from '@/lib/supabase'
import { unwrap } from './common'

// ---- sales report -----------------------------------------------------------------------------------------------------
export const REPORT_GROUPS = ['DAY', 'MONTH', 'PRODUCT', 'CATEGORY', 'CUSTOMER', 'BRANCH'] as const
export type ReportGroup = (typeof REPORT_GROUPS)[number]
export const REPORT_GROUP_LABEL: Record<ReportGroup, string> = {
  DAY: 'Day', MONTH: 'Month', PRODUCT: 'Product', CATEGORY: 'Category', CUSTOMER: 'Customer', BRANCH: 'Branch',
}

export interface SalesReportRow {
  group_key: string
  group_label: string
  invoices: number
  units: number
  sales: number
  credits: number
  net_sales: number
  tax: number
  /** null when the caller may not see cost */
  cost: number | null
  margin: number | null
  margin_pct: number | null
  uncosted_lines: number | null
}

export async function getSalesReport(from: string, to: string, group: ReportGroup, branchId: string | null): Promise<SalesReportRow[]> {
  const rows = unwrap(await supabase.rpc('sales_report', { p_from: from, p_to: to, p_group: group, p_branch_id: branchId as unknown as string }), 'reports.sales')
  const n = (v: number | null) => (v === null || v === undefined ? null : Number(v))
  return rows.map((r) => ({
    group_key: r.group_key, group_label: r.group_label, invoices: Number(r.invoices), units: Number(r.units), sales: Number(r.sales), credits: Number(r.credits),
    net_sales: Number(r.net_sales), tax: Number(r.tax), cost: n(r.cost), margin: n(r.margin), margin_pct: n(r.margin_pct), uncosted_lines: n(r.uncosted_lines),
  }))
}

// ---- controlled-drugs register ----------------------------------------------------------------------------------------
export interface ControlledSummaryRow { product_id: string; sku: string; product_name: string; opening: number; received: number; issued: number; adjusted: number; closing: number }

export async function getControlledSummary(from: string, to: string, warehouseId: string | null): Promise<ControlledSummaryRow[]> {
  const rows = unwrap(await supabase.rpc('controlled_drug_summary', { p_from: from, p_to: to, p_warehouse_id: warehouseId as unknown as string }), 'register.summary')
  return rows.map((r) => ({ ...r, opening: Number(r.opening), received: Number(r.received), issued: Number(r.issued), adjusted: Number(r.adjusted), closing: Number(r.closing) }))
}

export interface RegisterLine {
  line_no: number
  is_opening: boolean
  posted_at: string
  document_number: string | null
  document_type: string | null
  movement_type: string
  warehouse_name: string | null
  batch_number: string | null
  expiry_date: string | null
  stock_status: string | null
  quantity: number | null
  balance: number
  counterparty: string | null
  licence_number: string | null
  reference: string | null
  posted_by_name: string | null
  notes: string | null
}

export async function getControlledRegister(productId: string, from: string, to: string, warehouseId: string | null): Promise<RegisterLine[]> {
  const rows = unwrap(
    await supabase.rpc('controlled_drug_register', { p_product_id: productId, p_from: from, p_to: to, p_warehouse_id: warehouseId as unknown as string }),
    'register.lines',
  )
  return rows.map((r) => ({ ...r, line_no: Number(r.line_no), quantity: r.quantity === null ? null : Number(r.quantity), balance: Number(r.balance) }))
}

// ---- payment reminders ------------------------------------------------------------------------------------------------
export const REMINDER_CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP', 'PHONE', 'LETTER'] as const
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number]
export const REMINDER_CHANNEL_LABEL: Record<ReminderChannel, string> = { EMAIL: 'E-mail', SMS: 'SMS', WHATSAPP: 'WhatsApp', PHONE: 'Phone call', LETTER: 'Letter' }
export const REMINDER_LEVEL_LABEL: Record<number, string> = { 1: 'Friendly reminder', 2: 'Firm reminder', 3: 'Final notice' }

export interface OverdueCustomer {
  customer_id: string
  customer_name: string
  phone: string | null
  email: string | null
  contact_name: string | null
  overdue_amount: number
  invoices: number
  oldest_days: number
  on_hold: boolean
  last_reminder_at: string | null
  last_level: number | null
  suggested_level: number | null
}

export async function listOverdueCustomers(minDays = 1): Promise<OverdueCustomer[]> {
  const rows = unwrap(await supabase.rpc('overdue_customers', { p_min_days: minDays }), 'reminders.overdue')
  return rows.map((r) => ({ ...r, overdue_amount: Number(r.overdue_amount), invoices: Number(r.invoices), oldest_days: Number(r.oldest_days) }))
}

export interface OverdueInvoice { id: string; invoice_number: string | null; invoice_date: string; due_date: string | null; balance_due: number }

export async function listOverdueInvoices(customerId: string): Promise<OverdueInvoice[]> {
  const today = new Date().toISOString().slice(0, 10)
  const rows = unwrap(
    await supabase.from('sales_invoices').select('id, invoice_number, invoice_date, due_date, balance_due').eq('customer_id', customerId).eq('status', 'POSTED').gt('balance_due', 0).lt('due_date', today).order('due_date'),
    'reminders.invoices',
  )
  return rows.map((r) => ({ ...r, balance_due: Number(r.balance_due) }))
}

export interface ReminderRow {
  id: string
  level: number
  channel: ReminderChannel
  message: string
  overdue_amount: number
  sent_at: string
  sent_by: string | null
}

export async function listReminders(customerId: string): Promise<ReminderRow[]> {
  const rows = unwrap(
    await supabase.from('payment_reminders').select('id, level, channel, message, overdue_amount, sent_at, sent_by').eq('customer_id', customerId).order('sent_at', { ascending: false }).limit(50),
    'reminders.list',
  )
  return rows.map((r) => ({ ...r, channel: r.channel as ReminderChannel, overdue_amount: Number(r.overdue_amount) }))
}

export async function recordReminder(i: { customerId: string; level: number; channel: ReminderChannel; message: string; invoiceIds: string[] }): Promise<string> {
  return unwrap(
    await supabase.rpc('record_payment_reminder', { p_customer_id: i.customerId, p_level: i.level, p_channel: i.channel, p_message: i.message, p_invoice_ids: i.invoiceIds }),
    'reminders.record',
  ) as string
}
