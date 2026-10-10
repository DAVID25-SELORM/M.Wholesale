import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addBranch, addLocation, addProduct, addProductUnit, addSupplier, addUser, addWarehouse, admin, closePool, createOrg, withUser, type Org,
} from '../helpers/db'

let a: Org
let b: Org
let whA1: string
let branch2: string
let whA3: string
let whB1: string
let officer: string   // purchasing.view + create
let manager: string   // purchasing.view + create + approve
let storeman: string  // purchasing.view + receive (+ inventory)
let supplierA: string

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  a = await createOrg('PUR-A')
  b = await createOrg('PUR-B')
  whA1 = await addWarehouse(a.id, a.hq, 'W1')
  branch2 = await addBranch(a.id, 'B2')
  whA3 = await addWarehouse(a.id, branch2, 'W3')
  whB1 = await addWarehouse(b.id, b.hq, 'WB1')
  officer = await addUser(a.id, 'PROCUREMENT_OFFICER')
  manager = await addUser(a.id, 'PROCUREMENT_MANAGER')
  storeman = await addUser(a.id, 'WAREHOUSE_MANAGER')
  supplierA = await addSupplier(a.id)
})
afterAll(closePool)

type Line = Record<string, unknown>
type Out = { ok: true; rows: any[] } | { ok: false; code: string; message: string }

const call = (user: string, sql: string, params: unknown[] = []): Promise<Out> =>
  withUser(user, (c) => c.attempt(sql, params), { commit: true }) as Promise<Out>
