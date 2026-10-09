import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addBranch, addIdentity, addProduct, addProductUnit, addUser, admin, closePool, createOrg, formId, unitId, withUser, type Org,
} from '../helpers/db'

let a: Org
let b: Org

beforeAll(async () => {
  a = await createOrg('CAT-A')
  b = await createOrg('CAT-B')
})
afterAll(closePool)

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e.code as string)

describe('canonical identities', () => {
  it('collapses spelling, case and spacing differences into one identity per organization', async () => {
    await admin.query(
      `insert into public.product_identities (organization_id, generic_name, dosage_form_id, strength_text) values ($1, 'Cefixime', $2, '200 mg')`,
      [a.id, await formId('TABLET')])
    const dup = admin.query(
      `insert into public.product_identities (organization_id, generic_name, dosage_form_id, strength_text) values ($1, 'CEFIXIME ', $2, '200MG')`,
      [a.id, await formId('TABLET')])
    expect(await code(dup)).toBe('23505')
    // a different strength or form is a different identity; the same identity in ANOTHER organization is fine
    expect(await code(admin.query(
      `insert into public.product_identities (organization_id, generic_name, dosage_form_id, strength_text) values ($1, 'Cefixime', $2, '100 mg')`,
      [a.id, await formId('TABLET')]))).toBe('ok')
    expect(await code(admin.query(
      `insert into public.product_identities (organization_id, generic_name, dosage_form_id, strength_text) values ($1, 'Cefixime', $2, '200 mg')`,
      [b.id, await formId('TABLET')]))).toBe('ok')
  })

  it('an identity already used by products cannot change meaning, but display-only edits refresh search keys', async () => {
    const identityId = await addIdentity(a.id, 'Paracetamol', '500 mg')
    const p = await addProduct(a.id, { identityId, brand: 'Panadol' })
    expect(await code(admin.query(`update public.product_identities set strength_text = '1 g' where id = $1`, [identityId]))).toBe('23514')
    // same normalised words, different display -> allowed
    await admin.query(`update public.product_identities set generic_name = 'PARACETAMOL' where id = $1`, [identityId])
    const key = (await admin.query('select search_key from public.products where id = $1', [p.id])).rows[0].search_key
    expect(key).toContain('paracetamol')
    // unused identities can still be corrected
    const unused = await addIdentity(a.id, 'Ibuprofen', '200 mg')
    expect(await code(admin.query(`update public.product_identities set strength_text = '400 mg' where id = $1`, [unused]))).toBe('ok')
  })
})

