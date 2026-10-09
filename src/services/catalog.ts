import { supabase } from '@/lib/supabase'
import { sanitizeForOrFilter } from '@/lib/utils'
import type { PageParams, Paged, Tables } from '@/types/domain'
import type { ActiveFilter } from './branches'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'

export type Manufacturer = Tables<'manufacturers'>
export type ProductCategory = Tables<'product_categories'>
export type UnitOfMeasure = Tables<'units_of_measure'>
export type DosageForm = Tables<'dosage_forms'>
export type ProductUnit = Tables<'product_units'> & { unit: { code: string; name: string } | null }
export type ProductBarcode = Tables<'product_barcodes'> & { product_unit: { unit: { code: string; name: string } | null } | null }
export type ProductAlias = Tables<'product_aliases'>

export const PRODUCT_CLASSES = ['POM', 'P', 'GSL', 'CONTROLLED', 'MEDICAL_DEVICE', 'CONSUMABLE', 'SUPPLEMENT', 'COSMETIC', 'OTHER'] as const
export type ProductClass = (typeof PRODUCT_CLASSES)[number]
export const PRODUCT_CLASS_LABEL: Record<ProductClass, string> = {
  POM: 'Prescription-only (POM)', P: 'Pharmacy only (P)', GSL: 'General sale (GSL)', CONTROLLED: 'Controlled drug',
  MEDICAL_DEVICE: 'Medical device', CONSUMABLE: 'Consumable', SUPPLEMENT: 'Supplement', COSMETIC: 'Cosmetic', OTHER: 'Other',
}
/** Classes that must have a canonical pharmaceutical identity (mirrors products_identity_required). */
export const IDENTITY_REQUIRED: readonly ProductClass[] = ['POM', 'P', 'GSL', 'CONTROLLED']
export const STORAGE_CONDITIONS = ['AMBIENT', 'COOL', 'REFRIGERATED', 'FROZEN'] as const
export const STORAGE_LABEL: Record<(typeof STORAGE_CONDITIONS)[number], string> = {
  AMBIENT: 'Room temperature', COOL: 'Cool (8–15 °C)', REFRIGERATED: 'Refrigerated (2–8 °C)', FROZEN: 'Frozen',
}

// ---- reference data (global, read-only) --------------------------------------------------------------------
export async function listUnitsOfMeasure(): Promise<UnitOfMeasure[]> {
  return unwrap(await supabase.from('units_of_measure').select('*').eq('is_active', true).order('kind').order('name'), 'units.list')
}
export async function listDosageForms(): Promise<DosageForm[]> {
  return unwrap(await supabase.from('dosage_forms').select('*').eq('is_active', true).order('name'), 'forms.list')
}

// ---- manufacturers --------------------------------------------------------------------------------------------
export interface SimpleListParams extends PageParams { search: string; status: ActiveFilter }
export interface ManufacturerInput { name: string; country?: string | undefined; notes?: string | undefined; is_active: boolean }

