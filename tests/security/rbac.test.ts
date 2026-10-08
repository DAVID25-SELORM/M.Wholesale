import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addUser, admin, closePool, createOrg, roleId, withUser, type Org } from '../helpers/db'

let org: Org
let branch2: string

beforeAll(async () => {
  org = await createOrg('RBAC')
  branch2 = await addBranch(org.id, 'B2')
})
afterAll(closePool)

describe('security 2: inactive users are denied', () => {
  it('an inactive user sees and changes nothing; session context reports inactive_user', async () => {
    const u = await addUser(org.id, 'GENERAL_MANAGER')
    await admin.query('update public.profiles set is_active = false where id = $1', [u])
    await withUser(u, async (c) => {
      for (const t of ['branches', 'warehouses', 'organizations', 'user_roles', 'audit_logs']) {
        expect((await c.q(`select count(*)::int n from public.${t}`)).rows[0].n, t).toBe(0)
      }
      // own profile row stays readable so the UI can show "access disabled"
      expect((await c.q('select count(*)::int n from public.profiles')).rows[0].n).toBe(1)
      const w = await c.attempt(`insert into public.branches (code, name) values ('INACT', 'x')`)
      expect(w.ok).toBe(false)
      const ctx = (await c.q('select public.get_session_context() as c')).rows[0].c
      expect(ctx.status).toBe('inactive_user')
      expect(ctx.org_permissions).toBeUndefined()
    })
  })

  it('users of a deactivated organization are denied', async () => {
    const o = await createOrg('Dormant')
    await admin.query('update public.organizations set is_active = false where id = $1', [o.id])
    await withUser(o.ownerId, async (c) => {
      expect((await c.q('select count(*)::int n from public.branches')).rows[0].n).toBe(0)
      const ctx = (await c.q('select public.get_session_context() as c')).rows[0].c
      expect(ctx.status).toBe('inactive_organization')
    })
  })
})

describe('permissions 16/17: with permission succeeds, without fails', () => {
  it('OWNER can create a branch and edit the organization', async () => {
    await withUser(org.ownerId, async (c) => {
      expect((await c.attempt(`insert into public.branches (code, name) values ('NEW1', 'New One') returning id`)).ok).toBe(true)
      expect((await c.q(`update public.organizations set trading_name = 'Trading' where id = $1`, [org.id])).rowCount).toBe(1)
    })
  })

  it('READ_ONLY can read but cannot write anything', async () => {
    const u = await addUser(org.id, 'READ_ONLY')
    await withUser(u, async (c) => {
      expect((await c.q('select count(*)::int n from public.branches')).rows[0].n).toBeGreaterThan(0)
      expect((await c.attempt(`insert into public.branches (code, name) values ('RO1', 'x')`)).ok).toBe(false)
      expect((await c.q(`update public.organizations set name = 'x' where id = $1`, [org.id])).rowCount).toBe(0)
      expect((await c.q(`update public.branches set name = 'x'`)).rowCount).toBe(0)
      expect((await c.attempt(`insert into public.warehouses (branch_id, code, name) values ($1, 'RO', 'x')`, [org.hq])).ok).toBe(false)
    })
  })

  it('GENERAL_MANAGER edits branches but cannot edit the organization profile', async () => {
    const u = await addUser(org.id, 'GENERAL_MANAGER')
    await withUser(u, async (c) => {
      expect((await c.q(`update public.branches set phone = '0300000000' where id = $1`, [org.hq])).rowCount).toBe(1)
      expect((await c.q(`update public.organizations set name = 'Hijack' where id = $1`, [org.id])).rowCount).toBe(0)
    })
  })

  it('users cannot see audit entries or users without the matching permission', async () => {
    const u = await addUser(org.id, 'CASHIER')
    await withUser(u, async (c) => {
      expect((await c.q('select count(*)::int n from public.audit_logs')).rows[0].n).toBe(0)
      expect((await c.q('select count(*)::int n from public.profiles')).rows[0].n).toBe(1) // only self
      expect((await c.q('select count(*)::int n from public.role_permissions')).rows[0].n).toBe(0)
    })
  })
})

