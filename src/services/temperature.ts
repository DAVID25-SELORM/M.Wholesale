import { supabase } from '@/lib/supabase'
import { unwrap } from './common'

export const TEMPERATURE_STAGES = ['PACKING', 'DISPATCH', 'TRANSIT', 'DELIVERY'] as const
export type TemperatureStage = (typeof TEMPERATURE_STAGES)[number]
export const STAGE_LABEL: Record<string, string> = { PACKING: 'At packing', DISPATCH: 'At dispatch', TRANSIT: 'In transit', DELIVERY: 'At delivery' }

export interface ColdPackage {
  package_id: string; package_number: string; fulfilment_order_id: string; order_number: string; customer_name: string; order_status: string
  latest_temperature_c: number | null; latest_within_range: boolean | null; latest_stage: string | null; latest_recorded_at: string | null
  open_excursions: number; rejected_excursions: number
}
export interface TemperatureReading {
  id: string; branch_id: string; package_id: string; stage: string; temperature_c: number; storage_condition: string
  limit_min_c: number; limit_max_c: number; within_range: boolean; note: string | null; recorded_at: string
}
export interface TemperatureExcursion {
  id: string; branch_id: string; package_id: string; reading_id: string; status: string; decision: string | null; decision_reason: string | null; decided_at: string | null; created_at: string
}
export interface ReadingResult { reading_id: string; within_range: boolean; excursion_id: string | null; limit_min_c: number; limit_max_c: number; storage_condition: string }

export async function listColdPackages(): Promise<ColdPackage[]> {
  return unwrap(await supabase.rpc('cold_chain_packages'), 'temperature.packages') as unknown as ColdPackage[]
}
export async function listRecentReadings(limit = 100): Promise<TemperatureReading[]> {
  return unwrap(await supabase.from('temperature_readings').select('id,branch_id,package_id,stage,temperature_c,storage_condition,limit_min_c,limit_max_c,within_range,note,recorded_at').order('recorded_at', { ascending: false }).limit(limit), 'temperature.readings') as unknown as TemperatureReading[]
}
export async function listExcursions(limit = 100): Promise<TemperatureExcursion[]> {
  return unwrap(await supabase.from('temperature_excursions').select('id,branch_id,package_id,reading_id,status,decision,decision_reason,decided_at,created_at').order('created_at', { ascending: false }).limit(limit), 'temperature.excursions') as unknown as TemperatureExcursion[]
}
export async function recordReading(packageId: string, stage: TemperatureStage, temperature: number, note: string): Promise<ReadingResult> {
  return unwrap(await supabase.rpc('record_temperature_reading', { p_package_id: packageId, p_stage: stage, p_temperature: temperature, p_note: note.trim() || undefined }), 'temperature.record') as unknown as ReadingResult
}
export async function resolveExcursion(id: string, decision: 'ACCEPT_USE' | 'REJECT_GOODS', reason: string) {
  unwrap(await supabase.rpc('resolve_temperature_excursion', { p_excursion_id: id, p_decision: decision, p_reason: reason.trim() }), 'temperature.resolve')
}

export interface RunColdPackage {
  stop_id: string; stop_position: number; stop_status: string; customer_name: string; package_id: string; package_number: string
  latest_temperature_c: number | null; latest_within_range: boolean | null; latest_stage: string | null; latest_recorded_at: string | null
  open_excursions: number; rejected_excursions: number
}
export async function listRunColdPackages(runId: string): Promise<RunColdPackage[]> {
  return unwrap(await supabase.rpc('run_cold_packages', { p_run_id: runId }), 'temperature.runPackages') as unknown as RunColdPackage[]
}
export async function recordRunTemperature(runId: string, packageId: string, stage: 'TRANSIT' | 'DELIVERY', temperature: number, note: string): Promise<ReadingResult> {
  return unwrap(await supabase.rpc('record_run_temperature', { p_run_id: runId, p_package_id: packageId, p_stage: stage, p_temperature: temperature, p_note: note.trim() || undefined }), 'temperature.runRecord') as unknown as ReadingResult
}
