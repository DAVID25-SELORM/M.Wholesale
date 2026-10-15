import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addLocation, addProduct, addUser, addWarehouse, admin, closePool, createOrg, rand, withUser, type Org } from '../helpers/db'

let a: Org
let b: Org
let wh: string
let branch2: string
let owner: string
let picker: string      // deliveries.view + create
let picker2: string     // branch 2 only
let dispatcher: string  // deliveries.view + dispatch
let whMgr: string       // all deliveries, reports.stock
let rep: string         // deliveries.view only
let salesMgr: string    // reports.stock, no cost visibility
let accountsMgr: string // reports.tax
let defaultList: string

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  a = await createOrg('P12-A')
  b = await createOrg('P12-B')
  wh = await addWarehouse(a.id, a.hq, 'W1')
  branch2 = await addBranch(a.id, 'B2')
  await addWarehouse(a.id, branch2, 'W2')
  owner = a.ownerId
  picker = await addUser(a.id, 'WAREHOUSE_PICKER')
  picker2 = await addUser(a.id, 'WAREHOUSE_PICKER', branch2)
  dispatcher = await addUser(a.id, 'DISPATCHER')
  whMgr = await addUser(a.id, 'WAREHOUSE_MANAGER')
  rep = await addUser(a.id, 'SALES_REP')
  salesMgr = await addUser(a.id, 'SALES_MANAGER')
  accountsMgr = await addUser(a.id, 'ACCOUNTS_MANAGER')
  defaultList = (await q(`insert into public.price_lists (organization_id, code, name, is_default) values ($1, 'RETAIL', 'Retail', true) returning id`, [a.id]))[0].id
})
afterAll(closePool)