describe('security 6: unauthorized role modification fails', () => {
  it('direct writes to RBAC tables are impossible for clients', async () => {
    const roleOwner = await roleId('OWNER')
    await withUser(org.ownerId, async (c) => {
      for (const sql of [
        [`insert into public.user_roles (user_id, role_id, organization_id) values ($1, $2, $3)`, [org.ownerId, roleOwner, org.id]],
        [`update public.user_roles set role_id = $1`, [roleOwner]],
        [`delete from public.user_roles`, []],
        [`insert into public.roles (code, name, is_system_role) values ('X', 'x', true)`, []],
        [`update public.roles set name = 'x'`, []],
        [`insert into public.role_permissions (role_id, permission_id) select $1, id from public.permissions limit 1`, [roleOwner]],
        [`delete from public.role_permissions`, []],
        [`insert into public.permissions (code, module, action, description) values ('a.b', 'a', 'b', 'x')`, []],
      ] as [string, unknown[]][]) {
        const r = await c.attempt(sql[0], sql[1])
        expect(r.ok, sql[0]).toBe(false)
        if (!r.ok) expect(r.code, sql[0]).toBe('42501')
      }
    })
  })

  it('a user without roles.assign cannot assign roles', async () => {
    const u = await addUser(org.id, 'BRANCH_MANAGER', org.hq)
    const target = await addUser(org.id, 'READ_ONLY')
    await withUser(u, async (c) => {
      const r = await c.attempt('select public.assign_user_role($1, $2)', [target, await roleId('CASHIER')])
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('42501')
    })
  })

  it('privilege escalation is blocked: a manager cannot hand out a role stronger than their own', async () => {
    const gm = await addUser(org.id, 'GENERAL_MANAGER')
    const target = await addUser(org.id, 'READ_ONLY')
    await withUser(gm, async (c) => {
      for (const code of ['OWNER', 'SUPER_ADMIN']) {
        const r = await c.attempt('select public.assign_user_role($1, $2)', [target, await roleId(code)])
        expect(r.ok, code).toBe(false)
        if (!r.ok) expect(r.code).toBe('42501')
      }
      // …but a weaker role is fine and is audited with the reason
      const ok = await c.attempt('select public.assign_user_role($1, $2, null, $3)', [target, await roleId('CASHIER'), 'covering tills'])
      expect(ok.ok).toBe(true)
    }, { commit: true })
    const audit = await admin.query(
      `select action, reason, actor_user_id from public.audit_logs where action = 'user_role.created' and reason = 'covering tills'`)
    expect(audit.rowCount).toBe(1)
    expect(audit.rows[0].actor_user_id).toBe(gm)
  })

  it('a manager cannot strip an owner of their role or deactivate them', async () => {
    const gm = await addUser(org.id, 'GENERAL_MANAGER')
    const ownerRole = (await admin.query('select id from public.user_roles where user_id = $1', [org.ownerId])).rows[0].id
    await withUser(gm, async (c) => {
      const rev = await c.attempt('select public.revoke_user_role($1)', [ownerRole])
      expect(rev.ok).toBe(false)
      const off = await c.attempt('select public.set_user_active($1, false)', [org.ownerId])
      expect(off.ok).toBe(false)
    })
  })

  it('cross-organization assignment is rejected', async () => {
    const other = await createOrg('Other')
    await withUser(org.ownerId, async (c) => {
      const r = await c.attempt('select public.assign_user_role($1, $2)', [other.ownerId, await roleId('READ_ONLY')])
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('P0002')
      const b = await c.attempt('select public.assign_user_role($1, $2, $3)', [await addUser(org.id, 'READ_ONLY'), await roleId('READ_ONLY'), other.hq])
      expect(b.ok).toBe(false)
    })
  })

  it('the last administrator cannot be removed, deactivated, or deactivate themselves', async () => {
    const solo = await createOrg('Solo')
    const ownerRole = (await admin.query('select id from public.user_roles where user_id = $1', [solo.ownerId])).rows[0].id
    await withUser(solo.ownerId, async (c) => {
      const self = await c.attempt('select public.set_user_active($1, false)', [solo.ownerId])
      expect(self.ok).toBe(false)
      const rev = await c.attempt('select public.revoke_user_role($1)', [ownerRole])
      expect(rev.ok).toBe(false)
      if (!rev.ok) expect(rev.code).toBe('23514')
    })
  })

  it('set_user_active toggles status for authorised users; direct is_active edits are impossible', async () => {
    const target = await addUser(org.id, 'READ_ONLY')
    await withUser(org.ownerId, async (c) => {
      const direct = await c.attempt('update public.profiles set is_active = false where id = $1', [target])
      expect(direct.ok).toBe(false)
      expect((await c.attempt('select public.set_user_active($1, false, $2)', [target, 'left company'])).ok).toBe(true)
      expect((await c.q('select is_active from public.profiles where id = $1', [target])).rows[0].is_active).toBe(false)
    })
  })

  it('employee_code / job_title need users.edit; personal fields are self-editable', async () => {
    const u = await addUser(org.id, 'CASHIER')
    await withUser(u, async (c) => {
      expect((await c.attempt(`update public.profiles set phone = '0240000000' where id = $1`, [u])).ok).toBe(true)
      const r = await c.attempt(`update public.profiles set job_title = 'CEO' where id = $1`, [u])
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('42501')
      expect((await c.attempt('update public.profiles set organization_id = gen_random_uuid() where id = $1', [u])).ok).toBe(false)
    })
  })
})

