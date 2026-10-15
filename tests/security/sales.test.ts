import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addBranch, addProduct, addProductUnit, addUser, addWarehouse, admin, closePool, createOrg, rand, unitId, withUser, type Org,
} from '../helpers/db'

let a: Org
let b: Org
let wh: string         // org A, head office
let branch2: string
let wh2: string        // org A, branch 2
let whB: string
let owner: string
let salesMgr: string   // customers.*, pricing.manage, sales create/post/discount/price_override (no override_credit)
let rep: string        // sales.create only
let cashier: string    // sales.create + post, receipts.create
let accounts: string   // receipts.*, override_credit
let rep2: string       // sales rep, branch 2 only
let defaultList: string

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  a = await createOrg('SAL-A')
  b = await createOrg('SAL-B')
  wh = await addWarehouse(a.id, a.hq, 'W1')
  branch2 = await addBranch(a.id, 'B2')
  wh2 = await addWarehouse(a.id, branch2, 'W2')
  whB = await addWarehouse(b.id, b.hq, 'WB')
  owner = a.ownerId
  salesMgr = await addUser(a.id, 'SALES_MANAGER')
  rep = await addUser(a.id, 'SALES_REP')
  cashier = await addUser(a.id, 'CASHIER')
  accounts = await addUser(a.id, 'ACCOUNTS_MANAGER')
  rep2 = await addUser(a.id, 'SALES_REP', branch2)
  defaultList = await priceList(a.id, 'RETAIL', true)
})
afterAll(closePool)

type Out = { ok: true; rows: any[] } | { ok: false; code: string; message: string }
const call = (user: string, sql: string, params: unknown[] = []): Promise<Out> =>
  withUser(user, (c) => c.attempt(sql, params), { commit: true }) as Promise<Out>
const ok = async (p: Promise<Out>) => {
  const r = await p
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`)
  return r.rows[0]
}
const failure = async (p: Promise<Out>) => { const r = await p; return r.ok ? { code: 'ok', message: '' } : { code: r.code, message: r.message } }
const code = async (p: Promise<Out>) => (await failure(p)).code
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows

/** Test-only: shifts a posted invoice's due date, bypassing the invoice lock (which correctly refuses this for everybody else). */
async function setDue(invoiceId: string, daysFromToday: number) {
  const client = await admin.connect()
  try {
    await client.query('begin')
    await client.query('set local session_replication_role = replica')
    await client.query(`update public.sales_invoices set due_date = current_date + $2::int where id = $1`, [invoiceId, daysFromToday])
    await client.query('commit')
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    client.release()
  }
}

async function priceList(orgId: string, listCode: string, isDefault = false): Promise<string> {
  return (await q(`insert into public.price_lists (organization_id, code, name, is_default) values ($1, $2, $3, $4) returning id`, [orgId, `${listCode}${isDefault ? '' : rand()}`, `List ${listCode}`, isDefault]))[0].id
}
async function setPrice(orgId: string, listId: string, productId: string, productUnitId: string, price: number) {
  await q(`insert into public.price_list_items (organization_id, price_list_id, product_id, product_unit_id, unit_price) values ($1, $2, $3, $4, $5)
           on conflict (price_list_id, product_unit_id) do update set unit_price = excluded.unit_price`, [orgId, listId, productId, productUnitId, price])
}
async function addCustomer(orgId: string, o: {
  name?: string; type?: string; licence?: 'valid' | 'expired' | 'none'; controlled?: boolean; terms?: number; limit?: number; shelf?: number
  hold?: boolean; list?: string | null
} = {}): Promise<string> {
  const licence = o.licence ?? 'valid'
  return (await q(
    `insert into public.customers (organization_id, code, name, customer_type, licence_number, licence_expiry, controlled_drugs_authorised, payment_terms_days, credit_limit,
                                   min_shelf_life_days, on_hold, hold_reason, price_list_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [orgId, `C${rand()}`, o.name ?? `Customer ${rand()}`, o.type ?? 'PHARMACY', licence === 'none' ? null : 'PC/123', licence === 'none' ? null : day(licence === 'valid' ? 300 : -5),
     o.controlled ?? false, o.terms ?? 30, o.limit ?? 100000, o.shelf ?? 0, o.hold ?? false, o.hold ? 'Overdue account' : null, o.list ?? null]))[0].id
}

/** A product with stock in `wh` (batches: [qty in base units, expiry offset in days]) and a price of `price` per base unit (and per box of 10 at 10x). */
async function sellable(batches: [number, number][], o: { price?: number; cls?: string; cost?: number; warehouse?: string; sku?: string } = {}) {
  const product = await addProduct(a.id, { cls: o.cls ?? 'GSL', ...(o.sku ? { sku: o.sku } : {}) })
  const box = await addProductUnit(a.id, product.id, 'BOX', 10)
  await setPrice(a.id, defaultList, product.id, product.baseUnitRowId, o.price ?? 2)
  await setPrice(a.id, defaultList, product.id, box, (o.price ?? 2) * 10)
  let i = 0
  for (const [qty, exp] of batches) {
    await ok(call(owner, `select public.post_stock_document('OPENING', $1, $2::jsonb) as r`, [o.warehouse ?? wh, JSON.stringify([
      { product_id: product.id, quantity: qty, batch_number: `B${rand()}${++i}`, expiry_date: day(exp), ...(o.cost !== undefined ? { unit_cost: o.cost * 1 } : {}) }])]))
  }
  return { product, box }
}
const onHand = async (productId: string, status = 'AVAILABLE') =>
  Number((await q(`select coalesce(sum(quantity),0) n from public.stock_balances where product_id = $1 and stock_status = $2`, [productId, status]))[0].n)

const save = (user: string, o: { id?: string | null; customer: string; wh?: string; lines: object[]; ref?: string | null }) =>
  call(user, `select public.save_sales_invoice($1, $2, $3, $4, null, $5::jsonb) as id`, [o.id ?? null, o.customer, o.wh ?? wh, o.ref ?? null, JSON.stringify(o.lines)])
const post = (user: string, id: string, reason: string | null = null, payment: object | null = null) =>
  call(user, `select public.post_sales_invoice($1, $2, $3::jsonb) as r`, [id, reason, payment ? JSON.stringify(payment) : null])
