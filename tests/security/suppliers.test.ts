import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addProduct, addProductUnit, addSupplier, addUser, admin, closePool, createOrg, withUser, type Org } from '../helpers/db'

let a: Org
let b: Org

beforeAll(async () => {
  a = await createOrg('SUP-A')
  b = await createOrg('SUP-B')
})
afterAll(closePool)

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e.code as string)

describe('suppliers', () => {
  it('officers create and edit; read-only users read; users without suppliers.view see nothing', async () => {
    const officer = await addUser(a.id, 'PROCUREMENT_OFFICER')
    const viewer = await addUser(a.id, 'READ_ONLY')
    const cashier = await addUser(a.id, 'CASHIER') // products.view only
    let id = ''
    await withUser(officer, async (c) => {
      const r = await c.attempt(
        `insert into public.suppliers (code, name, supplier_type, licence_number, licence_expiry, payment_terms_days, currency_code, country)
         values ('EMP', 'Emmanuel Pharma Ltd', 'DISTRIBUTOR', 'FDA/123', '2027-06-30', 45, 'GHS', 'GH') returning id`)
      expect(r.ok).toBe(true)
      if (r.ok) id = r.rows[0].id
      expect((await c.q(`update public.suppliers set phone = '0302000000' where id = $1`, [id])).rowCount).toBe(1)
    }, { commit: true })
    await withUser(viewer, async (c) => {
      expect((await c.q('select count(*)::int n from public.suppliers where id = $1', [id])).rows[0].n).toBe(1)
      expect((await c.attempt(`insert into public.suppliers (code, name) values ('NOPE', 'Nope')`)).ok).toBe(false)
      expect((await c.q(`update public.suppliers set phone = 'x' where id = $1`, [id])).rowCount).toBe(0)
    })
    await withUser(cashier, async (c) => {
      expect((await c.q('select count(*)::int n from public.suppliers')).rows[0].n).toBe(0)
    })
  })

  it('codes and names are unique per organization (name case-insensitively)', async () => {
    await addSupplier(a.id, 'DUPC', 'Dup Name Ltd')
    expect(await code(addSupplier(a.id, 'DUPC', 'Another'))).toBe('23505')
    expect(await code(addSupplier(a.id, 'DUPD', 'dup NAME ltd'))).toBe('23505')
    expect(await code(addSupplier(b.id, 'DUPC', 'Dup Name Ltd'))).toBe('ok')
  })

  it('validates terms, currency, country and type', async () => {
    const ins = (cols: string, v: unknown) => admin.query(`insert into public.suppliers (organization_id, code, name, ${cols}) values ($1, $2, 'V', $3)`, [a.id, `V${Math.random().toString(36).slice(2, 7).toUpperCase()}`, v])
    expect(await code(ins('payment_terms_days', -1))).toBe('23514')
    expect(await code(ins('payment_terms_days', 366))).toBe('23514')
    expect(await code(ins('currency_code', 'ghs'))).toBe('23514')
    expect(await code(ins('country', 'GHA'))).toBe('23514')
    expect(await code(ins('supplier_type', 'PIRATE'))).toBe('23514')
    expect(await code(ins('payment_terms_days', 30))).toBe('ok')
  })

  it('is isolated per tenant and cannot be spoofed', async () => {
    const sB = await addSupplier(b.id)
    await withUser(a.ownerId, async (c) => {
      expect((await c.q('select 1 from public.suppliers where id = $1', [sB])).rowCount).toBe(0)
      expect((await c.q(`update public.suppliers set name = 'pwned' where id = $1`, [sB])).rowCount).toBe(0)
      const spoof = await c.attempt(`insert into public.suppliers (organization_id, code, name) values ($1, 'EVIL', 'Evil')`, [b.id])
      expect(spoof.ok).toBe(false)
      if (!spoof.ok) expect(spoof.code).toBe('42501')
    })
  })

  it('records who created and changed a supplier', async () => {
    await withUser(a.ownerId, async (c) => {
      const id = (await c.q(`insert into public.suppliers (code, name) values ('AUD1', 'Audit Supplier') returning id`)).rows[0].id
      await c.q(`update public.suppliers set is_active = false where id = $1`, [id])
    }, { commit: true })
    const { rows } = await admin.query(`select action, actor_user_id from public.audit_logs where organization_id = $1 and entity_type = 'supplier' and entity_id = (select id::text from public.suppliers where organization_id = $1 and code = 'AUD1')`, [a.id])
    expect(rows.map((r) => r.action).sort()).toEqual(['supplier.created', 'supplier.deactivated'])
    expect(rows.every((r) => r.actor_user_id === a.ownerId)).toBe(true)
  })
})

