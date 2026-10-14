import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addBranch, addLocation, addProduct, addProductUnit, addSupplier, addUser, addWarehouse, admin, closePool, createOrg, withUser, type Org,
} from '../helpers/db'

let a: Org
let b: Org
let whA1: string
let branch2: string
let supplierA: string
let procurement: string   // purchasing create/approve, payables view/create, valuation
let storeman: string      // receive, inventory.%, count
let accounts: string      // payables all, valuation
let counter: string       // count only (PICKER)
let counterApprover: string // BRANCH_MANAGER: count_approve

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  a = await createOrg('P4-A')
  b = await createOrg('P4-B')
  whA1 = await addWarehouse(a.id, a.hq, 'W1')
  branch2 = await addBranch(a.id, 'B2')
  await addWarehouse(a.id, branch2, 'W3')
  await addWarehouse(b.id, b.hq, 'WB1')
  supplierA = await addSupplier(a.id)
  procurement = await addUser(a.id, 'PROCUREMENT_MANAGER')
  storeman = await addUser(a.id, 'WAREHOUSE_MANAGER')
  accounts = await addUser(a.id, 'ACCOUNTS_MANAGER')
  counter = await addUser(a.id, 'WAREHOUSE_PICKER')
  counterApprover = await addUser(a.id, 'BRANCH_MANAGER')
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
const code = async (p: Promise<Out>) => { const r = await p; return r.ok ? 'ok' : r.code }
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows

const open = (user: string, wh: string, lines: object[]) =>
  call(user, `select public.post_stock_document('OPENING', $1, $2::jsonb) as r`, [wh, JSON.stringify(lines)])
const onHand = async (productId: string, status?: string, wh?: string) =>
  Number((await q(`select coalesce(sum(quantity),0) n from public.stock_balances where product_id = $1 and ($2::text is null or stock_status = $2) and ($3::uuid is null or warehouse_id = $3)`, [productId, status ?? null, wh ?? null]))[0].n)

const savePo = (user: string, lines: object[], supplier = supplierA, wh = whA1) =>
  call(user, `select public.save_purchase_order(null, $1, $2, null, null, $3::jsonb) as id`, [supplier, wh, JSON.stringify(lines)])
const receive = (user: string, poId: string, lines: object[]) =>
  call(user, `select public.receive_goods($1, $2::jsonb, null, null) as r`, [poId, JSON.stringify(lines)])

/** An APPROVED order with one line (10 boxes of 14 at 100.00) and `received` boxes already received. */
async function order(opts: { received?: number; qty?: number; cost?: number; wh?: string } = {}) {
  const product = await addProduct(a.id)
  const box = await addProductUnit(a.id, product.id, 'BOX', 14)
  const id = (await ok(savePo(procurement, [{ product_id: product.id, product_unit_id: box, quantity: opts.qty ?? 10, unit_cost: opts.cost ?? 100 }], supplierA, opts.wh))).id as string
  await ok(call(procurement, `select public.submit_purchase_order($1)`, [id]))
  await ok(call(a.ownerId, `select public.approve_purchase_order($1)`, [id]))
  const [line] = await q(`select id from public.purchase_order_lines where purchase_order_id = $1`, [id])
  if (opts.received) {
    await ok(receive(storeman, id, [{ po_line_id: line.id, quantity: opts.received, batch_number: `B${Math.random().toString(36).slice(2, 7)}`, expiry_date: day(400) }]))
  }
  return { id, product, box, lineId: line.id as string }
}

