import { supabase } from '@/lib/supabase'
import { unwrap } from './common'

export type DrugXoneConnection = {
  configured: boolean
  environment: 'SANDBOX' | 'PRODUCTION' | null
  base_url: string | null
  external_business_id: string | null
  status: 'DISCONNECTED' | 'READY' | 'PAUSED' | 'ERROR' | null
  api_version: string | null
  last_sync_at: string | null
  last_error: string | null
  updated_at: string | null
}

export async function getDrugXoneConnection(): Promise<DrugXoneConnection> {
  return unwrap(await supabase.rpc('drugxone_connection_read'), 'drugxone.connection.read') as DrugXoneConnection
}

export async function setDrugXoneConnection(input: {
  environment: 'SANDBOX' | 'PRODUCTION'
  base_url: string
  external_business_id: string
  status: 'DISCONNECTED' | 'READY' | 'PAUSED'
  reason: string
}): Promise<void> {
  unwrap(await supabase.rpc('drugxone_set_connection', {
    p_environment: input.environment,
    p_base_url: input.base_url,
    p_external_business_id: input.external_business_id,
    p_status: input.status,
    p_reason: input.reason,
  }), 'drugxone.connection.save')
}

export async function queueDrugXoneCatalogue(reason: string, productIds?: string[]): Promise<{ queued: number; event_ids: string[] }> {
  return unwrap(await supabase.rpc('drugxone_queue_catalogue', { p_product_ids: productIds ?? null, p_reason: reason }), 'drugxone.catalogue.queue') as { queued: number; event_ids: string[] }
}
