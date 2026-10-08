// Development seed: two independent demo organizations with branches, warehouses, locations and users.
//   DEV_SEED_PASSWORD='<12+ chars of your choice>' node scripts/seed-dev.mjs
//
// - Needs the local stack (`node scripts/dev-stack.mjs up`) and reads its service key from .stack/ (git-ignored).
// - NO default password exists on purpose: you must supply DEV_SEED_PASSWORD. Nothing here is a production credential.
// - Users are created through GoTrue's admin API and provisioned via the service-role-only SQL functions,
//   exactly the path a real server-side onboarding/invite flow will use.
// - Idempotent: running it twice does not duplicate anything.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const secretsFile = join(root, '.stack', 'secrets.json')
if (!existsSync(secretsFile)) {
  console.error('Local stack not found. Run: node scripts/dev-stack.mjs up')
  process.exit(1)
}
const { authUrl, restUrl, serviceKey } = JSON.parse(readFileSync(secretsFile, 'utf8'))

const password = process.env.DEV_SEED_PASSWORD ?? ''
if (password.length < 12) {
  console.error('Set DEV_SEED_PASSWORD (min 12 characters). There is intentionally no default.')
  process.exit(1)
}

const svc = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  'Content-Type': 'application/json',
}

async function rest(method, path, body, extra = {}) {
  const res = await fetch(`${restUrl}${path}`, { method, headers: { ...svc, ...extra }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

async function ensureAuthUser(email) {
  const res = await fetch(`${authUrl}/admin/users`, {
    method: 'POST', headers: svc, body: JSON.stringify({ email, password, email_confirm: true }),
  })
  if (res.ok) return (await res.json()).id
  const list = await fetch(`${authUrl}/admin/users?per_page=200`, { headers: svc })
  const found = (await list.json()).users?.find((u) => u.email === email)
  if (found) return found.id
  throw new Error(`could not create or find ${email}: ${res.status} ${await res.text()}`)
}

async function ensureOrg(name, owner) {
  const existing = await rest('GET', `/organizations?select=id&name=eq.${encodeURIComponent(name)}`)
  if (existing[0]) return existing[0].id
  const ownerId = await ensureAuthUser(owner.email)
  return rest('POST', '/rpc/provision_organization', {
    p_user_id: ownerId, p_first_name: owner.first, p_last_name: owner.last, p_name: name,
    p_legal_name: `${name}`, p_branch_code: 'HQ', p_branch_name: 'Head Office',
  })
}

async function ensureBranch(orgId, code, name, city) {
  const ex = await rest('GET', `/branches?select=id&organization_id=eq.${orgId}&code=eq.${code}`)
  if (ex[0]) return ex[0].id
  return (await rest('POST', '/branches', { organization_id: orgId, code, name, city }, { Prefer: 'return=representation' }))[0].id
}

async function ensureWarehouse(orgId, branchId, code, name, type = 'MAIN') {
  const ex = await rest('GET', `/warehouses?select=id&organization_id=eq.${orgId}&code=eq.${code}`)
  if (ex[0]) return ex[0].id
  return (await rest('POST', '/warehouses', { organization_id: orgId, branch_id: branchId, code, name, warehouse_type: type }, { Prefer: 'return=representation' }))[0].id
}

async function ensureLocations(orgId, warehouseId, prefix) {
  const ex = await rest('GET', `/warehouse_locations?select=id&warehouse_id=eq.${warehouseId}&limit=1`)
  if (ex[0]) return
  const rows = []
  let seq = 10
  for (const aisle of ['A', 'B']) {
    for (const rack of ['1', '2']) {
      for (const shelf of ['1', '2', '3']) {
        rows.push({ organization_id: orgId, warehouse_id: warehouseId, code: `${prefix}-${aisle}${rack}-${shelf}`, aisle, rack, shelf, bin: '01', picking_sequence: seq })
        seq += 10
      }
    }
  }
  await rest('POST', '/warehouse_locations', rows)
}

async function ensureUser(orgId, u, branchId = null) {
  const id = await ensureAuthUser(u.email)
  const ex = await rest('GET', `/profiles?select=id&id=eq.${id}`)
  if (!ex[0]) {
    await rest('POST', '/rpc/provision_user', {
      p_user_id: id, p_organization_id: orgId, p_first_name: u.first, p_last_name: u.last, p_role_code: u.role, p_branch_id: branchId,
    })
  }
  if (u.inactive) await rest('PATCH', `/profiles?id=eq.${id}`, { is_active: false })
  return id
}

// ---- Organization A: the main demo --------------------------------------------------------
const orgA = await ensureOrg('Demo Wholesale Pharma Ltd', { email: 'owner@demo.test', first: 'Ama', last: 'Owusu' })
const hqA = (await rest('GET', `/branches?select=id&organization_id=eq.${orgA}&is_head_office=is.true`))[0].id
const kumA = await ensureBranch(orgA, 'KUM', 'Kumasi Branch', 'Kumasi')
const whMainHq = await ensureWarehouse(orgA, hqA, 'MAIN-HQ', 'Head Office Main Store', 'MAIN')
await ensureWarehouse(orgA, hqA, 'RET-HQ', 'Head Office Returns', 'RETURNS')
const whMainKum = await ensureWarehouse(orgA, kumA, 'MAIN-KUM', 'Kumasi Main Store', 'MAIN')
await ensureLocations(orgA, whMainHq, 'HQ')
await ensureLocations(orgA, whMainKum, 'KUM')

await ensureUser(orgA, { email: 'kumasi.manager@demo.test', first: 'Kofi', last: 'Boateng', role: 'BRANCH_MANAGER' }, kumA)
await ensureUser(orgA, { email: 'auditor@demo.test', first: 'Efua', last: 'Mensah', role: 'AUDITOR' })
await ensureUser(orgA, { email: 'cashier@demo.test', first: 'Yaw', last: 'Darko', role: 'CASHIER' })
await ensureUser(orgA, { email: 'viewer@demo.test', first: 'Abena', last: 'Asante', role: 'READ_ONLY' })
await ensureUser(orgA, { email: 'inactive@demo.test', first: 'Kwame', last: 'Former', role: 'READ_ONLY', inactive: true })

// ---- Organization B: proves tenant isolation in the browser -----------------------------------
const orgB = await ensureOrg('Other Pharma Ltd', { email: 'owner@other.test', first: 'Nana', last: 'Other' })
const hqB = (await rest('GET', `/branches?select=id&organization_id=eq.${orgB}&is_head_office=is.true`))[0].id
await ensureWarehouse(orgB, hqB, 'MAIN-HQ', 'Other Main Store')

console.log('Seeded.')
console.log('  Organization A: owner@demo.test, kumasi.manager@demo.test (Kumasi only), auditor@demo.test,')
console.log('                  cashier@demo.test, viewer@demo.test, inactive@demo.test (deactivated)')
console.log('  Organization B: owner@other.test')
console.log('  Password for all of them = the DEV_SEED_PASSWORD you supplied.')