const draft = async (customer: string, lines: object[], user = salesMgr) => (await ok(save(user, { customer, lines }))).id as string
const inv = async (id: string) => (await q(`select * from public.sales_invoices where id = $1`, [id]))[0]
const lines = async (id: string) => q(`select * from public.sales_invoice_lines where sales_invoice_id = $1 order by line_no`, [id])
const allocs = async (id: string) => q(`select a.*, ba.batch_number from public.sales_invoice_allocations a left join public.batches ba on ba.id = a.batch_id where a.sales_invoice_id = $1 order by ba.expiry_date, a.id`, [id])
const receipt = (user: string, customer: string, amount: number, method = 'CASH', ref: string | null = null, allocations: object[] | null = null, branch = a.hq) =>
  call(user, `select public.record_receipt($1, $2, $3, $4, $5, $6::jsonb) as r`, [customer, branch, amount, method, ref, allocations ? JSON.stringify(allocations) : null])

// ================================================================================================
describe('tax codes, customers and price lists', () => {
  it('gives every organization an EXEMPT 0 % default tax code, keeps exactly one default, and protects it', async () => {
    const codes = await q(`select code, rate::float8 r, is_default from public.tax_codes where organization_id = $1`, [a.id])
    expect(codes).toEqual([{ code: 'EXEMPT', r: 0, is_default: true }])
    await expect(admin.query(`insert into public.tax_codes (organization_id, code, name, rate, is_default) values ($1, 'VAT2', 'Second default', 15, true)`, [a.id])).rejects.toMatchObject({ code: '23505' })
    await expect(admin.query(`update public.tax_codes set is_active = false where organization_id = $1 and code = 'EXEMPT'`, [a.id])).rejects.toMatchObject({ code: '23514' })
    await expect(admin.query(`insert into public.tax_codes (organization_id, code, name, rate) values ($1, 'BAD', 'Bad', 101)`, [a.id])).rejects.toMatchObject({ code: '23514' })
    // clients: managers may add codes, others may not
    expect(await code(call(salesMgr, `insert into public.tax_codes (code, name, rate) values ('VAT15', 'VAT 15%', 15)`))).toBe('ok')
    expect(await code(call(rep, `insert into public.tax_codes (code, name, rate) values ('VAT99', 'No', 9)`))).toBe('42501')
    expect(await code(call(rep, `select count(*)::int from public.tax_codes`))).toBe('ok')
  })

  it('lets sales managers manage customers, reps create but not edit them, and others only read', async () => {
    let id = ''
    const r = await call(salesMgr, `insert into public.customers (code, name, customer_type, licence_number, licence_expiry, payment_terms_days, credit_limit) values ('GOOD1', 'Good Pharmacy', 'PHARMACY', 'PC/1', $1, 30, 5000) returning id`, [day(200)])
    expect(r.ok).toBe(true)
    if (r.ok) id = r.rows[0].id
    expect(await code(call(salesMgr, `update public.customers set credit_limit = 8000 where id = $1`, [id]))).toBe('ok')
    expect(await code(call(rep, `insert into public.customers (code, name) values ('REP1', 'Rep made me')`))).toBe('ok')
    expect((await call(rep, `update public.customers set credit_limit = 1 where id = $1`, [id])) as Out).toMatchObject({ ok: true, rows: [] })
    expect(await code(call(cashier, `insert into public.customers (code, name) values ('NO1', 'Nope')`))).toBe('42501')
    const branchMgr = await addUser(a.id, 'SALES_MANAGER', branch2)   // customers are organization-wide data: a branch-scoped role cannot write them
    expect(await code(call(branchMgr, `insert into public.customers (code, name) values ('NO2', 'Nope too')`))).toBe('42501')
    expect(await code(call(await addUser(a.id, 'PROCUREMENT_OFFICER'), `select count(*)::int from public.customers`))).toBe('ok')
    await withUser(await addUser(a.id, 'PROCUREMENT_OFFICER'), async (c) => expect((await c.q(`select count(*)::int n from public.customers`)).rows[0].n).toBe(0))   // no customers.view
    await withUser(b.ownerId, async (c) => expect((await c.q(`select count(*)::int n from public.customers where id = $1`, [id])).rows[0].n).toBe(0))
    expect(await code(call(owner, `insert into public.customers (organization_id, code, name) values ($1, 'SPOOF', 'Spoof')`, [b.id]))).toBe('42501')
  })

  it('validates customers: unique name, valid country, credit and terms ranges, a hold needs a reason, organization cannot change', async () => {
    const c1 = await addCustomer(a.id, { name: 'Unique Name Ltd' })
    await expect(admin.query(`insert into public.customers (organization_id, code, name) values ($1, 'DUPN', 'unique name ltd')`, [a.id])).rejects.toMatchObject({ code: '23505' })
    for (const [col, v] of [['country', 'GHA'], ['payment_terms_days', 366], ['credit_limit', -1], ['min_shelf_life_days', 4000], ['customer_type', 'PIRATE']] as const) {
      await expect(admin.query(`update public.customers set ${col} = $2 where id = $1`, [c1, v]), col).rejects.toMatchObject({ code: '23514' })
    }
    await expect(admin.query(`update public.customers set on_hold = true where id = $1`, [c1])).rejects.toMatchObject({ code: '23514' })
    await admin.query(`update public.customers set on_hold = true, hold_reason = 'Cheque bounced' where id = $1`, [c1])
    await expect(admin.query(`update public.customers set organization_id = $2 where id = $1`, [c1, b.id])).rejects.toBeTruthy()
  })

  it('resolves prices: the customer’s list first, then the default list, ignoring inactive lists and items', async () => {
    const p = await addProduct(a.id)
    const box = await addProductUnit(a.id, p.id, 'BOX', 10)
    const special = await priceList(a.id, 'WHOLESALE')
    const onList = await addCustomer(a.id, { list: special })
    const noList = await addCustomer(a.id)
    const price = (customer: string, unit: string) => withUser(owner, async (c) => (await c.q(`select public.resolve_price($1, $2) as p`, [customer, unit])).rows[0].p)
    expect(await price(noList, p.baseUnitRowId)).toBeNull()                         // priced nowhere
    await setPrice(a.id, defaultList, p.id, p.baseUnitRowId, 5)
    expect(Number(await price(noList, p.baseUnitRowId))).toBe(5)
    expect(Number(await price(onList, p.baseUnitRowId))).toBe(5)                    // special list has no entry: falls back to the default
    await setPrice(a.id, special, p.id, p.baseUnitRowId, 4)
    expect(Number(await price(onList, p.baseUnitRowId))).toBe(4)
    expect(Number(await price(noList, p.baseUnitRowId))).toBe(5)
    await q(`update public.price_list_items set is_active = false where price_list_id = $1 and product_unit_id = $2`, [special, p.baseUnitRowId])
    expect(Number(await price(onList, p.baseUnitRowId))).toBe(5)
    await q(`update public.price_lists set is_active = false where id = $1`, [special])
    await setPrice(a.id, special, p.id, box, 30)
    expect(await price(onList, box)).toBeNull()                                    // inactive list, and no default entry for the box
    // prices are managed by pricing.manage only
    expect(await code(call(rep, `update public.price_list_items set unit_price = 1`))).toBe('ok')
    expect(await q(`select unit_price::float8 p from public.price_list_items where price_list_id = $1 and product_unit_id = $2`, [defaultList, p.baseUnitRowId])).toEqual([{ p: 5 }])
    expect(await code(call(salesMgr, `update public.price_list_items set unit_price = 6 where price_list_id = $1 and product_unit_id = $2`, [defaultList, p.baseUnitRowId]))).toBe('ok')
  })
})