type Out = { ok: true; rows: any[] } | { ok: false; code: string; message: string }
const call = (user: string, sql: string, params: unknown[] = []): Promise<Out> => withUser(user, (c) => c.attempt(sql, params), { commit: true }) as Promise<Out>
const ok = async (p: Promise<Out>) => {
  const r = await p
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`)
  return r.rows
}
const failure = async (p: Promise<Out>) => { const r = await p; return r.ok ? { code: 'ok', message: '' } : { code: r.code, message: r.message } }
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows
const num = (v: unknown) => Number(v)
/** test-only: bypass triggers (the same trick the other suites use to age data) */
async function replica(sql: string, params: unknown[] = []) {
  const c = await admin.connect()
  try { await c.query('begin'); await c.query('set local session_replication_role = replica'); await c.query(sql, params); await c.query('commit') } finally { c.release() }
}

async function addCustomer(): Promise<string> {
  return (await q(
    `insert into public.customers (organization_id, code, name, customer_type, licence_number, licence_expiry, payment_terms_days, credit_limit, address)
     values ($1, $2, $3, 'PHARMACY', 'PC/1', $4, 30, 1000000, 'Plot 4, Spintex Road') returning id`, [a.id, `C${rand()}`, `Customer ${rand()}`, day(300)]))[0].id
}
async function stocked(o: { price?: number; cost?: number | null; qty?: number; expiry?: number; location?: string; taxRate?: number } = {}) {
  const product = await addProduct(a.id, { cls: 'GSL' })
  await q(`insert into public.price_list_items (organization_id, price_list_id, product_id, product_unit_id, unit_price) values ($1, $2, $3, $4, $5)`, [a.id, defaultList, product.id, product.baseUnitRowId, o.price ?? 10])
  if (o.taxRate) {
    const tax = (await q(`insert into public.tax_codes (organization_id, code, name, rate) values ($1, $2, 'VAT', $3) returning id`, [a.id, `T${rand()}`, o.taxRate]))[0].id
    await q(`update public.products set tax_code_id = $2 where id = $1`, [product.id, tax])
  }
  await ok(call(owner, `select public.post_stock_document('OPENING', $1, $2::jsonb) as r`, [wh, JSON.stringify([{
    product_id: product.id, quantity: o.qty ?? 1000, batch_number: `B${rand()}`, expiry_date: day(o.expiry ?? 300), ...(o.location ? { location_id: o.location } : {}),
    ...(o.cost === null ? {} : { unit_cost: o.cost ?? 4 }) }])]))
  return product
}
async function invoice(customer: string, lines: { product: string; qty: number }[]): Promise<string> {
  const id = (await ok(call(owner, `select public.save_sales_invoice(null, $1, $2, null, null, $3::jsonb) as id`, [customer, wh, JSON.stringify(lines.map((l) => ({ product_id: l.product, quantity: l.qty })))])))[0].id
  await ok(call(owner, `select public.post_sales_invoice($1) as r`, [id]))
  return id
}
const prepare = (user: string, invoiceId: string, packages = 3) =>
  call(user, `select public.prepare_delivery_note($1, 'Plot 4, Spintex Road', 'Kofi', '0244000111', $2, 'Fridge items') as id`, [invoiceId, packages])
const note = async (id: string) => (await q(`select * from public.delivery_notes where id = $1`, [id]))[0]

describe('delivery notes and picking', () => {
  it('prepares a note with a pick list in walking order, dispatches it with a driver, and records who received it', async () => {
    const l1 = await addLocation(a.id, wh, `A-${rand()}`)
    const l2 = await addLocation(a.id, wh, `B-${rand()}`)
    await q(`update public.warehouse_locations set picking_sequence = 10 where id = $1`, [l1])
    await q(`update public.warehouse_locations set picking_sequence = 20 where id = $1`, [l2])
    const far = await stocked({ location: l2 })
    const near = await stocked({ location: l1 })
    const c = await addCustomer()
    const i = await invoice(c, [{ product: far.id, qty: 5 }, { product: near.id, qty: 7 }])      // invoice order: far, near
    const id = (await ok(prepare(picker, i)))[0].id
    expect(await note(id)).toMatchObject({ status: 'PREPARED', customer_id: c, branch_id: a.hq, warehouse_id: wh, packages: 3, delivery_address: 'Plot 4, Spintex Road', contact_name: 'Kofi' })
    expect((await note(id)).note_number).toMatch(/^DN-\d{4}-\d{6}$/)
    const pick = await ok(call(picker, `select line_no, sku, line_quantity::float8 lq, base_quantity::float8 bq, batch_number, expiry_date::text, location_code, picking_sequence from public.delivery_pick_list($1)`, [id]))
    expect(pick.map((r) => [r.sku, r.bq, r.picking_sequence])).toEqual([[near.sku, 7, 10], [far.sku, 5, 20]])    // the nearest shelf first, whatever the invoice order
    expect(pick[0]).toMatchObject({ lq: 7, batch_number: expect.stringMatching(/^B/), location_code: expect.stringMatching(/^A-/) })
    // who may do what
    expect((await failure(prepare(dispatcher, i))).code).toBe('42501')                           // dispatchers do not prepare
    expect((await failure(call(picker, `select public.dispatch_delivery_note($1, 'Yaw', 'GR 123')`, [id]))).code).toBe('42501')   // pickers do not dispatch
    expect((await failure(call(dispatcher, `select public.dispatch_delivery_note($1, '', 'GR 123')`, [id]))).code).toBe('22023')
    expect((await failure(call(dispatcher, `select public.confirm_delivery($1, 'Kofi')`, [id]))).message).toMatch(/only a dispatched delivery can be confirmed/)
    await ok(call(dispatcher, `select public.dispatch_delivery_note($1, 'Yaw Boateng', 'GR 4417-22')`, [id]))
    expect(await note(id)).toMatchObject({ status: 'DISPATCHED', driver_name: 'Yaw Boateng', vehicle_number: 'GR 4417-22' })
    expect((await failure(call(dispatcher, `select public.dispatch_delivery_note($1, 'Yaw', 'GR 123')`, [id]))).message).toMatch(/only a prepared delivery note can be dispatched/)
    expect((await failure(call(dispatcher, `select public.confirm_delivery($1, '  ')`, [id]))).code).toBe('22023')
    await ok(call(dispatcher, `select public.confirm_delivery($1, 'Kofi Mensah (pharmacist)', 'Two cartons signed for') as r`, [id]))
    expect(await note(id)).toMatchObject({ status: 'DELIVERED', received_by_name: 'Kofi Mensah (pharmacist)', status_reason: 'Two cartons signed for' })
    expect((await note(id)).delivered_at).not.toBeNull()
    // delivered notes are final; an invoice has only one live note
    for (const sql of [`update public.delivery_notes set packages = 9 where id = $1`, `update public.delivery_notes set status = 'PREPARED' where id = $1`, `delete from public.delivery_notes where id = $1`])
      await expect(admin.query(sql, [id]), sql).rejects.toBeTruthy()
    expect((await failure(prepare(whMgr, i))).message).toMatch(/already has a delivery note/)
    expect((await failure(call(whMgr, `select public.cancel_delivery_note($1, 'x')`, [id]))).message).toMatch(/delivered delivery note cannot be cancelled/)
  })

  it('cancels a prepared note, records a failed delivery and lets the invoice be prepared again; only posted invoices are delivered', async () => {
    const p = await stocked()
    const c = await addCustomer()
    const i = await invoice(c, [{ product: p.id, qty: 3 }])
    const n1 = (await ok(prepare(picker, i)))[0].id
    expect((await failure(call(picker, `select public.cancel_delivery_note($1, '')`, [n1]))).code).toBe('22023')
    await ok(call(picker, `select public.cancel_delivery_note($1, 'Wrong address')`, [n1]))
    expect(await note(n1)).toMatchObject({ status: 'CANCELLED', status_reason: 'Wrong address' })
    const n2 = (await ok(prepare(picker, i)))[0].id
    await ok(call(dispatcher, `select public.dispatch_delivery_note($1, 'Yaw', 'GR 1')`, [n2]))
    expect((await failure(call(picker, `select public.cancel_delivery_note($1, 'x')`, [n2]))).message).toMatch(/dispatched delivery note cannot be cancelled/)
    await ok(call(dispatcher, `select public.fail_delivery($1, 'Shop was closed')`, [n2]))
    expect(await note(n2)).toMatchObject({ status: 'FAILED', status_reason: 'Shop was closed' })
    expect((await ok(prepare(picker, i)))[0].id).toBeTruthy()                                      // a third attempt
    const draft = (await ok(call(owner, `select public.save_sales_invoice(null, $1, $2, null, null, $3::jsonb) as id`, [c, wh, JSON.stringify([{ product_id: p.id, quantity: 1 }])])))[0].id
    expect((await failure(prepare(picker, draft))).message).toMatch(/only a posted invoice can be delivered/)
    expect((await failure(prepare(picker, i, -1))).code).toBe('22023')
  })

  it('is cancelled with a reversed invoice while prepared, and blocks reversal once the goods have left', async () => {
    const p = await stocked()
    const c = await addCustomer()
    const i1 = await invoice(c, [{ product: p.id, qty: 2 }])
    const n1 = (await ok(prepare(picker, i1)))[0].id
    await ok(call(owner, `select public.reverse_sales_invoice($1, 'Wrong customer')`, [i1]))
    expect(await note(n1)).toMatchObject({ status: 'CANCELLED', status_reason: 'The invoice was reversed' })
    const i2 = await invoice(c, [{ product: p.id, qty: 2 }])
    const n2 = (await ok(prepare(picker, i2)))[0].id
    await ok(call(dispatcher, `select public.dispatch_delivery_note($1, 'Yaw', 'GR 2')`, [n2]))
    expect((await failure(call(owner, `select public.reverse_sales_invoice($1, 'Wrong customer')`, [i2]))).message).toMatch(/already left .* take them back with a credit note/)
    expect((await q(`select status from public.sales_invoices where id = $1`, [i2]))[0].status).toBe('POSTED')
  })

  it('is visible per branch to people with deliveries.view, and to nobody else', async () => {
    const p = await stocked()
    const i = await invoice(await addCustomer(), [{ product: p.id, qty: 1 }])
    const n = (await ok(prepare(whMgr, i)))[0].id
    const seen = (user: string) => withUser(user, async (cx) => (await cx.q(`select count(*)::int n from public.delivery_notes where id = $1`, [n])).rows[0].n)
    expect([await seen(picker), await seen(dispatcher), await seen(rep), await seen(owner)]).toEqual([1, 1, 1, 1])
    const pharmacist = await addUser(a.id, 'PHARMACIST')                                           // no deliveries.view
    expect([await seen(picker2), await seen(pharmacist), await seen(b.ownerId)]).toEqual([0, 0, 0])
    expect(await seen(salesMgr)).toBe(1)
    expect((await failure(call(picker2, `select * from public.delivery_pick_list($1)`, [n]))).code).toBe('P0002')
    expect((await failure(call(rep, `select public.prepare_delivery_note($1, null, null, null, 1, null)`, [i]))).code).toBe('42501')   // view only
    expect((await failure(call(picker2, `select public.prepare_delivery_note($1, null, null, null, 1, null)`, [i]))).code).toBe('42501')
    expect((await failure(call(b.ownerId, `select public.prepare_delivery_note($1, null, null, null, 1, null)`, [i]))).code).toBe('P0002')
    for (const user of [owner, whMgr]) {
      expect((await failure(call(user, `delete from public.delivery_notes`))).code).toBe('42501')
      expect((await failure(call(user, `update public.delivery_notes set status = 'DELIVERED' where id = $1`, [n]))).code).toBe('42501')
    }
  })
})

describe('stock insights', () => {
  const reorder = (user: string, cover = 30) => call(user, `select product_id, on_hand::float8 oh, free::float8 fr, avg_daily::float8 d, days_cover::float8 dc, lead_time_days lt, target_stock::float8 tgt, suggested_qty::float8 sug from public.reorder_suggestions(null, 90, $1)`, [cover])

  it('suggests what to buy from recent sales, current free stock and the lead time, leaving out products that do not sell', async () => {
    const fast = await stocked({ qty: 100 })
    const slow = await stocked({ qty: 1000 })
    const idle = await stocked({ qty: 50 })
    const c = await addCustomer()
    await invoice(c, [{ product: fast.id, qty: 90 }, { product: slow.id, qty: 9 }])               // 90 and 9 sold in the last 90 days
    const rows = await ok(reorder(whMgr))
    const f = rows.find((r) => r.product_id === fast.id)
    const s = rows.find((r) => r.product_id === slow.id)
    expect(f).toMatchObject({ oh: 10, fr: 10, d: 1, dc: 10, lt: 7, tgt: 37, sug: 27 })              // 1/day x (30 cover + 7 lead) = 37 wanted, 10 free
    expect(s).toMatchObject({ oh: 991, d: 0.1, sug: 0 })                                           // plenty of cover
    expect(rows.find((r) => r.product_id === idle.id)).toBeUndefined()                              // never sold: not a reorder candidate
    expect(rows.findIndex((r) => r.product_id === fast.id)).toBeLessThan(rows.findIndex((r) => r.product_id === slow.id))   // least cover first
    expect(num((await ok(reorder(whMgr, 60))).find((r) => r.product_id === fast.id)!.sug)).toBe(57)
    // a reservation for a customer order reduces what is free
    const o = (await ok(call(owner, `select public.save_sales_order(null, $1, $2, null, null, null, null, $3::jsonb) as id`, [c, wh, JSON.stringify([{ product_id: fast.id, quantity: 4 }])])))[0].id
    await ok(call(owner, `select public.confirm_sales_order($1)`, [o]))
    expect((await ok(reorder(whMgr))).find((r) => r.product_id === fast.id)).toMatchObject({ oh: 10, fr: 6, sug: 31 })
    expect((await failure(reorder(rep))).code).toBe('42501')
    expect((await failure(reorder(accountsMgr))).code).toBe('42501')
    expect((await failure(call(owner, `select * from public.reorder_suggestions(null, 3, 30)`))).code).toBe('22023')
    expect((await ok(reorder(b.ownerId)))).toEqual([])
  })

  it('lists stock that has not sold for a long time, with its value only for people allowed to see costs', async () => {
    const dead = await stocked({ qty: 40, cost: 5 })
    const old = await stocked({ qty: 10, cost: 2 })
    const live = await stocked({ qty: 100, cost: 1 })
    const c = await addCustomer()
    const iOld = await invoice(c, [{ product: old.id, qty: 5 }])
    await replica(`update public.sales_invoices set invoice_date = current_date - 200 where id = $1`, [iOld])
    await invoice(c, [{ product: live.id, qty: 5 }])
    const slow = (user: string) => call(user, `select product_id, on_hand::float8 oh, stock_value::float8 val, days_since_sale from public.slow_moving_stock(180)`)
    const rows = await ok(slow(owner))
    expect(rows.find((r) => r.product_id === dead.id)).toEqual({ product_id: dead.id, oh: 40, val: 200, days_since_sale: null })
    expect(rows.find((r) => r.product_id === old.id)).toMatchObject({ oh: 5, val: 10, days_since_sale: 200 })
    expect(rows.find((r) => r.product_id === live.id)).toBeUndefined()
    expect(rows.findIndex((r) => r.product_id === dead.id)).toBeLessThan(rows.findIndex((r) => r.product_id === old.id))     // biggest value first
    expect((await ok(slow(salesMgr))).find((r) => r.product_id === dead.id)).toMatchObject({ oh: 40, val: null })           // reports.stock without cost visibility
    expect((await failure(slow(rep))).code).toBe('42501')
    expect((await failure(call(owner, `select * from public.slow_moving_stock(5)`))).code).toBe('22023')
  })

  it('estimates what will not sell before it expires, batch by batch, earliest expiry first', async () => {
    const p = await stocked({ qty: 100, cost: 3, expiry: 30 })
    await ok(call(owner, `select public.post_stock_document('OPENING', $1, $2::jsonb) as r`, [wh, JSON.stringify([{ product_id: p.id, quantity: 100, batch_number: `L${rand()}`, expiry_date: day(60), unit_cost: 3 }])]))
    await invoice(await addCustomer(), [{ product: p.id, qty: 30 }])                               // 30 sold in 90 days: 1/3 per day; FEFO takes them from the first batch
    const risk = (user: string, horizon = 180) => call(user, `select product_id, expiry_date::text, days_left, quantity::float8 qty, avg_daily::float8 d, expected_sales::float8 es, at_risk_qty::float8 risk, value_at_risk::float8 val from public.expiry_risk($1, 90, null)`, [horizon])
    const rows = (await ok(risk(owner))).filter((r) => r.product_id === p.id)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ days_left: 30, qty: 70, d: 0.333, es: 10, risk: 60, val: 180 })         // 70 left, 10 can sell in 30 days
    expect(rows[1]).toMatchObject({ days_left: 60, qty: 100, es: 0, risk: 100, val: 300 })                    // 60 days x 1/3 = 20 sellable, but the 70 in the earlier batch go first: none of this batch
    expect((await ok(risk(owner, 40))).filter((r) => r.product_id === p.id)).toHaveLength(1)                 // the horizon cuts off the later batch
    expect((await ok(risk(salesMgr))).find((r) => r.product_id === p.id)).toMatchObject({ risk: 60, val: null })
    expect((await failure(risk(rep))).code).toBe('42501')
  })
})

describe('VAT summary', () => {
  it('reports output VAT per tax code net of credit notes, and input VAT on approved supplier invoices', async () => {
    const taxed = await stocked({ price: 100, taxRate: 10, qty: 100 })
    const exempt = await stocked({ price: 50, qty: 100 })
    const c = await addCustomer()
    const i = await invoice(c, [{ product: taxed.id, qty: 10 }, { product: exempt.id, qty: 4 }])       // 1000 + 10 % tax 100 ; 200 exempt
    const [l] = await q(`select id from public.sales_invoice_lines where sales_invoice_id = $1 and product_id = $2`, [i, taxed.id])
    const n = (await ok(call(owner, `select public.save_credit_note(null, $1, null, 'DAMAGED', null, $2::jsonb) as id`, [i, JSON.stringify([{ type: 'RETURN', invoice_line_id: l.id, quantity: 2 }])])))[0].id
    await ok(call(owner, `select public.post_credit_note($1)`, [n]))                                  // 200 + 20 tax credited
    const supplier = (await q(`select id from public.suppliers where organization_id = $1 limit 1`, [a.id]))[0]?.id
      ?? (await q(`insert into public.suppliers (organization_id, code, name) values ($1, $2, 'Supplier') returning id`, [a.id, `S${rand()}`]))[0].id
    const po = (await q(`insert into public.purchase_orders (organization_id, po_number, supplier_id, branch_id, warehouse_id, status, order_date, currency_code, payment_terms_days, total_amount)
                         values ($1, $2, $3, $4, $5, 'APPROVED', current_date, 'GHS', 30, 440) returning id`, [a.id, `PO-${rand()}`, supplier, a.hq, wh]))[0].id
    await q(`insert into public.supplier_invoices (organization_id, invoice_number, supplier_invoice_number, supplier_id, purchase_order_id, branch_id, invoice_date, due_date, currency_code, subtotal, tax_amount, total_amount, status)
             values ($1, $2, $3, $4, $5, $6, current_date, current_date + 30, 'GHS', 400, 40, 440, 'APPROVED')`, [a.id, `SI-${rand()}`, `EMP/${rand()}`, supplier, po, a.hq])
    const vat = (user: string, from = day(-1), to = day(1)) =>
      call(user, `select section, tax_code, tax_name, rate::float8 rate, taxable::float8 taxable, tax::float8 tax from public.vat_report($1, $2)`, [from, to])
    const rows = await ok(vat(accountsMgr))
    const out = rows.filter((r) => r.section === 'OUTPUT')
    expect(out).toHaveLength(2)
    expect(out.find((r) => r.rate === 0)!.taxable).toBeGreaterThanOrEqual(200)                       // exempt sales (other tests of this organization add to it)
    expect(out.find((r) => r.rate === 0)!.tax).toBe(0)
    expect(rows.find((r) => r.section === 'OUTPUT' && r.rate === 10)).toMatchObject({ taxable: 800, tax: 80 })
    expect(rows.find((r) => r.section === 'INPUT')).toMatchObject({ taxable: 400, tax: 40 })
    expect(await ok(vat(accountsMgr, day(-30), day(-10)))).toEqual([])
    expect((await failure(vat(rep))).code).toBe('42501')
    expect((await failure(vat(salesMgr))).code).toBe('42501')
    expect((await failure(vat(owner, day(1), day(-1)))).code).toBe('22023')
    expect((await ok(vat(b.ownerId)))).toEqual([])
  })
})
