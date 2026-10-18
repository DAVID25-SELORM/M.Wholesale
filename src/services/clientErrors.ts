import { supabase } from '@/lib/supabase'
import type { PageParams, Paged } from '@/types/domain'
import { rangeFor, unwrapPaged } from './common'

export interface ClientError { id: string; source: string; message: string; stack: string | null; page_path: string | null; app_version: string | null; user_agent: string | null; created_at: string }

export async function listClientErrors(p: PageParams & { source: string }): Promise<Paged<ClientError>> {
  let q = supabase.from('client_errors').select('id, source, message, stack, page_path, app_version, user_agent, created_at', { count: 'exact' })
  if (p.source) q = q.eq('source', p.source)
  const [from, to] = rangeFor(p)
  const res = unwrapPaged(await q.order('created_at', { ascending: false }).order('id').range(from, to), 'clientErrors.list', p)
  return { ...res, rows: res.rows as ClientError[] }
}
