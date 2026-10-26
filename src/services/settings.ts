import { supabase } from '@/lib/supabase'
import type { Json } from '@/types/database'
import { unwrap } from './common'

// The registry of supported settings lives in the database (private.setting_defs); this file only reads and writes through the checked functions.

export type SettingValue = string | number | null
export type AppSettings = Record<string, SettingValue>

/** What the screens use when the server cannot be reached; they match the database defaults. */
export const SETTING_DEFAULTS: AppSettings = {
  'invoice.footer': '',
  'invoice.payment_instructions': '',
  'sales.default_payment_terms_days': 0,
  'sales.quotation_validity_days': 30,
  'credit.default_credit_limit': 0,
  'purchasing.default_payment_terms_days': 30,
  'inventory.near_expiry_days': 90,
  'inventory.default_sales_warehouse': null,
  'security.idle_timeout_minutes': 0,
  'fleet.expiry_warning_days': 30,
}

/** Effective values for the signed-in member's organization (and the given branch's overrides). Open to every member; settings never hold secrets. */
export async function getAppSettings(branchId: string | null): Promise<AppSettings> {
  const raw = unwrap(await supabase.rpc('app_settings', { p_branch_id: branchId as unknown as string }), 'settings.app') as unknown as AppSettings
  return { ...SETTING_DEFAULTS, ...raw }
}

let cache: { key: string; at: number; value: Promise<AppSettings> } | null = null
/** For code that is not a component (PDF builders): a short-lived cached read. */
export function fetchAppSettings(branchId: string | null = null): Promise<AppSettings> {
  const key = branchId ?? ''
  if (cache && cache.key === key && Date.now() - cache.at < 30_000) return cache.value
  const value = getAppSettings(branchId).catch(() => ({ ...SETTING_DEFAULTS }))
  cache = { key, at: Date.now(), value }
  return value
}
export const clearSettingsCache = () => { cache = null }

export interface SettingRow {
  category: string; key: string; kind: 'text' | 'int' | 'number' | 'warehouse'
  min_num: number | null; max_num: number | null; min_nonzero: number | null; max_len: number | null
  branch_scoped: boolean; sensitive: boolean; default_value: SettingValue; value: SettingValue
  source: 'default' | 'organization' | 'branch'; updated_at: string | null
}

export async function getSettingsOverview(branchId: string | null): Promise<SettingRow[]> {
  const rows = unwrap(await supabase.rpc('settings_overview', { p_branch_id: branchId as unknown as string }), 'settings.overview')
  return rows.map((r) => ({
    ...r, kind: r.kind as SettingRow['kind'], min_num: r.min_num === null ? null : Number(r.min_num), max_num: r.max_num === null ? null : Number(r.max_num),
    min_nonzero: r.min_nonzero === null ? null : Number(r.min_nonzero), source: r.source as SettingRow['source'],
    default_value: r.default_value as SettingValue, value: r.value as SettingValue,
  }))
}

/** value null = back to the default (the saved value is removed). Sensitive settings need a reason. */
export async function saveSetting(i: { category: string; key: string; value: SettingValue; branchId?: string | null; reason?: string }): Promise<void> {
  unwrap(await supabase.rpc('save_setting', {
    p_category: i.category, p_key: i.key, p_value: i.value as Json, p_branch_id: (i.branchId ?? null) as unknown as string, p_reason: i.reason?.trim() ? i.reason.trim() : (null as unknown as string),
  }), 'settings.save')
  clearSettingsCache()
}

export interface NumberingRow { document_type: string; prefix: string; padding: number; reset_period: 'NEVER' | 'YEARLY' | 'MONTHLY'; next_number: number; configured: boolean; in_use: boolean }

export async function getNumberingOverview(): Promise<NumberingRow[]> {
  return unwrap(await supabase.rpc('numbering_overview'), 'settings.numbering').map((r) => ({ ...r, reset_period: r.reset_period as NumberingRow['reset_period'], next_number: Number(r.next_number) }))
}

export async function configureNumbering(i: { documentType: string; prefix: string; padding: number; resetPeriod: string }): Promise<void> {
  unwrap(await supabase.rpc('configure_document_numbering', { p_document_type: i.documentType, p_prefix: i.prefix.trim(), p_padding: i.padding, p_reset_period: i.resetPeriod }), 'settings.configureNumbering')
}

export const DOCUMENT_LABEL: Record<string, string> = {
  SALES_QUOTATION: 'Quotations', SALES_ORDER: 'Sales orders', SALES_INVOICE: 'Sales invoices', CREDIT_NOTE: 'Credit notes', CUSTOMER_RECEIPT: 'Payments received',
  CUSTOMER_REFUND: 'Customer refunds', DELIVERY_NOTE: 'Delivery notes', POS_SESSION: 'Till shifts', PURCHASE_ORDER: 'Purchase orders', GOODS_RECEIPT: 'Goods received',
  PURCHASE_RETURN: 'Purchase returns', SUPPLIER_INVOICE: 'Supplier invoices', STOCK_TRANSFER: 'Stock transfers', STOCK_COUNT: 'Stock counts', JOURNAL: 'Journals',
  CONTROLLED_ADJUSTMENT: 'Controlled adjustments',
  FULFILMENT_ORDER: 'Fulfilment orders', PACKAGE: 'Packages', DELIVERY_RUN: 'Delivery runs', RECALL: 'Recalls',
}

/** What a number will look like, for the preview next to the form (the database builds the real ones the same way). */
export function numberExample(prefix: string, padding: number, reset: string, n = 1, now = new Date()): string {
  const period = reset === 'YEARLY' ? String(now.getFullYear()) : reset === 'MONTHLY' ? `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}` : ''
  return `${prefix || '…'}-${period ? `${period}-` : ''}${String(n).padStart(padding, '0')}`
}
