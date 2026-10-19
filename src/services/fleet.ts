import { sanitizeForOrFilter } from '@/lib/utils'
import { supabase } from '@/lib/supabase'
import type { PageParams, Paged, Tables } from '@/types/domain'
import { emptyToNull, rangeFor, unwrap, unwrapPaged } from './common'

export type Driver = Tables<'drivers'>
export type Vehicle = Tables<'vehicles'>
export type ActiveFilter = 'all' | 'active' | 'inactive'
export const VEHICLE_TYPES = ['MOTORBIKE', 'CAR', 'VAN', 'PICKUP', 'TRUCK', 'OTHER'] as const
export type VehicleType = (typeof VEHICLE_TYPES)[number]

export interface DriverListParams extends PageParams {
  search: string
  status: ActiveFilter
  sortKey: 'name' | 'code' | 'licence_expiry'
  sortDirection: 'asc' | 'desc'
}
export interface VehicleListParams extends PageParams {
  search: string
  status: ActiveFilter
  sortKey: 'registration_number' | 'insurance_expiry' | 'roadworthy_expiry'
  sortDirection: 'asc' | 'desc'
}

export interface DriverInput {
  branch_id: string
  code: string
  name: string
  phone?: string | undefined
  licence_number?: string | undefined
  licence_class?: string | undefined
  licence_expiry?: string | undefined
  notes?: string | undefined
  is_active: boolean
}
export interface VehicleInput {
  branch_id: string
  registration_number: string
  name?: string | undefined
  vehicle_type: VehicleType
  capacity_packages?: number | undefined
  capacity_kg?: number | undefined
  refrigerated: boolean
  insurance_expiry?: string | undefined
  roadworthy_expiry?: string | undefined
  notes?: string | undefined
  is_active: boolean
}

export async function listDrivers(p: DriverListParams): Promise<Paged<Driver>> {
  let q = supabase.from('drivers').select('*', { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`name.ilike.%${s}%,code.ilike.%${s}%,phone.ilike.%${s}%,licence_number.ilike.%${s}%`)
  if (p.status !== 'all') q = q.eq('is_active', p.status === 'active')
  const [from, to] = rangeFor(p)
  return unwrapPaged(await q.order(p.sortKey, { ascending: p.sortDirection === 'asc', nullsFirst: false }).order('id').range(from, to), 'drivers.list', p)
}

export async function listVehicles(p: VehicleListParams): Promise<Paged<Vehicle>> {
  let q = supabase.from('vehicles').select('*', { count: 'exact' })
  const s = sanitizeForOrFilter(p.search)
  if (s) q = q.or(`registration_number.ilike.%${s}%,name.ilike.%${s}%`)
  if (p.status !== 'all') q = q.eq('is_active', p.status === 'active')
  const [from, to] = rangeFor(p)
  return unwrapPaged(await q.order(p.sortKey, { ascending: p.sortDirection === 'asc', nullsFirst: false }).order('id').range(from, to), 'vehicles.list', p)
}

// organization_id is never sent: the database fills it from the caller's session.
const driverRow = (i: DriverInput) => ({
  branch_id: i.branch_id,
  code: i.code.trim().toUpperCase(),
  name: i.name.trim(),
  phone: emptyToNull(i.phone),
  licence_number: emptyToNull(i.licence_number),
  licence_class: emptyToNull(i.licence_class),
  licence_expiry: emptyToNull(i.licence_expiry),
  notes: emptyToNull(i.notes),
  is_active: i.is_active,
})
const vehicleRow = (i: VehicleInput) => ({
  branch_id: i.branch_id,
  registration_number: i.registration_number,
  name: emptyToNull(i.name),
  vehicle_type: i.vehicle_type,
  capacity_packages: i.capacity_packages ?? null,
  capacity_kg: i.capacity_kg ?? null,
  refrigerated: i.refrigerated,
  insurance_expiry: emptyToNull(i.insurance_expiry),
  roadworthy_expiry: emptyToNull(i.roadworthy_expiry),
  notes: emptyToNull(i.notes),
  is_active: i.is_active,
})

export async function createDriver(i: DriverInput): Promise<void> {
  unwrap(await supabase.from('drivers').insert(driverRow(i)).select('id').single(), 'drivers.create')
}
export async function updateDriver(id: string, i: DriverInput): Promise<void> {
  unwrap(await supabase.from('drivers').update(driverRow(i)).eq('id', id).select('id').single(), 'drivers.update')
}
export async function setDriverActive(id: string, isActive: boolean): Promise<void> {
  unwrap(await supabase.from('drivers').update({ is_active: isActive }).eq('id', id).select('id').single(), 'drivers.setActive')
}
export async function createVehicle(i: VehicleInput): Promise<void> {
  unwrap(await supabase.from('vehicles').insert(vehicleRow(i)).select('id').single(), 'vehicles.create')
}
export async function updateVehicle(id: string, i: VehicleInput): Promise<void> {
  unwrap(await supabase.from('vehicles').update(vehicleRow(i)).eq('id', id).select('id').single(), 'vehicles.update')
}
export async function setVehicleActive(id: string, isActive: boolean): Promise<void> {
  unwrap(await supabase.from('vehicles').update({ is_active: isActive }).eq('id', id).select('id').single(), 'vehicles.setActive')
}