describe('security 7: unauthorized settings modification fails', () => {
  it('only settings.manage may write; settings.view may read; branch scope is respected', async () => {
    const viewer = await addUser(org.id, 'AUDITOR') // has settings.view only
    const manager = await addUser(org.id, 'BRANCH_MANAGER', org.hq) // settings.view only, branch scoped
    await withUser(org.ownerId, async (c) => {
      expect((await c.attempt(
        `insert into public.system_settings (category, key, value) values ('sales', 'default.tax', '{"rate":0}')`)).ok).toBe(true)
      expect((await c.attempt(
        `insert into public.system_settings (branch_id, category, key, value) values ($1, 'sales', 'branch.only', '1')`, [branch2])).ok).toBe(true)
      await c.q(`select 1`) // keep tx open; commit below
    }, { commit: true })

    for (const user of [viewer, manager]) {
      await withUser(user, async (c) => {
        expect((await c.q(`select count(*)::int n from public.system_settings`)).rows[0].n).toBeGreaterThan(0)
        const w = await c.attempt(`insert into public.system_settings (category, key, value) values ('sales', 'evil', '1')`)
        expect(w.ok).toBe(false)
        if (!w.ok) expect(w.code).toBe('42501')
        expect((await c.q(`update public.system_settings set value = '{"rate":99}'`)).rowCount).toBe(0)
      })
    }
    // branch-scoped manager must not even see the other branch's setting
    await withUser(manager, async (c) => {
      const rows = await c.q(`select key from public.system_settings`)
      expect(rows.rows.map((r) => r.key)).not.toContain('branch.only')
    })
  })

  it('settings keys/scope are immutable and values are bounded', async () => {
    await withUser(org.ownerId, async (c) => {
      const big = await c.attempt(
        `insert into public.system_settings (category, key, value) values ('sales', 'big', to_jsonb(repeat('x', 20000)))`)
      expect(big.ok).toBe(false)
      const badCat = await c.attempt(`insert into public.system_settings (category, key, value) values ('nope', 'k', '1')`)
      expect(badCat.ok).toBe(false)
    })
  })
})

describe('session context', () => {
  it('returns permissions, roles and only accessible branches in one call', async () => {
    const mgr = await addUser(org.id, 'BRANCH_MANAGER', org.hq)
    await withUser(mgr, async (c) => {
      const ctx = (await c.q('select public.get_session_context() as c')).rows[0].c
      expect(ctx.status).toBe('ok')
      expect(ctx.org_permissions).toEqual([])
      expect(ctx.branch_permissions[org.hq]).toContain('warehouses.create')
      expect(ctx.branches.map((b: any) => b.id)).toEqual([org.hq])
      expect(ctx.roles[0].role_code).toBe('BRANCH_MANAGER')
    })
    await withUser(org.ownerId, async (c) => {
      const ctx = (await c.q('select public.get_session_context() as c')).rows[0].c
      expect(ctx.org_permissions).toContain('roles.manage')
      expect(ctx.branches.length).toBeGreaterThanOrEqual(2)
    })
  })
})
