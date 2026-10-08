import { supabase } from '@/lib/supabase'
import { sanitizeForOrFilter } from '@/lib/utils'
import type { PageParams, Paged, Tables, WarehouseType } from '@/types/domain'
import type { ActiveFilter } from './branches'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'

export type Warehouse = Tables<'warehouses'> & { branch: { id: string; code: string; name: string } | null }
export type WarehouseLocation = Tables<'warehouse_locations'>

const WAREHOUSE_SELECT = '*, branch:branches!warehouses_branch_fk(id, code, name)'

export interface WarehouseListParams extends PageParams {
  search: string
  status: ActiveFilter
  branchId: string | null
  sortKey: 'name' | 'code' | 'created_at'
  sortDirection: 'asc' | 'desc'
}

export interface WarehouseInput {
  branch_id: string
  code: string
  name: string
  description?: string | undefined
  warehouse_type: WarehouseType
  is_active: boolean
}

export async function listWarehouses(p: WarehouseListParams): Promise<Paged<Warehouse>> {
  let q = supabase.from('warehouses').select(WAREHOUSE_SELECT, { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`name.ilike.%${s}%,code.ilike.%${s}%`)
  if (p.status !== 'all') q = q.eq('is_active', p.status === 'active')
  if (p.branchId) q = q.eq('branch_id', p.branchId)
  const [from, to] = rangeFor(p)
  return unwrapPaged(
    await q.order(p.sortKey, { ascending: p.sortDirection === 'asc' }).order('id').range(from, to),
    'warehouses.list',
    p,
  ) as Paged<Warehouse>
}

export async function listWarehouseOptions(branchId: string | null): Promise<Pick<Warehouse, 'id' | 'code' | 'name' | 'branch_id' | 'is_active'>[]> {
  let q = supabase.from('warehouses').select('id, code, name, branch_id, is_active').order('name').limit(500)
  if (branchId) q = q.eq('branch_id', branchId)
  return unwrap(await q, 'warehouses.options')
}

// organization_id is filled by the database from the caller's session; branch_id is immutable after creation.
export async function createWarehouse(i: WarehouseInput): Promise<void> {
  unwrap(
    await supabase.from('warehouses').insert({
      branch_id: i.branch_id,
      code: i.code.trim().toUpperCase(),
      name: i.name.trim(),
      description: emptyToNull(i.description),
      warehouse_type: i.warehouse_type,
      is_active: i.is_active,
    }).select('id').single(),
    'warehouses.create',
  )
}

export async function updateWarehouse(id: string, i: Omit<WarehouseInput, 'branch_id'>): Promise<void> {
  unwrap(
    await supabase.from('warehouses').update({
      code: i.code.trim().toUpperCase(),
      name: i.name.trim(),
      description: emptyToNull(i.description),
      warehouse_type: i.warehouse_type,
      is_active: i.is_active,
    }).eq('id', id).select('id').single(),
    'warehouses.update',
  )
}

export async function setWarehouseActive(id: string, isActive: boolean): Promise<void> {
  unwrap(await supabase.from('warehouses').update({ is_active: isActive }).eq('id', id).select('id').single(), 'warehouses.setActive')
}

// ---- locations ------------------------------------------------------------------------------

export interface LocationListParams extends PageParams {
  warehouseId: string
  search: string
  status: ActiveFilter
  sortKey: 'picking_sequence' | 'code'
  sortDirection: 'asc' | 'desc'
}

export interface LocationInput {
  warehouse_id: string
  code: string
  aisle?: string | undefined
  rack?: string | undefined
  shelf?: string | undefined
  bin?: string | undefined
  description?: string | undefined
  picking_sequence: number
  is_active: boolean
}

export async function listLocations(p: LocationListParams): Promise<Paged<WarehouseLocation>> {
  let q = supabase.from('warehouse_locations').select('*', { count: 'exact' }).eq('warehouse_id', p.warehouseId)
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`code.ilike.%${s}%,aisle.ilike.%${s}%,rack.ilike.%${s}%,shelf.ilike.%${s}%,bin.ilike.%${s}%`)
  if (p.status !== 'all') q = q.eq('is_active', p.status === 'active')
  const [from, to] = rangeFor(p)
  return unwrapPaged(
    await q.order(p.sortKey, { ascending: p.sortDirection === 'asc' }).order('code').range(from, to),
    'locations.list',
    p,
  )
}

const locationRow = (i: Omit<LocationInput, 'warehouse_id'>) => ({
  code: i.code.trim().toUpperCase(),
  aisle: emptyToNull(i.aisle),
  rack: emptyToNull(i.rack),
  shelf: emptyToNull(i.shelf),
  bin: emptyToNull(i.bin),
  description: emptyToNull(i.description),
  picking_sequence: i.picking_sequence,
  is_active: i.is_active,
})

export async function createLocation(i: LocationInput): Promise<void> {
  unwrap(
    await supabase.from('warehouse_locations').insert({ warehouse_id: i.warehouse_id, ...locationRow(i) }).select('id').single(),
    'locations.create',
  )
}

export async function updateLocation(id: string, i: Omit<LocationInput, 'warehouse_id'>): Promise<void> {
  unwrap(await supabase.from('warehouse_locations').update(locationRow(i)).eq('id', id).select('id').single(), 'locations.update')
}

export async function setLocationActive(id: string, isActive: boolean): Promise<void> {
  unwrap(await supabase.from('warehouse_locations').update({ is_active: isActive }).eq('id', id).select('id').single(), 'locations.setActive')
}