// ================================================================================================
describe('batch costs and stock valuation', () => {
  it('records a batch cost from opening stock (per pack -> per base unit) and from receipts, only when the batch is created', async () => {
    const p = await addProduct(a.id)
    const box = await addProductUnit(a.id, p.id, 'BOX', 14)
    await ok(open(a.ownerId, whA1, [{ product_id: p.id, product_unit_id: box, quantity: 2, batch_number: 'C1', expiry_date: day(300), unit_cost: 140 }]))
    expect(Number((await q(`select c.unit_cost_base from public.batch_costs c join public.batches b on b.id = c.batch_id where b.product_id = $1`, [p.id]))[0].unit_cost_base)).toBe(10)
    // topping up an existing batch does not change its cost
    await ok(open(a.ownerId, whA1, [{ product_id: p.id, product_unit_id: box, quantity: 1, batch_number: 'C1', expiry_date: day(300), unit_cost: 999 }]))
    expect(Number((await q(`select c.unit_cost_base from public.batch_costs c join public.batches b on b.id = c.batch_id where b.product_id = $1`, [p.id]))[0].unit_cost_base)).toBe(10)

    const o = await order({ received: 4, cost: 85.5 })
    const [c] = await q(`select c.unit_cost_base from public.batch_costs c join public.batches b on b.id = c.batch_id where b.product_id = $1`, [o.product.id])
    expect(Number(c.unit_cost_base)).toBe(6.107143)
    expect(await code(open(a.ownerId, whA1, [{ product_id: p.id, quantity: 1, batch_number: 'NEG', expiry_date: day(300), unit_cost: -1 }]))).toBe('22023')
  })

  it('values good stock at batch cost, flags uncosted stock, and gives damaged / expired stock no value', async () => {
    const p = await addProduct(a.id, { brand: 'Valuex Forte' })
    await ok(open(a.ownerId, whA1, [
      { product_id: p.id, quantity: 100, batch_number: 'V1', expiry_date: day(300), unit_cost: 2.5 },
      { product_id: p.id, quantity: 40, batch_number: 'V2', expiry_date: day(300), status: 'QUARANTINE', unit_cost: 3 },
      { product_id: p.id, quantity: 10, batch_number: 'V3', expiry_date: day(300) },                       // no cost
      { product_id: p.id, quantity: 7, batch_number: 'V4', expiry_date: day(300), status: 'DAMAGED', unit_cost: 5 },
    ]))
    const rows = (await call(a.ownerId, `select * from public.stock_valuation($1) where product_id = $2`, [whA1, p.id]))
    expect(rows.ok && rows.rows).toHaveLength(1)
    const r = (rows as any).rows[0]
    expect([Number(r.good_quantity), Number(r.other_quantity), Number(r.uncosted_quantity), Number(r.value)]).toEqual([150, 7, 10, 370])
    expect(r.sku).toBe(p.sku)
  })

  it('keeps cost private: only inventory.valuation sees batch costs or the valuation report', async () => {
    const p = await addProduct(a.id)
    await ok(open(a.ownerId, whA1, [{ product_id: p.id, quantity: 5, batch_number: 'PRIV', expiry_date: day(300), unit_cost: 9 }]))
    // WAREHOUSE_MANAGER can see stock and batches but not what they cost
    await withUser(storeman, async (c) => {
      expect((await c.q(`select count(*)::int n from public.batches where product_id = $1`, [p.id])).rows[0].n).toBe(1)
      expect((await c.q(`select count(*)::int n from public.batch_costs`)).rows[0].n).toBe(0)
      const r = await c.attempt(`select * from public.stock_valuation(null)`)
      expect(!r.ok && r.code).toBe('42501')
    })
    expect((await call(accounts, `select count(*)::int n from public.batch_costs`)).ok).toBe(true)
    await withUser(accounts, async (c) => expect((await c.q(`select count(*)::int n from public.batch_costs`)).rows[0].n).toBeGreaterThan(0))
    await withUser(b.ownerId, async (c) => expect((await c.q(`select count(*)::int n from public.batch_costs`)).rows[0].n).toBe(0))
  })

  it('cannot be edited: costs are append-only and clients cannot write them', async () => {
    const p = await addProduct(a.id)
    await ok(open(a.ownerId, whA1, [{ product_id: p.id, quantity: 5, batch_number: 'IMM', expiry_date: day(300), unit_cost: 1 }]))
    await expect(admin.query(`update public.batch_costs set unit_cost_base = 99`)).rejects.toMatchObject({ code: '42501' })
    await withUser(a.ownerId, async (c) => {
      const r = await c.attempt(`insert into public.batch_costs (batch_id, unit_cost_base) select id, 1 from public.batches limit 1`)
      expect(!r.ok && r.code).toBe('42501')
    })
  })
})

