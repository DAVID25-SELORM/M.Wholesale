import { supabase } from '@/lib/supabase'
import type { Tables } from '@/types/domain'
import { emptyToNull, unwrap } from './common'

// ---- tax codes ------------------------------------------------------------------------------------------------------
export type TaxCode = Tables<'tax_codes'>

export async function listTaxCodes(): Promise<TaxCode[]> {
  return unwrap(await supabase.from('tax_codes').select('*').order('is_default', { ascending: false }).order('name'), 'taxCodes.list')
}

export interface TaxCodeInput { code: string; name: string; rate: number; is_default: boolean; is_active: boolean }

export async function createTaxCode(i: TaxCodeInput): Promise<void> {
  unwrap(await supabase.from('tax_codes').insert({ code: i.code.trim().toUpperCase(), name: i.name.trim(), rate: i.rate, is_default: i.is_default, is_active: i.is_active }).select('id').single(), 'taxCodes.create')
}
export async function updateTaxCode(id: string, i: Omit<TaxCodeInput, 'code'>): Promise<void> {
  unwrap(await supabase.from('tax_codes').update({ name: i.name.trim(), rate: i.rate, is_default: i.is_default, is_active: i.is_active }).eq('id', id).select('id').single(), 'taxCodes.update')
}

// ---- price lists -----------------------------------------------------------------------------------------------------
export type PriceList = Tables<'price_lists'>

export async function listPriceLists(): Promise<PriceList[]> {
  return unwrap(await supabase.from('price_lists').select('*').order('is_default', { ascending: false }).order('name'), 'priceLists.list')
}

export interface PriceListInput { code: string; name: string; is_default: boolean; is_active: boolean; notes?: string | undefined }

export async function createPriceList(i: PriceListInput): Promise<string> {
  return (unwrap(
    await supabase.from('price_lists').insert({ code: i.code.trim().toUpperCase(), name: i.name.trim(), is_default: i.is_default, is_active: i.is_active, notes: emptyToNull(i.notes) }).select('id').single(),
    'priceLists.create',
  ) as { id: string }).id
}
export async function updatePriceList(id: string, i: Omit<PriceListInput, 'code'>): Promise<void> {
  unwrap(await supabase.from('price_lists').update({ name: i.name.trim(), is_default: i.is_default, is_active: i.is_active, notes: emptyToNull(i.notes) }).eq('id', id).select('id').single(), 'priceLists.update')
}

export interface PriceListItemRow extends Tables<'price_list_items'> {
  product_unit: {
    factor_to_base: number
    unit: { code: string; name: string } | null
    product: { sku: string; brand_name: string } | null
  } | null
}

const ITEM_SELECT = '*, product_unit:product_units!price_list_items_unit_fk(factor_to_base, unit:units_of_measure(code, name), product:products(sku, brand_name))'

export async function listPriceListItems(listId: string): Promise<PriceListItemRow[]> {
  const rows = unwrap(await supabase.from('price_list_items').select(ITEM_SELECT).eq('price_list_id', listId).order('created_at').limit(2000), 'priceListItems.list')
  return rows as unknown as PriceListItemRow[]
}

export async function createPriceListItem(i: { price_list_id: string; product_id: string; product_unit_id: string; unit_price: number }): Promise<void> {
  unwrap(await supabase.from('price_list_items').insert({ ...i, is_active: true }).select('id').single(), 'priceListItems.create')
}
export async function updatePriceListItem(id: string, patch: { unit_price?: number; is_active?: boolean }): Promise<void> {
  unwrap(await supabase.from('price_list_items').update(patch).eq('id', id).select('id').single(), 'priceListItems.update')
}

/** The price of one pack level for a customer (their own list, else the default list); null when neither has one. */
export async function resolvePrice(customerId: string, productUnitId: string): Promise<number | null> {
  const v = unwrap(await supabase.rpc('resolve_price', { p_customer_id: customerId, p_product_unit_id: productUnitId }), 'prices.resolve')
  return v === null || v === undefined ? null : Number(v)
}