export async function listManufacturers(p: SimpleListParams): Promise<Paged<Manufacturer>> {
  let q = supabase.from('manufacturers').select('*', { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.ilike('name', `%${s}%`)
  if (p.status !== 'all') q = q.eq('is_active', p.status === 'active')
  const [from, to] = rangeFor(p)
  return unwrapPaged(await q.order('name').range(from, to), 'manufacturers.list', p)
}
export async function listManufacturerOptions(): Promise<Pick<Manufacturer, 'id' | 'name' | 'is_active'>[]> {
  return unwrap(await supabase.from('manufacturers').select('id, name, is_active').order('name').limit(1000), 'manufacturers.options')
}
const manufacturerRow = (i: ManufacturerInput) => ({
  name: i.name.trim(), country: emptyToNull(i.country?.toUpperCase()), notes: emptyToNull(i.notes), is_active: i.is_active,
})
export async function createManufacturer(i: ManufacturerInput): Promise<void> {
  unwrap(await supabase.from('manufacturers').insert(manufacturerRow(i)).select('id').single(), 'manufacturers.create')
}
export async function updateManufacturer(id: string, i: ManufacturerInput): Promise<void> {
  unwrap(await supabase.from('manufacturers').update(manufacturerRow(i)).eq('id', id).select('id').single(), 'manufacturers.update')
}

// ---- categories ------------------------------------------------------------------------------------------------
export interface CategoryInput { code: string; name: string; is_active: boolean }
export async function listCategories(p: SimpleListParams): Promise<Paged<ProductCategory>> {
  let q = supabase.from('product_categories').select('*', { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`name.ilike.%${s}%,code.ilike.%${s}%`)
  if (p.status !== 'all') q = q.eq('is_active', p.status === 'active')
  const [from, to] = rangeFor(p)
  return unwrapPaged(await q.order('name').range(from, to), 'categories.list', p)
}
export async function listCategoryOptions(): Promise<Pick<ProductCategory, 'id' | 'name' | 'is_active'>[]> {
  return unwrap(await supabase.from('product_categories').select('id, name, is_active').order('name').limit(1000), 'categories.options')
}
const categoryRow = (i: CategoryInput) => ({ code: i.code.trim().toUpperCase(), name: i.name.trim(), is_active: i.is_active })
export async function createCategory(i: CategoryInput): Promise<void> {
  unwrap(await supabase.from('product_categories').insert(categoryRow(i)).select('id').single(), 'categories.create')
}
export async function updateCategory(id: string, i: CategoryInput): Promise<void> {
  unwrap(await supabase.from('product_categories').update(categoryRow(i)).eq('id', id).select('id').single(), 'categories.update')
}

// ---- canonical identities -------------------------------------------------------------------------------------
export type ProductIdentity = Tables<'product_identities'> & { dosage_form: { code: string; name: string } | null }
export interface IdentityInput { generic_name: string; dosage_form_id: string; strength_text: string; notes?: string | undefined; is_active: boolean }

export async function listIdentities(p: SimpleListParams): Promise<Paged<ProductIdentity>> {
  let q = supabase.from('product_identities').select('*, dosage_form:dosage_forms(code, name)', { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`generic_name.ilike.%${s}%,strength_text.ilike.%${s}%`)
  if (p.status !== 'all') q = q.eq('is_active', p.status === 'active')
  const [from, to] = rangeFor(p)
  return unwrapPaged(await q.order('generic_name').order('strength_text').range(from, to), 'identities.list', p) as Paged<ProductIdentity>
}
export async function searchIdentityOptions(search: string): Promise<ProductIdentity[]> {
  let q = supabase.from('product_identities').select('*, dosage_form:dosage_forms(code, name)').eq('is_active', true)
  const s = sanitizeForOrFilter(search)
  if (s) q = q.or(`generic_name.ilike.%${s}%,strength_text.ilike.%${s}%`)
  return unwrap(await q.order('generic_name').limit(50), 'identities.options') as unknown as ProductIdentity[]
}
export async function getIdentity(id: string): Promise<ProductIdentity | null> {
  return unwrap(await supabase.from('product_identities').select('*, dosage_form:dosage_forms(code, name)').eq('id', id).maybeSingle(), 'identities.get') as unknown as ProductIdentity | null
}
const identityRow = (i: IdentityInput) => ({
  generic_name: i.generic_name.trim(), dosage_form_id: i.dosage_form_id, strength_text: i.strength_text.trim(),
  notes: emptyToNull(i.notes), is_active: i.is_active,
})
export async function createIdentity(i: IdentityInput): Promise<string> {
  return (unwrap(await supabase.from('product_identities').insert(identityRow(i)).select('id').single(), 'identities.create') as { id: string }).id
}
export async function updateIdentity(id: string, i: IdentityInput): Promise<void> {
  unwrap(await supabase.from('product_identities').update(identityRow(i)).eq('id', id).select('id').single(), 'identities.update')
}

// ---- products ------------------------------------------------------------------------------------------------
/** One flat shape for both the plain list and search results. */
export interface ProductRow {
  id: string
  sku: string
  brand_name: string
  generic_name: string | null
  strength_text: string | null
  dosage_form: string | null
  manufacturer_name: string | null
  product_class: string
  is_active: boolean
  matched_on?: string
}

export interface ProductListParams extends PageParams {
  search: string
  status: ActiveFilter
  productClass: ProductClass | ''
  categoryId: string
}

const PRODUCT_LIST_SELECT =
  '*, identity:product_identities!products_identity_fk(generic_name, strength_text, dosage_form:dosage_forms(name)), manufacturer:manufacturers!products_manufacturer_fk(name)'

/**
 * Empty search -> a plain, filtered, paginated table query.
 * With text -> the database search function (matches brand, SKU, generic, strength, aliases and exact barcodes);
 * it runs with the caller's RLS, so it can only ever return the caller's organization.
 */
export async function listProducts(p: ProductListParams): Promise<Paged<ProductRow>> {
  const text = p.search.trim()
  if (text) {
    const { data, error } = await supabase.rpc('search_products', { p_query: text, p_limit: p.pageSize + 1, p_offset: p.page * p.pageSize })
    const rows = unwrap({ data, error }, 'products.search').map((r) => ({
      id: r.product_id, sku: r.sku, brand_name: r.brand_name, generic_name: r.generic_name, strength_text: r.strength_text,
      dosage_form: r.dosage_form, manufacturer_name: r.manufacturer_name, product_class: r.product_class,
      is_active: r.is_active, matched_on: r.matched_on,
    }))
    const filtered = rows.filter((r) => (p.status === 'all' || r.is_active === (p.status === 'active')) && (!p.productClass || r.product_class === p.productClass))
    return { rows: filtered.slice(0, p.pageSize), hasNext: rows.length > p.pageSize }
  }
  let q = supabase.from('products').select(PRODUCT_LIST_SELECT, { count: 'exact' })
  if (p.status !== 'all') q = q.eq('is_active', p.status === 'active')
  if (p.productClass) q = q.eq('product_class', p.productClass)
  if (p.categoryId) q = q.eq('category_id', p.categoryId)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('brand_name').order('id').range(from, to), 'products.list', p)
  type Joined = Tables<'products'> & {
    identity: { generic_name: string; strength_text: string; dosage_form: { name: string } | null } | null
    manufacturer: { name: string } | null
  }
  return {
    ...res,
    rows: (res.rows as unknown as Joined[]).map((r) => ({
      id: r.id, sku: r.sku, brand_name: r.brand_name, generic_name: r.identity?.generic_name ?? null,
      strength_text: r.identity?.strength_text ?? null, dosage_form: r.identity?.dosage_form?.name ?? null,
      manufacturer_name: r.manufacturer?.name ?? null, product_class: r.product_class, is_active: r.is_active,
    })),
  }
}

export type ProductDetail = Tables<'products'> & {
  identity: ProductIdentity | null
  manufacturer: { id: string; name: string } | null
  category: { id: string; name: string } | null
  base_unit: { code: string; name: string } | null
}

export async function getProduct(id: string): Promise<ProductDetail | null> {
  const res = await supabase
    .from('products')
    .select('*, identity:product_identities!products_identity_fk(*, dosage_form:dosage_forms(code, name)), manufacturer:manufacturers!products_manufacturer_fk(id, name), category:product_categories!products_category_fk(id, name), base_unit:units_of_measure!products_base_unit_id_fkey(code, name)')
    .eq('id', id)
    .maybeSingle()
  return unwrap(res, 'products.get') as unknown as ProductDetail | null
}

export interface ProductInput {
  sku: string
  brand_name: string
  identity_id: string | null
  description?: string | undefined
  manufacturer_id: string | null
  category_id: string | null
  product_class: ProductClass
  storage_condition: (typeof STORAGE_CONDITIONS)[number]
  requires_prescription: boolean
  fda_registration_number?: string | undefined
  fda_registration_expiry?: string | undefined
  base_unit_id: string
  track_batches: boolean
  is_active: boolean
}

// requires_prescription / is_controlled follow the class (the database enforces the same rules)
const classFlags = (c: ProductClass, rx: boolean) => ({
  product_class: c,
  is_controlled: c === 'CONTROLLED',
  requires_prescription: c === 'POM' || c === 'CONTROLLED' ? true : rx,
})
const productUpdateRow = (i: ProductInput) => ({
  identity_id: i.identity_id, brand_name: i.brand_name.trim(), description: emptyToNull(i.description),
  manufacturer_id: i.manufacturer_id, category_id: i.category_id, storage_condition: i.storage_condition,
  ...classFlags(i.product_class, i.requires_prescription),
  fda_registration_number: emptyToNull(i.fda_registration_number), fda_registration_expiry: emptyToNull(i.fda_registration_expiry),
  track_batches: i.track_batches, is_active: i.is_active,
})
export async function createProduct(i: ProductInput): Promise<string> {
  return (unwrap(
    await supabase.from('products').insert({ sku: i.sku.trim().toUpperCase(), base_unit_id: i.base_unit_id, ...productUpdateRow(i) }).select('id').single(),
    'products.create',
  ) as { id: string }).id
}
export async function updateProduct(id: string, i: ProductInput): Promise<void> {
  unwrap(await supabase.from('products').update(productUpdateRow(i)).eq('id', id).select('id').single(), 'products.update')
}

// ---- pack levels (units) ------------------------------------------------------------------------------------
export async function listProductUnits(productId: string): Promise<ProductUnit[]> {
  const rows = unwrap(
    await supabase.from('product_units').select('*, unit:units_of_measure(code, name)').eq('product_id', productId).order('is_base', { ascending: false }).order('factor_to_base'),
    'productUnits.list',
  )
  return rows as unknown as ProductUnit[]
}
export interface ProductUnitInput { product_id: string; unit_id: string; factor_to_base: number; is_sellable: boolean; is_purchasable: boolean }
export async function createProductUnit(i: ProductUnitInput): Promise<void> {
  unwrap(await supabase.from('product_units').insert({ ...i, is_active: true }).select('id').single(), 'productUnits.create')
}
export async function updateProductUnit(id: string, patch: { is_sellable?: boolean; is_purchasable?: boolean; is_active?: boolean }): Promise<void> {
  unwrap(await supabase.from('product_units').update(patch).eq('id', id).select('id').single(), 'productUnits.update')
}

// ---- barcodes -------------------------------------------------------------------------------------------------
export async function listBarcodes(productId: string): Promise<ProductBarcode[]> {
  const rows = unwrap(
    await supabase.from('product_barcodes').select('*, product_unit:product_units(unit:units_of_measure(code, name))').eq('product_id', productId).order('created_at'),
    'barcodes.list',
  )
  return rows as unknown as ProductBarcode[]
}
export interface BarcodeInput { product_id: string; product_unit_id: string; barcode: string; barcode_type: 'GTIN' | 'INTERNAL' | 'SUPPLIER' }
export async function createBarcode(i: BarcodeInput): Promise<void> {
  unwrap(await supabase.from('product_barcodes').insert({ ...i, barcode: i.barcode.trim(), is_active: true }).select('id').single(), 'barcodes.create')
}
export async function setBarcodeActive(id: string, isActive: boolean): Promise<void> {
  unwrap(await supabase.from('product_barcodes').update({ is_active: isActive }).eq('id', id).select('id').single(), 'barcodes.setActive')
}

// ---- aliases --------------------------------------------------------------------------------------------------
export async function listProductAliases(productId: string): Promise<ProductAlias[]> {
  return unwrap(await supabase.from('product_aliases').select('*').eq('product_id', productId).order('created_at'), 'aliases.list')
}
export async function createProductAlias(productId: string, alias: string): Promise<void> {
  unwrap(await supabase.from('product_aliases').insert({ product_id: productId, alias: alias.trim(), source: 'MANUAL', is_active: true }).select('id').single(), 'aliases.create')
}
export async function setAliasActive(id: string, isActive: boolean): Promise<void> {
  unwrap(await supabase.from('product_aliases').update({ is_active: isActive }).eq('id', id).select('id').single(), 'aliases.setActive')
}