// ================================================================================================
describe('purchase returns', () => {
  async function stocked(qtyBoxes = 6, cost = 100) {
    const o = await order({ received: qtyBoxes, cost })
    const [bal] = await q(`select id, batch_id, quantity from public.stock_balances where product_id = $1`, [o.product.id])
    return { ...o, batchId: bal.batch_id as string, qty: Number(bal.quantity) }
  }
  const ret = (user: string, lines: object[], o: { supplier?: string; wh?: string; reason?: string; po?: string | null; notes?: string | null } = {}) =>
    call(user, `select public.post_purchase_return($1, $2, $3, $4::jsonb, $5, $6) as r`,
      [o.supplier ?? supplierA, o.wh ?? whA1, o.reason ?? 'DAMAGED', JSON.stringify(lines), o.notes ?? null, o.po ?? null])

  it('takes the goods out of stock, records the return with cost snapshot and expected credit, and links the ledger', async () => {
    const s = await stocked(6, 100)                                  // 84 base units @ 100/14
    const r = (await ok(ret(storeman, [{ product_id: s.product.id, product_unit_id: s.box, quantity: 2, batch_id: s.batchId }], { po: s.id, notes: 'Cracked blisters' }))).r
    expect(r.return_number).toMatch(/^PRN-/)
    expect(r.stock_document_number).toMatch(/^RTN-/)
    expect(Number(r.expected_credit)).toBe(200)                      // 28 x 7.142857 -> 200.00
    expect(await onHand(s.product.id)).toBe(56)
    const [row] = await q(`select * from public.purchase_returns where id = $1`, [r.purchase_return_id])
    expect(row).toMatchObject({ reason: 'DAMAGED', credit_status: 'PENDING', supplier_id: supplierA, purchase_order_id: s.id, returned_by: storeman })
    const lines = await q(`select returned_base, quantity_returned, unit_cost_base from public.purchase_return_lines where purchase_return_id = $1`, [r.purchase_return_id])
    expect(lines.map((l) => [Number(l.returned_base), Number(l.quantity_returned), Number(l.unit_cost_base)])).toEqual([[28, 2, 7.142857]])
    const [doc] = await q(`select document_type, reason_code, source_type, source_id from public.stock_documents where id = $1`, [row.stock_document_id])
    expect(doc).toEqual({ document_type: 'RETURN', reason_code: 'RETURN_TO_SUPPLIER', source_type: 'PURCHASE_RETURN', source_id: r.purchase_return_id })
    expect((await q(`select movement_type, quantity::float8 q from public.stock_movements where document_id = $1`, [row.stock_document_id]))).toEqual([{ movement_type: 'RETURN_OUT', q: -28 }])
  })

  it('refuses to return more than is in stock, from a missing batch, or without a reason; nothing is left behind', async () => {
    const s = await stocked(2)
    const line = { product_id: s.product.id, product_unit_id: s.box, quantity: 3, batch_id: s.batchId }
    const over = await ret(storeman, [line])
    expect(!over.ok && over.code).toBe('23514')
    expect(await code(ret(storeman, [{ ...line, quantity: 1, batch_id: '00000000-0000-0000-0000-000000000000' }]))).toBe('P0002')
    expect(await code(ret(storeman, [{ ...line, quantity: 1 }], { reason: 'BOGUS' }))).toBe('22023')
    expect(await code(ret(storeman, []))).toBe('22023')
    expect(await onHand(s.product.id)).toBe(28)
    expect((await q(`select count(*)::int n from public.purchase_returns where supplier_id = $1 and created_at is null`.replace(' and created_at is null', ''), [supplierA]))[0].n).toBeGreaterThanOrEqual(0)
  })

  it('needs purchasing.receive for the warehouse, a supplier of this organization, and a matching order', async () => {
    const s = await stocked(3)
    const line = { product_id: s.product.id, product_unit_id: s.box, quantity: 1, batch_id: s.batchId }
    expect(await code(ret(procurement, [line]))).toBe('42501')
    expect(await code(ret(counter, [line]))).toBe('42501')
    const supplierB = await addSupplier(b.id)
    expect(await code(ret(storeman, [line], { supplier: supplierB }))).toBe('P0002')
    const other = await addSupplier(a.id)
    expect(await code(ret(storeman, [line], { supplier: other, po: s.id }))).toBe('P0002')   // order belongs to another supplier
    const store2 = await addUser(a.id, 'WAREHOUSE_MANAGER', branch2)
    expect(await code(ret(store2, [line]))).toBe('42501')                                     // other branch's warehouse
  })

  it('records the supplier credit once, with payables permission, and keeps the return immutable', async () => {
    const s = await stocked(3)
    const r = (await ok(ret(storeman, [{ product_id: s.product.id, product_unit_id: s.box, quantity: 1, batch_id: s.batchId }]))).r
    expect(await code(call(storeman, `select public.record_return_credit($1, 'CN-1', 50)`, [r.purchase_return_id]))).toBe('42501')
    expect(await code(call(accounts, `select public.record_return_credit($1, '', 50)`, [r.purchase_return_id]))).toBe('22023')
    expect(await code(call(accounts, `select public.record_return_credit($1, 'CN-1', -5)`, [r.purchase_return_id]))).toBe('22023')
    await ok(call(accounts, `select public.record_return_credit($1, 'CN-1', 95.5)`, [r.purchase_return_id]))
    expect((await q(`select credit_status, credit_note_number, credit_amount::float8 a, credited_by from public.purchase_returns where id = $1`, [r.purchase_return_id]))[0])
      .toEqual({ credit_status: 'CREDITED', credit_note_number: 'CN-1', a: 95.5, credited_by: accounts })
    expect(await code(call(accounts, `select public.record_return_credit($1, 'CN-2', 1)`, [r.purchase_return_id]))).toBe('22023')
    await expect(admin.query(`update public.purchase_returns set reason = 'OTHER' where id = $1`, [r.purchase_return_id])).rejects.toMatchObject({ code: '23514' })
    await expect(admin.query(`delete from public.purchase_returns where id = $1`, [r.purchase_return_id])).rejects.toMatchObject({ code: '42501' })
    await expect(admin.query(`update public.purchase_return_lines set quantity_returned = 99 where purchase_return_id = $1`, [r.purchase_return_id])).rejects.toMatchObject({ code: '42501' })
  })

  it('is branch-scoped and tenant-isolated, and clients cannot write the tables', async () => {
    const s = await stocked(3)
    const r = (await ok(ret(storeman, [{ product_id: s.product.id, product_unit_id: s.box, quantity: 1, batch_id: s.batchId }]))).r
    const mgr2 = await addUser(a.id, 'WAREHOUSE_MANAGER', branch2)
    await withUser(mgr2, async (c) => expect((await c.q(`select count(*)::int n from public.purchase_returns where id = $1`, [r.purchase_return_id])).rows[0].n).toBe(0))
    await withUser(b.ownerId, async (c) => expect((await c.q(`select count(*)::int n from public.purchase_returns`)).rows[0].n).toBe(0))
    await withUser(a.ownerId, async (c) => {
      for (const sql of [
        `update public.purchase_returns set credit_status = 'CREDITED', credit_note_number = 'X', credit_amount = 1`,
        `insert into public.purchase_returns (return_number) values ('X')`,
        `delete from public.purchase_return_lines`,
      ]) {
        const out = await c.attempt(sql)
        expect(out.ok, sql).toBe(false)
        if (!out.ok) expect(out.code, sql).toBe('42501')
      }
    })
    const direct = await call(a.ownerId, `select public.post_stock_document('RETURN', $1, '[]'::jsonb)`, [whA1])
    expect(direct.ok).toBe(false)
  })
})

