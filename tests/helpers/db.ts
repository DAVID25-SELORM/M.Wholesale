import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'

const base = {
  host: '127.0.0.1',
  port: Number(process.env.WPS_TEST_PORT ?? 54522),
  user: 'postgres',
  password: process.env.WPS_TEST_PASSWORD ?? 'wps_test_pw',
  database: 'wps_test',
}

/** Superuser-ish pool (role `postgres`): used only to build fixtures and inspect results. */
export const admin = new pg.Pool({ ...base, max: 25 })

/**
 * Low-privilege login used for simulated API requests, exactly like Supabase's `authenticator`:
 * it can SET ROLE anon / authenticated / service_role and nothing else.
 */
const app = new pg.Pool({ ...base, user: 'wps_authenticator', password: 'wps_test_pw', max: 25 })

export const rand = () => randomBytes(4).toString('hex').toUpperCase()

export type QueryResult = { ok: true; rows: any[]; rowCount: number } | { ok: false; code: string; message: string }

export interface Ctx {
  /** Run a statement; throws on error. */
  q: (sql: string, params?: unknown[]) => Promise<pg.QueryResult<any>>
  /** Run a statement inside a savepoint and report the outcome instead of throwing. */
  attempt: (sql: string, params?: unknown[]) => Promise<QueryResult>
}

/**
 * Executes `fn` the way PostgREST would for a signed-in user: role `authenticated`,
 * verified JWT claims in request.jwt.claims. Rolled back unless commit is requested.
 * userId = null -> `anon` with no claims.
 */
export async function withUser<T>(
  userId: string | null,
  fn: (ctx: Ctx) => Promise<T>,
  opts: { commit?: boolean; role?: 'authenticated' | 'anon'; claims?: Record<string, unknown> } = {},
): Promise<T> {
  const client = await app.connect()
  const role = opts.role ?? (userId ? 'authenticated' : 'anon')
  let n = 0
  try {
    await client.query('begin')
    await client.query(`set local role ${role}`)
    if (userId) {
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role, ...(opts.claims ?? {}) }),
      ])
    }
    const ctx: Ctx = {
      q: (sql, params) => client.query(sql, params as any[]),
      attempt: async (sql, params) => {
        const sp = `sp_${n++}`
        await client.query(`savepoint ${sp}`)
        try {
          const r = await client.query(sql, params as any[])
          await client.query(`release savepoint ${sp}`)
          return { ok: true, rows: r.rows, rowCount: r.rowCount ?? 0 }
        } catch (e: any) {
          await client.query(`rollback to savepoint ${sp}`)
          return { ok: false, code: e.code ?? 'UNKNOWN', message: e.message }
        }
      },
    }
    const out = await fn(ctx)
    if (opts.commit) await client.query('commit')
    else await client.query('rollback')
    return out
  } catch (e) {
    try { await client.query('rollback') } catch { /* ignore */ }
    throw e
  } finally {
    client.release()
  }
}

export async function createAuthUser(): Promise<string> {
  const id = randomUUID()
  await admin.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@test.invalid`])
  return id
}

export interface Org {
  id: string
  ownerId: string
  hq: string
}

export async function createOrg(label = 'Org'): Promise<Org> {
  const ownerId = await createAuthUser()
  const { rows } = await admin.query(
    `select public.provision_organization($1, 'Olivia', 'Owner', $2, 'HQ', 'Head Office') as id`,
    [ownerId, `${label} ${rand()}`],
  )
  const id = rows[0].id as string
  const hq = (await admin.query('select id from public.branches where organization_id = $1 and is_head_office', [id])).rows[0].id
  return { id, ownerId, hq }
}

export async function addBranch(orgId: string, code: string): Promise<string> {
  const { rows } = await admin.query(
    `insert into public.branches (organization_id, code, name) values ($1, $2, $3) returning id`,
    [orgId, code, `Branch ${code}`],
  )
  return rows[0].id
}

export async function addWarehouse(orgId: string, branchId: string, code: string): Promise<string> {
  const { rows } = await admin.query(
    `insert into public.warehouses (organization_id, branch_id, code, name) values ($1, $2, $3, $4) returning id`,
    [orgId, branchId, code, `Warehouse ${code}`],
  )
  return rows[0].id
}

export async function addLocation(orgId: string, warehouseId: string, code: string): Promise<string> {
  const { rows } = await admin.query(
    `insert into public.warehouse_locations (organization_id, warehouse_id, code, aisle, rack, shelf, bin, picking_sequence)
     values ($1, $2, $3, 'A', '1', '1', '1', 10) returning id`,
    [orgId, warehouseId, code],
  )
  return rows[0].id
}

/** Creates an auth user + profile + role assignment. branchId = null -> organization-wide. */
export async function addUser(orgId: string, roleCode: string, branchId: string | null = null): Promise<string> {
  const id = await createAuthUser()
  await admin.query(`select public.provision_user($1, $2, 'Test', $3, $4, $5)`, [id, orgId, roleCode, roleCode, branchId])
  return id
}

export async function roleId(code: string): Promise<string> {
  return (await admin.query('select id from public.roles where organization_id is null and code = $1', [code])).rows[0].id
}

export async function closePool() {
  await Promise.allSettled([admin.end(), app.end()])
}
