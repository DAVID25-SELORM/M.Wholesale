import { describe, expect, it, vi } from 'vitest'
import { allowedDestination, main, partnerFor } from '../../supabase/functions/drugxone-sync/index'

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const ORIGIN = 'https://api.drugxone.example'
const partners = { [ORG_A]: { token: 'token-of-A', business_id: 'BIZ-A' }, [ORG_B]: { token: 'token-of-B', business_id: 'BIZ-B' } }
const env = { DRUGXONE_SYNC_SECRET: 'worker-secret', DRUGXONE_PARTNER_TOKENS_JSON: JSON.stringify(partners), DRUGXONE_ALLOWED_ORIGINS: `${ORIGIN}/` }

type Conn = { base_url: string; external_business_id: string }
/** a tiny stand-in for the database: one organization, one connection, one event */
function fakeDb(org: string, conn: Conn, status = 'QUEUED') {
  const updates: Record<string, unknown>[] = []
  const filters: [string, unknown][] = []
  const db = {
    from(table: string) {
      let update: Record<string, unknown> | null = null
      const q: any = {
        select: () => q, lte: () => q, order: () => q, limit: () => q,
        in: (c: string, v: unknown) => { filters.push([c, v]); return q },
        eq: (c: string, v: unknown) => { filters.push([c, v]); return q },
        update: (v: Record<string, unknown>) => { update = v; updates.push({ table, ...v }); return q },
        maybeSingle: async () => ({ data: update ? { id: 'e1' } : { id: 'c1', organization_id: org, status: 'READY', ...conn }, error: null }),
        then: (resolve: (r: unknown) => void) => resolve({ data: update ? null : [{ id: 'e1', organization_id: org, connection_id: 'c1', entity_type: 'CATALOGUE', external_id: null, idempotency_key: 'k1', payload: {}, status, attempts: 1 }], error: null }),
      }
      return q
    },
  }
  return { db, updates, filters }
}
const request = (org: string, secret = 'worker-secret') => new Request('https://worker.example/drugxone-sync', { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ organization_id: org }) })
const okFetch = () => vi.fn(async () => new Response('{}', { status: 200 }))
const run = async (org: string, conn: Conn, over: Partial<typeof env> = {}, status = 'QUEUED') => {
  const fetcher = okFetch()
  const fake = fakeDb(org, conn, status)
  const res = await main(request(org), fake.db as never, { ...env, ...over }, fetcher as unknown as typeof fetch)
  return { fetcher, body: await res.json(), ...fake }
}

describe('drugxone-sync worker', () => {
  it('sends an organization only its own token, to an approved origin, without following redirects', async () => {
    const r = await run(ORG_A, { base_url: ORIGIN, external_business_id: 'BIZ-A' })
    expect(r.body.succeeded).toBe(1)
    const [url, init] = r.fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${ORIGIN}/api/integrations/erp/catalogue`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-of-A')
    expect(init.redirect).toBe('error')
  })

  it('does not leak another organization’s token when a tenant copies its business id', async () => {
    // organization B types A's business id and its own server
    const r = await run(ORG_B, { base_url: 'https://attacker.example', external_business_id: 'BIZ-A' })
    expect(r.fetcher).not.toHaveBeenCalled()
    expect(r.body.skipped).toBe(1)
    // even with an approved origin, the business id must be the one registered for B
    expect((await run(ORG_B, { base_url: ORIGIN, external_business_id: 'BIZ-A' })).fetcher).not.toHaveBeenCalled()
  })

  it('never sends a token to an origin the operator has not approved, and fails closed without an allow list', async () => {
    for (const base of ['https://attacker.example', `${ORIGIN}.attacker.example`, 'http://api.drugxone.example', 'https://user:pass@api.drugxone.example', 'https://api.drugxone.example:8443']) {
      expect((await run(ORG_A, { base_url: base, external_business_id: 'BIZ-A' })).fetcher, base).not.toHaveBeenCalled()
    }
    expect((await run(ORG_A, { base_url: ORIGIN, external_business_id: 'BIZ-A' }, { DRUGXONE_ALLOWED_ORIGINS: '' })).fetcher).not.toHaveBeenCalled()
    expect(allowedDestination('not a url', [ORIGIN])).toBe(false)
    expect(partnerFor(partners, '__proto__', { id: 'c', organization_id: 'x', base_url: ORIGIN, external_business_id: 'BIZ-A', status: 'READY' })).toBeNull()
  })

  it('picks up failed events again once their retry time has come', async () => {
    const r = await run(ORG_A, { base_url: ORIGIN, external_business_id: 'BIZ-A' }, {}, 'FAILED')
    expect(r.filters).toContainEqual(['status', ['QUEUED', 'FAILED']])
    expect(r.filters).toContainEqual(['status', 'FAILED'])           // claimed from the state it was in
    expect(r.body.succeeded).toBe(1)
  })

  it('refuses a caller without the worker secret, including when none is configured', async () => {
    const fake = fakeDb(ORG_A, { base_url: ORIGIN, external_business_id: 'BIZ-A' })
    expect((await main(request(ORG_A, 'wrong'), fake.db as never, env, okFetch() as unknown as typeof fetch)).status).toBe(401)
    expect((await main(request(ORG_A, ''), fake.db as never, { ...env, DRUGXONE_SYNC_SECRET: '' }, okFetch() as unknown as typeof fetch)).status).toBe(401)
  })
})
