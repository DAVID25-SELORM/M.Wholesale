import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addLocation, addProduct, addSupplier, addUser, addWarehouse, admin, closePool, createOrg, withUser, type Org } from '../helpers/db'

// A cross-tenant sweep over EVERYTHING that exists, not a hand-picked list: every table that carries an organization_id, and every report-style function.
// New tables and functions are covered automatically, so a module added later cannot forget tenant isolation without this test failing.
// It is most meaningful inside the full database suite (other test files leave rows of many organizations behind); alone it still checks the rows it creates.

let a: Org
let b: Org
let aReader: string
let tenantTables: { name: string; hasId: boolean }[]

const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

beforeAll(async () => {
  a = await createOrg('SWEEP-A')
  b = await createOrg('SWEEP-B')
  for (const o of [a, b]) {
    const second = await addBranch(o.id, 'S2')
    const wh = await addWarehouse(o.id, o.hq, 'SW1')
    await addWarehouse(o.id, second, 'SW2')
    await addLocation(o.id, wh, 'SL1')
    await addProduct(o.id)
    await addSupplier(o.id)
  }
  aReader = await addUser(a.id, 'OWNER')
  tenantTables = (await q(`select c.relname as name, exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'id') as "hasId"
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and exists (select 1 from pg_attribute x where x.attrelid = c.oid and x.attname = 'organization_id' and not x.attisdropped) order by 1`)) as typeof tenantTables
})
afterAll(closePool)

describe('tenant sweep: every table with an organization_id', () => {
  it('finds the tenant tables (a floor, so a broken catalog query cannot make the sweep pass by checking nothing)', () => {
    expect(tenantTables.length).toBeGreaterThanOrEqual(68)
  })

  it('shows an organization A user no row of any other organization, in any table', async () => {
    const leaks: string[] = []
    let meaningful = 0
    await withUser(a.ownerId, async (c) => {
      for (const t of tenantTables) {
        const seen = (await c.q(`select count(*)::int n from public.${t.name} where organization_id <> $1`, [a.id])).rows[0].n as number
        if (seen > 0) leaks.push(`${t.name}: ${seen} rows of other organizations`)
      }
    })
    for (const t of tenantTables) if (((await q(`select count(*)::int n from public.${t.name} where organization_id <> $1`, [a.id]))[0].n as number) > 0) meaningful += 1
    expect(leaks).toEqual([])
    expect(meaningful, 'the sweep needs other organizations to have rows in several tables to mean anything').toBeGreaterThanOrEqual(6)
  })

  it('cannot update or delete another organization\'s rows in any table (zero rows affected or refused outright)', async () => {
    const touched: string[] = []
    for (const t of tenantTables) {
      for (const sql of [`update public.${t.name} set organization_id = organization_id where organization_id <> $1`, `delete from public.${t.name} where organization_id <> $1`]) {
        const r = await withUser(a.ownerId, (c) => c.attempt(sql, [a.id]))
        if (r.ok && r.rowCount > 0) touched.push(`${t.name}: ${sql.split(' ')[0]} affected ${r.rowCount}`)
      }
    }
    expect(touched).toEqual([])
  })

  it('cannot create a row in another organization by naming it, in any table whose columns the browser may write', async () => {
    // organization_id is not a writable column for users anywhere (column grants): naming it is refused, never honoured
    const writable = await q(`select table_name from information_schema.column_privileges where table_schema = 'public' and column_name = 'organization_id' and grantee = 'authenticated' and privilege_type in ('INSERT', 'UPDATE')`)
    expect(writable.map((r) => r.table_name)).toEqual([])
  })
})

// This automatic sweep covers every report-style function callable with no arguments.
// Parameterized reports are exercised in their module security suites (reporting.test.ts,
// accounting.test.ts, phase12.test.ts, and picking.test.ts) with foreign tenant records.
describe('tenant sweep: report-style functions (those callable with no arguments)', () => {
  it('return no id that belongs to another organization, for either organization', async () => {
    const fns = await q(`select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proretset
      and has_function_privilege('authenticated', p.oid, 'execute') and p.pronargs = p.pronargdefaults order by 1`)
    expect(fns.length).toBeGreaterThanOrEqual(8)
    const problems: string[] = []
    for (const [me, other] of [[a, b], [b, a]] as const) {
      const foreign = new Set<string>()
      for (const t of tenantTables.filter((x) => x.hasId)) for (const r of await q(`select id::text as id from public.${t.name} where organization_id = $1`, [other.id])) foreign.add(r.id as string)
      const user = me === a ? a.ownerId : b.ownerId
      for (const f of fns) {
        const res = await withUser(user, (c) => c.attempt(`select * from public.${f.proname}()`))
        if (!res.ok) continue                                                   // refused (no permission, accounting not started ...): nothing leaked
        for (const row of res.rows) for (const [k, v] of Object.entries(row)) if (typeof v === 'string' && UUID.test(v) && foreign.has(v)) problems.push(`${f.proname}.${k} shows another organization's id ${v}`)
      }
    }
    expect(problems).toEqual([])
  })
})

describe('tenant sweep: functions and the platform boundary', () => {
  it('no function a signed-in user may call takes an organization id, so none can be pointed at another organization', async () => {
    const rows = await q(`select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute')
      and pg_get_function_arguments(p.oid) ~* '(^|[ ,])(p_)?org(anization)?(_id)?[ ,]'`)
    expect(rows).toEqual([])
  })

  it('platform-level operations (creating organizations and their first users) are not callable by any signed-in user, anonymous or not', async () => {
    const rows = await q(`select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as authed, has_function_privilege('anon', p.oid, 'execute') as anon
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('provision_organization', 'provision_user', 'complete_invitation')`)
    expect(rows.length).toBe(3)
    expect(rows.filter((r) => r.authed || r.anon)).toEqual([])
    const platformTables = await q(`select table_name from information_schema.table_privileges where table_schema = 'public' and grantee = 'authenticated' and privilege_type in ('INSERT', 'DELETE') and table_name = 'organizations'`)
    expect(platformTables).toEqual([])                                              // organizations are neither created nor deleted from the app
  })

  it('shared reference data (units of measure, dosage forms, permission names) is read-only for everyone in the app, and readable only when signed in to an organization', async () => {
    for (const t of ['units_of_measure', 'dosage_forms', 'permissions', 'role_permissions']) {
      const writes = await q(`select privilege_type from information_schema.table_privileges where table_schema = 'public' and table_name = $1 and grantee in ('authenticated', 'anon') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')`, [t])
      expect(writes, t).toEqual([])
    }
    const anon = await withUser(null, (c) => c.attempt(`select * from public.units_of_measure`))
    expect(anon.ok).toBe(false)
    expect((await withUser(aReader, async (c) => (await c.q(`select count(*)::int n from public.units_of_measure`)).rows[0].n)) as number).toBeGreaterThan(0)
  })
})