// ================================================================================================
describe('writing a draft invoice', () => {
  it('prices from the customer’s list, adds tax at the product’s rate, discounts, and totals to the cent', async () => {
    const vat = (await q(`insert into public.tax_codes (organization_id, code, name, rate) values ($1, $2, 'VAT 12.5%', 12.5) returning id`, [a.id, `V${rand()}`]))[0].id
    const s1 = await sellable([[1000, 300]], { price: 1.25 })
    const s2 = await sellable([[1000, 300]], { price: 3 })
    await q(`update public.products set tax_code_id = $2 where id = $1`, [s1.product.id, vat])
    const c = await addCustomer(a.id)
    const id = await draft(c, [
      { product_id: s1.product.id, quantity: 100, discount_percent: 10 },                          // 100 x 1.25 = 125, -10 % = 112.50, tax 14.06 (rounded)
      { product_id: s2.product.id, product_unit_id: s2.box, quantity: 3 },                           // 3 boxes x 30 = 90, exempt
    ])
    const i = await inv(id)
    expect(i).toMatchObject({ status: 'DRAFT', invoice_number: null, customer_id: c, branch_id: a.hq, warehouse_id: wh, currency_code: 'GHS', payment_terms_days: 30, created_by: salesMgr })
    const [l1, l2] = await lines(id)
    expect([Number(l1.list_price), Number(l1.unit_price), Number(l1.discount_percent), Number(l1.tax_rate), Number(l1.line_net), Number(l1.line_tax), Number(l1.line_total)]).toEqual([1.25, 1.25, 10, 12.5, 112.5, 14.06, 126.56])
    expect([Number(l2.base_quantity), Number(l2.line_net), Number(l2.line_tax)]).toEqual([30, 90, 0])
    expect([Number(i.subtotal), Number(i.discount_total), Number(i.tax_total), Number(i.total_amount), Number(i.balance_due)]).toEqual([202.5, 12.5, 14.06, 216.56, 216.56])
  })

  it('needs a price: from the list, or named by someone allowed to override prices', async () => {
    const p = await addProduct(a.id, { cls: 'GSL' })
    const c = await addCustomer(a.id)
    const line = { product_id: p.id, quantity: 5 }
    expect((await failure(save(salesMgr, { customer: c, lines: [line] }))).message).toMatch(/has no price for this customer/)
    expect(await code(save(rep, { customer: c, lines: [{ ...line, unit_price: 3 }] }))).toBe('42501')          // reps cannot name a price
    await ok(save(salesMgr, { customer: c, lines: [{ ...line, unit_price: 3 }] }))
    const s = await sellable([[100, 300]], { price: 2 })
    expect(await code(save(rep, { customer: c, lines: [{ product_id: s.product.id, quantity: 1, unit_price: 2 }] }))).toBe('ok')   // naming the list price is fine
    expect(await code(save(rep, { customer: c, lines: [{ product_id: s.product.id, quantity: 1, unit_price: 1.5 }] }))).toBe('42501')
    expect(await code(save(salesMgr, { customer: c, lines: [{ product_id: s.product.id, quantity: 1, unit_price: 1.5 }] }))).toBe('ok')
  })

  it('allows discounts only with sales.discount, and only between 0 and 100 %', async () => {
    const s = await sellable([[100, 300]])
    const c = await addCustomer(a.id)
    const line = (d: number) => ({ product_id: s.product.id, quantity: 1, discount_percent: d })
    expect(await code(save(rep, { customer: c, lines: [line(5)] }))).toBe('42501')
    expect(await code(save(salesMgr, { customer: c, lines: [line(5)] }))).toBe('ok')
    expect(await code(save(salesMgr, { customer: c, lines: [line(101)] }))).toBe('22023')
    expect(await code(save(salesMgr, { customer: c, lines: [line(-1)] }))).toBe('22023')
    expect(await code(save(salesMgr, { customer: c, lines: [line(2.345)] }))).toBe('22023')
    expect(await code(save(rep, { customer: c, lines: [line(0)] }))).toBe('ok')
  })

  it('validates lines, customers and warehouses, and respects branch scope and tenancy', async () => {
    const s = await sellable([[100, 300]])
    const c = await addCustomer(a.id)
    const inactive = await addCustomer(a.id); await q(`update public.customers set is_active = false where id = $1`, [inactive])
    const good = { product_id: s.product.id, quantity: 2 }
    expect(await code(save(rep, { customer: c, lines: [] }))).toBe('22023')
    expect(await code(save(rep, { customer: c, lines: [{ ...good, quantity: 0 }] }))).toBe('22023')
    expect(await code(save(rep, { customer: c, lines: [{ ...good, quantity: 1.0001 }] }))).toBe('22023')
    expect(await code(save(rep, { customer: c, lines: [good, good] }))).toBe('22023')                            // same product, pack, price, discount twice
    expect(await code(save(rep, { customer: c, lines: [{ product_id: '00000000-0000-0000-0000-000000000000', quantity: 1 }] }))).toBe('P0002')
    expect(await code(save(rep, { customer: inactive, lines: [good] }))).toBe('P0002')
    expect(await code(save(rep, { customer: c, wh: whB, lines: [good] }))).toBe('P0002')
    expect(await code(save(rep2, { customer: c, wh, lines: [good] }))).toBe('42501')                             // branch-2 rep, head-office warehouse
    expect(await code(save(rep2, { customer: c, wh: wh2, lines: [good] }))).toBe('ok')
    await admin.query(`update public.product_units set is_sellable = false where id = $1`, [s.box])
    expect(await code(save(rep, { customer: c, lines: [{ product_id: s.product.id, product_unit_id: s.box, quantity: 1 }] }))).toBe('P0002')
    expect(await code(save(await addUser(a.id, 'PHARMACIST'), { customer: c, lines: [good] }))).toBe('42501')   // no sales.create
  })

  it('edits only drafts (replacing the lines) and cancels only drafts, with a reason', async () => {
    const s = await sellable([[100, 300]])
    const c = await addCustomer(a.id)
    const id = await draft(c, [{ product_id: s.product.id, quantity: 5 }], rep)
    await ok(save(rep, { id, customer: c, ref: 'PO-77', lines: [{ product_id: s.product.id, quantity: 8 }] }))
    expect((await lines(id)).map((l) => Number(l.quantity))).toEqual([8])
    expect((await inv(id)).customer_reference).toBe('PO-77')
    expect(await code(call(rep, `select public.cancel_sales_invoice($1, '')`, [id]))).toBe('22023')
    expect(await code(call(await addUser(a.id, 'PHARMACIST'), `select public.cancel_sales_invoice($1, 'x')`, [id]))).toBe('42501')
    await ok(call(rep, `select public.cancel_sales_invoice($1, 'Customer changed their mind')`, [id]))
    expect(await inv(id)).toMatchObject({ status: 'CANCELLED', status_reason: 'Customer changed their mind' })
    expect(await code(save(rep, { id, customer: c, lines: [{ product_id: s.product.id, quantity: 1 }] }))).toBe('22023')
    await expect(admin.query(`update public.sales_invoices set notes = 'x' where id = $1`, [id])).rejects.toMatchObject({ code: '42501' })
  })
})

