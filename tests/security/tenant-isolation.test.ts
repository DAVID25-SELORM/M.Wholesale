import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addBranch, addLocation, addUser, addWarehouse, admin, closePool, createOrg, withUser, type Org,
} from '../helpers/db'

let a: Org
let b: Org
let bBranch2: string
let bWh: string
let bLoc: string
let aBranch2: string
let aWh1: string
let aWh2: string

beforeAll(async () => {
  a = await createOrg('A')
  b = await createOrg('B')
  bBranch2 = await addBranch(b.id, 'B2')
  bWh = await addWarehouse(b.id, b.hq, 'WH1')
  bLoc = await addLocation(b.id, bWh, 'LOC1')
  aBranch2 = await addBranch(a.id, 'A2')
  aWh1 = await addWarehouse(a.id, a.hq, 'WH1')
  aWh2 = await addWarehouse(a.id, aBranch2, 'WH2')
  await admin.query(
    `insert into public.system_settings (organization_id, category, key, value) values ($1, 'sales', 'secret.b', '{"x":1}')`,
    [b.id],
  )
})
afterAll(closePool)

const tables = [
  'organizations', 'branches', 'warehouses', 'warehouse_locations', 'profiles',
  'user_roles', 'audit_logs', 'system_settings', 'number_sequences',
]

describe('security 1: unauthenticated access', () => {
  it('anon cannot read any tenant table (no privileges)', async () => {
    for (const t of tables) {
      const r = await withUser(null, (c) => c.attempt(`select * from public.${t} limit 1`))
      expect(r.ok, t).toBe(false)
      if (!r.ok) expect(r.code, t).toBe('42501')
    }
  })

  it('anon cannot call session or admin RPCs', async () => {
    for (const fn of ['public.get_session_context()', 'public.set_user_active(gen_random_uuid(), false)']) {
      const r = await withUser(null, (c) => c.attempt(`select ${fn}`))
      expect(r.ok, fn).toBe(false)
      if (!r.ok) expect(r.code).toBe('42501')
    }
  })

  it('authenticated role WITHOUT a profile sees nothing and cannot write', async () => {
    const ghost = '00000000-0000-4000-8000-00000000dead'
    await withUser(ghost, async (c) => {
      for (const t of tables) {
        const r = await c.q(`select count(*)::int as n from public.${t}`)
        expect(r.rows[0].n, t).toBe(0)
      }
      const w = await c.attempt(`insert into public.branches (code, name) values ('GHOST', 'Ghost')`)
      expect(w.ok).toBe(false)
    })
  })
})

describe('security 3: organization A cannot READ organization B', () => {
  it('every tenant table only returns the caller organization', async () => {
    await withUser(a.ownerId, async (c) => {
      const orgs = await c.q('select id from public.organizations')
      expect(orgs.rows.map((r) => r.id)).toEqual([a.id])
      for (const t of ['branches', 'warehouses', 'warehouse_locations', 'profiles', 'user_roles', 'audit_logs', 'system_settings', 'number_sequences']) {
        const r = await c.q(`select count(*)::int as n from public.${t} where organization_id <> $1`, [a.id])
        expect(r.rows[0].n, t).toBe(0)
      }
    })
  })

  it('direct lookups of B rows by primary key return nothing', async () => {
    await withUser(a.ownerId, async (c) => {
      expect((await c.q('select 1 from public.branches where id = $1', [bBranch2])).rowCount).toBe(0)
      expect((await c.q('select 1 from public.warehouses where id = $1', [bWh])).rowCount).toBe(0)
      expect((await c.q('select 1 from public.warehouse_locations where id = $1', [bLoc])).rowCount).toBe(0)
      expect((await c.q('select 1 from public.profiles where id = $1', [b.ownerId])).rowCount).toBe(0)
      expect((await c.q('select 1 from public.user_roles where user_id = $1', [b.ownerId])).rowCount).toBe(0)
      expect((await c.q(`select 1 from public.system_settings where key = 'secret.b'`)).rowCount).toBe(0)
      expect((await c.q('select 1 from public.audit_logs where organization_id = $1', [b.id])).rowCount).toBe(0)
    })
  })
})

