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

// ---- Phase 1: catalogue and suppliers (idempotent) ------------------------------------------------
async function one(path) { return (await rest('GET', path))[0] }
async function ensure(table, findQuery, row) {
  const found = await one(`/${table}?select=id&${findQuery}`)
  if (found) return found.id
  return (await rest('POST', `/${table}`, row, { Prefer: 'return=representation' }))[0].id
}
const unit = async (code) => (await one(`/units_of_measure?select=id&code=eq.${code}`)).id
const form = async (code) => (await one(`/dosage_forms?select=id&code=eq.${code}`)).id

async function seedCatalogue(orgId) {
  const gsk = await ensure('manufacturers', `organization_id=eq.${orgId}&name=eq.GlaxoSmithKline`, { organization_id: orgId, name: 'GlaxoSmithKline', country: 'GB' })
  const ernest = await ensure('manufacturers', `organization_id=eq.${orgId}&name=eq.Ernest Chemists`, { organization_id: orgId, name: 'Ernest Chemists', country: 'GH' })
  const antibiotics = await ensure('product_categories', `organization_id=eq.${orgId}&code=eq.ANTIBIOTICS`, { organization_id: orgId, code: 'ANTIBIOTICS', name: 'Antibiotics' })
  const analgesics = await ensure('product_categories', `organization_id=eq.${orgId}&code=eq.ANALGESICS`, { organization_id: orgId, code: 'ANALGESICS', name: 'Analgesics' })

  const augIdentity = await ensure('product_identities', `organization_id=eq.${orgId}&generic_name=eq.Amoxicillin%20%2B%20Clavulanic%20acid`,
    { organization_id: orgId, generic_name: 'Amoxicillin + Clavulanic acid', dosage_form_id: await form('TABLET'), strength_text: '500 mg + 125 mg' })
  const pcmIdentity = await ensure('product_identities', `organization_id=eq.${orgId}&generic_name=eq.Paracetamol`,
    { organization_id: orgId, generic_name: 'Paracetamol', dosage_form_id: await form('TABLET'), strength_text: '500 mg' })

  const aug = await ensure('products', `organization_id=eq.${orgId}&sku=eq.AUG-625-14`, {
    organization_id: orgId, sku: 'AUG-625-14', identity_id: augIdentity, brand_name: 'Augmentin 625', manufacturer_id: gsk, category_id: antibiotics,
    product_class: 'POM', requires_prescription: true, base_unit_id: await unit('TABLET'), storage_condition: 'AMBIENT',
  })
  const augBox = await ensure('product_units', `product_id=eq.${aug}&unit_id=eq.${await unit('BOX')}`, { organization_id: orgId, product_id: aug, unit_id: await unit('BOX'), factor_to_base: 14 })
  await ensure('product_barcodes', `organization_id=eq.${orgId}&barcode=eq.6001087000017`, { organization_id: orgId, product_id: aug, product_unit_id: augBox, barcode: '6001087000017', barcode_type: 'GTIN' })
  await ensure('product_aliases', `organization_id=eq.${orgId}&normalized_alias=eq.augmentin%20625%20mg%2014%20s`, { organization_id: orgId, product_id: aug, alias: "AUGMENTIN 625MG 14'S" })
  await ensure('product_aliases', `organization_id=eq.${orgId}&normalized_alias=eq.co%20amoxiclav%20625`, { organization_id: orgId, product_id: aug, alias: 'Co-amoxiclav 625' })

  const pcm = await ensure('products', `organization_id=eq.${orgId}&sku=eq.PANADOL-500-100`, {
    organization_id: orgId, sku: 'PANADOL-500-100', identity_id: pcmIdentity, brand_name: 'Panadol Tablets 500 mg', manufacturer_id: gsk, category_id: analgesics,
    product_class: 'GSL', requires_prescription: false, base_unit_id: await unit('TABLET'),
  })
  const pcmBox = await ensure('product_units', `product_id=eq.${pcm}&unit_id=eq.${await unit('BOX')}`, { organization_id: orgId, product_id: pcm, unit_id: await unit('BOX'), factor_to_base: 100 })
  await ensure('products', `organization_id=eq.${orgId}&sku=eq.PCM-ERN-500-100`, {
    organization_id: orgId, sku: 'PCM-ERN-500-100', identity_id: pcmIdentity, brand_name: 'Ernest Paracetamol 500 mg', manufacturer_id: ernest, category_id: analgesics,
    product_class: 'GSL', requires_prescription: false, base_unit_id: await unit('TABLET'),
  })

  const emp = await ensure('suppliers', `organization_id=eq.${orgId}&code=eq.EMP`, {
    organization_id: orgId, code: 'EMP', name: 'Emmanuel Pharma Ltd', supplier_type: 'DISTRIBUTOR', licence_number: 'FDA/DIST/0412',
    licence_expiry: '2027-03-31', payment_terms_days: 30, contact_name: 'Emmanuel Tetteh', phone: '0302123456', email: 'orders@emp.example', city: 'Accra', country: 'GH',
  })
  await ensure('suppliers', `organization_id=eq.${orgId}&code=eq.KOF`, {
    organization_id: orgId, code: 'KOF', name: 'Kofi Medical Imports', supplier_type: 'IMPORTER', licence_number: 'FDA/IMP/0099',
    licence_expiry: '2026-11-15', payment_terms_days: 14, city: 'Tema', country: 'GH',
  })
  await ensure('supplier_products', `supplier_id=eq.${emp}&product_id=eq.${aug}`, {
    organization_id: orgId, supplier_id: emp, product_id: aug, product_unit_id: augBox, supplier_sku: 'EMP-AUG-14', supplier_product_name: 'AUGMENTIN 625 TAB 14S',
    last_cost: 85.5, lead_time_days: 3, is_preferred: true,
  })
  await ensure('supplier_products', `supplier_id=eq.${emp}&product_id=eq.${pcm}`, {
    organization_id: orgId, supplier_id: emp, product_id: pcm, product_unit_id: pcmBox, last_cost: 22, lead_time_days: 2,
  })
}
await seedCatalogue(orgA)

