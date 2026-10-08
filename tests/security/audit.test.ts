import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addUser, admin, closePool, createOrg, withUser, type Org } from '../helpers/db'

let org: Org

beforeAll(async () => {
  org = await createOrg('Audit')
  // make sure there is at least one row
  await withUser(org.ownerId, (c) => c.q(`insert into public.branches (code, name) values ('AUD1', 'Audit Branch')`), { commit: true })
})
afterAll(closePool)

describe('security 8/9: audit logs are append-only', () => {
  it('ordinary users (even owners) cannot update, delete or insert audit rows', async () => {
    for (const user of [org.ownerId, await addUser(org.id, 'AUDITOR')]) {
      await withUser(user, async (c) => {
        for (const sql of [
          `update public.audit_logs set action = 'tampered'`,
          `delete from public.audit_logs`,
          `truncate public.audit_logs`,
          `insert into public.audit_logs (organization_id, action, entity_type) values (gen_random_uuid(), 'fake', 'x')`,
        ]) {
          const r = await c.attempt(sql)
          expect(r.ok, sql).toBe(false)
          if (!r.ok) expect(r.code, sql).toBe('42501')
        }
      })
    }
  })

  it('even the table owner / server context cannot rewrite history', async () => {
    await expect(admin.query(`update public.audit_logs set action = 'tampered'`)).rejects.toMatchObject({ code: '42501' })
    await expect(admin.query(`delete from public.audit_logs`)).rejects.toMatchObject({ code: '42501' })
    await expect(admin.query(`truncate public.audit_logs`)).rejects.toMatchObject({ code: '42501' })
    const n = await admin.query(`select count(*)::int n from public.audit_logs where action = 'tampered'`)
    expect(n.rows[0].n).toBe(0)
  })
})

describe('audit coverage for Phase 0 entities', () => {
  it('records created / updated / deactivated with actor, branch and only changed columns', async () => {
    let branchId = ''
    await withUser(org.ownerId, async (c) => {
      branchId = (await c.q(`insert into public.branches (code, name) values ('AUD2', 'Second') returning id`)).rows[0].id
      await c.q(`update public.branches set name = 'Second renamed', phone = '0301' where id = $1`, [branchId])
      await c.q(`update public.branches set is_active = false where id = $1`, [branchId])
      await c.q(`update public.branches set is_active = true where id = $1`, [branchId])
    }, { commit: true })

    const { rows } = await admin.query(
      `select action, actor_user_id, branch_id, previous_values, new_values
         from public.audit_logs where entity_type = 'branch' and entity_id = $1 order by created_at, id`, [branchId])
    expect(rows.map((r) => r.action)).toEqual(['branch.created', 'branch.updated', 'branch.deactivated', 'branch.activated'])
    expect(rows.every((r) => r.actor_user_id === org.ownerId)).toBe(true)
    expect(rows.every((r) => r.branch_id === branchId)).toBe(true)
    expect(rows[1].previous_values).toEqual({ name: 'Second', phone: null })
    expect(rows[1].new_values).toEqual({ name: 'Second renamed', phone: '0301' })
  })

  it('warehouses, locations, profiles, roles and settings are audited', async () => {
    const mgrBranch = await addBranch(org.id, 'AUD3')
    let whId = ''
    await withUser(org.ownerId, async (c) => {
      whId = (await c.q(`insert into public.warehouses (branch_id, code, name) values ($1, 'AW1', 'Aud WH') returning id`, [mgrBranch])).rows[0].id
      await c.q(`insert into public.warehouse_locations (warehouse_id, code, aisle) values ($1, 'AL1', 'A')`, [whId])
      await c.q(`insert into public.system_settings (category, key, value) values ('company', 'audit.test', '"x"')`)
      await c.q(`update public.organizations set trading_name = 'Audited Trading' where id = $1`, [org.id])
    }, { commit: true })
    const target = await addUser(org.id, 'READ_ONLY')
    await withUser(org.ownerId, (c) => c.q('select public.set_user_active($1, false, $2)', [target, 'audit test']), { commit: true })

    const { rows } = await admin.query(
      `select distinct action from public.audit_logs where organization_id = $1`, [org.id])
    const actions = rows.map((r) => r.action)
    for (const expected of [
      'warehouse.created', 'warehouse_location.created', 'system_setting.created',
      'organization.updated', 'user.created', 'user.deactivated', 'user_role.created',
    ]) {
      expect(actions, expected).toContain(expected)
    }
    const reason = await admin.query(`select reason from public.audit_logs where action = 'user.deactivated' and entity_id = $1`, [target])
    expect(reason.rows[0].reason).toBe('audit test')
  })

  it('rolled-back changes leave no audit trace and no-op updates are not logged', async () => {
    const before = (await admin.query('select count(*)::int n from public.audit_logs where organization_id = $1', [org.id])).rows[0].n
    await withUser(org.ownerId, async (c) => {
      await c.q(`insert into public.branches (code, name) values ('ROLLB', 'will roll back')`)
    }) // rolled back
    await withUser(org.ownerId, async (c) => {
      await c.q(`update public.branches set name = name where id = $1`, [org.hq])
    }, { commit: true })
    const after = (await admin.query('select count(*)::int n from public.audit_logs where organization_id = $1', [org.id])).rows[0].n
    expect(after).toBe(before)
  })

  it('audit visibility follows permission and branch scope', async () => {
    const b2 = await addBranch(org.id, 'AUD4')
    await admin.query(`update public.branches set name = 'Aud4 renamed' where id = $1`, [b2])
    const auditor = await addUser(org.id, 'AUDITOR')
    const cashier = await addUser(org.id, 'CASHIER')
    const scoped = await addUser(org.id, 'BRANCH_MANAGER', org.hq)
    await withUser(auditor, async (c) => {
      expect((await c.q('select count(*)::int n from public.audit_logs')).rows[0].n).toBeGreaterThan(0)
    })
    await withUser(cashier, async (c) => {
      expect((await c.q('select count(*)::int n from public.audit_logs')).rows[0].n).toBe(0)
    })
    await withUser(scoped, async (c) => {
      const r = await c.q('select distinct branch_id from public.audit_logs')
      expect(r.rows.every((x) => x.branch_id === org.hq)).toBe(true)
    })
  })
})
