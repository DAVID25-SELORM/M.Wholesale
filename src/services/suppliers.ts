import { supabase } from '@/lib/supabase'
import { sanitizeForOrFilter } from '@/lib/utils'
import type { PageParams, Paged, Tables } from '@/types/domain'
import type { ActiveFilter } from './branches'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'

export type Supplier = Tables<'suppliers'>
export type SupplierProduct = Tables<'supplier_products'>

export const SUPPLIER_TYPES = ['MANUFACTURER', 'IMPORTER', 'DISTRIBUTOR', 'WHOLESALER', 'OTHER'] as const
export type SupplierType = (typeof SUPPLIER_TYPES)[number]

export interface SupplierListParams extends PageParams {
  search: string
  status: ActiveFilter
  sortKey: 'name' | 'code' | 'licence_expiry'
  sortDirection: 'asc' | 'desc'
}

export interface SupplierInput {
  code: string
  name: string
  supplier_type: SupplierType
  registration_number?: string | undefined
  tax_number?: string | undefined
  licence_number?: string | undefined
  licence_expiry?: string | undefined
  payment_terms_days: number
  currency_code?: string | undefined
  contact_name?: string | undefined
  phone?: string | undefined
  email?: string | undefined
  address?: string | undefined
  city?: string | undefined
  region?: string | undefined
  country?: string | undefined
  notes?: string | undefined
  is_active: boolean
}

export async function listSuppliers(p: SupplierListParams): Promise<Paged<Supplier>> {
  let q = supabase.from('suppliers').select('*', { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`name.ilike.%${s}%,code.ilike.%${s}%,licence_number.ilike.%${s}%,contact_name.ilike.%${s}%`)
  if (p.status !== 'all') q = q.eq('is_active', p.status === 'active')
  const [from, to] = rangeFor(p)
  return unwrapPaged(
    await q.order(p.sortKey, { ascending: p.sortDirection === 'asc', nullsFirst: false }).order('id').range(from, to),
    'suppliers.list',
    p,
  )
}

export async function listSupplierOptions(): Promise<Pick<Supplier, 'id' | 'code' | 'name' | 'is_active'>[]> {
  return unwrap(await supabase.from('suppliers').select('id, code, name, is_active').order('name').limit(1000), 'suppliers.options')
}

const row = (i: SupplierInput) => ({
  code: i.code.trim().toUpperCase(),
  name: i.name.trim(),
  supplier_type: i.supplier_type,
  registration_number: emptyToNull(i.registration_number),
  tax_number: emptyToNull(i.tax_number),
  licence_number: emptyToNull(i.licence_number),
  licence_expiry: emptyToNull(i.licence_expiry),
  payment_terms_days: i.payment_terms_days,
  currency_code: emptyToNull(i.currency_code?.toUpperCase()),
  contact_name: emptyToNull(i.contact_name),
  phone: emptyToNull(i.phone),
  email: emptyToNull(i.email),
  address: emptyToNull(i.address),
  city: emptyToNull(i.city),
  region: emptyToNull(i.region),
  country: emptyToNull(i.country?.toUpperCase()),
  notes: emptyToNull(i.notes),
  is_active: i.is_active,
})

export async function createSupplier(i: SupplierInput): Promise<void> {
  unwrap(await supabase.from('suppliers').insert(row(i)).select('id').single(), 'suppliers.create')
}
export async function updateSupplier(id: string, i: SupplierInput): Promise<void> {
  unwrap(await supabase.from('suppliers').update(row(i)).eq('id', id).select('id').single(), 'suppliers.update')
}
export async function setSupplierActive(id: string, isActive: boolean): Promise<void> {
  unwrap(await supabase.from('suppliers').update({ is_active: isActive }).eq('id', id).select('id').single(), 'suppliers.setActive')
}

// ---- supplier price list ------------------------------------------------------------------------------------
export interface SupplierProductRow extends SupplierProduct {
  // the product is reached through the pack level (composite FK keeps product, unit and organization consistent)
  product_unit: {
    factor_to_base: number
    unit: { code: string; name: string } | null
    product: { sku: string; brand_name: string } | null
  } | null
}

const SP_SELECT = '*, product_unit:product_units(factor_to_base, unit:units_of_measure(code, name), product:products(sku, brand_name))'

export async function listSupplierProducts(supplierId: string): Promise<SupplierProductRow[]> {
  const rows = unwrap(await supabase.from('supplier_products').select(SP_SELECT).eq('supplier_id', supplierId).order('created_at'), 'supplierProducts.list')
  return rows as unknown as SupplierProductRow[]
}

export interface ProductSupplierRow extends SupplierProduct {
  supplier: { code: string; name: string } | null
  product_unit: { factor_to_base: number; unit: { code: string; name: string } | null } | null
}

export async function listProductSuppliers(productId: string): Promise<ProductSupplierRow[]> {
  const rows = unwrap(
    await supabase.from('supplier_products').select('*, supplier:suppliers!supplier_products_supplier_fk(code, name), product_unit:product_units(factor_to_base, unit:units_of_measure(code, name))').eq('product_id', productId).order('created_at'),
    'productSuppliers.list',
  )
  return rows as unknown as ProductSupplierRow[]
}

export interface SupplierProductInput {
  supplier_id: string
  product_id: string
  product_unit_id: string
  supplier_sku?: string | undefined
  supplier_product_name?: string | undefined
  last_cost?: number | null | undefined
  lead_time_days?: number | null | undefined
  min_order_quantity?: number | null | undefined
  is_preferred: boolean
  is_active: boolean
}

export async function createSupplierProduct(i: SupplierProductInput): Promise<void> {
  unwrap(
    await supabase.from('supplier_products').insert({
      supplier_id: i.supplier_id, product_id: i.product_id, product_unit_id: i.product_unit_id,
      supplier_sku: emptyToNull(i.supplier_sku), supplier_product_name: emptyToNull(i.supplier_product_name),
      last_cost: i.last_cost ?? null, lead_time_days: i.lead_time_days ?? null, min_order_quantity: i.min_order_quantity ?? null,
      is_preferred: i.is_preferred, is_active: i.is_active,
    }).select('id').single(),
    'supplierProducts.create',
  )
}

export async function updateSupplierProduct(id: string, i: Omit<SupplierProductInput, 'supplier_id' | 'product_id' | 'product_unit_id'>): Promise<void> {
  unwrap(
    await supabase.from('supplier_products').update({
      supplier_sku: emptyToNull(i.supplier_sku), supplier_product_name: emptyToNull(i.supplier_product_name),
      last_cost: i.last_cost ?? null, lead_time_days: i.lead_time_days ?? null, min_order_quantity: i.min_order_quantity ?? null,
      is_preferred: i.is_preferred, is_active: i.is_active,
    }).eq('id', id).select('id').single(),
    'supplierProducts.update',
  )
}