describe('security 4: organization A cannot MUTATE organization B', () => {
  it('updates against B rows affect zero rows', async () => {
    await withUser(a.ownerId, async (c) => {
      const stmts: [string, unknown[]][] = [
        ['update public.organizations set name = $2 where id = $1', [b.id, 'pwned']],
        ['update public.branches set name = $2 where id = $1', [bBranch2, 'pwned']],
        ['update public.warehouses set name = $2 where id = $1', [bWh, 'pwned']],
        ['update public.warehouse_locations set description = $2 where id = $1', [bLoc, 'pwned']],
        ['update public.profiles set first_name = $2 where id = $1', [b.ownerId, 'pwned']],
        [`update public.system_settings set value = '{"x":2}' where organization_id = $1 and $2::text is not null`, [b.id, 'x']],
      ]
      for (const [sql, params] of stmts) {
        const r = await c.attempt(sql, params)
        expect(r.ok && r.rowCount, sql).toBe(0)
      }
    })
    const check = await admin.query('select name from public.branches where id = $1', [bBranch2])
    expect(check.rows[0].name).not.toBe('pwned')
  })

  it('cannot insert into B by supplying B ids or organization_id (organization_id spoofing)', async () => {
    await withUser(a.ownerId, async (c) => {
      const spoof = await c.attempt(
        `insert into public.branches (organization_id, code, name) values ($1, 'EVIL', 'Evil')`, [b.id])
      expect(spoof.ok).toBe(false)
      if (!spoof.ok) expect(spoof.code).toBe('42501') // column not grantable

      // warehouse inside B's branch: organization_id defaults to A -> composite FK rejects it
      const wh = await c.attempt(
        `insert into public.warehouses (branch_id, code, name) values ($1, 'EVIL', 'Evil')`, [b.hq])
      expect(wh.ok).toBe(false)

      const loc = await c.attempt(
        `insert into public.warehouse_locations (warehouse_id, code) values ($1, 'EVIL')`, [bWh])
      expect(loc.ok).toBe(false)
    })
    const leaked = await admin.query(`select 1 from public.warehouses where code = 'EVIL' union all select 1 from public.branches where code = 'EVIL'`)
    expect(leaked.rowCount).toBe(0)
  })

  it('cannot move own rows to another organization or parent', async () => {
    await withUser(a.ownerId, async (c) => {
      for (const sql of [
        [`update public.branches set organization_id = $1 where id = $2`, [b.id, aBranch2]],
        [`update public.warehouses set organization_id = $1 where id = $2`, [b.id, aWh1]],
        [`update public.warehouses set branch_id = $1 where id = $2`, [aBranch2, aWh1]],
        [`update public.profiles set organization_id = $1 where id = $2`, [b.id, a.ownerId]],
      ] as [string, unknown[]][]) {
        const r = await c.attempt(sql[0], sql[1])
        expect(r.ok, sql[0]).toBe(false) // 42501 (no column grant)
      }
    })
    // even a trusted server context cannot re-parent rows
    for (const [sql, params] of [
      ['update public.warehouses set branch_id = $1 where id = $2', [aBranch2, aWh1]],
      ['update public.branches set organization_id = $1 where id = $2', [b.id, aBranch2]],
    ] as [string, unknown[]][]) {
      await expect(admin.query(sql, params)).rejects.toMatchObject({ code: '23514' })
    }
  })
})

