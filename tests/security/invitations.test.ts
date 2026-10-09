import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addUser, admin, closePool, createAuthUser, createOrg, roleId, withUser, type Org } from '../helpers/db'

let org: Org
let other: Org
let branch2: string

beforeAll(async () => {
  org = await createOrg('INVITE')
  other = await createOrg('INVITE-OTHER')
  branch2 = await addBranch(org.id, 'B2')
})
afterAll(closePool)

describe('prepare_invitation (called with the inviter\'s own JWT)', () => {
  it('lets an owner invite for a valid role and branch', async () => {
    await withUser(org.ownerId, async (c) => {
      const r = await c.q('select public.prepare_invitation($1, $2) as r', [await roleId('CASHIER'), branch2])
      expect(r.rows[0].r).toMatchObject({ actor_id: org.ownerId, organization_id: org.id, role_code: 'CASHIER' })
    })
  })

  it('denies users without users.invite', async () => {
    for (const role of ['READ_ONLY', 'CASHIER', 'AUDITOR']) {
      const u = await addUser(org.id, role)
      await withUser(u, async (c) => {
        const r = await c.attempt('select public.prepare_invitation($1)', [await roleId('READ_ONLY')])
        expect(r.ok, role).toBe(false)
        if (!r.ok) expect(r.code).toBe('42501')
      })
    }
  })

  it('blocks privilege escalation: a general manager cannot invite an owner', async () => {
    const gm = await addUser(org.id, 'GENERAL_MANAGER')
    await withUser(gm, async (c) => {
      for (const role of ['OWNER', 'SUPER_ADMIN']) {
        const r = await c.attempt('select public.prepare_invitation($1)', [await roleId(role)])
        expect(r.ok, role).toBe(false)
        if (!r.ok) expect(r.code).toBe('42501')
      }
      expect((await c.attempt('select public.prepare_invitation($1)', [await roleId('CASHIER')])).ok).toBe(true)
    })
  })

  it('rejects branches of another organization and unknown roles', async () => {
    await withUser(org.ownerId, async (c) => {
      const b = await c.attempt('select public.prepare_invitation($1, $2)', [await roleId('CASHIER'), other.hq])
      expect(b.ok).toBe(false)
      if (!b.ok) expect(b.code).toBe('P0002')
      const r = await c.attempt('select public.prepare_invitation(gen_random_uuid())')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('P0002')
    })
  })

  it('is not callable anonymously or by an inactive user', async () => {
    const anon = await withUser(null, (c) => c.attempt('select public.prepare_invitation(gen_random_uuid())'))
    expect(anon.ok).toBe(false)
    const u = await addUser(org.id, 'GENERAL_MANAGER')
    await admin.query('update public.profiles set is_active = false where id = $1', [u])
    await withUser(u, async (c) => {
      const r = await c.attempt('select public.prepare_invitation($1)', [await roleId('CASHIER')])
      expect(r.ok).toBe(false)
    })
  })
})

describe('prepare_resend', () => {
  it('works for users in the organization, not for others, not for stronger roles', async () => {
    const target = await addUser(org.id, 'CASHIER')
    const foreign = await addUser(other.id, 'CASHIER')
    const gm = await addUser(org.id, 'GENERAL_MANAGER')
    await withUser(org.ownerId, async (c) => {
      const r = await c.q('select public.prepare_resend($1) as r', [target])
      expect(r.rows[0].r).toMatchObject({ organization_id: org.id })
      expect((await c.attempt('select public.prepare_resend($1)', [foreign])).ok).toBe(false)
    })
    await withUser(gm, async (c) => {
      const r = await c.attempt('select public.prepare_resend($1)', [org.ownerId])
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('42501')
    })
  })
})

describe('complete_invitation (service role only)', () => {
  it('cannot be executed by signed-in users', async () => {
    const dummy = '00000000-0000-4000-8000-000000000001'
    await withUser(org.ownerId, async (c) => {
      const r = await c.attempt(
        'select public.complete_invitation($1, $2, $3, $4, $5, $6)',
        [org.ownerId, dummy, org.id, 'A', 'B', await roleId('CASHIER')])
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('42501')
    }, { claims: { role: 'service_role' } })
  })

  it('creates profile, role and an audit entry attributed to the inviter', async () => {
    const invitee = await createAuthUser()
    await admin.query(
      'select public.complete_invitation($1, $2, $3, $4, $5, $6, $7, $8)',
      [org.ownerId, invitee, org.id, 'Esi', 'Appiah', await roleId('BRANCH_MANAGER'), branch2, 'Branch lead'])

    const p = await admin.query('select first_name, last_name, email, job_title, default_branch_id, is_active from public.profiles where id = $1', [invitee])
    expect(p.rows[0]).toMatchObject({ first_name: 'Esi', last_name: 'Appiah', job_title: 'Branch lead', default_branch_id: branch2, is_active: true })
    expect(p.rows[0].email).toContain('@')

    const ur = await admin.query('select branch_id, created_by from public.user_roles where user_id = $1', [invitee])
    expect(ur.rows).toEqual([{ branch_id: branch2, created_by: org.ownerId }])

    const a = await admin.query(`select actor_user_id, branch_id, new_values from public.audit_logs where action = 'user.invited' and entity_id = $1`, [invitee])
    expect(a.rows).toHaveLength(1)
    expect(a.rows[0]).toMatchObject({ actor_user_id: org.ownerId, branch_id: branch2, new_values: { role_code: 'BRANCH_MANAGER' } })
  })

  it('rejects an inviter from another organization and cross-organization branches', async () => {
    const invitee = await createAuthUser()
    await expect(admin.query(
      'select public.complete_invitation($1, $2, $3, $4, $5, $6)',
      [other.ownerId, invitee, org.id, 'X', 'Y', await roleId('CASHIER')])).rejects.toMatchObject({ code: '42501' })
    await expect(admin.query(
      'select public.complete_invitation($1, $2, $3, $4, $5, $6, $7)',
      [org.ownerId, invitee, org.id, 'X', 'Y', await roleId('CASHIER'), other.hq])).rejects.toMatchObject({ code: '23503' })
    // failed attempts leave nothing behind
    expect((await admin.query('select 1 from public.profiles where id = $1', [invitee])).rowCount).toBe(0)
  })
})
