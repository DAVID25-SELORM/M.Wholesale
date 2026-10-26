import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addUser, addWarehouse, admin, closePool, createOrg, withUser, type Org } from '../helpers/db'

let a: Org
let b: Org
let branch2: string
let whHq: string
let whB2: string
let whB: string
let owner: string
let viewer: string      // AUDITOR: settings.view only
let cashier: string     // no settings rights at all
let manager2: string    // GENERAL_MANAGER limited to branch 2: settings.manage there only
let cashier2: string    // CASHIER limited to branch 2

type Out = { ok: true; rows: any[] } | { ok: false; code: string; message: string }
const call = (user: string, sql: string, params: unknown[] = []): Promise<Out> => withUser(user, (c) => c.attempt(sql, params), { commit: true }) as Promise<Out>
const ok = async (p: Promise<Out>) => { const r = await p; if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`); return r.rows[0] }
const failure = async (p: Promise<Out>) => { const r = await p; return r.ok ? { code: 'ok', message: '' } : { code: r.code, message: r.message } }
const code = async (p: Promise<Out>) => (await failure(p)).code
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows

const save = (user: string, cat: string, key: string, value: unknown, branch: string | null = null, reason: string | null = null) =>
  call(user, `select public.save_setting($1, $2, $3::jsonb, $4, $5)`, [cat, key, JSON.stringify(value), branch, reason])
const a_id = () => a.id
const effective = async (user: string, branch: string | null = null) =>
  withUser(user, async (c) => (await c.q(`select public.app_settings($1) as s`, [branch])).rows[0].s as Record<string, unknown>)

beforeAll(async () => {
  a = await createOrg('SET-A')
  b = await createOrg('SET-B')
  branch2 = await addBranch(a.id, 'B2')
  whHq = await addWarehouse(a.id, a.hq, 'W1')
  whB2 = await addWarehouse(a.id, branch2, 'W2')
  whB = await addWarehouse(b.id, b.hq, 'WB')
  owner = a.ownerId
  viewer = await addUser(a.id, 'AUDITOR')
  cashier = await addUser(a.id, 'CASHIER')
  manager2 = await addUser(a.id, 'GENERAL_MANAGER', branch2)
  cashier2 = await addUser(a.id, 'CASHIER', branch2)
})
afterAll(closePool)

describe('the registry: only supported settings with valid values', () => {
  it('rejects unknown settings, from users and from the server role alike', async () => {
    expect(await code(save(owner, 'sales', 'made_up', 1))).toBe('22023')
    expect(await code(save(owner, 'nope', 'footer', 'x'))).toBe('22023')
    await expect(admin.query(`insert into public.system_settings (organization_id, category, key, value) values ($1, 'sales', 'made_up', '1')`, [a.id])).rejects.toMatchObject({ code: '22023' })
    await expect(admin.query(`insert into public.system_settings (organization_id, category, key, value) values ($1, 'integrations', 'api_key', '"secret"')`, [a.id])).rejects.toMatchObject({ code: '22023' })
  })

  it('checks types, ranges and lengths', async () => {
    const bad: [string, string, unknown][] = [
      ['sales', 'default_payment_terms_days', 400], ['sales', 'default_payment_terms_days', -1], ['sales', 'default_payment_terms_days', 7.5], ['sales', 'default_payment_terms_days', '30'],
      ['sales', 'quotation_validity_days', 0], ['credit', 'default_credit_limit', -5], ['credit', 'default_credit_limit', 10.123], ['credit', 'default_credit_limit', 2_000_000_000],
      ['inventory', 'near_expiry_days', 0], ['inventory', 'near_expiry_days', 731], ['invoice', 'footer', 'x'.repeat(301)], ['invoice', 'footer', 42], ['invoice', 'payment_instructions', 'y'.repeat(501)],
      ['purchasing', 'default_payment_terms_days', 366],
    ]
    for (const [cat, key, v] of bad) expect(await code(save(owner, cat, key, v, null, 'a good reason')), `${cat}.${key}=${JSON.stringify(v)}`).toBe('22023')
    for (const [cat, key, v] of [['sales', 'default_payment_terms_days', 30], ['credit', 'default_credit_limit', 2500.5], ['invoice', 'footer', 'Thank you for your business'], ['inventory', 'near_expiry_days', 120]] as [string, string, unknown][]) {
      await ok(save(owner, cat, key, v))
    }
    const e = await effective(owner)
    expect(e).toMatchObject({ 'sales.default_payment_terms_days': 30, 'credit.default_credit_limit': 2500.5, 'invoice.footer': 'Thank you for your business', 'inventory.near_expiry_days': 120 })
  })

  it('scopes settings correctly and only accepts an active warehouse of that branch', async () => {
    expect(await code(save(owner, 'inventory', 'default_sales_warehouse', whHq))).toBe('22023')                        // a branch setting without a branch
    expect(await code(save(owner, 'sales', 'quotation_validity_days', 14, branch2))).toBe('22023')                     // an organization setting with a branch
    expect(await code(save(owner, 'inventory', 'default_sales_warehouse', whHq, branch2))).toBe('22023')               // another branch's warehouse
    expect(await code(save(owner, 'inventory', 'default_sales_warehouse', whB, branch2))).toBe('22023')                // another organization's warehouse
    expect(await code(save(owner, 'inventory', 'default_sales_warehouse', 'not-a-uuid', branch2))).toBe('22023')
    expect(await code(save(owner, 'inventory', 'default_sales_warehouse', whB2, b.hq))).toBe('22023')                  // another organization's branch
    await ok(save(owner, 'inventory', 'default_sales_warehouse', whB2, branch2))
    await q(`update public.warehouses set is_active = false where id = $1`, [whB2])
    expect(await code(save(owner, 'inventory', 'default_sales_warehouse', whB2, branch2))).toBe('22023')               // inactive
    await q(`update public.warehouses set is_active = true where id = $1`, [whB2])
  })

  it('treats the idle time-out as sensitive: 0 (off) or at least 5 minutes, and always with a reason', async () => {
    expect(await code(save(owner, 'security', 'idle_timeout_minutes', 30))).toBe('22023')                              // no reason
    expect(await code(save(owner, 'security', 'idle_timeout_minutes', 30, null, 'x'))).toBe('22023')                   // reason too short
    expect(await code(save(owner, 'security', 'idle_timeout_minutes', 3, null, 'Shared counter PCs'))).toBe('22023')   // below the minimum
    expect(await code(save(owner, 'security', 'idle_timeout_minutes', 500, null, 'Shared counter PCs'))).toBe('22023')
    await ok(save(owner, 'security', 'idle_timeout_minutes', 30, null, 'Shared counter PCs'))
    await ok(save(owner, 'security', 'idle_timeout_minutes', 0, null, 'Switched off for the warehouse office'))
    await ok(save(owner, 'security', 'idle_timeout_minutes', 20, null, 'Back on: audit recommendation'))
    const rowId = (await q(`select id from public.system_settings where organization_id = $1 and category = 'security' and key = 'idle_timeout_minutes'`, [a_id()]))[0].id
    const log = await q(`select action, actor_user_id, previous_values, new_values, reason from public.audit_logs where entity_type = 'system_setting' and entity_id = $1 order by created_at, id`, [rowId])
    expect(log.length).toBe(3)
    expect(log[0]).toMatchObject({ action: 'system_setting.created', actor_user_id: owner, reason: 'Shared counter PCs' })
    expect(log[log.length - 1]).toMatchObject({ action: 'system_setting.updated', reason: 'Back on: audit recommendation' })
    expect(log[log.length - 1].new_values).toMatchObject({ value: 20 })
    expect(log[log.length - 1].previous_values).toMatchObject({ value: 0 })
  })
})

describe('who may read and write', () => {
  it('lets only settings.manage change a setting, organization-wide or at the branch they manage', async () => {
    expect(await code(save(viewer, 'sales', 'quotation_validity_days', 10))).toBe('42501')
    expect(await code(save(cashier, 'sales', 'quotation_validity_days', 10))).toBe('42501')
    expect(await code(save(b.ownerId, 'inventory', 'default_sales_warehouse', whB2, branch2))).toBe('22023')            // another organization's branch: refused
    expect(await code(save(manager2, 'sales', 'quotation_validity_days', 10))).toBe('42501')                         // branch-limited: no organization-wide setting
    expect(await code(save(manager2, 'inventory', 'default_sales_warehouse', whB2, a.hq))).toBe('42501')            // another branch
    await ok(save(manager2, 'inventory', 'default_sales_warehouse', whB2, branch2))                                   // their own branch
    await ok(save(owner, 'sales', 'quotation_validity_days', 21))
    expect((await effective(owner))['sales.quotation_validity_days']).toBe(21)
  })

  it('shows effective values to every member, with branch overrides only for branches they can use', async () => {
    const orgWide = await effective(cashier)
    expect(orgWide).toMatchObject({ 'sales.quotation_validity_days': 21, 'inventory.default_sales_warehouse': null, 'security.idle_timeout_minutes': 20 })
    expect((await effective(cashier2, branch2))['inventory.default_sales_warehouse']).toBe(whB2)
    expect((await effective(cashier2, a.hq))['inventory.default_sales_warehouse']).toBeNull()                         // not their branch: no override
    expect((await effective(cashier, branch2))['inventory.default_sales_warehouse']).toBe(whB2)                       // organization-wide user may use any branch
    const other = await effective(b.ownerId)
    expect(other).toMatchObject({ 'sales.quotation_validity_days': 30, 'invoice.footer': '', 'inventory.near_expiry_days': 90 })   // defaults: B sees nothing of A
  })

  it('lets only people with settings.view open the Settings screen data, and marks where each value comes from', async () => {
    expect(await code(call(cashier, `select * from public.settings_overview()`))).toBe('42501')
    const rows = await withUser(viewer, async (c) => (await c.q(`select category || '.' || key as k, source, value from public.settings_overview($1)`, [branch2])).rows)
    const by = Object.fromEntries(rows.map((r) => [r.k, r]))
    expect(Object.keys(by).length).toBe(10)
    expect(by['sales.quotation_validity_days']).toMatchObject({ source: 'organization', value: 21 })
    expect(by['purchasing.default_payment_terms_days']).toMatchObject({ source: 'default', value: 30 })
    expect(by['inventory.default_sales_warehouse']).toMatchObject({ source: 'branch', value: whB2 })
  })

  it('resets a setting to its default when sent null, with a reason for sensitive ones, and audits it', async () => {
    await ok(save(owner, 'invoice', 'footer', 'Temporary footer'))
    expect((await effective(owner))['invoice.footer']).toBe('Temporary footer')
    expect(await code(save(viewer, 'invoice', 'footer', null))).toBe('42501')
    expect(await code(save(owner, 'made_up', 'x', null))).toBe('22023')
    await ok(save(owner, 'invoice', 'footer', null))
    expect((await effective(owner))['invoice.footer']).toBe('')
    expect(await code(save(owner, 'security', 'idle_timeout_minutes', null))).toBe('22023')             // sensitive: reason needed
    await ok(save(owner, 'security', 'idle_timeout_minutes', null, null, 'Reset to the default'))
    expect((await effective(owner))['security.idle_timeout_minutes']).toBe(0)
    expect((await q(`select count(*)::int n from public.audit_logs where organization_id = $1 and action = 'system_setting.deleted'`, [a.id]))[0].n).toBeGreaterThanOrEqual(2)
  })

  it('keeps the direct table protections: nobody edits keys or scope, and viewers cannot write', async () => {
    expect(await code(call(viewer, `insert into public.system_settings (category, key, value) values ('sales', 'default_payment_terms_days', '1')`))).toBe('42501')
    await expect(admin.query(`update public.system_settings set key = 'near_expiry_days' where category = 'sales' and key = 'quotation_validity_days'`)).rejects.toBeTruthy()
    const r = await call(owner, `update public.system_settings set category = 'credit' where category = 'sales' and key = 'quotation_validity_days'`)
    expect(r.ok).toBe(false)
  })
})

describe('document numbering', () => {
  it('lists every configurable document with its current format', async () => {
    const rows = await withUser(viewer, async (c) => (await c.q(`select * from public.numbering_overview()`)).rows)
    expect(rows.length).toBe(20)
    expect(rows.find((r) => r.document_type === 'RECALL')).toMatchObject({ prefix: 'REC' })
    expect(rows.find((r) => r.document_type === 'SALES_INVOICE')).toMatchObject({ prefix: 'INV', padding: 6, reset_period: 'YEARLY', next_number: '1', configured: false, in_use: false })
    expect(await code(call(cashier, `select * from public.numbering_overview()`))).toBe('42501')
  })

  it('configures prefix, length and reset period with rules that prevent duplicates', async () => {
    const cfg = (user: string, type: string, prefix: string, padding: number, reset: string) =>
      call(user, `select public.configure_document_numbering($1, $2, $3, $4)`, [type, prefix, padding, reset])
    expect(await code(cfg(viewer, 'SALES_INVOICE', 'TX', 6, 'YEARLY'))).toBe('42501')
    expect(await code(cfg(manager2, 'SALES_INVOICE', 'TX', 6, 'YEARLY'))).toBe('42501')
    expect(await code(cfg(owner, 'WHATEVER', 'TX', 6, 'YEARLY'))).toBe('22023')
    for (const p of ['', '-X', 'X-', 'X Y', 'x_y', 'ABCDEFGHIJKLMNOPQ']) expect(await code(cfg(owner, 'SALES_INVOICE', p, 6, 'YEARLY')), p).toBe('22023')
    expect(await code(cfg(owner, 'SALES_INVOICE', 'TX', 2, 'YEARLY'))).toBe('22023')
    expect(await code(cfg(owner, 'SALES_INVOICE', 'TX', 13, 'YEARLY'))).toBe('22023')
    expect(await code(cfg(owner, 'SALES_INVOICE', 'TX', 6, 'WEEKLY'))).toBe('22023')
    expect(await code(cfg(owner, 'SALES_ORDER', 'inv', 6, 'YEARLY'))).toBe('23514')                                   // another document's prefix (case-insensitive)
    expect(await code(cfg(owner, 'SALES_INVOICE', 'SO', 6, 'YEARLY'))).toBe('23514')

    // not yet in use: everything can change, including the reset period
    await ok(cfg(owner, 'SALES_INVOICE', 'tax-inv', 5, 'NEVER'))
    expect((await q(`select private.generate_document_number($1, null, 'SALES_INVOICE', 'INV') n`, [a.id]))[0].n).toBe('TAX-INV-00001')
    expect((await q(`select private.generate_document_number($1, null, 'SALES_INVOICE', 'INV') n`, [a.id]))[0].n).toBe('TAX-INV-00002')

    // now in use: prefix and length may change (the counter carries on), the reset period may not
    expect((await failure(cfg(owner, 'SALES_INVOICE', 'TAX-INV', 5, 'YEARLY'))).message).toMatch(/already been issued/)
    await ok(cfg(owner, 'SALES_INVOICE', 'FACT', 4, 'NEVER'))
    const next = await Promise.all(Array.from({ length: 10 }, () => q(`select private.generate_document_number($1, null, 'SALES_INVOICE', 'INV') n`, [a.id])))
    const numbers = next.map((r) => r[0].n as string)
    expect(new Set(numbers).size).toBe(10)
    expect(numbers.map((n) => n.replace('FACT-', '')).sort()).toEqual(['0003', '0004', '0005', '0006', '0007', '0008', '0009', '0010', '0011', '0012'])
    const log = await q(`select previous_values, new_values, actor_user_id from public.audit_logs where organization_id = $1 and action = 'numbering.configured' and entity_id = 'SALES_INVOICE' order by created_at, id`, [a.id])
    expect(log.length).toBe(2)
    expect(log[1]).toMatchObject({ actor_user_id: owner, previous_values: { prefix: 'TAX-INV', padding: 5, reset_period: 'NEVER' }, new_values: { prefix: 'FACT', padding: 4, reset_period: 'NEVER' } })
    expect((await q(`select prefix, next_number from public.number_sequences where organization_id = $1 and document_type = 'SALES_INVOICE'`, [a.id]))[0]).toMatchObject({ prefix: 'FACT', next_number: '13' })
    // another organization is untouched
    const other = await withUser(b.ownerId, async (c) => (await c.q(`select prefix from public.numbering_overview() where document_type = 'SALES_INVOICE'`)).rows[0].prefix)
    expect(other).toBe('INV')
  })
})