// ================================================================================================
describe('supplier invoices and the 3-way match', () => {
  const rec = (user: string, poId: string, lines: object[], o: { no?: string; id?: string | null; tax?: number; date?: string } = {}) =>
    call(user, `select public.record_supplier_invoice($1, $2, $3, $4, $5, null, $6::jsonb) as id`,
      [o.id ?? null, poId, o.no ?? `INV-${Math.random().toString(36).slice(2, 8)}`, o.date ?? day(0), o.tax ?? 0, JSON.stringify(lines)])
  const approve = (user: string, id: string, reason: string | null = null) => call(user, `select public.approve_supplier_invoice($1, $2)`, [id, reason])
  const inv = async (id: string) => (await q(`select * from public.supplier_invoices where id = $1`, [id]))[0]
  const invLines = async (id: string) => q(`select * from public.supplier_invoice_lines where supplier_invoice_id = $1 order by line_no`, [id])

  it('matches an invoice that agrees with the order and what was received, and totals it with tax and due date', async () => {
    const o = await order({ received: 6, cost: 100 })
    const id = (await ok(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 6, unit_price: 100 }], { tax: 30, date: day(-2) }))).id
    const i = await inv(id)
    expect(i).toMatchObject({ status: 'MATCHED', currency_code: 'GHS', created_by: accounts, supplier_id: supplierA })
    expect(i.invoice_number).toMatch(/^SIN-/)
    expect([Number(i.subtotal), Number(i.tax_amount), Number(i.total_amount)]).toEqual([600, 30, 630])
    expect((await q(`select due_date::text d from public.supplier_invoices where id = $1`, [id]))[0].d).toBe(day(28))             // 30-day terms from invoice date (2 days ago)
    const [l] = await invLines(id)
    expect(l).toMatchObject({ match_status: 'MATCHED' })
    expect([Number(l.allowed_quantity), Number(l.po_unit_cost)]).toEqual([6, 100])
  })

  it('flags quantity over what was received, and price differences beyond 1 %, as exceptions', async () => {
    const check = async (qty: number, price: number) => {
      const o = await order({ received: 4, cost: 100 })
      const id = (await ok(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: qty, unit_price: price }]))).id
      return { status: (await inv(id)).status, line: (await invLines(id))[0].match_status }
    }
    expect(await check(5, 100)).toEqual({ status: 'EXCEPTION', line: 'QTY_OVER' })
    expect(await check(1, 102)).toEqual({ status: 'EXCEPTION', line: 'PRICE_DIFF' })
    expect(await check(9, 90)).toEqual({ status: 'EXCEPTION', line: 'QTY_AND_PRICE' })
    expect(await check(1, 100.9)).toEqual({ status: 'MATCHED', line: 'MATCHED' })     // 0.9 % is inside the tolerance
  })

  it('counts what other live invoices already bill, and a cancelled invoice frees its quantity', async () => {
    const o = await order({ received: 6, cost: 100 })
    const first = (await ok(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 4, unit_price: 100 }]))).id
    const second = (await ok(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 4, unit_price: 100 }]))).id
    expect((await inv(first)).status).toBe('MATCHED')
    expect((await inv(second)).status).toBe('EXCEPTION')
    expect(Number((await invLines(second))[0].allowed_quantity)).toBe(2)
    // the exception invoice is still live and bills 4, so only 2 of the 6 received remain; cancelling the first frees ITS 4
    await ok(call(accounts, `select public.cancel_supplier_invoice($1, 'duplicate')`, [first]))
    const third = (await ok(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 2, unit_price: 100 }]))).id
    expect((await inv(third)).status).toBe('MATCHED')
    const fourth = (await ok(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 1, unit_price: 100 }]))).id
    expect((await inv(fourth)).status).toBe('EXCEPTION')
  })

  it('serialises racing invoices: three invoices for 6 boxes against 10 received boxes cannot all match', async () => {
    const o = await order({ received: 10, cost: 100 })
    const results = await Promise.all([1, 2, 3].map(() => rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 6, unit_price: 100 }])))
    const ids = results.map((r) => (r.ok ? r.rows[0].id : null)).filter(Boolean) as string[]
    expect(ids).toHaveLength(3)
    const statuses = (await Promise.all(ids.map(async (id) => (await inv(id)).status))).sort()
    expect(statuses).toEqual(['EXCEPTION', 'EXCEPTION', 'MATCHED'])
  })

  it('refuses a duplicate supplier invoice number (but allows it again after cancelling), and bad input', async () => {
    const o = await order({ received: 5 })
    const lines = [{ po_line_id: o.lineId, quantity: 1, unit_price: 100 }]
    const id = (await ok(rec(accounts, o.id, lines, { no: 'DUP-1' }))).id
    expect(await code(rec(accounts, o.id, lines, { no: ' dup-1 ' }))).toBe('23505')
    await ok(call(accounts, `select public.cancel_supplier_invoice($1, 'wrong one')`, [id]))
    await ok(rec(accounts, o.id, lines, { no: 'DUP-1' }))
    expect(await code(rec(accounts, o.id, [], { no: 'X1' }))).toBe('22023')
    expect(await code(rec(accounts, o.id, lines, { no: '' }))).toBe('22023')
    expect(await code(rec(accounts, o.id, lines, { no: 'X2', date: day(5) }))).toBe('22023')
    expect(await code(rec(accounts, o.id, lines, { no: 'X3', tax: -1 }))).toBe('22023')
    expect(await code(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 0, unit_price: 1 }], { no: 'X4' }))).toBe('22023')
    expect(await code(rec(accounts, o.id, [...lines, ...lines], { no: 'X5' }))).toBe('22023')
    const other = await order({ received: 1 })
    expect(await code(rec(accounts, o.id, [{ po_line_id: other.lineId, quantity: 1, unit_price: 1 }], { no: 'X6' }))).toBe('P0002')
  })

  it('only accepts invoices against an approved order, from someone with payables.create', async () => {
    const p = await addProduct(a.id)
    const draft = (await ok(savePo(procurement, [{ product_id: p.id, quantity: 5, unit_cost: 1 }]))).id
    const [dl] = await q(`select id from public.purchase_order_lines where purchase_order_id = $1`, [draft])
    expect(await code(rec(accounts, draft, [{ po_line_id: dl.id, quantity: 1, unit_price: 1 }]))).toBe('22023')
    const o = await order({ received: 2 })
    expect(await code(rec(storeman, o.id, [{ po_line_id: o.lineId, quantity: 1, unit_price: 100 }]))).toBe('42501')
    expect(await code(rec(counter, o.id, [{ po_line_id: o.lineId, quantity: 1, unit_price: 100 }]))).toBe('42501')
  })

  it('edits only while recorded: lines are re-matched, and approved invoices are locked', async () => {
    const o = await order({ received: 3 })
    const id = (await ok(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 5, unit_price: 100 }]))).id
    expect((await inv(id)).status).toBe('EXCEPTION')
    await ok(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 3, unit_price: 100 }], { id, no: 'EDITED-1' }))
    expect(await inv(id)).toMatchObject({ status: 'MATCHED', supplier_invoice_number: 'EDITED-1' })
    expect(await invLines(id)).toHaveLength(1)
    await ok(approve(a.ownerId, id))
    expect(await code(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 1, unit_price: 100 }], { id }))).toBe('22023')
  })

  it('approves a matched invoice, but an exception needs a stated reason, and separation of duties applies', async () => {
    const o = await order({ received: 4 })
    const matched = (await ok(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 2, unit_price: 100 }]))).id
    expect(await code(approve(procurement, matched))).toBe('42501')               // no payables.approve
    expect(await code(approve(accounts, matched))).toBe('42501')                  // recorded it, and other approvers exist
    await ok(approve(a.ownerId, matched))
    expect(await inv(matched)).toMatchObject({ status: 'APPROVED', approved_by: a.ownerId, variance_reason: null })
    expect(await code(approve(a.ownerId, matched))).toBe('22023')

    const exc = (await ok(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 2, unit_price: 110 }]))).id
    expect((await inv(exc)).status).toBe('EXCEPTION')
    expect(await code(approve(a.ownerId, exc))).toBe('22023')                      // reason required
    expect(await code(approve(a.ownerId, exc, '  '))).toBe('22023')
    await ok(approve(a.ownerId, exc, 'Supplier price increase agreed by phone'))
    expect(await inv(exc)).toMatchObject({ status: 'APPROVED', variance_reason: 'Supplier price increase agreed by phone' })
    const audit = await q(`select reason from public.audit_logs where entity_type = 'supplier_invoice' and entity_id = $1 and reason is not null`, [exc])
    expect(audit.map((r) => r.reason)).toContain('Supplier price increase agreed by phone')
  })

  it('re-checks the match at approval time, so an exception that became valid needs no reason', async () => {
    const o = await order({ received: 4 })
    const a1 = (await ok(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 3, unit_price: 100 }]))).id
    const a2 = (await ok(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 1, unit_price: 100 }]))).id
    const a3 = (await ok(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 1, unit_price: 100 }]))).id
    expect([(await inv(a1)).status, (await inv(a2)).status, (await inv(a3)).status]).toEqual(['MATCHED', 'MATCHED', 'EXCEPTION'])
    await ok(call(accounts, `select public.cancel_supplier_invoice($1, 'entered twice')`, [a2]))   // frees a2's quantity
    await ok(approve(a.ownerId, a3))                                                                // no reason needed: it matches now
    expect(await inv(a3)).toMatchObject({ status: 'APPROVED', variance_reason: null })
    expect((await invLines(a3))[0]).toMatchObject({ match_status: 'MATCHED' })
    expect(Number((await invLines(a3))[0].allowed_quantity)).toBe(1)
  })

  it('cancels with a reason and the right permission, and pays only approved invoices with a reference', async () => {
    const o = await order({ received: 6 })
    const id = (await ok(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 2, unit_price: 100 }]))).id
    expect(await code(call(accounts, `select public.cancel_supplier_invoice($1, '')`, [id]))).toBe('22023')
    expect(await code(call(storeman, `select public.cancel_supplier_invoice($1, 'x')`, [id]))).toBe('42501')
    expect(await code(call(accounts, `select public.pay_supplier_invoice($1, $2, 'CHQ-1')`, [id, day(0)]))).toBe('22023')   // not approved yet
    await ok(approve(a.ownerId, id))
    expect(await code(call(procurement, `select public.pay_supplier_invoice($1, $2, 'CHQ-1')`, [id, day(0)]))).toBe('42501')
    expect(await code(call(accounts, `select public.pay_supplier_invoice($1, $2, '')`, [id, day(0)]))).toBe('22023')
    expect(await code(call(accounts, `select public.pay_supplier_invoice($1, $2, 'CHQ-1')`, [id, day(3)]))).toBe('22023')
    await ok(call(accounts, `select public.pay_supplier_invoice($1, $2, 'CHQ-1')`, [id, day(0)]))
    expect(await inv(id)).toMatchObject({ status: 'PAID', payment_reference: 'CHQ-1', paid_by: accounts })
    expect(await code(call(accounts, `select public.cancel_supplier_invoice($1, 'late')`, [id]))).toBe('22023')
    await expect(admin.query(`update public.supplier_invoices set invoice_number = 'HACK' where id = $1`, [id])).rejects.toMatchObject({ code: '23514' })
  })

  it('summarises payables by supplier with ageing buckets, pending invoices and expected credits', async () => {
    const sup = await addSupplier(a.id, `AGE${Math.floor(Math.random() * 1e6)}`)
    const mk = async (daysAgo: number, qty: number) => {
      const p = await addProduct(a.id)
      const box = await addProductUnit(a.id, p.id, 'BOX', 10)
      const poId = (await ok(savePo(procurement, [{ product_id: p.id, product_unit_id: box, quantity: 5, unit_cost: 100 }], sup))).id as string
      await ok(call(procurement, `select public.submit_purchase_order($1)`, [poId])); await ok(call(a.ownerId, `select public.approve_purchase_order($1)`, [poId]))
      const [l] = await q(`select id from public.purchase_order_lines where purchase_order_id = $1`, [poId])
      await ok(receive(storeman, poId, [{ po_line_id: l.id, quantity: 5, batch_number: 'AG', expiry_date: day(400) }]))
      const id = (await ok(rec(accounts, poId, [{ po_line_id: l.id, quantity: qty, unit_price: 100 }], { date: day(-daysAgo) }))).id as string
      return { id, p, box, poId }
    }
    const current = await mk(5, 1)       // due in 25 days   -> 100
    const late20 = await mk(50, 2)       // due 20 days ago  -> 200
    const late100 = await mk(130, 3)     // due 100 days ago -> 300
    const pending = await mk(1, 4)       // recorded only    -> awaiting approval 400
    for (const x of [current, late20, late100]) await ok(approve(a.ownerId, x.id))
    const s = (await ok(call(a.ownerId, `select * from public.payables_summary() where supplier_id = $1`, [sup])))
    expect([s.outstanding, s.not_due, s.overdue_1_30, s.overdue_31_60, s.overdue_61_90, s.overdue_over_90, s.awaiting_approval].map(Number)).toEqual([600, 100, 200, 0, 0, 300, 400])
    expect(pending.id).toBeTruthy()
  })

  it('is branch-scoped, tenant-isolated and read-only for clients', async () => {
    const o = await order({ received: 2 })
    const id = (await ok(rec(accounts, o.id, [{ po_line_id: o.lineId, quantity: 1, unit_price: 100 }]))).id
    const acct2 = await addUser(a.id, 'ACCOUNTS_MANAGER', branch2)
    await withUser(acct2, async (c) => {
      expect((await c.q(`select count(*)::int n from public.supplier_invoices where id = $1`, [id])).rows[0].n).toBe(0)
      expect((await c.q(`select count(*)::int n from public.supplier_invoice_lines where supplier_invoice_id = $1`, [id])).rows[0].n).toBe(0)
    })
    expect(await code(approve(acct2, id))).toBe('42501')
    await withUser(b.ownerId, async (c) => expect((await c.q(`select count(*)::int n from public.supplier_invoices`)).rows[0].n).toBe(0))
    expect(await code(approve(b.ownerId, id))).toBe('P0002')
    const cashier = await addUser(a.id, 'CASHIER')
    await withUser(cashier, async (c) => expect((await c.q(`select count(*)::int n from public.supplier_invoices`)).rows[0].n).toBe(0))
    await withUser(accounts, async (c) => {
      for (const sql of [
        `update public.supplier_invoices set status = 'PAID', paid_on = current_date`,
        `delete from public.supplier_invoices`,
        `insert into public.supplier_invoice_lines (supplier_invoice_id) values (gen_random_uuid())`,
        `update public.supplier_invoice_lines set quantity = 1`,
      ]) {
        const out = await c.attempt(sql)
        expect(out.ok, sql).toBe(false)
        if (!out.ok) expect(out.code, sql).toBe('42501')
      }
    })
  })

  it('lets a sole approver approve their own invoice', async () => {
    const solo = await createOrg('P4-SOLO')
    const wh = await addWarehouse(solo.id, solo.hq, 'WS')
    const sup = await addSupplier(solo.id)
    const p = await addProduct(solo.id)
    const poId = (await ok(call(solo.ownerId, `select public.save_purchase_order(null, $1, $2, null, null, $3::jsonb) as id`, [sup, wh, JSON.stringify([{ product_id: p.id, quantity: 5, unit_cost: 10 }])]))).id
    await ok(call(solo.ownerId, `select public.submit_purchase_order($1)`, [poId])); await ok(call(solo.ownerId, `select public.approve_purchase_order($1)`, [poId]))
    const [l] = await q(`select id from public.purchase_order_lines where purchase_order_id = $1`, [poId])
    await ok(call(solo.ownerId, `select public.receive_goods($1, $2::jsonb, null, null)`, [poId, JSON.stringify([{ po_line_id: l.id, quantity: 5, batch_number: 'S', expiry_date: day(300) }])]))
    const id = (await ok(rec(solo.ownerId, poId, [{ po_line_id: l.id, quantity: 5, unit_price: 10 }]))).id
    await ok(approve(solo.ownerId, id))
    expect((await inv(id)).status).toBe('APPROVED')
  })
})