const ok = async (p: Promise<Out>) => {
  const r = await p
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`)
  return r.rows[0]
}
const failCode = async (p: Promise<Out>) => {
  const r = await p
  return r.ok ? 'ok' : r.code
}

const save = (user: string, o: { id?: string | null; supplier?: string; wh?: string; lines: Line[]; terms?: number | null; notes?: string | null }) =>
  call(user, `select public.save_purchase_order($1, $2, $3, null, $4, $5::jsonb, $6) as id`,
    [o.id ?? null, o.supplier ?? supplierA, o.wh ?? whA1, o.notes ?? null, JSON.stringify(o.lines), o.terms ?? null])
const submit = (user: string, id: string) => call(user, `select public.submit_purchase_order($1)`, [id])
const approve = (user: string, id: string) => call(user, `select public.approve_purchase_order($1)`, [id])
const reject = (user: string, id: string, reason: string | null) => call(user, `select public.reject_purchase_order($1, $2)`, [id, reason])
const cancel = (user: string, id: string, reason: string | null) => call(user, `select public.cancel_purchase_order($1, $2)`, [id, reason])
const close = (user: string, id: string, reason: string | null) => call(user, `select public.close_purchase_order($1, $2)`, [id, reason])
const receive = (user: string, id: string, lines: Line[], note: string | null = null) =>
  call(user, `select public.receive_goods($1, $2::jsonb, $3, null) as r`, [id, JSON.stringify(lines), note])

const poRow = async (id: string) => (await admin.query(`select * from public.purchase_orders where id = $1`, [id])).rows[0]
const polines = async (id: string) => (await admin.query(`select * from public.purchase_order_lines where purchase_order_id = $1 order by line_no`, [id])).rows
const onHand = async (productId: string, status?: string) =>
  Number((await admin.query(`select coalesce(sum(quantity), 0) q from public.stock_balances where product_id = $1 and ($2::text is null or stock_status = $2)`, [productId, status ?? null])).rows[0].q)

/** An APPROVED order with one line (default: 10 boxes of 14 at 85.50). */
async function approvedOrder(opts: { qty?: number; wh?: string; supplier?: string } = {}) {
  const product = await addProduct(a.id)
  const box = await addProductUnit(a.id, product.id, 'BOX', 14)
  const wh = opts.wh ?? whA1
  const id = (await ok(save(officer, { wh, supplier: opts.supplier, lines: [{ product_id: product.id, product_unit_id: box, quantity: opts.qty ?? 10, unit_cost: 85.5 }] }))).id as string
  await ok(submit(officer, id))
  await ok(approve(manager, id))
  const [line] = await polines(id)
  return { id, product, box, lineId: line.id as string }
}

describe('drafting orders', () => {
  it('creates a numbered draft with computed totals, currency and terms from the supplier, and replaces lines on edit', async () => {
    const p1 = await addProduct(a.id)
    const p2 = await addProduct(a.id)
    const box = await addProductUnit(a.id, p2.id, 'BOX', 10)
    const id = (await ok(save(officer, { lines: [
      { product_id: p1.id, quantity: 100, unit_cost: 1.25 },
      { product_id: p2.id, product_unit_id: box, quantity: 3, unit_cost: 12.5 },
    ] }))).id
    let po = await poRow(id)
    expect(po).toMatchObject({ status: 'DRAFT', currency_code: 'GHS', payment_terms_days: 30, created_by: officer })
    expect(po.po_number).toMatch(/^PO-/)
    expect(Number(po.total_amount)).toBe(162.5)
    const lines = await polines(id)
    expect(lines.map((l) => [Number(l.quantity_ordered), Number(l.ordered_base), Number(l.line_total)])).toEqual([[100, 100, 125], [3, 30, 37.5]])

    await ok(save(officer, { id, lines: [{ product_id: p1.id, quantity: 10, unit_cost: 2 }], terms: 14 }))
    po = await poRow(id)
    expect(Number(po.total_amount)).toBe(20)
    expect(po.payment_terms_days).toBe(14)
    expect((await polines(id))).toHaveLength(1)
  })

  it('numbers orders sequentially', async () => {
    const p = await addProduct(a.id)
    const n1 = (await poRow((await ok(save(officer, { lines: [{ product_id: p.id, quantity: 1, unit_cost: 1 }] }))).id)).po_number as string
    const n2 = (await poRow((await ok(save(officer, { lines: [{ product_id: p.id, quantity: 1, unit_cost: 1 }] }))).id)).po_number as string
    const n = (s: string) => Number(s.split('-').pop())
    expect(n(n2)).toBe(n(n1) + 1)
  })

  it('rejects empty orders, bad quantities and costs, duplicate lines and unpurchasable packs', async () => {
    const p = await addProduct(a.id)
    const other = await addProduct(a.id)
    const otherBox = await addProductUnit(a.id, other.id, 'BOX', 10)
    expect(await failCode(save(officer, { lines: [] }))).toBe('22023')
    for (const quantity of [0, -1, 'x', null]) expect(await failCode(save(officer, { lines: [{ product_id: p.id, quantity, unit_cost: 1 }] }))).toBe('22023')
    for (const unit_cost of [-1, 'x', null]) expect(await failCode(save(officer, { lines: [{ product_id: p.id, quantity: 1, unit_cost }] }))).toBe('22023')
    expect(await failCode(save(officer, { lines: [{ product_id: p.id, quantity: 1, unit_cost: 1.123456 }] }))).toBe('22023')
    expect(await failCode(save(officer, { lines: [{ product_id: p.id, quantity: 1, unit_cost: 1 }, { product_id: p.id, quantity: 2, unit_cost: 1 }] }))).toBe('22023')
    expect(await failCode(save(officer, { lines: [{ product_id: p.id, product_unit_id: otherBox, quantity: 1, unit_cost: 1 }] }))).toBe('P0002')
    await admin.query(`update public.product_units set is_purchasable = false where id = $1`, [otherBox])
    expect(await failCode(save(officer, { lines: [{ product_id: other.id, product_unit_id: otherBox, quantity: 1, unit_cost: 1 }] }))).toBe('P0002')
  })

  it('refuses inactive suppliers, foreign suppliers, products and warehouses', async () => {
    const p = await addProduct(a.id)
    const pB = await addProduct(b.id)
    const inactive = await addSupplier(a.id)
    await admin.query(`update public.suppliers set is_active = false where id = $1`, [inactive])
    const supplierB = await addSupplier(b.id)
    const lines = [{ product_id: p.id, quantity: 1, unit_cost: 1 }]
    expect(await failCode(save(officer, { supplier: inactive, lines }))).toBe('P0002')
    expect(await failCode(save(officer, { supplier: supplierB, lines }))).toBe('P0002')
    expect(await failCode(save(officer, { wh: whB1, lines }))).toBe('P0002')
    expect(await failCode(save(officer, { lines: [{ product_id: pB.id, quantity: 1, unit_cost: 1 }] }))).toBe('P0002')
  })

  it('lets only a draft be edited', async () => {
    const p = await addProduct(a.id)
    const id = (await ok(save(officer, { lines: [{ product_id: p.id, quantity: 1, unit_cost: 1 }] }))).id
    await ok(submit(officer, id))
    expect(await failCode(save(officer, { id, lines: [{ product_id: p.id, quantity: 2, unit_cost: 1 }] }))).toBe('22023')
    expect((await polines(id))[0].quantity_ordered).toBe('1.000')
  })
})

describe('approval workflow', () => {
  it('needs purchasing.create to draft/submit and purchasing.approve to approve', async () => {
    const p = await addProduct(a.id)
    const lines = [{ product_id: p.id, quantity: 5, unit_cost: 2 }]
    expect(await failCode(save(storeman, { lines }))).toBe('42501')
    const id = (await ok(save(officer, { lines }))).id
    expect(await failCode(approve(manager, id))).toBe('22023')            // still a draft
    expect(await failCode(submit(storeman, id))).toBe('42501')
    await ok(submit(officer, id))
    expect(await failCode(approve(officer, id))).toBe('42501')             // officers cannot approve
    expect(await failCode(approve(storeman, id))).toBe('42501')
    await ok(approve(manager, id))
    expect(await poRow(id)).toMatchObject({ status: 'APPROVED', approved_by: manager })
    expect(await failCode(approve(manager, id))).toBe('22023')            // already approved
  })

  it('does not let someone approve their own order while another approver exists', async () => {
    const p = await addProduct(a.id)
    const id = (await ok(save(manager, { lines: [{ product_id: p.id, quantity: 1, unit_cost: 1 }] }))).id
    await ok(submit(manager, id))
    expect(await failCode(approve(manager, id))).toBe('42501')
    await ok(approve(a.ownerId, id)) // a different approver can
  })

  it('lets a sole approver approve their own order (otherwise a one-person company is stuck)', async () => {
    const solo = await createOrg('PUR-SOLO')
    const wh = await addWarehouse(solo.id, solo.hq, 'WS')
    const sup = await addSupplier(solo.id)
    const p = await addProduct(solo.id)
    const id = (await ok(save(solo.ownerId, { supplier: sup, wh, lines: [{ product_id: p.id, quantity: 1, unit_cost: 1 }] }))).id
    await ok(submit(solo.ownerId, id))
    await ok(approve(solo.ownerId, id))
    expect((await poRow(id)).status).toBe('APPROVED')
  })

  it('refuses approval when the supplier licence has expired or the supplier is inactive', async () => {
    const p = await addProduct(a.id)
    const lines = [{ product_id: p.id, quantity: 1, unit_cost: 1 }]
    const expired = await addSupplier(a.id)
    await admin.query(`update public.suppliers set licence_expiry = $2 where id = $1`, [expired, day(-1)])
    const id = (await ok(save(officer, { supplier: expired, lines }))).id
    await ok(submit(officer, id))
    const r = await approve(manager, id)
    expect(!r.ok && r.code).toBe('22023')
    expect(!r.ok && r.message).toMatch(/licence expired/)
    await admin.query(`update public.suppliers set licence_expiry = $2 where id = $1`, [expired, day(30)])
    await ok(approve(manager, id))

    const later = await addSupplier(a.id)
    const id2 = (await ok(save(officer, { supplier: later, lines }))).id
    await ok(submit(officer, id2))
    await admin.query(`update public.suppliers set is_active = false where id = $1`, [later])
    expect(await failCode(approve(manager, id2))).toBe('22023')
  })

  it('sends an order back with a reason, and cancels with a reason', async () => {
    const p = await addProduct(a.id)
    const lines = [{ product_id: p.id, quantity: 1, unit_cost: 1 }]
    const id = (await ok(save(officer, { lines }))).id
    await ok(submit(officer, id))
    expect(await failCode(reject(manager, id, ''))).toBe('22023')
    expect(await failCode(reject(officer, id, 'no'))).toBe('42501')
    await ok(reject(manager, id, 'Price too high'))
    expect(await poRow(id)).toMatchObject({ status: 'DRAFT', status_reason: 'Price too high' })
    await ok(save(officer, { id, lines: [{ product_id: p.id, quantity: 1, unit_cost: 0.5 }] }))
    expect((await poRow(id)).status_reason).toBeNull()

    expect(await failCode(cancel(officer, id, null))).toBe('22023')
    await ok(cancel(officer, id, 'Not needed'))
    expect(await poRow(id)).toMatchObject({ status: 'CANCELLED', status_reason: 'Not needed' })
    expect(await failCode(submit(officer, id))).toBe('22023')

    const approved = await approvedOrder()
    expect(await failCode(cancel(officer, approved.id, 'x'))).toBe('42501')   // cancelling an approved order needs approve rights
    await ok(cancel(manager, approved.id, 'Supplier withdrew'))
  })

  it('audits every status change with the actor and the reason', async () => {
    const o = await approvedOrder()
    await ok(cancel(manager, o.id, 'Audit me'))
    const rows = (await admin.query(
      `select action, actor_user_id, previous_values ->> 'status' as prev, new_values ->> 'status' as next, reason
         from public.audit_logs where entity_type = 'purchase_order' and entity_id = $1 order by created_at, id`, [o.id])).rows
    // created, total stamped, submitted, approved, cancelled
    expect(rows.map((r) => r.action)).toEqual(['purchase_order.created', ...Array(4).fill('purchase_order.updated')])
    const last = rows[rows.length - 1]
    expect(last).toMatchObject({ actor_user_id: manager, prev: 'APPROVED', next: 'CANCELLED', reason: 'Audit me' })
  })
})

describe('receiving goods', () => {
  it('receives part of an order into stock with batch and expiry, then the rest, completing the order', async () => {
    const o = await approvedOrder({ qty: 10 })
    const r1 = (await ok(receive(storeman, o.id, [{ po_line_id: o.lineId, quantity: 4, batch_number: 'ab-1', expiry_date: day(400) }], 'DN-100'))).r
    expect(r1).toMatchObject({ order_status: 'PARTIALLY_RECEIVED' })
    expect(r1.grn_number).toMatch(/^GRN-/)
    expect(r1.stock_document_number).toMatch(/^RCV-/)
    expect(await onHand(o.product.id)).toBe(56)           // 4 boxes x 14
    expect((await polines(o.id))[0].received_base).toBe('56.000')

    const r2 = (await ok(receive(storeman, o.id, [{ po_line_id: o.lineId, quantity: 6, batch_number: 'AB-2', expiry_date: day(500) }]))).r
    expect(r2.order_status).toBe('RECEIVED')
    expect(await onHand(o.product.id)).toBe(140)
    expect((await poRow(o.id)).status).toBe('RECEIVED')

    const grn = (await admin.query(`select * from public.goods_receipts where id = $1`, [r1.goods_receipt_id])).rows[0]
    expect(grn).toMatchObject({ delivery_note: 'DN-100', purchase_order_id: o.id, supplier_id: supplierA, received_by: storeman })
    const gl = (await admin.query(`select quantity_received, received_base, unit_cost_base, stock_status, batch_id from public.goods_receipt_lines where goods_receipt_id = $1`, [r1.goods_receipt_id])).rows
    expect(gl).toHaveLength(1)
    expect([Number(gl[0].quantity_received), Number(gl[0].received_base), Number(gl[0].unit_cost_base), gl[0].stock_status]).toEqual([4, 56, 6.107143, 'AVAILABLE'])
    expect(gl[0].batch_id).not.toBeNull()
    const doc = (await admin.query(`select document_type, source_type, source_id, reason_code from public.stock_documents where id = $1`, [grn.stock_document_id])).rows[0]
    expect(doc).toEqual({ document_type: 'RECEIPT', source_type: 'PURCHASE_ORDER', source_id: o.id, reason_code: 'RECEIPT' })
  })

  it('splits one order line over several batches in one receipt', async () => {
    const o = await approvedOrder({ qty: 10 })
    const r = (await ok(receive(storeman, o.id, [
      { po_line_id: o.lineId, quantity: 3, batch_number: 'S1', expiry_date: day(300) },
      { po_line_id: o.lineId, quantity: 7, batch_number: 'S2', expiry_date: day(310) },
    ]))).r
    expect(r.order_status).toBe('RECEIVED')
    expect((await admin.query(`select count(*)::int n from public.batches where product_id = $1`, [o.product.id])).rows[0].n).toBe(2)
    expect((await admin.query(`select count(*)::int n from public.goods_receipt_lines where goods_receipt_id = $1`, [r.goods_receipt_id])).rows[0].n).toBe(2)
  })

  it('refuses to receive more than was ordered, across lines and receipts, leaving nothing behind', async () => {
    const o = await approvedOrder({ qty: 10 })
    expect(await failCode(receive(storeman, o.id, [{ po_line_id: o.lineId, quantity: 11, batch_number: 'X', expiry_date: day(300) }]))).toBe('22023')
    expect(await failCode(receive(storeman, o.id, [
      { po_line_id: o.lineId, quantity: 6, batch_number: 'X1', expiry_date: day(300) },
      { po_line_id: o.lineId, quantity: 5, batch_number: 'X2', expiry_date: day(300) },
    ]))).toBe('22023')
    expect(await onHand(o.product.id)).toBe(0)
    expect((await polines(o.id))[0].received_base).toBe('0.000')
    expect((await poRow(o.id)).status).toBe('APPROVED')
    await ok(receive(storeman, o.id, [{ po_line_id: o.lineId, quantity: 10, batch_number: 'FULL', expiry_date: day(300) }]))
    expect(await failCode(receive(storeman, o.id, [{ po_line_id: o.lineId, quantity: 1, batch_number: 'MORE', expiry_date: day(300) }]))).toBe('22023') // already RECEIVED
  })

  it('is all-or-nothing: a bad second line rolls back the first', async () => {
    const o = await approvedOrder({ qty: 10 })
    const p2 = await addProduct(a.id)
    const id2 = (await ok(save(officer, { lines: [{ product_id: o.product.id, product_unit_id: o.box, quantity: 10, unit_cost: 1 }, { product_id: p2.id, quantity: 5, unit_cost: 1 }] }))).id
    await ok(submit(officer, id2)); await ok(approve(manager, id2))
    const [l1, l2] = await polines(id2)
    const before = (await admin.query(`select count(*)::int n from public.goods_receipts where purchase_order_id = $1`, [id2])).rows[0].n
    const r = await receive(storeman, id2, [
      { po_line_id: l1.id, quantity: 2, batch_number: 'GOOD', expiry_date: day(300) },
      { po_line_id: l2.id, quantity: 5 },   // tracked product without batch/expiry
    ])
    expect(r.ok).toBe(false)
    expect(await onHand(o.product.id)).toBe(0)
    expect((await polines(id2)).map((l) => l.received_base)).toEqual(['0.000', '0.000'])
    expect((await admin.query(`select count(*)::int n from public.goods_receipts where purchase_order_id = $1`, [id2])).rows[0].n).toBe(before)
    expect((await poRow(id2)).status).toBe('APPROVED')
  })

  it('routes doubtful goods to QUARANTINE or DAMAGED on arrival, and refuses expired goods as AVAILABLE', async () => {
    const o = await approvedOrder({ qty: 10 })
    expect(await failCode(receive(storeman, o.id, [{ po_line_id: o.lineId, quantity: 1, batch_number: 'OLD', expiry_date: day(-3) }]))).toBe('22023')
    expect(await failCode(receive(storeman, o.id, [{ po_line_id: o.lineId, quantity: 1, batch_number: 'Y', expiry_date: day(300), status: 'EXPIRED' }]))).toBe('22023')
    await ok(receive(storeman, o.id, [
      { po_line_id: o.lineId, quantity: 6, batch_number: 'GOOD', expiry_date: day(300) },
      { po_line_id: o.lineId, quantity: 2, batch_number: 'HOLD', expiry_date: day(300), status: 'QUARANTINE' },
      { po_line_id: o.lineId, quantity: 1, batch_number: 'BROKEN', expiry_date: day(300), status: 'DAMAGED' },
      { po_line_id: o.lineId, quantity: 1, batch_number: 'OLD', expiry_date: day(-3), status: 'QUARANTINE' },
    ]))
    expect(await onHand(o.product.id, 'AVAILABLE')).toBe(84)
    expect(await onHand(o.product.id, 'QUARANTINE')).toBe(42)
    expect(await onHand(o.product.id, 'DAMAGED')).toBe(14)
    expect((await poRow(o.id)).status).toBe('RECEIVED')
  })

  it('can receive in a different pack level than ordered, and into a location', async () => {
    const o = await approvedOrder({ qty: 2 })     // 28 tablets
    const loc = await addLocation(a.id, whA1, `L${Math.random().toString(36).slice(2, 6).toUpperCase()}`)
    await ok(receive(storeman, o.id, [{ po_line_id: o.lineId, product_unit_id: null, quantity: 1, batch_number: 'LOC', expiry_date: day(300), location_id: loc }]))
    const tablet = (await admin.query(`select id from public.product_units where product_id = $1 and is_base`, [o.product.id])).rows[0].id
    await ok(receive(storeman, o.id, [{ po_line_id: o.lineId, product_unit_id: tablet, quantity: 14, batch_number: 'LOC', expiry_date: day(300) }]))
    expect(await onHand(o.product.id)).toBe(28)
    expect((await poRow(o.id)).status).toBe('RECEIVED')
    expect((await admin.query(`select count(*)::int n from public.stock_balances where product_id = $1 and location_id = $2 and quantity = 14`, [o.product.id, loc])).rows[0].n).toBe(1)
  })

  it('needs purchasing.receive and an approved order', async () => {
    const o = await approvedOrder()
    const line = [{ po_line_id: o.lineId, quantity: 1, batch_number: 'P', expiry_date: day(300) }]
    expect(await failCode(receive(officer, o.id, line))).toBe('42501')
    expect(await failCode(receive(manager, o.id, line))).toBe('42501')
    const draftProduct = await addProduct(a.id)
    const draft = (await ok(save(officer, { lines: [{ product_id: draftProduct.id, quantity: 1, unit_cost: 1 }] }))).id
    const [dl] = await polines(draft)
    expect(await failCode(receive(storeman, draft, [{ po_line_id: dl.id, quantity: 1, batch_number: 'P', expiry_date: day(300) }]))).toBe('22023')
    expect(await failCode(receive(storeman, o.id, [{ po_line_id: dl.id, quantity: 1, batch_number: 'P', expiry_date: day(300) }]))).toBe('P0002') // line of another order
    expect(await failCode(receive(storeman, o.id, []))).toBe('22023')
    await ok(receive(storeman, o.id, line))
  })

  it('does not allow cancelling after goods arrived, but allows closing a part-delivered order', async () => {
    const o = await approvedOrder({ qty: 10 })
    await ok(receive(storeman, o.id, [{ po_line_id: o.lineId, quantity: 4, batch_number: 'C1', expiry_date: day(300) }]))
    expect(await failCode(cancel(manager, o.id, 'x'))).toBe('22023')
    expect(await failCode(close(officer, o.id, 'x'))).toBe('42501')
    expect(await failCode(close(manager, o.id, ''))).toBe('22023')
    await ok(close(manager, o.id, 'Supplier cannot deliver the rest'))
    expect(await poRow(o.id)).toMatchObject({ status: 'CLOSED' })
    expect(await failCode(receive(storeman, o.id, [{ po_line_id: o.lineId, quantity: 1, batch_number: 'C2', expiry_date: day(300) }]))).toBe('22023')
  })

  it('lets exactly one of two simultaneous full receipts succeed', async () => {
    const o = await approvedOrder({ qty: 10 })
    const full = (n: string) => receive(storeman, o.id, [{ po_line_id: o.lineId, quantity: 10, batch_number: n, expiry_date: day(300) }])
    const results = await Promise.all([full('R1'), full('R2'), full('R3')])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(await onHand(o.product.id)).toBe(140)
    expect((await polines(o.id))[0].received_base).toBe('140.000')
  })

  it('keeps the stock ledger reconciled with the balances and refuses RECEIPT through the public posting function', async () => {
    const o = await approvedOrder({ qty: 3 })
    await ok(receive(storeman, o.id, [{ po_line_id: o.lineId, quantity: 3, batch_number: 'REC', expiry_date: day(300) }]))
    const direct = await call(a.ownerId, `select public.post_stock_document('RECEIPT', $1, $2::jsonb)`, [whA1, JSON.stringify([{ product_id: o.product.id, quantity: 1, batch_number: 'Z', expiry_date: day(300) }])])
    expect(!direct.ok && direct.code).toBe('42501')
    const { rows } = await admin.query(`
      with led as (select organization_id, warehouse_id, location_id, product_id, batch_id, stock_status, sum(quantity) q from public.stock_movements group by 1,2,3,4,5,6)
      select count(*)::int n from led full join public.stock_balances b
        on b.organization_id = led.organization_id and b.warehouse_id = led.warehouse_id and b.location_id is not distinct from led.location_id
       and b.product_id = led.product_id and b.batch_id is not distinct from led.batch_id and b.stock_status = led.stock_status
      where coalesce(b.quantity, 0) <> coalesce(led.q, 0)`)
    expect(rows[0].n).toBe(0)
  })
})

describe('scope, isolation and immutability', () => {
  it('scopes orders and receipts to the branch of the delivery warehouse', async () => {
    const mgr2 = await addUser(a.id, 'PROCUREMENT_MANAGER', branch2)
    const store2 = await addUser(a.id, 'WAREHOUSE_MANAGER', branch2)
    const hq = await approvedOrder({ wh: whA1 })
    const br = await approvedOrder({ wh: whA3 })
    await withUser(mgr2, async (c) => {
      const seen = (await c.q(`select id from public.purchase_orders where id = any($1)`, [[hq.id, br.id]])).rows.map((r) => r.id)
      expect(seen).toEqual([br.id])
      expect((await c.q(`select count(*)::int n from public.purchase_order_lines where purchase_order_id = $1`, [hq.id])).rows[0].n).toBe(0)
    })
    const p = await addProduct(a.id)
    expect(await failCode(save(mgr2, { wh: whA1, lines: [{ product_id: p.id, quantity: 1, unit_cost: 1 }] }))).toBe('42501')
    expect(await failCode(approve(mgr2, hq.id))).toBe('42501')   // another branch's order
    expect(await failCode(receive(store2, hq.id, [{ po_line_id: hq.lineId, quantity: 1, batch_number: 'N', expiry_date: day(300) }]))).toBe('42501')
    await ok(receive(store2, br.id, [{ po_line_id: br.lineId, quantity: 1, batch_number: 'N', expiry_date: day(300) }]))
    await withUser(mgr2, async (c) => {
      expect((await c.q(`select count(*)::int n from public.goods_receipts`)).rows[0].n).toBeGreaterThanOrEqual(1)
      expect((await c.q(`select count(*)::int n from public.goods_receipts where purchase_order_id = $1`, [hq.id])).rows[0].n).toBe(0)
    })
  })

  it('hides everything from other tenants and users without purchasing.view', async () => {
    const o = await approvedOrder()
    await ok(receive(storeman, o.id, [{ po_line_id: o.lineId, quantity: 1, batch_number: 'ISO', expiry_date: day(300) }]))
    await withUser(b.ownerId, async (c) => {
      for (const t of ['purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines']) {
        expect((await c.q(`select count(*)::int n from public.${t}`)).rows[0].n, t).toBe(0)
      }
    })
    const cashier = await addUser(a.id, 'CASHIER')
    await withUser(cashier, async (c) => {
      expect((await c.q(`select count(*)::int n from public.purchase_orders`)).rows[0].n).toBe(0)
    })
    // another tenant's owner cannot act on the order either
    expect(await failCode(approve(b.ownerId, o.id))).toBe('P0002')
    expect(await failCode(receive(b.ownerId, o.id, [{ po_line_id: o.lineId, quantity: 1 }]))).toBe('P0002')
  })

  it('gives clients no direct write access; receipts and lines cannot be changed even by the database owner', async () => {
    const o = await approvedOrder()
    const r = (await ok(receive(storeman, o.id, [{ po_line_id: o.lineId, quantity: 1, batch_number: 'IMM', expiry_date: day(300) }]))).r
    await withUser(manager, async (c) => {
      for (const s of [
        `update public.purchase_orders set status = 'RECEIVED' where id = '${o.id}'`,
        `update public.purchase_orders set total_amount = 1 where id = '${o.id}'`,
        `delete from public.purchase_orders where id = '${o.id}'`,
        `update public.purchase_order_lines set received_base = 140 where id = '${o.lineId}'`,
        `update public.purchase_order_lines set unit_cost = 0 where id = '${o.lineId}'`,
        `delete from public.purchase_order_lines where id = '${o.lineId}'`,
        `insert into public.purchase_orders (po_number, supplier_id, branch_id, warehouse_id, currency_code) values ('X', '${supplierA}', '${a.hq}', '${whA1}', 'GHS')`,
        `update public.goods_receipts set notes = 'x' where id = '${r.goods_receipt_id}'`,
        `delete from public.goods_receipt_lines where goods_receipt_id = '${r.goods_receipt_id}'`,
      ]) {
        const out = await c.attempt(s)
        expect(out.ok, s).toBe(false)
        if (!out.ok) expect(out.code, s).toBe('42501')
      }
    })
    for (const s of [
      `update public.goods_receipts set notes = 'edited' where id = '${r.goods_receipt_id}'`,
      `delete from public.goods_receipt_lines where goods_receipt_id = '${r.goods_receipt_id}'`,
      `truncate public.goods_receipts cascade`,
    ]) {
      await expect(admin.query(s), s).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('keeps the order number and organization immutable', async () => {
    const p = await addProduct(a.id)
    const id = (await ok(save(officer, { lines: [{ product_id: p.id, quantity: 1, unit_cost: 1 }] }))).id
    await expect(admin.query(`update public.purchase_orders set po_number = 'HACK' where id = $1`, [id])).rejects.toMatchObject({ code: '23514' })
    await expect(admin.query(`update public.purchase_orders set organization_id = $2 where id = $1`, [id, b.id])).rejects.toBeTruthy()
  })

  it('denies anonymous callers every purchasing function', async () => {
    for (const sql of [
      `select public.save_purchase_order(null, null, null, null, null, '[]'::jsonb)`,
      `select public.submit_purchase_order('00000000-0000-0000-0000-000000000000')`,
      `select public.approve_purchase_order('00000000-0000-0000-0000-000000000000')`,
      `select public.receive_goods('00000000-0000-0000-0000-000000000000', '[]'::jsonb)`,
    ]) {
      const out = await withUser(null, (c) => c.attempt(sql))
      expect(out.ok, sql).toBe(false)
      if (!out.ok) expect(out.code, sql).toBe('42501')
    }
  })
})
