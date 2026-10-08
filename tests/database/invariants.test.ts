import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addLocation, addUser, addWarehouse, admin, closePool, createOrg, roleId, type Org } from '../helpers/db'

let a: Org
let b: Org
let bWh: string

beforeAll(async () => {
  a = await createOrg('INV-A')
  b = await createOrg('INV-B')
  bWh = await addWarehouse(b.id, b.hq, 'WH1')
})
afterAll(closePool)

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e.code as string)

describe('database invariants (checked as the trusted server role, i.e. without RLS)', () => {
  it('10: a branch must belong to a matching organization (profile default branch / role scope)', async () => {
    const u = await addUser(a.id, 'READ_ONLY')
    expect(await code(admin.query('update public.profiles set default_branch_id = $1 where id = $2', [b.hq, u]))).toBe('23503')
    expect(await code(admin.query(
      'insert into public.user_roles (user_id, role_id, organization_id, branch_id) values ($1, $2, $3, $4)',
      [u, await roleId('CASHIER'), a.id, b.hq]))).toBe('23503')
    // system settings / number sequences too
    expect(await code(admin.query(
      `insert into public.system_settings (organization_id, branch_id, category, key, value) values ($1, $2, 'sales', 'k', '1')`,
      [a.id, b.hq]))).toBe('23503')
  })

  it('11: a warehouse organization must equal its branch organization', async () => {
    expect(await code(admin.query(
      `insert into public.warehouses (organization_id, branch_id, code, name) values ($1, $2, 'CROSS', 'x')`,
      [a.id, b.hq]))).toBe('23503')
    expect(await code(admin.query(
      `insert into public.warehouses (organization_id, branch_id, code, name) values ($1, $2, 'OK1', 'x')`,
      [a.id, a.hq]))).toBe('ok')
  })

  it('12: a warehouse location organization must equal its warehouse organization', async () => {
    expect(await code(admin.query(
      `insert into public.warehouse_locations (organization_id, warehouse_id, code) values ($1, $2, 'CROSS')`,
      [a.id, bWh]))).toBe('23503')
  })

  it('13: branch codes are unique within an organization, reusable across organizations', async () => {
    await addBranch(a.id, 'DUP1')
    expect(await code(addBranch(a.id, 'DUP1'))).toBe('23505')
    expect(await code(addBranch(b.id, 'DUP1'))).toBe('ok')
  })

  it('14: warehouse codes are unique within an organization (across branches)', async () => {
    const a2 = await addBranch(a.id, 'WBR2')
    await addWarehouse(a.id, a.hq, 'WDUP')
    expect(await code(addWarehouse(a.id, a2, 'WDUP'))).toBe('23505')
    expect(await code(addWarehouse(b.id, b.hq, 'WDUP'))).toBe('ok')
  })

  it('location codes are unique per warehouse, and picking sequence cannot be negative', async () => {
    const w = await addWarehouse(a.id, a.hq, 'LOCW')
    await addLocation(a.id, w, 'L1')
    expect(await code(addLocation(a.id, w, 'L1'))).toBe('23505')
    expect(await code(admin.query(
      `insert into public.warehouse_locations (organization_id, warehouse_id, code, picking_sequence) values ($1, $2, 'NEG', -1)`,
      [a.id, w]))).toBe('23514')
  })

  it('only one head office per organization; codes must be well formed', async () => {
    expect(await code(admin.query(`insert into public.branches (organization_id, code, name, is_head_office) values ($1, 'HQ2', 'x', true)`, [a.id]))).toBe('23505')
    expect(await code(admin.query(`insert into public.branches (organization_id, code, name) values ($1, 'bad code', 'x')`, [a.id]))).toBe('23514')
    expect(await code(admin.query(`insert into public.branches (organization_id, code, name) values ($1, 'LOWER', '  ')`, [a.id]))).toBe('23514')
  })

  it('organization validation: currency, country and time zone', async () => {
    expect(await code(admin.query(`insert into public.organizations (name, currency_code) values ('x', 'ghs')`))).toBe('23514')
    expect(await code(admin.query(`insert into public.organizations (name, country) values ('x', 'GHA')`))).toBe('23514')
    expect(await code(admin.query(`insert into public.organizations (name, timezone) values ('x', 'Mars/Olympus')`))).not.toBe('ok')
    expect(await code(admin.query(`insert into public.organizations (name) values ('Defaults')`))).toBe('ok')
    const d = await admin.query(`select currency_code, timezone, country from public.organizations where name = 'Defaults'`)
    expect(d.rows[0]).toEqual({ currency_code: 'GHS', timezone: 'Africa/Accra', country: 'GH' })
  })

  it('role scope rules: role of another organization / inactive role cannot be assigned; duplicates rejected', async () => {
    const u = await addUser(a.id, 'READ_ONLY')
    expect(await code(admin.query(
      'insert into public.user_roles (user_id, role_id, organization_id) values ($1, $2, $3)',
      [u, await roleId('READ_ONLY'), a.id]))).toBe('23505')
    await admin.query(`update public.roles set is_active = false where organization_id is null and code = 'DRIVER'`)
    expect(await code(admin.query(
      'insert into public.user_roles (user_id, role_id, organization_id) values ($1, $2, $3)',
      [u, await roleId('DRIVER'), a.id]))).toBe('23514')
    await admin.query(`update public.roles set is_active = true where organization_id is null and code = 'DRIVER'`)
  })

  it('no hard deletes of tenant data are possible through foreign keys', async () => {
    expect(await code(admin.query('delete from public.branches where id = $1', [a.hq]))).toBe('23503')
    expect(await code(admin.query('delete from public.organizations where id = $1', [a.id]))).toBe('23503')
  })

  it('updated_at is maintained and created_at is stable', async () => {
    const id = await addBranch(a.id, 'TS1')
    const before = (await admin.query('select created_at, updated_at from public.branches where id = $1', [id])).rows[0]
    await new Promise((r) => setTimeout(r, 20))
    await admin.query(`update public.branches set name = 'later' where id = $1`, [id])
    const after = (await admin.query('select created_at, updated_at from public.branches where id = $1', [id])).rows[0]
    expect(after.created_at).toEqual(before.created_at)
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime())
  })
})