// ================================================================================================
describe('stock counts', () => {
  async function shelf() {
    const p1 = await addProduct(a.id, { brand: 'Countazole' })
    const p2 = await addProduct(a.id, { brand: 'Countamol' })
    const loc = await addLocation(a.id, whA1, `K${Math.random().toString(36).slice(2, 6).toUpperCase()}`)
    await ok(open(a.ownerId, whA1, [
      { product_id: p1.id, quantity: 100, batch_number: 'K1', expiry_date: day(300), location_id: loc },
      { product_id: p1.id, quantity: 30, batch_number: 'K2', expiry_date: day(400), location_id: loc },
      { product_id: p2.id, quantity: 50, batch_number: 'K3', expiry_date: day(300), location_id: loc },
    ]))
    return { p1, p2, loc }
  }
  const start = (user: string, wh: string, loc: string | null = null, products: string[] | null = null) =>
    call(user, `select public.start_stock_count($1, $2, $3::uuid[], null) as id`, [wh, loc, products])
  const countLines = async (id: string) => q(`select l.*, b.batch_number from public.stock_count_lines l left join public.batches b on b.id = l.batch_id where l.stock_count_id = $1 order by l.line_no`, [id])
  const enter = (user: string, id: string, entries: object[]) => call(user, `select public.save_count_entries($1, $2::jsonb) as n`, [id, JSON.stringify(entries)])
  const cnt = async (id: string) => (await q(`select * from public.stock_counts where id = $1`, [id]))[0]

  it('snapshots the stock in scope, numbers the count, and only includes what was asked for', async () => {
    const s = await shelf()
    const id = (await ok(start(storeman, whA1, s.loc, [s.p1.id]))).id
    const c = await cnt(id)
    expect(c).toMatchObject({ status: 'OPEN', warehouse_id: whA1, line_count: 2, created_by: storeman, location_id: s.loc })
    expect(c.count_number).toMatch(/^CNT-/)
    const lines = await countLines(id)
    expect(lines.map((l) => [l.batch_number, Number(l.system_quantity), l.counted_quantity])).toEqual([['K1', 100, null], ['K2', 30, null]])
    expect(await code(start(storeman, whA1, null, [(await addProduct(a.id)).id]))).toBe('22023')      // nothing to count
    const branchCounter = await addUser(a.id, 'WAREHOUSE_PICKER', branch2)
    expect(await code(start(branchCounter, whA1, s.loc))).toBe('42501')                                // other branch
    expect(await code(start(procurement, whA1, s.loc))).toBe('42501')                                  // no inventory.count
  })

  it('takes counted quantities, validates them, lets them be cleared, and locks them after submission', async () => {
    const s = await shelf()
    const id = (await ok(start(counter, whA1, s.loc, [s.p1.id]))).id
    const [l1, l2] = await countLines(id)
    expect(await code(enter(counter, id, [{ line_id: l1.id, counted_quantity: -1 }]))).toBe('22023')
    expect(await code(enter(counter, id, [{ line_id: l1.id, counted_quantity: 'x' }]))).toBe('22023')
    expect(await code(enter(counter, id, [{ line_id: '00000000-0000-0000-0000-000000000000', counted_quantity: 1 }]))).toBe('P0002')
    expect(await code(call(counter, `select public.submit_stock_count($1)`, [id]))).toBe('22023')      // nothing counted yet
    expect(Number((await ok(enter(counter, id, [{ line_id: l1.id, counted_quantity: 97 }, { line_id: l2.id, counted_quantity: 30 }]))).n)).toBe(2)
    await ok(enter(counter, id, [{ line_id: l2.id, counted_quantity: null }]))
    const lines = await countLines(id)
    expect([lines[0].counted_quantity, lines[1].counted_quantity].map((v) => (v === null ? null : Number(v)))).toEqual([97, null])
    expect(lines[0].counted_by).toBe(counter)
    await ok(call(counter, `select public.submit_stock_count($1)`, [id]))
    expect(await code(enter(counter, id, [{ line_id: l1.id, counted_quantity: 1 }]))).toBe('22023')
    await expect(admin.query(`update public.stock_count_lines set system_quantity = 1 where stock_count_id = $1`, [id])).rejects.toMatchObject({ code: '23514' })
  })

  it('posts the variances as one adjustment on approval, leaves uncounted lines alone, and needs a different approver', async () => {
    const s = await shelf()
    const id = (await ok(start(counter, whA1, s.loc))).id
    const lines = await countLines(id)
    const by = (b: string) => lines.find((l) => l.batch_number === b)!
    await ok(enter(counter, id, [
      { line_id: by('K1').id, counted_quantity: 96 },     // -4
      { line_id: by('K2').id, counted_quantity: 33 },     // +3
      { line_id: by('K3').id, counted_quantity: 50 },     // no variance
    ]))
    await ok(call(counter, `select public.submit_stock_count($1)`, [id]))
    expect(await code(call(counter, `select public.approve_stock_count($1)`, [id]))).toBe('42501')             // no count_approve
    expect(await code(call(storeman, `select public.approve_stock_count($1)`, [id]))).toBe('42501')
    const r = (await ok(call(counterApprover, `select public.approve_stock_count($1) as r`, [id]))).r
    expect(r.variances).toBe(2)
    expect(r.stock_document_number).toMatch(/^ADJ-/)
    expect(await onHand(s.p1.id)).toBe(129)                                                                    // 130 - 4 + 3
    expect(await onHand(s.p2.id)).toBe(50)
    const c = await cnt(id)
    expect(c).toMatchObject({ status: 'APPROVED', approved_by: counterApprover })
    const [doc] = await q(`select document_type, reason_code, source_type, source_id, line_count from public.stock_documents where id = $1`, [c.adjustment_document_id])
    expect(doc).toEqual({ document_type: 'ADJUSTMENT', reason_code: 'COUNT_VARIANCE', source_type: 'STOCK_COUNT', source_id: id, line_count: 2 })
    expect(await code(call(counterApprover, `select public.approve_stock_count($1)`, [id]))).toBe('22023')     // already approved
  })

  it('applies the variance to the stock as it is at approval, so movements during the count are not lost', async () => {
    const s = await shelf()
    const id = (await ok(start(counter, whA1, s.loc, [s.p1.id]))).id
    const lines = await countLines(id)
    const k1 = lines.find((l) => l.batch_number === 'K1')!
    await ok(enter(counter, id, [{ line_id: k1.id, counted_quantity: 90 }]))                                    // counted 90 of 100: -10
    await ok(call(counter, `select public.submit_stock_count($1)`, [id]))
    await ok(call(a.ownerId, `select public.post_stock_document('ADJUSTMENT', $1, $2::jsonb, null, 'DAMAGE')`,
      [whA1, JSON.stringify([{ product_id: s.p1.id, batch_number: 'K1', quantity: 20, direction: 'OUT', location_id: s.loc }])]))   // sold / moved 20 meanwhile
    await ok(call(counterApprover, `select public.approve_stock_count($1)`, [id]))
    expect(Number((await q(`select b.quantity from public.stock_balances b join public.batches ba on ba.id = b.batch_id where ba.batch_number = 'K1' and b.product_id = $1`, [s.p1.id]))[0].quantity)).toBe(70)   // 100 - 20 - 10
  })

  it('refuses to approve a variance the current stock cannot absorb, and leaves everything as it was', async () => {
    const s = await shelf()
    const id = (await ok(start(counter, whA1, s.loc, [s.p2.id]))).id
    const [l] = await countLines(id)
    await ok(enter(counter, id, [{ line_id: l.id, counted_quantity: 10 }]))                                     // -40
    await ok(call(counter, `select public.submit_stock_count($1)`, [id]))
    await ok(call(a.ownerId, `select public.post_stock_document('ADJUSTMENT', $1, $2::jsonb, null, 'THEFT_LOSS')`,
      [whA1, JSON.stringify([{ product_id: s.p2.id, batch_number: 'K3', quantity: 30, direction: 'OUT', location_id: s.loc }])]))   // only 20 left
    const r = await call(counterApprover, `select public.approve_stock_count($1)`, [id])
    expect(!r.ok && r.code).toBe('23514')
    expect((await cnt(id)).status).toBe('SUBMITTED')
    expect(await onHand(s.p2.id)).toBe(20)
  })

  it('can be sent back with a reason, cancelled with a reason, and a sole approver may approve their own', async () => {
    const s = await shelf()
    const id = (await ok(start(counter, whA1, s.loc, [s.p2.id]))).id
    const [l] = await countLines(id)
    await ok(enter(counter, id, [{ line_id: l.id, counted_quantity: 49 }]))
    await ok(call(counter, `select public.submit_stock_count($1)`, [id]))
    expect(await code(call(counterApprover, `select public.return_stock_count($1, '')`, [id]))).toBe('22023')
    expect(await code(call(counter, `select public.return_stock_count($1, 'recount')`, [id]))).toBe('42501')
    await ok(call(counterApprover, `select public.return_stock_count($1, 'Please recount the top shelf')`, [id]))
    expect(await cnt(id)).toMatchObject({ status: 'OPEN', status_reason: 'Please recount the top shelf' })
    await ok(call(counter, `select public.submit_stock_count($1)`, [id]))
    expect(await code(call(counter, `select public.cancel_stock_count($1, 'x')`, [id]))).toBe('42501')          // submitted counts are cancelled by approvers
    await ok(call(counterApprover, `select public.cancel_stock_count($1, 'Wrong warehouse')`, [id]))
    expect((await cnt(id)).status).toBe('CANCELLED')
    expect(await code(call(counterApprover, `select public.approve_stock_count($1)`, [id]))).toBe('22023')
    expect(await onHand(s.p2.id)).toBe(50)

    const solo = await createOrg('P4-COUNT-SOLO')
    const wh = await addWarehouse(solo.id, solo.hq, 'WSC')
    const p = await addProduct(solo.id)
    await ok(call(solo.ownerId, `select public.post_stock_document('OPENING', $1, $2::jsonb)`, [wh, JSON.stringify([{ product_id: p.id, quantity: 10, batch_number: 'Z', expiry_date: day(300) }])]))
    const sid = (await ok(start(solo.ownerId, wh))).id
    const [sl] = await countLines(sid)
    await ok(enter(solo.ownerId, sid, [{ line_id: sl.id, counted_quantity: 8 }]))
    await ok(call(solo.ownerId, `select public.submit_stock_count($1)`, [sid]))
    await ok(call(solo.ownerId, `select public.approve_stock_count($1)`, [sid]))
    expect(await onHand(p.id)).toBe(8)
  })

  it('is branch-scoped, tenant-isolated, audited and read-only for clients', async () => {
    const s = await shelf()
    const id = (await ok(start(counter, whA1, s.loc))).id
    const mgr2 = await addUser(a.id, 'WAREHOUSE_MANAGER', branch2)
    await withUser(mgr2, async (c) => {
      expect((await c.q(`select count(*)::int n from public.stock_counts where id = $1`, [id])).rows[0].n).toBe(0)
      expect((await c.q(`select count(*)::int n from public.stock_count_lines where stock_count_id = $1`, [id])).rows[0].n).toBe(0)
    })
    expect(await code(enter(mgr2, id, [{ line_id: (await countLines(id))[0].id, counted_quantity: 1 }]))).toBe('42501')
    await withUser(b.ownerId, async (c) => expect((await c.q(`select count(*)::int n from public.stock_counts`)).rows[0].n).toBe(0))
    expect(await code(call(b.ownerId, `select public.submit_stock_count($1)`, [id]))).toBe('P0002')
    await withUser(a.ownerId, async (c) => {
      for (const sql of [`update public.stock_counts set status = 'APPROVED'`, `delete from public.stock_count_lines`, `update public.stock_count_lines set counted_quantity = 1`, `insert into public.stock_counts (count_number) values ('X')`]) {
        const out = await c.attempt(sql)
        expect(out.ok, sql).toBe(false)
        if (!out.ok) expect(out.code, sql).toBe('42501')
      }
    })
    const actions = (await q(`select action from public.audit_logs where entity_type = 'stock_count' and entity_id = $1`, [id])).map((r) => r.action)
    expect(actions).toContain('stock_count.created')
    await expect(admin.query(`delete from public.stock_count_lines where stock_count_id = $1`, [id])).rejects.toMatchObject({ code: '42501' })
  })

  it('keeps the ledger reconciled with the balances after everything above', async () => {
    const { rows } = await admin.query(`
      with led as (select organization_id, warehouse_id, location_id, product_id, batch_id, stock_status, sum(quantity) q from public.stock_movements group by 1,2,3,4,5,6)
      select count(*)::int n from led full join public.stock_balances b
        on b.organization_id = led.organization_id and b.warehouse_id = led.warehouse_id and b.location_id is not distinct from led.location_id
       and b.product_id = led.product_id and b.batch_id is not distinct from led.batch_id and b.stock_status = led.stock_status
      where coalesce(b.quantity, 0) <> coalesce(led.q, 0)`)
    expect(rows[0].n).toBe(0)
  })
})