// ---- Phase 2: opening stock, posted the real way (as the owner, through post_stock_document) ----------
async function seedInventory(orgId) {
  const have = await one(`/stock_documents?select=id&organization_id=eq.${orgId}&limit=1`)
  if (have) return
  const { anonKey } = JSON.parse(readFileSync(secretsFile, 'utf8'))
  // the owner may have been created in an earlier run with another password: align it with this run's (local stack only)
  const ownerId = await ensureAuthUser('owner@demo.test')
  await fetch(`${authUrl}/admin/users/${ownerId}`, { method: 'PUT', headers: svc, body: JSON.stringify({ password }) })
  const login = await fetch(`${authUrl}/token?grant_type=password`, {
    method: 'POST', headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@demo.test', password }),
  })
  if (!login.ok) throw new Error(`owner login failed: ${login.status}`)
  const { access_token } = await login.json()
  const call = async (fn, body) => {
    const res = await fetch(`${restUrl}/rpc/${fn}`, {
      method: 'POST', headers: { apikey: anonKey, Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${fn} -> ${res.status} ${await res.text()}`)
    return res.json()
  }
  const wh = (await one(`/warehouses?select=id&organization_id=eq.${orgId}&order=code&limit=1`)).id
  const sku = async (s) => (await one(`/products?select=id&organization_id=eq.${orgId}&sku=eq.${s}`)).id
  const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  const aug = await sku('AUG-625-14')
  const pcm = await sku('PANADOL-500-100')
  const ern = await sku('PCM-ERN-500-100')
  const augBox = (await one(`/product_units?select=id&product_id=eq.${aug}&is_base=is.false`)).id
  await call('post_stock_document', {
    p_document_type: 'OPENING', p_warehouse_id: wh, p_notes: 'Demo opening balances',
    p_lines: [
      { product_id: aug, product_unit_id: augBox, quantity: 20, batch_number: 'AUG2601', expiry_date: day(25) },
      { product_id: aug, product_unit_id: augBox, quantity: 40, batch_number: 'AUG2608', expiry_date: day(540) },
      { product_id: pcm, quantity: 5000, batch_number: 'PN-7731', expiry_date: day(75) },
      { product_id: pcm, quantity: 12000, batch_number: 'PN-8020', expiry_date: day(700) },
      { product_id: ern, quantity: 800, batch_number: 'ERN-0042', expiry_date: day(200) },
      { product_id: ern, quantity: 150, batch_number: 'ERN-0009', expiry_date: day(-12), status: 'EXPIRED' },
    ],
  })
  await call('post_stock_document', {
    p_document_type: 'STATUS_CHANGE', p_warehouse_id: wh, p_reason_code: 'QUALITY_HOLD', p_notes: 'Awaiting lab result',
    p_lines: [{ product_id: pcm, batch_number: 'PN-8020', quantity: 1000, to_status: 'QUARANTINE' }],
  })
}
await seedInventory(orgA)

// ---- Organization B: proves tenant isolation in the browser -----------------------------------
const orgB = await ensureOrg('Other Pharma Ltd', { email: 'owner@other.test', first: 'Nana', last: 'Other' })
const hqB = (await rest('GET', `/branches?select=id&organization_id=eq.${orgB}&is_head_office=is.true`))[0].id
await ensureWarehouse(orgB, hqB, 'MAIN-HQ', 'Other Main Store')

console.log('Seeded.')
console.log('  Organization A: owner@demo.test, kumasi.manager@demo.test (Kumasi only), auditor@demo.test,')
console.log('                  cashier@demo.test, viewer@demo.test, inactive@demo.test (deactivated)')
console.log('  Organization B: owner@other.test')
console.log('  Password for all of them = the DEV_SEED_PASSWORD you supplied.')