// ================================================================================================
describe('posting an invoice: FEFO picking and stock', () => {
  it('takes the earliest-expiring batches first, splits a line across batches, records every pick with its cost, numbers the invoice and sets the due date', async () => {
    const s = await sellable([[100, 200], [60, 90], [500, 400]], { cost: 0.5 })     // expiry in 200, 90 and 400 days
    const c = await addCustomer(a.id, { terms: 14 })
    const id = await draft(c, [{ product_id: s.product.id, quantity: 100 }])
    const r = (await ok(post(salesMgr, id))).r
    expect(r.invoice_number).toMatch(/^INV-/)
    expect(r.stock_document_number).toMatch(/^SAL-/)
    const picks = await allocs(id)
    expect(picks.map((x) => [Number(x.base_quantity)])).toEqual([[60], [40]])        // 90-day batch first (60), then the 200-day batch (40)
    expect(picks.every((x) => Number(x.unit_cost_base) === 0.5)).toBe(true)
    expect(await onHand(s.product.id)).toBe(560)
    const i = await inv(id)
    expect(i).toMatchObject({ status: 'POSTED', posted_by: salesMgr })
    expect((await q(`select due_date::text d from public.sales_invoices where id = $1`, [id]))[0].d).toBe(day(14))
    const [doc] = await q(`select document_type, source_type, source_id from public.stock_documents where id = $1`, [i.stock_document_id])
    expect(doc).toEqual({ document_type: 'SALE', source_type: 'SALES_INVOICE', source_id: id })
    expect((await q(`select movement_type from public.stock_movements where document_id = $1 group by 1`, [i.stock_document_id]))).toEqual([{ movement_type: 'SALE_OUT' }])
  })

  it('sells only available, unexpired stock and respects the customer’s minimum shelf life', async () => {
    const s = await sellable([[50, 20], [40, 300]])
    await ok(call(owner, `select public.post_stock_document('OPENING', $1, $2::jsonb)`, [wh, JSON.stringify([
      { product_id: s.product.id, quantity: 1000, batch_number: 'HELD', expiry_date: day(500), status: 'QUARANTINE' },
      { product_id: s.product.id, quantity: 1000, batch_number: 'DEAD', expiry_date: day(-3), status: 'EXPIRED' }])]))
    const normal = await addCustomer(a.id)
    const picky = await addCustomer(a.id, { shelf: 180 })
    const id1 = await draft(normal, [{ product_id: s.product.id, quantity: 90 }])
    await ok(post(salesMgr, id1))                                                    // 50 short-dated + 40 good: everything sellable
    expect(await onHand(s.product.id)).toBe(0)
    const s2 = await sellable([[50, 20], [40, 300]])
    const id2 = await draft(picky, [{ product_id: s2.product.id, quantity: 45 }])
    const f = await failure(post(salesMgr, id2))
    expect(f.code).toBe('23514')
    expect(f.message).toMatch(/not enough sellable stock/)
    expect(f.message).toMatch(/at least 180 days/)
    expect((await inv(id2)).status).toBe('DRAFT')
    await ok(save(salesMgr, { id: id2, customer: picky, lines: [{ product_id: s2.product.id, quantity: 40 }] }))
    await ok(post(salesMgr, id2))                                                    // only the 300-day batch qualified
    expect(await onHand(s2.product.id)).toBe(50)
  })

  it('counts earlier lines of the same product when allocating later ones, and leaves everything untouched when stock runs out', async () => {
    const s = await sellable([[100, 100]])
    const c = await addCustomer(a.id)
    const id = await draft(c, [{ product_id: s.product.id, quantity: 60 }, { product_id: s.product.id, quantity: 50, unit_price: 1.9 }])   // 110 > 100
    const before = Number((await q(`select count(*)::int n from public.stock_documents where organization_id = $1`, [a.id]))[0].n)
    const f = await failure(post(salesMgr, id))
    expect(f.code).toBe('23514')
    expect(f.message).toMatch(/line 2/)
    expect(await onHand(s.product.id)).toBe(100)
    expect((await inv(id)).status).toBe('DRAFT')
    expect(Number((await q(`select count(*)::int n from public.stock_documents where organization_id = $1`, [a.id]))[0].n)).toBe(before)
    expect((await allocs(id))).toHaveLength(0)
    await ok(save(salesMgr, { id, customer: c, lines: [{ product_id: s.product.id, quantity: 60 }, { product_id: s.product.id, quantity: 40, unit_price: 1.9 }] }))
    await ok(post(salesMgr, id))
    expect(await onHand(s.product.id)).toBe(0)
  })

  it('numbers posted invoices gap-free: a failed posting uses no number', async () => {
    const s = await sellable([[10, 100]])
    const c = await addCustomer(a.id)
    const ok1 = await draft(c, [{ product_id: s.product.id, quantity: 5 }])
    const bad = await draft(c, [{ product_id: s.product.id, quantity: 500 }])
    const ok2 = await draft(c, [{ product_id: s.product.id, quantity: 5 }])
    const n1 = (await ok(post(salesMgr, ok1))).r.invoice_number as string
    expect(await code(post(salesMgr, bad))).toBe('23514')
    const n2 = (await ok(post(salesMgr, ok2))).r.invoice_number as string
    const n = (x: string) => Number(x.split('-').pop())
    expect(n(n2)).toBe(n(n1) + 1)
  })

  it('locks a posted invoice: no edits, no cancel, no second posting, no direct writes; only payments move', async () => {
    const s = await sellable([[100, 100]])
    const c = await addCustomer(a.id)
    const id = await draft(c, [{ product_id: s.product.id, quantity: 5 }])
    await ok(post(salesMgr, id))
    expect(await code(post(salesMgr, id))).toBe('22023')
    expect(await code(save(salesMgr, { id, customer: c, lines: [{ product_id: s.product.id, quantity: 1 }] }))).toBe('22023')
    expect(await code(call(salesMgr, `select public.cancel_sales_invoice($1, 'oops')`, [id]))).toBe('22023')
    for (const sql of [`update public.sales_invoices set total_amount = 1`, `update public.sales_invoices set status = 'DRAFT'`, `delete from public.sales_invoices`,
                       `update public.sales_invoice_lines set quantity = 99`, `delete from public.sales_invoice_allocations`, `insert into public.sales_invoices (customer_id) values (gen_random_uuid())`]) {
      const out = await call(owner, sql)
      expect(out.ok, sql).toBe(false)
      if (!out.ok) expect(out.code, sql).toBe('42501')
    }
    for (const sql of [`update public.sales_invoices set total_amount = 1 where id = $1`, `update public.sales_invoices set status = 'DRAFT' where id = $1`, `delete from public.sales_invoices where id = $1`,
                       `update public.sales_invoice_allocations set base_quantity = 1 where sales_invoice_id = $1`]) {
      await expect(admin.query(sql, [id]), sql).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('needs sales.post for the dispatching branch and shows invoices only to their branch', async () => {
    const s = await sellable([[100, 100]], { warehouse: wh2 })
    const c = await addCustomer(a.id)
    const id = (await ok(save(rep2, { customer: c, wh: wh2, lines: [{ product_id: s.product.id, quantity: 5 }] }))).id as string
    expect(await code(post(rep2, id))).toBe('42501')                                 // reps draft, they do not post
    expect(await code(post(cashier, id))).toBe('ok')                                  // org-wide cashier may
    const rep1 = await addUser(a.id, 'SALES_REP', a.hq)
    await withUser(rep1, async (c1) => expect((await c1.q(`select count(*)::int n from public.sales_invoices where id = $1`, [id])).rows[0].n).toBe(0))
    await withUser(rep2, async (c2) => expect((await c2.q(`select count(*)::int n from public.sales_invoices where id = $1`, [id])).rows[0].n).toBe(1))
    await withUser(b.ownerId, async (cb) => expect((await cb.q(`select count(*)::int n from public.sales_invoices`)).rows[0].n).toBe(0))
    expect(await code(post(b.ownerId, id))).toBe('P0002')
  })

  it('lets exactly one of two simultaneous invoices take the last units', async () => {
    const s = await sellable([[10, 100]])
    const c = await addCustomer(a.id)
    const ids = await Promise.all([1, 2, 3].map(() => draft(c, [{ product_id: s.product.id, quantity: 10 }])))
    const results = await Promise.all(ids.map((id) => post(salesMgr, id)))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(await onHand(s.product.id)).toBe(0)
    expect((await Promise.all(ids.map(async (id) => (await inv(id)).status))).sort()).toEqual(['DRAFT', 'DRAFT', 'POSTED'])
  })

  it('keeps the stock ledger reconciled with the balances after selling', async () => {
    const { rows } = await admin.query(`
      with led as (select organization_id, warehouse_id, location_id, product_id, batch_id, stock_status, sum(quantity) q from public.stock_movements group by 1,2,3,4,5,6)
      select count(*)::int n from led full join public.stock_balances b
        on b.organization_id = led.organization_id and b.warehouse_id = led.warehouse_id and b.location_id is not distinct from led.location_id
       and b.product_id = led.product_id and b.batch_id is not distinct from led.batch_id and b.stock_status = led.stock_status
      where coalesce(b.quantity, 0) <> coalesce(led.q, 0)`)
    expect(rows[0].n).toBe(0)
  })
})

// ================================================================================================
describe('regulatory rules (no override)', () => {
  it('sells prescription-only, pharmacy-only and controlled medicines only to licensed buyers', async () => {
    const pom = await sellable([[100, 300]], { cls: 'POM' })
    const gsl = await sellable([[100, 300]], { cls: 'GSL' })
    const shop = await addCustomer(a.id, { type: 'RETAILER', licence: 'none' })
    const idPom = await draft(shop, [{ product_id: pom.product.id, quantity: 5 }])
    const f = await failure(post(owner, idPom))                                       // the owner holds every permission and still cannot
    expect(f.code).toBe('22023')
    expect(f.message).toMatch(/not a licensed pharmacy, hospital, clinic or wholesaler/)
    expect(await code(post(owner, await draft(shop, [{ product_id: gsl.product.id, quantity: 5 }])))).toBe('ok')     // general-sale goods are fine
  })

  it('needs the buyer’s premises licence recorded and unexpired for any medicine', async () => {
    const pom = await sellable([[100, 300]], { cls: 'POM' })
    const noLicence = await addCustomer(a.id, { licence: 'none' })
    const expired = await addCustomer(a.id, { licence: 'expired' })
    const valid = await addCustomer(a.id)
    expect((await failure(post(owner, await draft(noLicence, [{ product_id: pom.product.id, quantity: 1 }])))).message).toMatch(/licence of .* is not recorded/)
    expect((await failure(post(owner, await draft(expired, [{ product_id: pom.product.id, quantity: 1 }])))).message).toMatch(/licence of .* expired on/)
    expect(await code(post(owner, await draft(valid, [{ product_id: pom.product.id, quantity: 1 }])))).toBe('ok')
    // ... but non-medicines do not need it
    const device = await sellable([[100, 300]], { cls: 'CONSUMABLE' })
    expect(await code(post(owner, await draft(expired, [{ product_id: device.product.id, quantity: 1 }])))).toBe('ok')
    expect(await code(post(owner, await draft(noLicence, [{ product_id: device.product.id, quantity: 1 }])))).toBe('ok')
  })

  it('sells controlled drugs only to customers authorised for them', async () => {
    const cd = await sellable([[100, 300]], { cls: 'CONTROLLED' })
    const plain = await addCustomer(a.id)
    const authorised = await addCustomer(a.id, { controlled: true })
    const f = await failure(post(owner, await draft(plain, [{ product_id: cd.product.id, quantity: 1 }])))
    expect(f.code).toBe('22023')
    expect(f.message).toMatch(/not authorised to buy controlled drugs/)
    expect(await code(post(owner, await draft(authorised, [{ product_id: cd.product.id, quantity: 1 }])))).toBe('ok')
  })
})

// ================================================================================================
describe('credit control and payment at the counter', () => {
  it('lets a customer with credit buy on account, tracks what they owe, and blocks the invoice that would pass the limit', async () => {
    const s = await sellable([[1000, 300]], { price: 1 })
    const c = await addCustomer(a.id, { limit: 150, terms: 30 })
    const first = await draft(c, [{ product_id: s.product.id, quantity: 100 }])                 // 100.00
    await ok(post(cashier, first))
    const credit = (await ok(call(salesMgr, `select * from public.customer_credit($1)`, [c])))
    expect([Number(credit.outstanding), Number(credit.credit_limit), Number(credit.available), credit.on_hold]).toEqual([100, 150, 50, false])
    const second = await draft(c, [{ product_id: s.product.id, quantity: 60 }])                 // would make 160 > 150
    const f = await failure(post(cashier, second))
    expect(f.code).toBe('22023')
    expect(f.message).toMatch(/credit limit of 150/)
    expect((await inv(second)).status).toBe('DRAFT')
    await ok(save(salesMgr, { id: second, customer: c, lines: [{ product_id: s.product.id, quantity: 50 }] }))
    await ok(post(cashier, second))                                                              // exactly at the limit
  })

  it('treats limit 0 as no credit: the invoice must be paid when it is posted, and the payment is recorded and allocated', async () => {
    const s = await sellable([[1000, 300]], { price: 2 })
    const cash = await addCustomer(a.id, { limit: 0, terms: 0 })
    const id = await draft(cash, [{ product_id: s.product.id, quantity: 25 }])                  // 50.00
    expect(await code(post(cashier, id))).toBe('22023')
    expect(await code(post(cashier, id, null, { amount: 30, method: 'CASH' }))).toBe('22023')      // 20.00 would still be owed
    expect(await code(post(cashier, id, null, { amount: 60, method: 'CASH' }))).toBe('22023')      // more than the total
    expect(await code(post(cashier, id, null, { amount: 50, method: 'BARTER' }))).toBe('22023')
    expect(await code(post(rep, id, null, { amount: 50, method: 'CASH' }))).toBe('42501')          // no sales.post
    const r = (await ok(post(cashier, id, null, { amount: 50, method: 'MOBILE_MONEY', reference: 'MM-123' }))).r
    expect(r.receipt_number).toMatch(/^RCP-/)
    expect(await inv(id)).toMatchObject({ status: 'POSTED' })
    expect([Number((await inv(id)).amount_paid), Number((await inv(id)).balance_due)]).toEqual([50, 0])
    const [rc] = await q(`select method, reference, amount::float8 a, allocated_amount::float8 al, unallocated_amount::float8 un, branch_id from public.customer_receipts where receipt_number = $1`, [r.receipt_number])
    expect(rc).toEqual({ method: 'MOBILE_MONEY', reference: 'MM-123', a: 50, al: 50, un: 0, branch_id: a.hq })
    expect(await code(post(accounts, await draft(cash, [{ product_id: s.product.id, quantity: 1 }]), null, { amount: 2, method: 'CASH' }))).toBe('42501')   // accounts cannot post
    // the half-failed attempts above changed nothing
    expect(await onHand(s.product.id)).toBe(1000 - 25)
  })

  it('blocks a customer on credit hold, and lets only someone with sales.override_credit override it, with a reason', async () => {
    const s = await sellable([[1000, 300]], { price: 1 })
    const held = await addCustomer(a.id, { hold: true })
    const id = await draft(held, [{ product_id: s.product.id, quantity: 10 }])
    const f = await failure(post(cashier, id))
    expect(f.code).toBe('22023')
    expect(f.message).toMatch(/credit hold \(Overdue account\)/)
    expect(await code(post(cashier, id, 'Boss said so'))).toBe('42501')                           // cashier cannot override
    expect(await code(post(owner, id, '   '))).toBe('22023')                                       // reason required
    const r = (await ok(post(owner, id, 'Cheque cleared this morning, hold not yet lifted'))).r
    expect(r.overridden).toBe(true)
    expect((await inv(id)).override_reason).toBe('Cheque cleared this morning, hold not yet lifted')
    const audit = await q(`select reason from public.audit_logs where entity_type = 'sales_invoice' and entity_id = $1 and reason is not null`, [id])
    expect(audit.map((x) => x.reason)).toContain('Cheque cleared this morning, hold not yet lifted')
  })

  it('counts a customer’s unused credit (unallocated receipts) against what they owe', async () => {
    const s = await sellable([[1000, 300]], { price: 1 })
    const c = await addCustomer(a.id, { limit: 0 })
    await ok(receipt(accounts, c, 80))                                                           // pays in advance: no invoice yet, so all of it is credit
    const id = await draft(c, [{ product_id: s.product.id, quantity: 70 }])
    await ok(post(cashier, id))                                                                   // 70 <= 80 credit held
    const id2 = await draft(c, [{ product_id: s.product.id, quantity: 20 }])
    expect(await code(post(cashier, id2))).toBe('22023')                                          // 70 + 20 - 80 = 10 > 0
    const pos = await ok(call(salesMgr, `select * from public.customer_credit($1)`, [c]))
    expect([Number(pos.outstanding), Number(pos.credit_held)]).toEqual([70, 80])
  })
})

// ================================================================================================
describe('receipts and allocation', () => {
  async function owing(c: string, amounts: number[], terms = 30) {
    const s = await sellable([[100000, 300]], { price: 1 })
    const ids: string[] = []
    for (const n of amounts) {
      const id = await draft(c, [{ product_id: s.product.id, quantity: n }])
      await ok(post(owner, id))
      ids.push(id)
    }
    void terms
    return ids
  }
  const paid = async (id: string) => Number((await inv(id)).amount_paid)

  it('allocates oldest-due-first, leaves the rest as credit, and takes an overpayment as unallocated credit', async () => {
    const c = await addCustomer(a.id)
    const [i1, i2, i3] = (await owing(c, [100, 50, 40])) as [string, string, string]
    await setDue(i2, -10)                                                                         // i2 is the oldest-due (i1 and i3 fall due in 30 days)
    const r = (await ok(receipt(accounts, c, 120))).r
    expect([Number(r.allocated), Number(r.unallocated)]).toEqual([120, 0])
    expect([await paid(i2), await paid(i1), await paid(i3)]).toEqual([50, 70, 0])                  // i2 first (50), then i1 (70)
    const over = (await ok(receipt(accounts, c, 100))).r                                           // 30 on i1, 40 on i3, 30 left over
    expect([Number(over.allocated), Number(over.unallocated)]).toEqual([70, 30])
    expect([await paid(i1), await paid(i3)]).toEqual([100, 40])
    expect(Number((await inv(i1)).balance_due)).toBe(0)
    const pos = await ok(call(accounts, `select * from public.customer_credit($1)`, [c]))
    expect([Number(pos.outstanding), Number(pos.credit_held)]).toEqual([0, 30])
  })

  it('applies chosen allocations only, validating the invoice, the customer and the amounts', async () => {
    const c = await addCustomer(a.id)
    const other = await addCustomer(a.id)
    const [i1, i2] = (await owing(c, [100, 100])) as [string, string]
    const [foreign] = await owing(other, [10])
    expect(await code(receipt(accounts, c, 50, 'CASH', null, [{ invoice_id: foreign, amount: 10 }]))).toBe('P0002')                 // someone else's invoice
    expect(await code(receipt(accounts, c, 50, 'CASH', null, [{ invoice_id: i1, amount: 150 }]))).toBe('22023')                      // more than the invoice owes
    expect(await code(receipt(accounts, c, 50, 'CASH', null, [{ invoice_id: i1, amount: 30 }, { invoice_id: i2, amount: 30 }]))).toBe('22023')   // more than received
    expect(await code(receipt(accounts, c, 50, 'CASH', null, [{ invoice_id: i1, amount: 0 }]))).toBe('22023')
    expect(await code(receipt(accounts, c, 50, 'CASH', null, [{ invoice_id: '00000000-0000-0000-0000-000000000000', amount: 5 }]))).toBe('P0002')
    expect([await paid(i1), await paid(i2)]).toEqual([0, 0])
    const r = (await ok(receipt(accounts, c, 50, 'CASH', null, [{ invoice_id: i2, amount: 20 }]))).r                                   // 20 chosen, 30 stays as credit
    expect([Number(r.allocated), Number(r.unallocated)]).toEqual([20, 30])
    expect([await paid(i1), await paid(i2)]).toEqual([0, 20])
  })

  it('needs a reference for anything but cash, a valid amount and method, receipts.create at the branch, and a draft cannot be paid', async () => {
    const c = await addCustomer(a.id)
    await owing(c, [10])
    expect(await code(receipt(accounts, c, 5, 'CHEQUE'))).toBe('22023')
    expect(await code(receipt(accounts, c, 5, 'CHEQUE', 'CHQ 0042'))).toBe('ok')
    expect(await code(receipt(accounts, c, 0))).toBe('22023')
    expect(await code(receipt(accounts, c, -5))).toBe('22023')
    expect(await code(receipt(accounts, c, 1.005))).toBe('22023')
    expect(await code(receipt(accounts, c, 5, 'GOLD'))).toBe('22023')
    expect(await code(receipt(rep, c, 5))).toBe('42501')
    expect(await code(receipt(accounts, '00000000-0000-0000-0000-000000000000', 5))).toBe('P0002')
    expect(await code(receipt(accounts, c, 5, 'CASH', null, null, '00000000-0000-0000-0000-000000000000'))).toBe('P0002')
    const s = await sellable([[10, 100]])
    const d = await draft(c, [{ product_id: s.product.id, quantity: 1 }])
    expect(await code(receipt(accounts, c, 5, 'CASH', null, [{ invoice_id: d, amount: 5 }]))).toBe('22023')
    const branchAcct = await addUser(a.id, 'ACCOUNTS_OFFICER', branch2)
    expect(await code(receipt(branchAcct, c, 5, 'CASH', null, null, a.hq))).toBe('42501')
    expect(await code(receipt(branchAcct, c, 5, 'CASH', null, null, branch2))).toBe('ok')
  })

  it('applies earlier credit to a new invoice with allocate_receipt', async () => {
    const c = await addCustomer(a.id)
    const r = (await ok(receipt(accounts, c, 60))).r                                               // nothing owed: all credit
    const s = await sellable([[1000, 300]], { price: 1 })
    const id = await draft(c, [{ product_id: s.product.id, quantity: 100 }])
    await ok(post(owner, id))
    const done = (await ok(call(accounts, `select public.allocate_receipt($1, null) as r`, [r.receipt_id]))).r
    expect(Number(done.allocated)).toBe(60)
    expect(await paid(id)).toBe(60)
    expect(await code(call(accounts, `select public.allocate_receipt($1, null)`, [r.receipt_id]))).toBe('22023')      // fully allocated now
    expect(await code(call(rep, `select public.allocate_receipt($1, null)`, [r.receipt_id]))).toBe('42501')
  })

  it('voids a receipt (a bounced cheque), re-opening what it paid, with a reason and the right permission, once only', async () => {
    const c = await addCustomer(a.id)
    const [i1, i2] = (await owing(c, [100, 100])) as [string, string]
    const r = (await ok(receipt(accounts, c, 150, 'CHEQUE', 'CHQ-9'))).r
    expect([await paid(i1), await paid(i2)]).toEqual([100, 50])
    expect(await code(call(cashier, `select public.void_receipt($1, 'bounced')`, [r.receipt_id]))).toBe('42501')
    expect(await code(call(accounts, `select public.void_receipt($1, '')`, [r.receipt_id]))).toBe('22023')
    await ok(call(accounts, `select public.void_receipt($1, 'Cheque bounced: insufficient funds')`, [r.receipt_id]))
    expect([await paid(i1), await paid(i2)]).toEqual([0, 0])
    expect((await q(`select status, void_reason, allocated_amount::float8 a, unallocated_amount::float8 u from public.customer_receipts where id = $1`, [r.receipt_id]))[0])
      .toEqual({ status: 'VOID', void_reason: 'Cheque bounced: insufficient funds', a: 0, u: 150 })
    expect(await code(call(accounts, `select public.void_receipt($1, 'again')`, [r.receipt_id]))).toBe('22023')
    expect(await code(call(accounts, `select public.allocate_receipt($1, null)`, [r.receipt_id]))).toBe('22023')
    const pos = await ok(call(accounts, `select * from public.customer_credit($1)`, [c]))
    expect([Number(pos.outstanding), Number(pos.credit_held)]).toEqual([200, 0])                    // a voided receipt is not credit either
  })

  it('keeps invoice payments equal to the sum of live allocations, and the tables immutable and closed to clients', async () => {
    const c = await addCustomer(a.id)
    const ids = await owing(c, [100, 80])
    const r1 = (await ok(receipt(accounts, c, 120))).r
    const r2 = (await ok(receipt(accounts, c, 30))).r
    await ok(call(accounts, `select public.void_receipt($1, 'wrong customer')`, [r2.receipt_id]))
    for (const id of ids) {
      const live = Number((await q(`select coalesce(sum(a.amount),0) s from public.receipt_allocations a where a.sales_invoice_id = $1 and not a.is_voided`, [id]))[0].s)
      expect(await paid(id)).toBe(live)
    }
    for (const sql of [`update public.customer_receipts set amount = 1`, `delete from public.customer_receipts`, `insert into public.customer_receipts (customer_id) values (gen_random_uuid())`,
                       `update public.receipt_allocations set amount = 1`, `delete from public.receipt_allocations`]) {
      const out = await call(accounts, sql)
      expect(out.ok, sql).toBe(false)
      if (!out.ok) expect(out.code, sql).toBe('42501')
    }
    await expect(admin.query(`update public.customer_receipts set amount = 1 where id = $1`, [r1.receipt_id])).rejects.toMatchObject({ code: '23514' })
    await expect(admin.query(`delete from public.receipt_allocations where receipt_id = $1`, [r1.receipt_id])).rejects.toMatchObject({ code: '42501' })
  })

  it('shows receipts to people with receipts.view at the branch only, and nothing across tenants', async () => {
    const c = await addCustomer(a.id)
    await owing(c, [10])
    const r = (await ok(receipt(accounts, c, 5))).r
    const look = (u: string) => withUser(u, async (cl) => (await cl.q(`select count(*)::int n from public.customer_receipts where id = $1`, [r.receipt_id])).rows[0].n)
    expect(await look(accounts)).toBe(1)
    expect(await look(await addUser(a.id, 'ACCOUNTS_OFFICER', branch2))).toBe(0)
    expect(await look(await addUser(a.id, 'WAREHOUSE_PICKER'))).toBe(0)
    expect(await look(b.ownerId)).toBe(0)
  })
})

// ================================================================================================
describe('receivables and statements', () => {
  it('ages what customers owe into buckets, includes unused credit, and orders by size', async () => {
    const org = await createOrg('SAL-AGE')
    const w = await addWarehouse(org.id, org.hq, 'WA')
    const list = await priceList(org.id, 'RETAIL', true)
    const p = await addProduct(org.id, { cls: 'GSL' })
    await setPrice(org.id, list, p.id, p.baseUnitRowId, 1)
    await ok(call(org.ownerId, `select public.post_stock_document('OPENING', $1, $2::jsonb)`, [w, JSON.stringify([{ product_id: p.id, quantity: 100000, batch_number: 'AG', expiry_date: day(400) }])]))
    const cust = async (n: string) => (await q(`insert into public.customers (organization_id, code, name, payment_terms_days, credit_limit) values ($1, $2, $3, 30, 100000) returning id`, [org.id, n.toUpperCase().replace(/[^A-Z0-9]/g, ''), n]))[0].id as string
    const sell = async (c: string, qty: number, dueOffset: number) => {
      const id = (await ok(call(org.ownerId, `select public.save_sales_invoice(null, $1, $2, null, null, $3::jsonb) as id`, [c, w, JSON.stringify([{ product_id: p.id, quantity: qty }])]))).id as string
      await ok(call(org.ownerId, `select public.post_sales_invoice($1, null, null)`, [id]))
      await setDue(id, dueOffset)
      return id
    }
    const big = await cust('Big Debtor'); const small = await cust('Small Debtor'); const prepaid = await cust('Prepaid Customer')
    await sell(big, 100, 10); await sell(big, 200, -15); await sell(big, 300, -45); await sell(big, 400, -75); await sell(big, 500, -120)
    await sell(small, 7, -3)
    await ok(call(org.ownerId, `select public.record_receipt($1, $2, 25, 'CASH', null, null) as r`, [prepaid, org.hq]))
    const rows = (await call(org.ownerId, `select * from public.receivables_summary()`)) as Extract<Out, { ok: true }>
    expect(rows.ok).toBe(true)
    const byName = Object.fromEntries(rows.rows.map((r) => [r.customer_name, r]))
    expect(rows.rows.map((r) => r.customer_name)).toEqual(['Big Debtor', 'Small Debtor', 'Prepaid Customer'])
    const b1 = byName['Big Debtor']
    expect([b1.outstanding, b1.not_due, b1.overdue_1_30, b1.overdue_31_60, b1.overdue_61_90, b1.overdue_over_90].map(Number)).toEqual([1500, 100, 200, 300, 400, 500])
    expect([Number(byName['Small Debtor'].outstanding), Number(byName['Small Debtor'].overdue_1_30)]).toEqual([7, 7])
    expect([Number(byName['Prepaid Customer'].outstanding), Number(byName['Prepaid Customer'].credit_held)]).toEqual([0, 25])
    // other organizations never see it
    await withUser(a.ownerId, async (c) => expect((await c.q(`select count(*)::int n from public.receivables_summary() where customer_name = 'Big Debtor'`)).rows[0].n).toBe(0))
  })

  it('writes a customer statement in date order with a running balance', async () => {
    const c = await addCustomer(a.id)
    const s = await sellable([[10000, 300]], { price: 1 })
    const i1 = await draft(c, [{ product_id: s.product.id, quantity: 100 }]); await ok(post(owner, i1))
    await ok(receipt(accounts, c, 40))
    const i2 = await draft(c, [{ product_id: s.product.id, quantity: 30 }]); await ok(post(owner, i2))
    const st = (await call(accounts, `select * from public.customer_statement($1, null)`, [c])) as Extract<Out, { ok: true }>
    expect(st.rows.map((r) => [r.entry_type, Number(r.debit), Number(r.credit), Number(r.balance)])).toEqual([
      ['INVOICE', 100, 0, 100], ['RECEIPT', 0, 40, 60], ['INVOICE', 30, 0, 90],
    ])
    expect(st.rows[0].reference).toMatch(/^INV-/)
    expect(st.rows[1].reference).toMatch(/^RCP-/)
    // a voided receipt drops out of the statement
    const r = (await ok(receipt(accounts, c, 10))).r
    await ok(call(accounts, `select public.void_receipt($1, 'mistake')`, [r.receipt_id]))
    const st2 = (await call(accounts, `select * from public.customer_statement($1, null)`, [c])) as Extract<Out, { ok: true }>
    expect(st2.rows).toHaveLength(3)
    expect(await unitId('TABLET')).toBeTruthy()
  })
})
