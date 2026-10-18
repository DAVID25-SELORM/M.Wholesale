import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addUser, admin, closePool, createOrg, withUser, type Org } from '../helpers/db'

let a: Org
let b: Org
let auditor: string
let cashier: string

type Out = { ok: true; rows: any[] } | { ok: false; code: string; message: string }
const call = (user: string | null, sql: string, params: unknown[] = []): Promise<Out> => withUser(user, (c) => c.attempt(sql, params), { commit: true }) as Promise<Out>
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows
const report = (user: string | null, msg = 'boom', source = 'render', path = '/sales/invoices?token=secret#frag') =>
  call(user, `select public.report_client_error($1, $2, 'Error: boom, at x', $3, 'abc123', 'TestBrowser/1')`, [source, msg, path])

beforeAll(async () => {
  a = await createOrg('ERR-A')
  b = await createOrg('ERR-B')
  auditor = await addUser(a.id, 'AUDITOR')
  cashier = await addUser(a.id, 'CASHIER')
})
afterAll(closePool)

describe('application error log', () => {
  it('records a report from any signed-in member, without the query string, and nothing from outsiders', async () => {
    expect((await report(cashier, 'Cannot read properties of undefined')).ok).toBe(true)
    const [row] = await q(`select * from public.client_errors where user_id = $1`, [cashier])
    expect(row).toMatchObject({ organization_id: a.id, source: 'render', page_path: '/sales/invoices', app_version: 'abc123' })
    expect((await report(null)).ok).toBe(false)                                                  // anonymous: no permission to call
    expect((await report(cashier, '   ')).ok).toBe(true)                                         // silently ignored
    expect((await report(cashier, 'x', 'hacker')).ok).toBe(true)
    expect((await q(`select count(*)::int n from public.client_errors where user_id = $1`, [cashier]))[0].n).toBe(1)
  })

  it('shows the log only to people with the audit right, within their own organization, and cannot be edited or deleted', async () => {
    const seen = (user: string) => withUser(user, async (c) => (await c.q(`select count(*)::int n from public.client_errors`)).rows[0].n)
    expect(await seen(auditor)).toBe(1)
    expect(await seen(a.ownerId)).toBe(1)
    expect(await seen(cashier)).toBe(0)
    expect(await seen(b.ownerId)).toBe(0)
    for (const sql of [`update public.client_errors set message = 'x'`, `delete from public.client_errors`,
      `insert into public.client_errors (organization_id, user_id, source, message) values (gen_random_uuid(), gen_random_uuid(), 'render', 'x')`]) {
      expect((await call(a.ownerId, sql)).ok, sql).toBe(false)
    }
    await expect(admin.query(`delete from public.client_errors`)).rejects.toMatchObject({ code: '42501' })
  })

  it('stops a runaway loop at 50 reports an hour per user', async () => {
    const user = await addUser(a.id, 'CASHIER')
    for (let i = 0; i < 55; i++) await report(user, `loop ${i}`)
    expect((await q(`select count(*)::int n from public.client_errors where user_id = $1`, [user]))[0].n).toBe(50)
  })
})
