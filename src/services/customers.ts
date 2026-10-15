import { supabase } from '@/lib/supabase'
import { sanitizeForOrFilter } from '@/lib/utils'
import type { PageParams, Paged, Tables } from '@/types/domain'
import type { ActiveFilter } from './branches'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'

export type Customer = Tables<'customers'>

export const CUSTOMER_TYPES = ['PHARMACY', 'HOSPITAL', 'CLINIC', 'WHOLESALER', 'RETAILER', 'OTHER'] as const
export type CustomerType = (typeof CUSTOMER_TYPES)[number]
export const CUSTOMER_TYPE_LABEL: Record<CustomerType, string> = {
  PHARMACY: 'Pharmacy', HOSPITAL: 'Hospital', CLINIC: 'Clinic', WHOLESALER: 'Wholesaler', RETAILER: 'Retailer (general goods)', OTHER: 'Other',
}
/** Types that may buy prescription-only, pharmacy-only and controlled medicines (the database enforces the same rule). */
export const MEDICINE_BUYERS: readonly CustomerType[] = ['PHARMACY', 'HOSPITAL', 'CLINIC', 'WHOLESALER']

export interface CustomerListParams extends PageParams {
  search: string
  status: ActiveFilter
  sortKey: 'name' | 'code' | 'licence_expiry'
  sortDirection: 'asc' | 'desc'
}

export interface CustomerInput {
  code: string
  name: string
  customer_type: CustomerType
  licence_number?: string | undefined
  licence_expiry?: string | undefined
  registered_pharmacist?: string | undefined
  controlled_drugs_authorised: boolean
  tax_number?: string | undefined
  contact_name?: string | undefined
  phone?: string | undefined
  email?: string | undefined
  address?: string | undefined
  city?: string | undefined
  region?: string | undefined
  country?: string | undefined
  payment_terms_days: number
  credit_limit: number
  price_list_id: string | null
  min_shelf_life_days: number
  on_hold: boolean
  hold_reason?: string | undefined
  notes?: string | undefined
  is_active: boolean
}

export async function listCustomers(p: CustomerListParams): Promise<Paged<Customer>> {
  let q = supabase.from('customers').select('*', { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`name.ilike.%${s}%,code.ilike.%${s}%,licence_number.ilike.%${s}%,contact_name.ilike.%${s}%,phone.ilike.%${s}%`)
  if (p.status !== 'all') q = q.eq('is_active', p.status === 'active')
  const [from, to] = rangeFor(p)
  return unwrapPaged(await q.order(p.sortKey, { ascending: p.sortDirection === 'asc', nullsFirst: false }).order('id').range(from, to), 'customers.list', p)
}

export type CustomerOption = Pick<Customer, 'id' | 'code' | 'name' | 'is_active' | 'on_hold' | 'hold_reason' | 'payment_terms_days' | 'credit_limit' | 'customer_type' | 'licence_expiry' | 'price_list_id'>

export async function listCustomerOptions(): Promise<CustomerOption[]> {
  return unwrap(
    await supabase.from('customers').select('id, code, name, is_active, on_hold, hold_reason, payment_terms_days, credit_limit, customer_type, licence_expiry, price_list_id').order('name').limit(2000),
    'customers.options',
  )
}

export async function getCustomer(id: string): Promise<Customer | null> {
  return unwrap(await supabase.from('customers').select('*').eq('id', id).maybeSingle(), 'customers.get')
}

const row = (i: CustomerInput) => ({
  code: i.code.trim().toUpperCase(),
  name: i.name.trim(),
  customer_type: i.customer_type,
  licence_number: emptyToNull(i.licence_number),
  licence_expiry: emptyToNull(i.licence_expiry),
  registered_pharmacist: emptyToNull(i.registered_pharmacist),
  controlled_drugs_authorised: i.controlled_drugs_authorised,
  tax_number: emptyToNull(i.tax_number),
  contact_name: emptyToNull(i.contact_name),
  phone: emptyToNull(i.phone),
  email: emptyToNull(i.email),
  address: emptyToNull(i.address),
  city: emptyToNull(i.city),
  region: emptyToNull(i.region),
  country: emptyToNull(i.country?.toUpperCase()),
  payment_terms_days: i.payment_terms_days,
  credit_limit: i.credit_limit,
  price_list_id: i.price_list_id,
  min_shelf_life_days: i.min_shelf_life_days,
  on_hold: i.on_hold,
  hold_reason: i.on_hold ? emptyToNull(i.hold_reason) : null,
  notes: emptyToNull(i.notes),
  is_active: i.is_active,
})

export async function createCustomer(i: CustomerInput): Promise<string> {
  return (unwrap(await supabase.from('customers').insert(row(i)).select('id').single(), 'customers.create') as { id: string }).id
}
export async function updateCustomer(id: string, i: CustomerInput): Promise<void> {
  unwrap(await supabase.from('customers').update(row(i)).eq('id', id).select('id').single(), 'customers.update')
}
export async function setCustomerActive(id: string, isActive: boolean): Promise<void> {
  unwrap(await supabase.from('customers').update({ is_active: isActive }).eq('id', id).select('id').single(), 'customers.setActive')
}

export interface CustomerCredit {
  outstanding: number
  overdue: number
  credit_held: number
  credit_limit: number
  available: number
  on_hold: boolean
}

export async function getCustomerCredit(customerId: string): Promise<CustomerCredit | null> {
  const rows = unwrap(await supabase.rpc('customer_credit', { p_customer_id: customerId }), 'customers.credit')
  const r = rows[0]
  return r ? {
    outstanding: Number(r.outstanding), overdue: Number(r.overdue), credit_held: Number(r.credit_held), credit_limit: Number(r.credit_limit),
    available: Number(r.available), on_hold: r.on_hold,
  } : null
}

export interface StatementRow {
  entry_date: string
  entry_type: 'INVOICE' | 'RECEIPT'
  reference: string
  description: string
  debit: number
  credit: number
  balance: number
}

export async function getCustomerStatement(customerId: string, from?: string): Promise<StatementRow[]> {
  const rows = unwrap(await supabase.rpc('customer_statement', { p_customer_id: customerId, p_from: from || undefined }), 'customers.statement')
  return rows.map((r) => ({
    entry_date: r.entry_date, entry_type: r.entry_type as StatementRow['entry_type'], reference: r.reference, description: r.description,
    debit: Number(r.debit), credit: Number(r.credit), balance: Number(r.balance),
  }))
}

/** Days until the licence expires (negative = expired); null when no expiry is recorded. */
export function licenceDaysLeft(expiry: string | null, today = new Date()): number | null {
  if (!expiry) return null
  const end = new Date(`${expiry}T00:00:00Z`).getTime()
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((end - start) / 86_400_000)
}
