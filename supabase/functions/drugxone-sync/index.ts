// Trusted server worker for queued DrugXOne catalogue events.
// It never accepts browser sessions and never reads credentials from the database.

type EventRow = {
  id: string
  organization_id: string
  connection_id: string
  entity_type: string
  external_id: string | null
  idempotency_key: string
  payload: Record<string, unknown>
  status: string
  attempts: number
}

type ConnectionRow = {
  id: string
  organization_id: string
  base_url: string | null
  external_business_id: string | null
  status: string
}

type DbResult = { data: unknown; error: { message?: string } | null }
type Query = {
  select(columns: string): Query
  update(values: Record<string, unknown>): Query
  eq(column: string, value: unknown): Query
  lte(column: string, value: unknown): Query
  order(column: string, options: { ascending: boolean }): Query
  limit(value: number): Query
  maybeSingle(): Promise<DbResult>
}
type Db = {
  from(table: string): Query
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

function sameSecret(expected: string, actual: string): boolean {
  const left = new TextEncoder().encode(expected)
  const right = new TextEncoder().encode(actual)
  if (left.length !== right.length || left.length === 0) return false
  let difference = 0
  for (let i = 0; i < left.length; i += 1) difference |= left[i]! ^ right[i]!
  return difference === 0
}

function bearer(req: Request): string {
  const value = req.headers.get('authorization') ?? ''
  return /^Bearer\s+\S+$/i.test(value) ? value.slice(7).trim() : ''
}

function targetUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function retryAt(attempt: number): string {
  const seconds = Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1))
  return new Date(Date.now() + seconds * 1000).toISOString()
}

async function processEvent(db: Db, event: EventRow, tokenMap: Record<string, string>, path: string, fetcher: typeof fetch): Promise<'succeeded' | 'failed' | 'skipped'> {
  const connectionResult = await db.from('drugxone_connections').select('id,organization_id,base_url,external_business_id,status').eq('id', event.connection_id).eq('organization_id', event.organization_id).maybeSingle()
  const connection = connectionResult.data as ConnectionRow | null
  if (connectionResult.error || !connection || connection.status !== 'READY' || !connection.base_url || !connection.external_business_id) return 'skipped'
  const token = tokenMap[connection.external_business_id]
  if (!token) return 'skipped'

  const claimed = await db.from('drugxone_sync_events').update({ status: 'PROCESSING', attempts: event.attempts + 1, last_error_code: null, last_error: null }).eq('id', event.id).eq('organization_id', event.organization_id).eq('status', 'QUEUED').select('id').maybeSingle()
  if (claimed.error || !claimed.data) return 'skipped'

  try {
    const response = await fetcher(targetUrl(connection.base_url, path), {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': event.idempotency_key, 'X-Request-ID': event.id },
      body: JSON.stringify({ version: 'v1', event_id: event.id, event_type: event.entity_type, external_id: event.external_id, payload: event.payload }),
    })
    if (!response.ok) throw new Error(`remote_http_${response.status}`)
    await db.from('drugxone_sync_events').update({ status: 'SUCCEEDED', processed_at: new Date().toISOString(), last_error_code: null, last_error: null }).eq('id', event.id).eq('organization_id', event.organization_id)
    await db.from('drugxone_connections').update({ last_catalog_sync_at: new Date().toISOString(), last_success_at: new Date().toISOString(), last_error_code: null, last_error: null }).eq('id', connection.id).eq('organization_id', connection.organization_id)
    return 'succeeded'
  } catch (error) {
    const code = error instanceof Error && /^remote_http_\d+$/.test(error.message) ? error.message : 'network_error'
    const terminal = event.attempts + 1 >= 8
    await db.from('drugxone_sync_events').update({ status: terminal ? 'DEAD_LETTER' : 'FAILED', next_attempt_at: retryAt(event.attempts + 1), last_error_code: code, last_error: 'Catalogue delivery failed.' }).eq('id', event.id).eq('organization_id', event.organization_id)
    await db.from('drugxone_connections').update({ last_error_code: code, last_error: 'Catalogue delivery failed.' }).eq('id', connection.id).eq('organization_id', connection.organization_id)
    return 'failed'
  }
}

async function main(req: Request, db: Db, env: Record<string, string | undefined>, fetcher: typeof fetch): Promise<Response> {
  const secret = env.DRUGXONE_SYNC_SECRET ?? ''
  if (!secret || !sameSecret(secret, bearer(req))) return json(401, { error: 'Unauthorized' })
  if (req.method === 'GET') return json(200, { ok: true, worker: 'drugxone-sync' })
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })
  let body: Record<string, unknown>
  try {
    const raw = await req.json()
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return json(400, { error: 'Request body must be a JSON object' })
    body = raw as Record<string, unknown>
  } catch { return json(400, { error: 'Request body must be valid JSON' }) }
  const organizationId = typeof body.organization_id === 'string' ? body.organization_id : ''
  if (!/^[0-9a-f-]{36}$/i.test(organizationId)) return json(400, { error: 'organization_id is required' })
  const max = typeof body.max_events === 'number' && Number.isInteger(body.max_events) ? Math.min(25, Math.max(1, body.max_events)) : 10
  const tokenText = env.DRUGXONE_PARTNER_TOKENS_JSON ?? '{}'
  let tokenMap: Record<string, string>
  try { tokenMap = JSON.parse(tokenText) as Record<string, string> } catch { return json(500, { error: 'Worker token configuration is invalid' }) }
  const eventsResult = await db.from('drugxone_sync_events').select('id,organization_id,connection_id,entity_type,external_id,idempotency_key,payload,status,attempts').eq('organization_id', organizationId).eq('status', 'QUEUED').lte('next_attempt_at', new Date().toISOString()).order('created_at', { ascending: true }).limit(max)
  if (eventsResult.error) return json(500, { error: 'Unable to read sync queue' })
  const counts = { succeeded: 0, failed: 0, skipped: 0 }
  for (const event of (eventsResult.data ?? []) as EventRow[]) counts[await processEvent(db, event, tokenMap, env.DRUGXONE_CATALOGUE_PATH ?? '/api/integrations/erp/catalogue', fetcher)] += 1
  return json(200, { ok: true, organization_id: organizationId, ...counts })
}

const denoGlobal = (globalThis as { Deno?: { env: { get(k: string): string | undefined }; serve(handler: (req: Request) => Response | Promise<Response>): void } }).Deno
if (denoGlobal) {
  const { createClient } = await import(/* @vite-ignore */ 'npm:@supabase/supabase-js@2') as { createClient: (url: string, key: string, options?: Record<string, unknown>) => Db }
  const db = createClient(denoGlobal.env.get('SUPABASE_URL') ?? '', denoGlobal.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } })
  const env = { DRUGXONE_SYNC_SECRET: denoGlobal.env.get('DRUGXONE_SYNC_SECRET'), DRUGXONE_PARTNER_TOKENS_JSON: denoGlobal.env.get('DRUGXONE_PARTNER_TOKENS_JSON'), DRUGXONE_CATALOGUE_PATH: denoGlobal.env.get('DRUGXONE_CATALOGUE_PATH') }
  denoGlobal.serve((req) => main(req, db, env, fetch))
}

export { main, processEvent, retryAt, sameSecret, targetUrl }
