import { supabase } from '@/lib/supabase'
import { unwrap } from './common'
export interface DeliveryRun {
  id: string; branch_id: string; run_number: string; run_date: string; status: 'PLANNED' | 'LOADING' | 'ON_ROAD' | 'COMPLETED' | 'CANCELLED'
  driver_name: string; vehicle_number: string; capacity_packages: number; capacity_kg: number; refrigerated: boolean; stop_count: number
}
export interface RunStop {
  id: string; position: number; status: 'PENDING' | 'DELIVERED' | 'FAILED' | 'REMOVED'; package_count: number; weight_kg: number; cold_chain: boolean
  loaded_at: string | null; returned_at: string | null; outcome_at: string | null; receiver_name: string | null; reason: string | null
  note_number: string; customer_name: string; delivery_address: string | null; contact_name: string | null; contact_phone: string | null; notes: string | null; invoice_number: string; balance_due: number; currency_code: string
}
export interface RunOptions {
  drivers: { id: string; name: string; licence_expiry: string | null }[]
  vehicles: { id: string; name: string; capacity_packages: number | null; capacity_kg: number | null; refrigerated: boolean }[]
  notes: { id: string; name: string; packages: number }[]
}
export async function listRuns(): Promise<DeliveryRun[]> { return unwrap(await supabase.rpc('delivery_run_list'), 'runs.list') as unknown as DeliveryRun[] }
export async function runStops(id: string): Promise<RunStop[]> { return unwrap(await supabase.rpc('delivery_run_detail', { p_id: id }), 'runs.detail') as unknown as RunStop[] }
export async function runOptions(branch: string): Promise<RunOptions> { return unwrap(await supabase.rpc('run_planning_options', { p_branch_id: branch }), 'runs.options') as unknown as RunOptions }
export async function createRun(branch: string, driver: string, vehicle: string, date: string) { return unwrap(await supabase.rpc('create_delivery_run', { p_branch_id: branch, p_driver_id: driver, p_vehicle_id: vehicle, p_date: date }), 'runs.create') }
export async function addStop(run: string, note: string, weight: number) { return unwrap(await supabase.rpc('add_run_stop', { p_run_id: run, p_note_id: note, p_weight_kg: weight }), 'runs.add') }
export async function removeStop(id: string, reason: string) { unwrap(await supabase.rpc('remove_run_stop', { p_id: id, p_reason: reason }), 'runs.remove') }
export async function reorderStops(id: string, stops: string[]) { unwrap(await supabase.rpc('reorder_run_stops', { p_id: id, p_stops: stops }), 'runs.reorder') }
export async function startLoading(id: string) { unwrap(await supabase.rpc('start_run_loading', { p_id: id }), 'runs.loading') }
export async function loadStop(id: string, packages: number) { unwrap(await supabase.rpc('load_run_stop', { p_id: id, p_packages: packages }), 'runs.load') }
export async function dispatchRun(id: string) { unwrap(await supabase.rpc('dispatch_delivery_run', { p_id: id }), 'runs.dispatch') }
export async function recordOutcome(id: string, delivered: boolean, receiver: string, reason: string) { unwrap(await supabase.rpc('record_run_outcome', { p_id: id, p_delivered: delivered, p_receiver: receiver, p_reason: reason }), 'runs.outcome') }
export async function returnStop(id: string) { unwrap(await supabase.rpc('return_run_stop', { p_id: id }), 'runs.return') }
export async function cancelRun(id: string, reason: string) { unwrap(await supabase.rpc('cancel_delivery_run', { p_id: id, p_reason: reason }), 'runs.cancel') }
export async function driverProfileOptions(id: string) { return unwrap(await supabase.rpc('driver_profile_options', { p_driver_id: id }), 'runs.profiles') }
export async function linkDriverProfile(id: string, profile: string | null) { unwrap(await supabase.rpc('link_driver_profile', { p_driver_id: id, p_profile_id: profile }), 'runs.linkDriver') }
