import { afterAll, beforeAll, expect, it } from 'vitest'
import { createOrg, withUser, closePool, type Org } from '../helpers/db'
let org: Org
beforeAll(async () => { org = await createOrg('INSIGHTS') })
afterAll(closePool)
it('returns an empty report for an organization without purchase orders', async () => {
  const result = await withUser(org.ownerId, c => c.q("select * from public.procurement_insights('2026-01-01','2026-12-31',null)"))
  expect(result.rows).toEqual([])
})
it('rejects invalid dates and anonymous access', async () => {
  const invalid = await withUser(org.ownerId, c => c.attempt("select * from public.procurement_insights('2026-12-31','2026-01-01',null)"))
  expect(invalid.ok).toBe(false)
  const anonymous = await withUser(null, c => c.attempt("select * from public.procurement_insights('2026-01-01','2026-12-31',null)"))
  expect(anonymous.ok).toBe(false)
})
