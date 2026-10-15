import { supabase } from '@/lib/supabase'
import { unwrap } from './common'

// ---- stock insights -----------------------------------------------------------------------------------------------------
export interface ReorderRow {
  product_id: string; sku: string; product_name: string; base_unit: string; on_hand: number; reserved: number; free: number; on_order: number
  avg_daily: number; days_cover: number | null; lead_time_days: number; target_stock: number; suggested_qty: number; supplier_name: string | null
}

export async function getReorderSuggestions(warehouseId: string | null, historyDays: number, coverDays: number): Promise<ReorderRow[]> {
  const rows = unwrap(await supabase.rpc('reorder_suggestions', { p_warehouse_id: warehouseId as unknown as string, p_history_days: historyDays, p_cover_days: coverDays }), 'insights.reorder')
  return rows.map((r) => ({
    ...r, on_hand: Number(r.on_hand), reserved: Number(r.reserved), free: Number(r.free), on_order: Number(r.on_order), avg_daily: Number(r.avg_daily),
    days_cover: r.days_cover === null ? null : Number(r.days_cover), target_stock: Number(r.target_stock), suggested_qty: Number(r.suggested_qty),
  }))
}

export interface SlowRow {
  product_id: string; sku: string; product_name: string; base_unit: string; on_hand: number; stock_value: number | null
  last_sale_date: string | null; days_since_sale: number | null; earliest_expiry: string | null
}

export async function getSlowMoving(days: number): Promise<SlowRow[]> {
  const rows = unwrap(await supabase.rpc('slow_moving_stock', { p_days: days }), 'insights.slow')
  return rows.map((r) => ({ ...r, on_hand: Number(r.on_hand), stock_value: r.stock_value === null ? null : Number(r.stock_value) }))
}

export interface ExpiryRiskRow {
  product_id: string; sku: string; product_name: string; batch_number: string; expiry_date: string; days_left: number; quantity: number; avg_daily: number
  expected_sales: number; at_risk_qty: number; value_at_risk: number | null
}

export async function getExpiryRisk(horizonDays: number, historyDays: number, warehouseId: string | null): Promise<ExpiryRiskRow[]> {
  const rows = unwrap(await supabase.rpc('expiry_risk', { p_horizon_days: horizonDays, p_history_days: historyDays, p_warehouse_id: warehouseId as unknown as string }), 'insights.expiry')
  return rows.map((r) => ({
    ...r, quantity: Number(r.quantity), avg_daily: Number(r.avg_daily), expected_sales: Number(r.expected_sales), at_risk_qty: Number(r.at_risk_qty),
    value_at_risk: r.value_at_risk === null ? null : Number(r.value_at_risk),
  }))
}

// ---- VAT ----------------------------------------------------------------------------------------------------------------
export interface VatRow { section: 'OUTPUT' | 'INPUT'; tax_code: string; tax_name: string; rate: number | null; taxable: number; tax: number }

export async function getVatReport(from: string, to: string, branchId: string | null): Promise<VatRow[]> {
  const rows = unwrap(await supabase.rpc('vat_report', { p_from: from, p_to: to, p_branch_id: branchId as unknown as string }), 'reports.vat')
  return rows.map((r) => ({
    section: r.section as VatRow['section'], tax_code: r.tax_code, tax_name: r.tax_name, rate: r.rate === null ? null : Number(r.rate), taxable: Number(r.taxable), tax: Number(r.tax),
  }))
}