describe('security 5: branch restrictions', () => {
  it('a branch-scoped manager only sees and edits their own branch', async () => {
    const mgr = await addUser(a.id, 'BRANCH_MANAGER', a.hq)
    await withUser(mgr, async (c) => {
      const br = await c.q('select id from public.branches')
      expect(br.rows.map((r) => r.id)).toEqual([a.hq])
      const wh = await c.q('select id from public.warehouses')
      expect(wh.rows.map((r) => r.id)).toEqual([aWh1])

      expect((await c.q(`update public.warehouses set name = 'Renamed' where id = $1`, [aWh1])).rowCount).toBe(1)
      expect((await c.q(`update public.warehouses set name = 'Nope' where id = $1`, [aWh2])).rowCount).toBe(0)
      expect((await c.q(`update public.branches set name = 'Nope' where id = $1`, [aBranch2])).rowCount).toBe(0)

      const other = await c.attempt(`insert into public.warehouses (branch_id, code, name) values ($1, 'X1', 'x')`, [aBranch2])
      expect(other.ok).toBe(false)
      if (!other.ok) expect(other.code).toBe('42501')

      const own = await c.attempt(`insert into public.warehouses (branch_id, code, name) values ($1, 'X2', 'x')`, [a.hq])
      expect(own.ok).toBe(true)

      const newBranch = await c.attempt(`insert into public.branches (code, name) values ('NEWB', 'New')`)
      expect(newBranch.ok).toBe(false) // creating branches is organization-wide only
    })
  })

  it('locations follow the branch of their warehouse', async () => {
    const mgr = await addUser(a.id, 'BRANCH_MANAGER', a.hq)
    const locOther = await addLocation(a.id, aWh2, 'LOC-OTHER')
    await withUser(mgr, async (c) => {
      expect((await c.q('select 1 from public.warehouse_locations where id = $1', [locOther])).rowCount).toBe(0)
      const add = await c.attempt(`insert into public.warehouse_locations (warehouse_id, code) values ($1, 'N1')`, [aWh1])
      expect(add.ok).toBe(true)
      const addOther = await c.attempt(`insert into public.warehouse_locations (warehouse_id, code) values ($1, 'N2')`, [aWh2])
      expect(addOther.ok).toBe(false)
    })
  })

  it('profile default branch must be one the user can access', async () => {
    const mgr = await addUser(a.id, 'BRANCH_MANAGER', a.hq)
    await withUser(mgr, async (c) => {
      const r = await c.attempt(`update public.profiles set default_branch_id = $1 where id = $2`, [aBranch2, mgr])
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('23514')
    })
  })
})

describe('permission 18: client manipulation cannot bypass database authorization', () => {
  it('cannot escalate the database role', async () => {
    await withUser(a.ownerId, async (c) => {
      // (the API connects as a login that can only become anon/authenticated/service_role,
      //  and a client cannot send raw SQL anyway; this proves the DB side regardless)
      for (const sql of ['set role postgres', 'set role supabase_admin', 'set session authorization postgres']) {
        const r = await c.attempt(sql)
        expect(r.ok, sql).toBe(false)
      }
    })
  })

  it('claiming service_role inside the JWT claims does not unlock provisioning RPCs', async () => {
    await withUser(a.ownerId, async (c) => {
      const r = await c.attempt(
        `select public.provision_user(gen_random_uuid(), $1, 'X', 'Y', 'OWNER', null)`, [a.id])
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('42501')
    }, { claims: { role: 'service_role' } })
  })

  it('private helpers and sequence generation are not callable by clients', async () => {
    await withUser(a.ownerId, async (c) => {
      for (const sql of [
        `select private.generate_document_number('${a.id}', null, 'INVOICE')`,
        `select private.write_audit('${a.id}', 'x', 'x')`,
        `select private.user_can_access_branch('${a.ownerId}', '${a.hq}')`,
      ]) {
        const r = await c.attempt(sql)
        expect(r.ok, sql).toBe(false)
        if (!r.ok) expect(r.code).toBe('42501')
      }
    })
  })

  it('a tampered JWT subject without a profile gets no data even with valid role', async () => {
    await withUser('11111111-1111-4111-8111-111111111111', async (c) => {
      expect((await c.q('select count(*)::int n from public.branches')).rows[0].n).toBe(0)
    })
  })
})
