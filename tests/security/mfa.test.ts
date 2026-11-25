import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addProduct, addUser, admin, closePool, createOrg, withUser, type Org } from '../helpers/db'

// Multi-factor sign-in is enforced by the database: a person with a verified second factor gets nothing from a password-only session.
let org: Org
let other: Org
let clerk: string

const ask = (user: string, sql: string, aal?: 'aal1' | 'aal2', params: unknown[] = []) =>
  withUser(user, (c) => c.attempt(sql, params), { claims: aal ? { aal } : {} })
const rows = async (user: string, sql: string, aal?: 'aal1' | 'aal2') => {
  const r = await ask(user, sql, aal)
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
  return r.rows
}
const status = async (user: string, aal?: 'aal1' | 'aal2') => (await rows(user, 'select public.get_session_context() c', aal))[0].c.status
const factor = (user: string, state: string) => admin.query('insert into auth.mfa_factors(user_id,status) values($1,$2)', [user, state])

beforeAll(async () => {
  org = await createOrg('MFA-A')
  other = await createOrg('MFA-B')
  clerk = await addUser(org.id, 'AUDITOR')
  await addProduct(org.id, { cls: 'GSL' })
  await addProduct(other.id, { cls: 'GSL' })
})
afterAll(closePool)

describe('multi-factor sign-in', () => {
  it('changes nothing for people without a second factor, or with an unfinished enrolment', async () => {
    expect(await status(org.ownerId, 'aal1')).toBe('ok')
    await factor(clerk, 'unverified')
    expect(await status(clerk, 'aal1')).toBe('ok')
    expect((await rows(clerk, 'select id from public.products', 'aal1')).length).toBe(1)
  })

  it('gives a password-only session nothing once a factor is verified, and everything after the second step', async () => {
    await factor(org.ownerId, 'verified')
    for (const aal of ['aal1', undefined] as const) {
      expect(await status(org.ownerId, aal)).toBe('mfa_required')
      const context = (await rows(org.ownerId, 'select public.get_session_context() c', aal))[0].c
      expect(context.org_permissions).toBeUndefined()
      expect(context.branches).toBeUndefined()
      expect((await rows(org.ownerId, 'select id from public.products', aal)).length).toBe(0)
      expect((await rows(org.ownerId, 'select id from public.organizations', aal)).length).toBe(0)
      expect((await rows(org.ownerId, "select private_ok from (select exists(select 1 from public.user_roles where user_id <> auth.uid()) private_ok) x", aal))[0].private_ok).toBe(false)
      const write = await ask(org.ownerId, "select public.create_recall('INTERNAL','II','Blocked','Password only session')", aal)
      expect(write.ok).toBe(false)
      const invite = await ask(org.ownerId, 'select public.prepare_invitation((select id from public.roles limit 1), null)', aal)
      expect(invite.ok).toBe(false)
    }
    expect(await status(org.ownerId, 'aal2')).toBe('ok')
    expect((await rows(org.ownerId, 'select id from public.products', 'aal2')).length).toBe(1)
  })

  it('does not let the second step cross organizations, and leaves colleagues unaffected', async () => {
    const seen = await rows(org.ownerId, 'select distinct organization_id from public.products', 'aal2')
    expect(seen.map((r) => r.organization_id)).toEqual([org.id])
    expect(await status(other.ownerId, 'aal1')).toBe('ok')
  })
})
