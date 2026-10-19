import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addUser, admin, closePool, createAuthUser, createOrg, rand, withUser, type Org } from '../helpers/db'

let a: Org
let b: Org
let branch2: string
let owner: string
let dispatcher: string       // organization-wide: fleet.view + fleet.manage
let warehouseMgr: string     // fleet.view only
let auditor: string          // fleet.view only
let cashier: string          // no fleet rights
let manager2: string         // BRANCH_MANAGER limited to branch 2
let ownerB: string

type Out = { ok: true; rows: any[]; rowCount: number } | { ok: false; code: string; message: string }
const call = (user: string, sql: string, params: unknown[] = []): Promise<Out> => withUser(user, (c) => c.attempt(sql, params), { commit: true }) as Promise<Out>
const ok = async (p: Promise<Out>) => { const r = await p; if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`); return r.rows[0] }
const code = async (p: Promise<Out>) => { const r = await p; return r.ok ? 'ok' : r.code }
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows

const addDriver = (user: string, branch: string, c = `D${rand()}`, extra: Record<string, unknown> = {}) =>
  call(user, `insert into public.drivers (branch_id, code, name, licence_expiry, profile_id) values ($1, $2, $3, $4, $5) returning id`, [branch, c, `Driver ${c}`, extra.licence_expiry ?? null, extra.profile_id ?? null])
const addVehicle = (user: string, branch: string, reg: string) =>
  call(user, `insert into public.vehicles (branch_id, registration_number, vehicle_type) values ($1, $2, 'VAN') returning id, registration_number`, [branch, reg])

beforeAll(async () => {
  a = await createOrg('FLEET-A')
  b = await createOrg('FLEET-B')
  branch2 = await addBranch(a.id, 'F2')
  owner = a.ownerId
  ownerB = b.ownerId
  dispatcher = await addUser(a.id, 'DISPATCHER')
  warehouseMgr = await addUser(a.id, 'WAREHOUSE_MANAGER')
  auditor = await addUser(a.id, 'AUDITOR')
  cashier = await addUser(a.id, 'CASHIER')
  manager2 = await addUser(a.id, 'BRANCH_MANAGER', branch2)
})
afterAll(closePool)

describe('fleet permissions', () => {
  it('grants fleet.view and fleet.manage to the intended roles only', async () => {
    const rows = await q(`select r.code as role, p.code as perm from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id where p.code in ('fleet.view','fleet.manage') and r.organization_id is null`)
    const has = (role: string, perm: string) => rows.some((r) => r.role === role && r.perm === perm)
    for (const r of ['SUPER_ADMIN', 'OWNER', 'GENERAL_MANAGER', 'BRANCH_MANAGER', 'DISPATCHER']) { expect(has(r, 'fleet.view'), r).toBe(true); expect(has(r, 'fleet.manage'), r).toBe(true) }
    for (const r of ['WAREHOUSE_MANAGER', 'AUDITOR']) { expect(has(r, 'fleet.view'), r).toBe(true); expect(has(r, 'fleet.manage'), r).toBe(false) }
    for (const r of ['CASHIER', 'WAREHOUSE_PICKER', 'WAREHOUSE_PACKER', 'DRIVER']) expect(rows.filter((x) => x.role === r), r).toEqual([])
  })

  it('lets managers write and read-only roles read, and shows nothing to roles without the right', async () => {
    const id = (await ok(addDriver(dispatcher, a.hq, 'DRV-P1'))).id
    expect(await code(addDriver(warehouseMgr, a.hq))).toBe('42501')
    expect(await code(addDriver(auditor, a.hq))).toBe('42501')
    expect(await code(addDriver(cashier, a.hq))).toBe('42501')
    expect(await code(call(auditor, `update public.drivers set name = 'x' where id = $1`, [id]))).toBe('ok')   // RLS filters: zero rows, no error
    expect((await q(`select name from public.drivers where id = $1`, [id]))[0].name).toBe('Driver DRV-P1')
    const seen = (u: string) => withUser(u, async (c) => (await c.q(`select count(*)::int n from public.drivers`)).rows[0].n as number)
    expect(await seen(auditor)).toBeGreaterThanOrEqual(1)
    expect(await seen(warehouseMgr)).toBeGreaterThanOrEqual(1)
    expect(await seen(cashier)).toBe(0)
  })
})

describe('driver rules', () => {
  it('requires a name and a unique code per organization, but allows the same code in another organization', async () => {
    expect(await code(call(owner, `insert into public.drivers (branch_id, code, name) values ($1, 'DRV-N1', '  ')`, [a.hq]))).toBe('23514')
    await ok(addDriver(owner, a.hq, 'DRV-U1'))
    expect(await code(addDriver(owner, a.hq, 'DRV-U1'))).toBe('23505')
    expect(await code(addDriver(ownerB, b.hq, 'DRV-U1'))).toBe('ok')
  })

  it('links at most one driver to a sign-in, and never a sign-in of another organization', async () => {
    const p = await addUser(a.id, 'DRIVER')
    await ok(addDriver(owner, a.hq, 'DRV-L1', { profile_id: p }))
    expect(await code(addDriver(owner, a.hq, 'DRV-L2', { profile_id: p }))).toBe('23505')
    const foreign = await addUser(b.id, 'DRIVER')
    expect(await code(addDriver(owner, a.hq, 'DRV-L3', { profile_id: foreign }))).toBe('23503')
  })

  it('cannot point at a branch of another organization', async () => {
    expect(['23503', '42501']).toContain(await code(addDriver(owner, b.hq, 'DRV-X1')))
    expect(await code(call(owner, `update public.drivers set branch_id = $1 where code = 'DRV-U1'`, [b.hq]))).not.toBe('ok')
  })

  it('ignores or refuses an attempt to name the organization', async () => {
    expect(await code(call(owner, `insert into public.drivers (organization_id, branch_id, code, name) values ($1, $2, 'DRV-O1', 'Spoof')`, [b.id, a.hq]))).toBe('42501')
    expect(await code(call(owner, `update public.drivers set organization_id = $1 where code = 'DRV-U1'`, [b.id]))).toBe('42501')
  })

  it('cannot be deleted, and changes are audited', async () => {
    const id = (await ok(addDriver(owner, a.hq, 'DRV-A1'))).id
    expect(await code(call(owner, `delete from public.drivers where id = $1`, [id]))).toBe('42501')
    await expect(admin.query(`delete from public.drivers where id = $1`, [id])).rejects.toBeTruthy()
    await ok(call(owner, `update public.drivers set is_active = false where id = $1 returning id`, [id]))
    const actions = (await q(`select action from public.audit_logs where entity_type = 'driver' and entity_id = $1 order by created_at`, [id])).map((r) => r.action)
    expect(actions).toEqual(['driver.created', 'driver.deactivated'])
  })
})

describe('vehicle rules', () => {
  it('stores the registration upper case without spaces, so spellings cannot duplicate', async () => {
    const r = await ok(addVehicle(owner, a.hq, ' gr 1234-24 '))
    expect(r.registration_number).toBe('GR1234-24')
    expect(await code(addVehicle(owner, a.hq, 'GR1234-24'))).toBe('23505')
    expect(await code(addVehicle(owner, a.hq, 'gr 1234 - 24'))).toBe('23505')
  })

  it('allows the same registration in another organization and rejects malformed ones', async () => {
    expect(await code(addVehicle(ownerB, b.hq, 'GR1234-24'))).toBe('ok')
    for (const bad of ['A', 'AB', 'GR/123', 'GR_123', 'X'.repeat(21)]) expect(await code(addVehicle(owner, a.hq, bad)), bad).toBe('23514')
  })

  it('checks type and capacity ranges', async () => {
    expect(await code(call(owner, `insert into public.vehicles (branch_id, registration_number, vehicle_type) values ($1, 'VT-BAD1', 'ROCKET')`, [a.hq]))).toBe('23514')
    expect(await code(call(owner, `insert into public.vehicles (branch_id, registration_number, capacity_kg) values ($1, 'VT-BAD2', -1)`, [a.hq]))).toBe('23514')
    expect(await code(call(owner, `insert into public.vehicles (branch_id, registration_number, capacity_packages, capacity_kg, refrigerated, insurance_expiry, roadworthy_expiry) values ($1, 'VT-OK1', 120, 900.5, true, '2030-01-01', '2030-06-01')`, [a.hq]))).toBe('ok')
  })

  it('cannot be deleted, cannot name the organization, and is audited', async () => {
    const id = (await ok(addVehicle(owner, a.hq, 'VT-AUD1'))).id
    expect(await code(call(owner, `delete from public.vehicles where id = $1`, [id]))).toBe('42501')
    expect(await code(call(owner, `insert into public.vehicles (organization_id, branch_id, registration_number) values ($1, $2, 'VT-SPOOF')`, [b.id, a.hq]))).toBe('42501')
    await ok(call(owner, `update public.vehicles set insurance_expiry = '2031-01-01' where id = $1 returning id`, [id]))
    const actions = (await q(`select action from public.audit_logs where entity_type = 'vehicle' and entity_id = $1 order by created_at`, [id])).map((r) => r.action)
    expect(actions).toEqual(['vehicle.created', 'vehicle.updated'])
  })
})

describe('branch scope', () => {
  it('a branch manager works only on their own branch', async () => {
    const own = await ok(addVehicle(manager2, branch2, 'BR2-OWN1'))
    expect(own.id).toBeTruthy()
    expect(await code(addVehicle(manager2, a.hq, 'BR2-OTHER'))).toBe('42501')
    expect(await code(call(manager2, `update public.vehicles set name = 'moved' where registration_number = 'GR1234-24'`))).toBe('ok')
    expect((await q(`select name from public.vehicles where registration_number = 'GR1234-24' and organization_id = $1`, [a.id]))[0].name).toBeNull()
    const rows = await withUser(manager2, async (c) => (await c.q(`select distinct branch_id from public.vehicles`)).rows.map((r) => r.branch_id))
    expect(rows).toEqual([branch2])
    expect(await code(call(manager2, `update public.vehicles set branch_id = $1 where registration_number = 'BR2-OWN1'`, [a.hq]))).toBe('42501')
  })
})

describe('cross-tenant', () => {
  it('shows another organization nothing and lets it change nothing', async () => {
    const seen = await withUser(ownerB, async (c) => ({
      d: (await c.q(`select count(*)::int n from public.drivers where organization_id <> $1`, [b.id])).rows[0].n,
      v: (await c.q(`select count(*)::int n from public.vehicles where organization_id <> $1`, [b.id])).rows[0].n,
    }))
    expect(seen).toEqual({ d: 0, v: 0 })
    const r = await call(ownerB, `update public.vehicles set name = 'hijack' where organization_id = $1`, [a.id])
    expect(r.ok && r.rowCount).toBe(0)
    const d = await call(ownerB, `update public.drivers set is_active = false where organization_id = $1`, [a.id])
    expect(d.ok && d.rowCount).toBe(0)
  })

  it('has no access for anonymous callers', async () => {
    for (const t of ['drivers', 'vehicles']) expect((await withUser(null, (c) => c.attempt(`select * from public.${t}`)) as Out).ok, t).toBe(false)
  })
})

describe('the expiry warning setting', () => {
  it('is registered with a default of 30 days and validated', async () => {
    const eff = await withUser(owner, async (c) => (await c.q(`select public.app_settings(null) as s`)).rows[0].s as Record<string, unknown>)
    expect(JSON.stringify(eff)).toContain('expiry_warning_days')
    for (const bad of [0, 366, 7.5, '30']) expect(await code(call(owner, `select public.save_setting('fleet', 'expiry_warning_days', $1::jsonb, null, null)`, [JSON.stringify(bad)])), String(bad)).toBe('22023')
    expect(await code(call(owner, `select public.save_setting('fleet', 'expiry_warning_days', '45'::jsonb, null, null)`))).toBe('ok')
    expect(await code(call(cashier, `select public.save_setting('fleet', 'expiry_warning_days', '45'::jsonb, null, null)`))).not.toBe('ok')
  })
})

void createAuthUser