describe('products and units', () => {
  it('creates the base unit (factor 1) together with the product, and protects it', async () => {
    const p = await addProduct(a.id, { baseUnit: 'TABLET' })
    const units = await admin.query('select is_base, factor_to_base::float8 as f, is_active from public.product_units where product_id = $1', [p.id])
    expect(units.rows).toEqual([{ is_base: true, f: 1, is_active: true }])
    expect(await code(admin.query('update public.product_units set is_active = false where id = $1', [p.baseUnitRowId]))).toBe('23514')
    expect(await code(admin.query('update public.product_units set factor_to_base = 2 where id = $1', [p.baseUnitRowId]))).toBe('23514')
    // only one base unit per product
    expect(await code(admin.query(
      `insert into public.product_units (organization_id, product_id, unit_id, factor_to_base, is_base) values ($1, $2, $3, 1, true)`,
      [a.id, p.id, await unitId('BOX')]))).toBe('23505')
  })

  it('pack levels convert to the base unit; factor and unit never change afterwards', async () => {
    const p = await addProduct(a.id)
    const box = await addProductUnit(a.id, p.id, 'BOX', 14)
    expect(await code(addProductUnit(a.id, p.id, 'BOX', 28))).toBe('23505') // one row per unit
    expect(await code(addProductUnit(a.id, p.id, 'CARTON', 0))).toBe('23514') // factor must be positive
    expect(await code(admin.query('update public.product_units set factor_to_base = 20 where id = $1', [box]))).toBe('23514')
    expect(await code(admin.query('update public.product_units set is_sellable = false where id = $1', [box]))).toBe('ok')
  })

  it('SKU and base unit are immutable business keys', async () => {
    const p = await addProduct(a.id)
    expect(await code(admin.query(`update public.products set sku = 'CHANGED' where id = $1`, [p.id]))).toBe('23514')
    expect(await code(admin.query('update public.products set base_unit_id = $2 where id = $1', [p.id, await unitId('BOX')]))).toBe('23514')
  })

  it('enforces the pharmaceutical classification rules', async () => {
    const base = await unitId('TABLET')
    const ins = (cols: string, vals: unknown[]) => admin.query(
      `insert into public.products (organization_id, sku, brand_name, base_unit_id, ${cols}) values ($1, $2, 'X', $3, ${vals.map((_, i) => `$${i + 4}`).join(', ')})`,
      [a.id, `RULE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, base, ...vals])
    expect(await code(ins('product_class', ['POM']))).toBe('23514')                         // medicine without identity
    expect(await code(ins('product_class, requires_prescription', ['MEDICAL_DEVICE', false]))).toBe('ok') // device needs none
    const identity = await addIdentity(a.id)
    expect(await code(ins('product_class, identity_id, requires_prescription', ['POM', identity, false]))).toBe('23514') // POM needs prescription
    expect(await code(ins('product_class, identity_id, requires_prescription, is_controlled', ['CONTROLLED', identity, true, false]))).toBe('23514')
    expect(await code(ins('product_class, identity_id, requires_prescription, is_controlled', ['CONTROLLED', identity, true, true]))).toBe('ok')
  })

  it('cross-organization references are impossible', async () => {
    const identityB = await addIdentity(b.id)
    const productA = await addProduct(a.id)
    const productB = await addProduct(b.id)
    expect(await code(admin.query(
      `insert into public.products (organization_id, sku, identity_id, brand_name, product_class, requires_prescription, base_unit_id)
       values ($1, 'XTENANT1', $2, 'X', 'POM', true, $3)`, [a.id, identityB, await unitId('TABLET')]))).toBe('23503')
    expect(await code(admin.query(
      `insert into public.product_barcodes (organization_id, product_id, product_unit_id, barcode, barcode_type)
       values ($1, $2, $3, 'XTENANT-BC', 'INTERNAL')`, [a.id, productA.id, productB.baseUnitRowId]))).toBe('23503')
    expect(await code(admin.query(
      `insert into public.product_aliases (organization_id, alias, product_id) values ($1, 'cross tenant', $2)`, [a.id, productB.id]))).toBe('23503')
  })
})

describe('barcodes', () => {
  it('validates GTIN check digits, keeps barcodes unique per organization, attaches them to the right pack level', async () => {
    const p = await addProduct(a.id)
    const box = await addProductUnit(a.id, p.id, 'BOX', 10)
    const other = await addProduct(a.id)
    const insert = (org: string, pid: string, unit: string, bc: string, type = 'GTIN') => admin.query(
      `insert into public.product_barcodes (organization_id, product_id, product_unit_id, barcode, barcode_type) values ($1, $2, $3, $4, $5)`,
      [org, pid, unit, bc, type])
    expect(await code(insert(a.id, p.id, box, '4006381333931'))).toBe('ok')        // valid EAN-13
    expect(await code(insert(a.id, p.id, box, '4006381333932'))).toBe('23514')     // wrong check digit
    expect(await code(insert(a.id, p.id, box, '12345'))).toBe('23514')             // GTIN with bad length
    expect(await code(insert(a.id, p.id, p.baseUnitRowId, 'LOCAL-0001', 'INTERNAL'))).toBe('ok')
    expect(await code(insert(a.id, other.id, other.baseUnitRowId, '4006381333931'))).toBe('23505') // duplicate in the organization
    const pb = await addProduct(b.id)
    expect(await code(insert(b.id, pb.id, pb.baseUnitRowId, '4006381333931'))).toBe('ok')          // other organization may reuse it
    expect(await code(insert(a.id, other.id, box, 'MISMATCH-1', 'INTERNAL'))).toBe('23503')         // pack level of a different product
  })

  it('barcodes are immutable apart from their active flag', async () => {
    const p = await addProduct(a.id)
    await admin.query(`insert into public.product_barcodes (organization_id, product_id, product_unit_id, barcode, barcode_type) values ($1, $2, $3, 'IMM-0001', 'INTERNAL')`, [a.id, p.id, p.baseUnitRowId])
    expect(await code(admin.query(`update public.product_barcodes set barcode = 'IMM-0002' where barcode = 'IMM-0001'`))).toBe('23514')
    expect(await code(admin.query(`update public.product_barcodes set is_active = false where barcode = 'IMM-0001'`))).toBe('ok')
  })
})

describe('aliases (messy real-world names)', () => {
  it('treats case, punctuation and spacing differences as the same alias', async () => {
    const p = await addProduct(a.id, { brand: 'Augmentin 625' })
    await admin.query(`insert into public.product_aliases (organization_id, alias, product_id) values ($1, $2, $3)`, [a.id, "AUGMENTIN 625MG 14'S", p.id])
    expect(await code(admin.query(`insert into public.product_aliases (organization_id, alias, product_id) values ($1, $2, $3)`, [a.id, "augmentin  625mg  14's", p.id]))).toBe('23505')
    expect(await code(admin.query(`insert into public.product_aliases (organization_id, alias, product_id) values ($1, $2, $3)`, [b.id, "AUGMENTIN 625MG 14'S", (await addProduct(b.id)).id]))).toBe('ok')
  })

  it('an alias points at exactly one thing', async () => {
    const p = await addProduct(a.id)
    const i = await addIdentity(a.id)
    expect(await code(admin.query(`insert into public.product_aliases (organization_id, alias, product_id, identity_id) values ($1, 'both', $2, $3)`, [a.id, p.id, i]))).toBe('23514')
    expect(await code(admin.query(`insert into public.product_aliases (organization_id, alias) values ($1, 'neither')`, [a.id]))).toBe('23514')
    expect(await code(admin.query(`insert into public.product_aliases (organization_id, alias, product_id) values ($1, '!!!', $2)`, [a.id, p.id]))).toBe('23514') // nothing searchable
  })
})

describe('search_products (runs with the caller\'s RLS)', () => {
  let user: string
  let idRow: { id: string; sku: string }

  beforeAll(async () => {
    user = await addUser(a.id, 'PROCUREMENT_OFFICER')
    const identity = await addIdentity(a.id, 'Amoxicillin + Clavulanic acid', '500 mg + 125 mg')
    idRow = await addProduct(a.id, { sku: 'AUG-625-14', brand: 'Augmentin 625', identityId: identity })
    const box = await addProductUnit(a.id, idRow.id, 'BOX', 14)
    await admin.query(`insert into public.product_barcodes (organization_id, product_id, product_unit_id, barcode, barcode_type) values ($1, $2, $3, '6001087000017', 'GTIN')`, [a.id, idRow.id, box])
    await admin.query(`insert into public.product_aliases (organization_id, alias, product_id) values ($1, 'Co-amoxiclav 625 tabs 14s', $2)`, [a.id, idRow.id])
    // a look-alike in the OTHER organization that must never leak
    const identityB = await addIdentity(b.id, 'Amoxicillin + Clavulanic acid', '500 mg + 125 mg')
    await addProduct(b.id, { sku: 'AUG-625-14', brand: 'Augmentin 625', identityId: identityB })
  })

  const search = (uid: string, q: string) =>
    withUser(uid, async (c) => (await c.q('select * from public.search_products($1)', [q])).rows)

  it('finds a product by brand words in any order, generic name, strength, SKU, alias and barcode', async () => {
    for (const q of ['augmentin', '625 augmentin', 'AUGMENTIN 625MG', 'clavulanic', 'amoxicillin 125', 'aug-625-14', 'co amoxiclav', '6001087000017']) {
      const rows = await search(user, q)
      expect(rows.map((r) => r.sku), q).toContain('AUG-625-14')
    }
  })

  it('reports why it matched and ranks exact barcode / SKU first', async () => {
    expect((await search(user, '6001087000017'))[0]).toMatchObject({ sku: 'AUG-625-14', matched_on: 'barcode', dosage_form: 'Tablet' })
    expect((await search(user, 'AUG-625-14'))[0]).toMatchObject({ matched_on: 'sku' })
  })

  it('never returns another organization\'s products, even with an identical name and SKU', async () => {
    const owners = async (rows: { product_id: string }[]) =>
      (await admin.query('select distinct organization_id from public.products where id = any($1)', [rows.map((r) => r.product_id)])).rows
    const rowsA = await search(user, 'augmentin')
    expect(rowsA.length).toBeGreaterThan(0)
    expect(await owners(rowsA)).toEqual([{ organization_id: a.id }])

    const bUser = await addUser(b.id, 'PROCUREMENT_OFFICER')
    const rowsB = await search(bUser, 'augmentin')
    expect(rowsB.length).toBeGreaterThan(0)
    expect(await owners(rowsB)).toEqual([{ organization_id: b.id }])
    expect(await search(bUser, 'co amoxiclav')).toHaveLength(0) // that alias belongs to organization A
  })

  it('returns nothing without products.view, and ignores junk / injection-looking input', async () => {
    const credit = await addUser(a.id, 'CREDIT_CONTROLLER')
    expect(await search(credit, 'augmentin')).toHaveLength(0)
    for (const q of ['', '   ', '%', "'; drop table public.products; --", '_']) {
      await expect(search(user, q)).resolves.toBeInstanceOf(Array)
    }
    expect((await admin.query('select count(*)::int n from public.products')).rows[0].n).toBeGreaterThan(0)
  })

  it('is not callable anonymously', async () => {
    const r = await withUser(null, (c) => c.attempt(`select * from public.search_products('x')`))
    expect(r.ok).toBe(false)
  })
})

describe('permissions and tenant isolation on the catalogue', () => {
  it('read needs products.view in any scope; branch-scoped staff can read but not write shared master data', async () => {
    const branch = await addBranch(a.id, 'CATB')
    const scoped = await addUser(a.id, 'PROCUREMENT_MANAGER', branch) // has products.* but only for one branch
    const p = await addProduct(a.id)
    await withUser(scoped, async (c) => {
      expect((await c.q('select count(*)::int n from public.products where id = $1', [p.id])).rows[0].n).toBe(1)
      const w = await c.attempt(`insert into public.manufacturers (name) values ('Scoped Pharma')`)
      expect(w.ok).toBe(false)
      if (!w.ok) expect(w.code).toBe('42501')
      expect((await c.q(`update public.products set brand_name = 'hacked' where id = $1`, [p.id])).rowCount).toBe(0)
    })
  })

  it('create vs edit are separate: an officer can create products but not edit them; a pharmacist the reverse', async () => {
    const officer = await addUser(a.id, 'PROCUREMENT_OFFICER')
    const pharmacist = await addUser(a.id, 'PHARMACIST')
    const identity = await addIdentity(a.id)
    const unit = await unitId('TABLET')
    let created = ''
    await withUser(officer, async (c) => {
      const r = await c.attempt(
        `insert into public.products (sku, identity_id, brand_name, product_class, requires_prescription, base_unit_id)
         values ('OFFICER-1', $1, 'Officer Product', 'POM', true, $2) returning id`, [identity, unit])
      expect(r.ok).toBe(true)
      if (r.ok) created = r.rows[0].id
      expect((await c.q(`update public.products set brand_name = 'x' where id = $1`, [created])).rowCount).toBe(0)
      expect((await c.attempt(`insert into public.product_aliases (alias, product_id) values ('officer alias', $1)`, [created])).ok).toBe(false)
    }, { commit: true })
    await withUser(pharmacist, async (c) => {
      expect((await c.q(`update public.products set description = 'pharmacist edit' where id = $1`, [created])).rowCount).toBe(1)
      expect((await c.attempt(`insert into public.manufacturers (name) values ('Pharm Co')`)).ok).toBe(false)
      expect((await c.attempt(`insert into public.product_aliases (alias, product_id) values ('pharmacist alias', $1)`, [created])).ok).toBe(true)
    })
  })

  it('organization_id cannot be spoofed or changed, and other tenants\' rows are invisible', async () => {
    const owner = a.ownerId
    const pB = await addProduct(b.id)
    await withUser(owner, async (c) => {
      const spoof = await c.attempt(`insert into public.manufacturers (organization_id, name) values ($1, 'Evil')`, [b.id])
      expect(spoof.ok).toBe(false)
      if (!spoof.ok) expect(spoof.code).toBe('42501')
      expect((await c.q('select 1 from public.products where id = $1', [pB.id])).rowCount).toBe(0)
      expect((await c.q(`update public.products set brand_name = 'pwned' where id = $1`, [pB.id])).rowCount).toBe(0)
      expect((await c.attempt(`update public.products set organization_id = $1 where sku like 'SKU-%'`, [b.id])).ok).toBe(false)
    })
  })

  it('reference data is read-only for tenants', async () => {
    await withUser(a.ownerId, async (c) => {
      expect((await c.q('select count(*)::int n from public.units_of_measure')).rows[0].n).toBeGreaterThan(10)
      expect((await c.q('select count(*)::int n from public.dosage_forms')).rows[0].n).toBeGreaterThan(10)
      for (const sql of [`insert into public.units_of_measure (code, name, kind) values ('EVIL', 'Evil', 'COUNT')`, `update public.dosage_forms set name = 'x'`, `delete from public.units_of_measure`]) {
        const r = await c.attempt(sql)
        expect(r.ok, sql).toBe(false)
      }
    })
  })

  it('catalogue changes are audited with the actor, and creating a product also audits its base unit', async () => {
    await withUser(a.ownerId, async (c) => {
      await c.q(`insert into public.manufacturers (name, country) values ('Audited Pharma', 'GH')`)
      const p = (await c.q(
        `insert into public.products (sku, brand_name, product_class, base_unit_id) values ('AUDIT-1', 'Audited Device', 'MEDICAL_DEVICE', $1) returning id`,
        [await unitId('PIECE')])).rows[0].id
      await c.q(`update public.products set brand_name = 'Audited Device v2' where id = $1`, [p])
    }, { commit: true })
    const { rows } = await admin.query(
      `select action, actor_user_id, new_values from public.audit_logs where organization_id = $1 and (new_values ->> 'name' = 'Audited Pharma' or new_values ->> 'sku' = 'AUDIT-1' or previous_values ->> 'brand_name' = 'Audited Device') order by created_at`, [a.id])
    const actions = rows.map((r) => r.action)
    for (const x of ['manufacturer.created', 'product.created', 'product.updated']) expect(actions).toContain(x)
    expect(rows.every((r) => r.actor_user_id === a.ownerId)).toBe(true)
  })
})