describe('supplier products (price list)', () => {
  it('links a supplier to a product at a pack level, stamps cost changes, and audits them', async () => {
    const supplier = await addSupplier(a.id)
    const p = await addProduct(a.id)
    const box = await addProductUnit(a.id, p.id, 'BOX', 14)
    const officer = await addUser(a.id, 'PROCUREMENT_OFFICER')
    let spId = ''
    await withUser(officer, async (c) => {
      const r = await c.attempt(
        `insert into public.supplier_products (supplier_id, product_id, product_unit_id, supplier_sku, supplier_product_name, last_cost, lead_time_days)
         values ($1, $2, $3, 'EMP-AUG-14', 'AUGMENTIN 625 14S', 85.5, 3) returning id, last_cost_at`, [supplier, p.id, box])
      expect(r.ok).toBe(true)
      if (r.ok) { spId = r.rows[0].id; expect(r.rows[0].last_cost_at).not.toBeNull() }
      await c.q('update public.supplier_products set last_cost = 90 where id = $1', [spId])
    }, { commit: true })
    const audit = await admin.query(`select previous_values, new_values from public.audit_logs where entity_type = 'supplier_product' and entity_id = $1 and action = 'supplier_product.updated'`, [spId])
    expect(audit.rows[0].previous_values).toMatchObject({ last_cost: 85.5 })
    expect(audit.rows[0].new_values).toMatchObject({ last_cost: 90 })
  })

  it('the pack level must belong to the same product; negative costs and duplicate links are rejected', async () => {
    const supplier = await addSupplier(a.id)
    const p1 = await addProduct(a.id)
    const p2 = await addProduct(a.id)
    const ins = (prod: string, unit: string, extra = '', val: unknown[] = []) => admin.query(
      `insert into public.supplier_products (organization_id, supplier_id, product_id, product_unit_id ${extra ? ', ' + extra.split('=')[0] : ''}) values ($1, $2, $3, $4 ${val.length ? ', $5' : ''})`,
      [a.id, supplier, prod, unit, ...val])
    expect(await code(ins(p1.id, p2.baseUnitRowId))).toBe('23503') // unit of another product
    expect(await code(ins(p1.id, p1.baseUnitRowId, 'last_cost=', [-1]))).toBe('23514')
    expect(await code(ins(p1.id, p1.baseUnitRowId))).toBe('ok')
    expect(await code(ins(p1.id, p1.baseUnitRowId))).toBe('23505')
    // supplier of another organization
    const sB = await addSupplier(b.id)
    expect(await code(admin.query(
      `insert into public.supplier_products (organization_id, supplier_id, product_id, product_unit_id) values ($1, $2, $3, $4)`, [a.id, sB, p2.id, p2.baseUnitRowId]))).toBe('23503')
  })

  it('allows only one preferred active supplier per product', async () => {
    const p = await addProduct(a.id)
    const s1 = await addSupplier(a.id)
    const s2 = await addSupplier(a.id)
    const ins = (s: string, preferred: boolean) => admin.query(
      `insert into public.supplier_products (organization_id, supplier_id, product_id, product_unit_id, is_preferred) values ($1, $2, $3, $4, $5)`,
      [a.id, s, p.id, p.baseUnitRowId, preferred])
    expect(await code(ins(s1, true))).toBe('ok')
    expect(await code(ins(s2, true))).toBe('23505')
    expect(await code(ins(s2, false))).toBe('ok')
    await admin.query('update public.supplier_products set is_active = false where supplier_id = $1 and product_id = $2', [s1, p.id])
    expect(await code(admin.query('update public.supplier_products set is_preferred = true where supplier_id = $1 and product_id = $2', [s2, p.id]))).toBe('ok')
  })

  it('costs are visible only with suppliers.view; writes need suppliers.edit; links never change parents', async () => {
    const supplier = await addSupplier(a.id)
    const p = await addProduct(a.id)
    await admin.query(
      `insert into public.supplier_products (organization_id, supplier_id, product_id, product_unit_id, last_cost) values ($1, $2, $3, $4, 12.34)`,
      [a.id, supplier, p.id, p.baseUnitRowId])
    const cashier = await addUser(a.id, 'CASHIER')
    const viewer = await addUser(a.id, 'READ_ONLY')
    const pharmacist = await addUser(a.id, 'PHARMACIST') // suppliers.view, no suppliers.edit
    await withUser(cashier, async (c) => {
      expect((await c.q('select count(*)::int n from public.supplier_products')).rows[0].n).toBe(0)
    })
    await withUser(viewer, async (c) => {
      expect((await c.q('select last_cost from public.supplier_products where supplier_id = $1', [supplier])).rows).toHaveLength(1)
    })
    await withUser(pharmacist, async (c) => {
      expect((await c.q('update public.supplier_products set last_cost = 1 where supplier_id = $1', [supplier])).rowCount).toBe(0)
    })
    expect(await code(admin.query('update public.supplier_products set product_id = $2 where supplier_id = $1', [supplier, (await addProduct(a.id)).id]))).toBe('23514')
  })

  it('another tenant can neither see nor touch the price list', async () => {
    const supplier = await addSupplier(a.id)
    const p = await addProduct(a.id)
    await admin.query(`insert into public.supplier_products (organization_id, supplier_id, product_id, product_unit_id) values ($1, $2, $3, $4)`, [a.id, supplier, p.id, p.baseUnitRowId])
    await withUser(b.ownerId, async (c) => {
      expect((await c.q('select 1 from public.supplier_products where supplier_id = $1', [supplier])).rowCount).toBe(0)
      expect((await c.q('update public.supplier_products set is_active = false where supplier_id = $1', [supplier])).rowCount).toBe(0)
    })
  })
})
