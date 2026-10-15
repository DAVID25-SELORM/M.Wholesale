import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addBranch, addLocation, addProduct, addProductUnit, addUser, addWarehouse, admin, closePool, createOrg, withUser, type Org,
} from '../helpers/db'

let a: Org
let b: Org
let whA: string       // org A, head office, warehouse 1
let whA2: string      // org A, head office, warehouse 2 (same branch)
let branch2: string
let branch3: string
let wh2: string       // branch 2
let whB: string
let storeman: string  // WAREHOUSE_MANAGER, organization-wide
let store2: string    // WAREHOUSE_MANAGER, branch 2 only
let store3: string    // WAREHOUSE_MANAGER, branch 3 only

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  a = await createOrg('P5-A')
  b = await createOrg('P5-B')
  whA = await addWarehouse(a.id, a.hq, 'W1')
  whA2 = await addWarehouse(a.id, a.hq, 'W1B')
  branch2 = await addBranch(a.id, 'B2')
  branch3 = await addBranch(a.id, 'B3')
  wh2 = await addWarehouse(a.id, branch2, 'W2')
  await addWarehouse(a.id, branch3, 'W3')
  whB = await addWarehouse(b.id, b.hq, 'WB')
  storeman = await addUser(a.id, 'WAREHOUSE_MANAGER')
  store2 = await addUser(a.id, 'WAREHOUSE_MANAGER', branch2)
  store3 = await addUser(a.id, 'WAREHOUSE_MANAGER', branch3)
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
const onHand = async (productId: string, wh?: string, status?: string) =>
  Number((await q(`select coalesce(sum(quantity),0) n from public.stock_balances where product_id = $1 and ($2::uuid is null or warehouse_id = $2) and ($3::text is null or stock_status = $3)`, [productId, wh ?? null, status ?? null]))[0].n)

// ================================================================================================
describe('in-transit transfers', () => {
  const dispatch = (user: string, from: string, to: string, lines: object[], notes: string | null = null) =>
    call(user, `select public.dispatch_transfer($1, $2, $3::jsonb, $4) as r`, [from, to, JSON.stringify(lines), notes])
  const receiveRaw = (user: string, id: string, lines: object[]) =>
    call(user, `select public.receive_transfer($1, $2::jsonb) as r`, [id, JSON.stringify(lines)])
  /** quantities in the pack the line was dispatched in (as these tests are written), unless a unit is given */
  const receive = async (user: string, id: string, lines: any[]) => {
    const units = new Map((await q(`select id, product_unit_id from public.stock_transfer_lines where stock_transfer_id = $1`, [id])).map((r) => [r.id, r.product_unit_id]))
    return receiveRaw(user, id, lines.map((l) => ({ product_unit_id: units.get(l.line_id), ...l })))
  }
  const transfer = async (id: string) => (await q(`select * from public.stock_transfers where id = $1`, [id]))[0]
  const tlines = async (id: string) => q(`select * from public.stock_transfer_lines where stock_transfer_id = $1 order by line_no`, [id])

  /** 10 boxes of 14 in warehouse `from`, in one location, batch TR-xxxx. */
  async function stocked(from = whA, qty = 10) {
    const product = await addProduct(a.id)
    const box = await addProductUnit(a.id, product.id, 'BOX', 14)
    const loc = await addLocation(a.id, from, `T${Math.random().toString(36).slice(2, 6).toUpperCase()}`)
    await ok(open(a.ownerId, from, [{ product_id: product.id, product_unit_id: box, quantity: qty, batch_number: `TR${Math.random().toString(36).slice(2, 6)}`, expiry_date: day(300), location_id: loc }]))
    const [bal] = await q(`select batch_id from public.stock_balances where product_id = $1`, [product.id])
    return { product, box, loc, batchId: bal.batch_id as string }
  }
  const line = (s: Awaited<ReturnType<typeof stocked>>, quantity: number, extra: object = {}) =>
    ({ product_id: s.product.id, product_unit_id: s.box, quantity, batch_id: s.batchId, location_id: s.loc, ...extra })

  it('dispatch takes stock out of the sender, records the transfer, and leaves the goods in no warehouse', async () => {
    const s = await stocked()
    const r = (await ok(dispatch(storeman, whA, wh2, [line(s, 4)], 'Restock Kumasi'))).r
    expect(r.transfer_number).toMatch(/^TRN-/)
    expect(r.stock_document_number).toMatch(/^DSP-/)
    expect(await onHand(s.product.id, whA)).toBe(84)         // 140 - 56
    expect(await onHand(s.product.id, wh2)).toBe(0)
    expect(await onHand(s.product.id)).toBe(84)               // the 56 on the road are in nobody's stock
    const t = await transfer(r.stock_transfer_id)
    expect(t).toMatchObject({ status: 'IN_TRANSIT', from_warehouse_id: whA, to_warehouse_id: wh2, from_branch_id: a.hq, to_branch_id: branch2, line_count: 1, dispatched_by: storeman, notes: 'Restock Kumasi' })
    const [l] = await tlines(r.stock_transfer_id)
    expect([Number(l.dispatched_base), Number(l.received_base), l.source_status, l.source_location_id, l.batch_id]).toEqual([56, 0, 'AVAILABLE', s.loc, s.batchId])
    const [doc] = await q(`select document_type, source_type, source_id from public.stock_documents where id = $1`, [t.dispatch_document_id])
    expect(doc).toEqual({ document_type: 'TRANSFER_DISPATCH', source_type: 'STOCK_TRANSFER', source_id: r.stock_transfer_id })
  })

  it('receives in several deliveries, in the condition found, into a location, and completes the transfer', async () => {
    const s = await stocked()
    const r = (await ok(dispatch(storeman, whA, wh2, [line(s, 6)]))).r
    const [l] = await tlines(r.stock_transfer_id)
    const loc2 = await addLocation(a.id, wh2, `R${Math.random().toString(36).slice(2, 6).toUpperCase()}`)

    const r1 = (await ok(receive(store2, r.stock_transfer_id, [{ line_id: l.id, quantity: 3, location_id: loc2 }]))).r
    expect(r1.transfer_status).toBe('PARTIALLY_RECEIVED')
    expect(r1.stock_document_number).toMatch(/^TRC-/)
    expect(await onHand(s.product.id, wh2, 'AVAILABLE')).toBe(42)
    const r2 = (await ok(receive(store2, r.stock_transfer_id, [
      { line_id: l.id, quantity: 2, status: 'QUARANTINE' },
      { line_id: l.id, quantity: 1, status: 'DAMAGED' },
    ]))).r
    expect(r2.transfer_status).toBe('RECEIVED')
    expect(await onHand(s.product.id, wh2, 'QUARANTINE')).toBe(28)
    expect(await onHand(s.product.id, wh2, 'DAMAGED')).toBe(14)
    expect(await onHand(s.product.id, wh2)).toBe(84)
    expect(await onHand(s.product.id, whA)).toBe(56)
    expect(Number((await tlines(r.stock_transfer_id))[0].received_base)).toBe(84)
    expect((await q(`select count(*)::int n from public.stock_balances where warehouse_id = $1 and location_id = $2 and quantity = 42`, [wh2, loc2]))[0].n).toBe(1)
  })

  it('counts a received quantity in the base unit unless a pack level is named', async () => {
    const s = await stocked()
    const r = (await ok(dispatch(storeman, whA, wh2, [line(s, 2)]))).r      // 2 boxes = 28 tablets
    const [l] = await tlines(r.stock_transfer_id)
    await ok(receiveRaw(store2, r.stock_transfer_id, [{ line_id: l.id, quantity: 10 }]))                      // 10 tablets
    expect(await onHand(s.product.id, wh2)).toBe(10)
    expect(await code(receiveRaw(store2, r.stock_transfer_id, [{ line_id: l.id, quantity: 19 }]))).toBe('22023')   // only 18 left
    await ok(receiveRaw(store2, r.stock_transfer_id, [{ line_id: l.id, quantity: 1, product_unit_id: s.box }]))     // 1 box = 14 tablets
    expect(await onHand(s.product.id, wh2)).toBe(24)
    await ok(receiveRaw(store2, r.stock_transfer_id, [{ line_id: l.id, quantity: 4 }]))
    expect((await transfer(r.stock_transfer_id)).status).toBe('RECEIVED')
  })

  it('refuses to receive more than is on its way, from a foreign line, or after completion; a bad line rolls back the good one', async () => {
    const s = await stocked()
    const s2 = await stocked()
    const r = (await ok(dispatch(storeman, whA, wh2, [line(s, 2), line(s2, 2)]))).r
    const [l1, l2] = await tlines(r.stock_transfer_id)
    expect(await code(receive(store2, r.stock_transfer_id, [{ line_id: l1.id, quantity: 3 }]))).toBe('22023')
    expect(await code(receive(store2, r.stock_transfer_id, [{ line_id: l1.id, quantity: 1 }, { line_id: l1.id, quantity: 2 }]))).toBe('22023')
    expect(await code(receive(store2, r.stock_transfer_id, [{ line_id: '00000000-0000-0000-0000-000000000000', quantity: 1 }]))).toBe('P0002')
    expect(await code(receive(store2, r.stock_transfer_id, [{ line_id: l1.id, quantity: 0 }]))).toBe('22023')
    // first line fine, second line impossible: nothing is booked
    expect(await code(receive(store2, r.stock_transfer_id, [{ line_id: l1.id, quantity: 1 }, { line_id: l2.id, quantity: 99 }]))).toBe('22023')
    expect((await tlines(r.stock_transfer_id)).map((x) => Number(x.received_base))).toEqual([0, 0])
    expect(await onHand(s.product.id, wh2)).toBe(0)
    await ok(receive(store2, r.stock_transfer_id, [{ line_id: l1.id, quantity: 2 }, { line_id: l2.id, quantity: 2 }]))
    expect((await transfer(r.stock_transfer_id)).status).toBe('RECEIVED')
    expect(await code(receive(store2, r.stock_transfer_id, [{ line_id: l1.id, quantity: 1 }]))).toBe('22023')
  })

  it('never lets goods that expired be received as AVAILABLE, but accepts them as quarantined or expired', async () => {
    const p = await addProduct(a.id)
    await ok(open(a.ownerId, whA, [{ product_id: p.id, quantity: 20, batch_number: 'OLD-TR', expiry_date: day(-4), status: 'QUARANTINE' }]))
    const [bal] = await q(`select batch_id from public.stock_balances where product_id = $1`, [p.id])
    const r = (await ok(dispatch(storeman, whA, wh2, [{ product_id: p.id, quantity: 20, batch_id: bal.batch_id, status: 'QUARANTINE' }]))).r
    const [l] = await tlines(r.stock_transfer_id)
    expect(await code(receive(store2, r.stock_transfer_id, [{ line_id: l.id, quantity: 5, status: 'AVAILABLE' }]))).toBe('22023')
    await ok(receive(store2, r.stock_transfer_id, [{ line_id: l.id, quantity: 5, status: 'QUARANTINE' }, { line_id: l.id, quantity: 15, status: 'EXPIRED' }]))
    expect(await onHand(p.id, wh2, 'EXPIRED')).toBe(15)
  })

  it('checks permissions at the right end: dispatch at the sender, receive at the receiver, nothing across branches', async () => {
    const s = await stocked()
    expect(await code(dispatch(store2, whA, wh2, [line(s, 1)]))).toBe('42501')            // branch 2 cannot send from head office
    expect(await code(dispatch(counterUser(), whA, wh2, [line(s, 1)]))).toBe('42501')    // no inventory.transfer at all
    const r = (await ok(dispatch(storeman, whA, wh2, [line(s, 3)]))).r
    const [l] = await tlines(r.stock_transfer_id)
    expect(await code(receive(store3, r.stock_transfer_id, [{ line_id: l.id, quantity: 1 }]))).toBe('42501')   // branch 3 is neither end
    const branchHq = await addUser(a.id, 'WAREHOUSE_MANAGER', a.hq)
    expect(await code(receive(branchHq, r.stock_transfer_id, [{ line_id: l.id, quantity: 1 }]))).toBe('42501') // the SENDER cannot book the arrival
    await ok(receive(store2, r.stock_transfer_id, [{ line_id: l.id, quantity: 1 }]))
  })

  it('shows a transfer to both ends and to nobody else', async () => {
    const s = await stocked()
    const r = (await ok(dispatch(storeman, whA, wh2, [line(s, 1)]))).r
    const count = (u: string) => withUser(u, async (c) => ({
      t: (await c.q(`select count(*)::int n from public.stock_transfers where id = $1`, [r.stock_transfer_id])).rows[0].n,
      l: (await c.q(`select count(*)::int n from public.stock_transfer_lines where stock_transfer_id = $1`, [r.stock_transfer_id])).rows[0].n,
    }))
    expect(await count(store2)).toEqual({ t: 1, l: 1 })          // receiver
    expect(await count(await addUser(a.id, 'WAREHOUSE_MANAGER', a.hq))).toEqual({ t: 1, l: 1 })   // sender
    expect(await count(store3)).toEqual({ t: 0, l: 0 })
    expect(await count(b.ownerId)).toEqual({ t: 0, l: 0 })
    expect(await code(call(b.ownerId, `select public.cancel_transfer($1, 'x')`, [r.stock_transfer_id]))).toBe('P0002')
  })

  it('validates a dispatch: stock on hand, distinct and existing warehouses, tenant, lines', async () => {
    const s = await stocked(whA, 1)                       // 14 tablets
    const p = line(s, 2)
    expect(await dispatch(storeman, whA, wh2, [p]).then((r) => !r.ok && r.code)).toBe('23514')
    expect(await code(dispatch(storeman, whA, whA, [line(s, 1)]))).toBe('22023')
    expect(await code(dispatch(storeman, whA, whB, [line(s, 1)]))).toBe('P0002')
    expect(await code(dispatch(storeman, whB, wh2, [line(s, 1)]))).toBe('P0002')
    expect(await code(dispatch(storeman, whA, wh2, []))).toBe('22023')
    expect(await onHand(s.product.id, whA)).toBe(14)
    // the same-branch warehouse works like any other
    await ok(dispatch(storeman, whA, whA2, [line(s, 1)]))
  })

  it('closes a part-delivered transfer short, writing off the rest with a reason and the right permission', async () => {
    const s = await stocked()
    const r = (await ok(dispatch(storeman, whA, wh2, [line(s, 5)]))).r
    const [l] = await tlines(r.stock_transfer_id)
    await ok(receive(store2, r.stock_transfer_id, [{ line_id: l.id, quantity: 3 }]))
    const accountant = await addUser(a.id, 'ACCOUNTS_MANAGER')
    expect(await code(call(accountant, `select public.close_transfer($1, 'lost')`, [r.stock_transfer_id]))).toBe('42501')
    expect(await code(call(store2, `select public.close_transfer($1, 'lost')`, [r.stock_transfer_id]))).toBe('42501')  // not the sender's stock
    expect(await code(call(storeman, `select public.close_transfer($1, '')`, [r.stock_transfer_id]))).toBe('22023')
    await ok(call(storeman, `select public.close_transfer($1, 'Truck broke down, 2 boxes spoiled')`, [r.stock_transfer_id]))
    expect(await transfer(r.stock_transfer_id)).toMatchObject({ status: 'CLOSED', status_reason: 'Truck broke down, 2 boxes spoiled' })
    const [after] = await tlines(r.stock_transfer_id)
    expect([Number(after.received_base), Number(after.short_base)]).toEqual([42, 28])
    expect(await onHand(s.product.id)).toBe(140 - 70 + 42)       // the 28 that never arrived are gone
    expect(await code(receive(store2, r.stock_transfer_id, [{ line_id: l.id, quantity: 1 }]))).toBe('22023')
    expect(await code(call(storeman, `select public.close_transfer($1, 'again')`, [r.stock_transfer_id]))).toBe('22023')
    const audit = await q(`select reason from public.audit_logs where entity_type = 'stock_transfer' and entity_id = $1 and reason is not null`, [r.stock_transfer_id])
    expect(audit.map((x) => x.reason)).toContain('Truck broke down, 2 boxes spoiled')
  })

  it('cancels a transfer nothing has arrived for, returning the goods to the same batch, location and status', async () => {
    const s = await stocked()
    const r = (await ok(dispatch(storeman, whA, wh2, [line(s, 4)]))).r
    expect(await onHand(s.product.id, whA)).toBe(84)
    expect(await code(call(store2, `select public.cancel_transfer($1, 'x')`, [r.stock_transfer_id]))).toBe('42501')   // only the sender cancels
    expect(await code(call(storeman, `select public.cancel_transfer($1, '')`, [r.stock_transfer_id]))).toBe('22023')
    await ok(call(storeman, `select public.cancel_transfer($1, 'Wrong warehouse') as r`, [r.stock_transfer_id]))
    expect(await onHand(s.product.id, whA)).toBe(140)
    expect((await q(`select count(*)::int n from public.stock_balances where warehouse_id = $1 and location_id = $2 and batch_id = $3 and stock_status = 'AVAILABLE' and quantity = 140`, [whA, s.loc, s.batchId]))[0].n).toBe(1)
    expect(await transfer(r.stock_transfer_id)).toMatchObject({ status: 'CANCELLED', status_reason: 'Wrong warehouse' })
    expect(Number((await tlines(r.stock_transfer_id))[0].returned_base)).toBe(56)

    const r2 = (await ok(dispatch(storeman, whA, wh2, [line(s, 2)]))).r
    const [l] = await tlines(r2.stock_transfer_id)
    await ok(receive(store2, r2.stock_transfer_id, [{ line_id: l.id, quantity: 1 }]))
    expect(await code(call(storeman, `select public.cancel_transfer($1, 'too late')`, [r2.stock_transfer_id]))).toBe('22023')   // part-received
  })

  it('lets exactly one of several simultaneous full receipts succeed', async () => {
    const s = await stocked()
    const r = (await ok(dispatch(storeman, whA, wh2, [line(s, 5)]))).r
    const [l] = await tlines(r.stock_transfer_id)
    const results = await Promise.all([1, 2, 3, 4].map(() => receive(store2, r.stock_transfer_id, [{ line_id: l.id, quantity: 5 }])))
    expect(results.filter((x) => x.ok)).toHaveLength(1)
    expect(await onHand(s.product.id, wh2)).toBe(70)
  })

  it('cannot be forged: clients cannot write the tables, the ledger refuses fake dispatch/receipt, and transfers are immutable', async () => {
    const s = await stocked()
    const r = (await ok(dispatch(storeman, whA, wh2, [line(s, 1)]))).r
    await withUser(a.ownerId, async (c) => {
      for (const sql of [
        `update public.stock_transfers set status = 'RECEIVED'`, `delete from public.stock_transfers`,
        `update public.stock_transfer_lines set received_base = 999`, `insert into public.stock_transfers (transfer_number) values ('X')`,
      ]) {
        const out = await c.attempt(sql)
        expect(out.ok, sql).toBe(false)
        if (!out.ok) expect(out.code, sql).toBe('42501')
      }
    })
    for (const type of ['TRANSFER_DISPATCH', 'TRANSFER_RECEIPT']) {
      expect(await code(call(a.ownerId, `select public.post_stock_document($1, $2, '[]'::jsonb)`, [type, whA]))).toBe('22023')
    }
    await expect(admin.query(`update public.stock_transfers set from_warehouse_id = $2 where id = $1`, [r.stock_transfer_id, whA2])).rejects.toMatchObject({ code: '23514' })
    await expect(admin.query(`update public.stock_transfer_lines set dispatched_base = 1 where stock_transfer_id = $1`, [r.stock_transfer_id])).rejects.toMatchObject({ code: '23514' })
    await expect(admin.query(`delete from public.stock_transfers where id = $1`, [r.stock_transfer_id])).rejects.toMatchObject({ code: '42501' })
  })

  it('keeps the ledger reconciled with the balances through dispatches, receipts, closings and cancellations', async () => {
    const { rows } = await admin.query(`
      with led as (select organization_id, warehouse_id, location_id, product_id, batch_id, stock_status, sum(quantity) q from public.stock_movements group by 1,2,3,4,5,6)
      select count(*)::int n from led full join public.stock_balances b
        on b.organization_id = led.organization_id and b.warehouse_id = led.warehouse_id and b.location_id is not distinct from led.location_id
       and b.product_id = led.product_id and b.batch_id is not distinct from led.batch_id and b.stock_status = led.stock_status
      where coalesce(b.quantity, 0) <> coalesce(led.q, 0)`)
    expect(rows[0].n).toBe(0)
  })

  function counterUser() { return counterId }
})

let counterId = ''
beforeAll(async () => { counterId = await addUser(a.id, 'ACCOUNTS_OFFICER') })

// ================================================================================================
describe('importing products and suppliers', () => {
  const importProducts = (user: string, rows: object[], dry = true) =>
    call(user, `select public.import_products($1::jsonb, $2) as r`, [JSON.stringify(rows), dry])
  const importSuppliers = (user: string, rows: object[], dry = true) =>
    call(user, `select public.import_suppliers($1::jsonb, $2) as r`, [JSON.stringify(rows), dry])
  const results = async (p: Promise<Out>) => (await ok(p)).r as { row: number; key: string; status: string; message: string | null }[]
  const sku = (s: string) => `${s}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase()
  const augmentin = (s: string, extra: object = {}) => ({
    sku: s, brand_name: 'Augmentin 625', product_class: 'POM', generic_name: 'Amoxicillin + Clavulanic acid', dosage_form: 'tablet',
    strength: '500 mg + 125 mg', manufacturer: 'GlaxoSmithKline', category: 'Antibiotics', base_unit: 'TABLET', pack_unit: 'BOX', pack_size: '14',
    barcode: '6001087000017', aliases: "AUGMENTIN 625MG 14'S; Co-amoxiclav 625", ...extra,
  })
  const productCount = async () => (await q(`select count(*)::int n from public.products where organization_id = $1`, [a.id]))[0].n

  it('a dry run reports what would happen and changes nothing; the real run then does exactly that', async () => {
    const org = await createOrg('P5-IMP1')
    const s1 = sku('AUG'); const s2 = sku('GLV')
    const rows = [augmentin(s1, { barcode: '6001087000017' }), { sku: s2, brand_name: 'Examination gloves M', product_class: 'CONSUMABLE', base_unit: 'PIECE', pack_unit: 'Box', pack_size: '100', category: 'Devices & consumables' }]
    const before = (await q(`select count(*)::int n from public.products where organization_id = $1`, [org.id]))[0].n
    const dry = await results(importProducts(org.ownerId, rows, true))
    expect(dry.map((r) => [r.row, r.key, r.status, r.message])).toEqual([[1, s1, 'VALID', null], [2, s2, 'VALID', null]])
    expect((await q(`select count(*)::int n from public.products where organization_id = $1`, [org.id]))[0].n).toBe(before)
    expect((await q(`select count(*)::int n from public.manufacturers where organization_id = $1`, [org.id]))[0].n).toBe(0)

    const real = await results(importProducts(org.ownerId, rows, false))
    expect(real.map((r) => r.status)).toEqual(['CREATED', 'CREATED'])
    const [p] = await q(`select p.*, i.generic_name, i.strength_text, m.name mfr, c.name cat from public.products p
      left join public.product_identities i on i.id = p.identity_id left join public.manufacturers m on m.id = p.manufacturer_id
      left join public.product_categories c on c.id = p.category_id where p.organization_id = $1 and p.sku = $2`, [org.id, s1])
    expect(p).toMatchObject({ brand_name: 'Augmentin 625', product_class: 'POM', requires_prescription: true, is_controlled: false, track_batches: true, generic_name: 'Amoxicillin + Clavulanic acid', mfr: 'GlaxoSmithKline', cat: 'Antibiotics' })
    const units = await q(`select u.code, pu.factor_to_base::float8 f, pu.is_base from public.product_units pu join public.units_of_measure u on u.id = pu.unit_id where pu.product_id = $1 order by pu.is_base desc`, [p.id])
    expect(units).toEqual([{ code: 'TABLET', f: 1, is_base: true }, { code: 'BOX', f: 14, is_base: false }])
    const bc = await q(`select b.barcode, b.barcode_type, u.code from public.product_barcodes b join public.product_units pu on pu.id = b.product_unit_id join public.units_of_measure u on u.id = pu.unit_id where b.product_id = $1`, [p.id])
    expect(bc).toEqual([{ barcode: '6001087000017', barcode_type: 'GTIN', code: 'BOX' }])
    expect((await q(`select count(*)::int n from public.product_aliases where product_id = $1 and source = 'IMPORT'`, [p.id]))[0].n).toBe(2)
    // the search function finds it through an alias
    await withUser(org.ownerId, async (c) => expect((await c.q(`select count(*)::int n from public.search_products('co amoxiclav')`)).rows[0].n).toBe(1))
    // one audit summary, written only by the real run
    const audit = await q(`select new_values from public.audit_logs where organization_id = $1 and action = 'product.imported'`, [org.id])
    expect(audit).toHaveLength(1)
    expect(audit[0].new_values).toMatchObject({ rows: 2, created: 2, errors: 0 })
  })

  it('leaves existing SKUs alone, flags duplicates in the file, and keeps good rows when others fail', async () => {
    const org = await createOrg('P5-IMP2')
    const known = sku('KNOWN'); const dup = sku('DUP'); const good = sku('GOOD')
    await results(importProducts(org.ownerId, [augmentin(known)], false))
    const out = await results(importProducts(org.ownerId, [
      augmentin(known, { brand_name: 'CHANGED' }),                       // exists
      augmentin(dup, { barcode: '' }), augmentin(dup, { barcode: '' }),  // duplicate in file
      { sku: 'bad sku!', brand_name: 'X', base_unit: 'TABLET', product_class: 'GSL' },
      { sku: sku('NONAME'), brand_name: '', base_unit: 'TABLET', product_class: 'GSL' },
      { sku: sku('MED'), brand_name: 'No identity', base_unit: 'TABLET', product_class: 'POM' },
      { sku: sku('HALF'), brand_name: 'Half identity', base_unit: 'PIECE', product_class: 'CONSUMABLE', generic_name: 'Paracetamol' },
      augmentin(sku('UNIT'), { base_unit: 'FURLONG' }), augmentin(sku('FORM'), { dosage_form: 'jelly' }),
      augmentin(sku('PU'), { pack_unit: 'TABLET' }), augmentin(sku('PS'), { pack_size: 'many' }), augmentin(sku('PS1'), { pack_size: '1' }),
      augmentin(sku('CLS'), { product_class: 'WIZARD' }), augmentin(sku('STO'), { storage: 'WARM' }), augmentin(sku('BOOL'), { requires_prescription: 'maybe' }),
      augmentin(sku('GTIN'), { barcode: '6001087000018' }),              // wrong check digit
      { sku: good, brand_name: 'Good one', base_unit: 'bottle', product_class: 'gsl', generic_name: 'Paracetamol', dosage_form: 'SYRUP', strength: '120 mg / 5 ml' },
    ], false))
    const by = (i: number) => out[i - 1]!
    expect([by(1).status, by(1).message]).toEqual(['EXISTS', 'already in the catalogue - left unchanged'])
    expect(by(2).status).toBe('CREATED')
    expect([by(3).status, by(3).message]).toEqual(['ERROR', 'the same SKU appears more than once in this file'])
    expect(by(4).message).toMatch(/SKU is missing or not valid/)
    expect(by(5).message).toMatch(/product name is missing/)
    expect(by(6).message).toMatch(/medicine needs a generic name/)
    expect(by(7).message).toMatch(/together/)
    expect(by(8).message).toMatch(/base unit "FURLONG"/)
    expect(by(9).message).toMatch(/dosage form "jelly"/)
    expect(by(10).message).toMatch(/pack unit must differ/)
    expect(by(11).message).toMatch(/pack size must be a number/)
    expect(by(12).message).toMatch(/greater than 1/)
    expect(by(13).message).toMatch(/unknown class/)
    expect(by(14).message).toMatch(/storage must be/)
    expect(by(15).message).toMatch(/not yes or no/)
    expect(by(16).message).toMatch(/GTIN/)
    expect(by(17).status).toBe('CREATED')
    // the existing product was not touched, and failed rows left nothing behind
    expect((await q(`select brand_name from public.products where organization_id = $1 and sku = $2`, [org.id, known]))[0].brand_name).toBe('Augmentin 625')
    expect((await q(`select count(*)::int n from public.products where organization_id = $1`, [org.id]))[0].n).toBe(3)     // known + dup + good
    expect((await q(`select count(*)::int n from public.product_barcodes where organization_id = $1`, [org.id]))[0].n).toBe(1)
    // the lower-case class and unit names were understood
    expect((await q(`select product_class, requires_prescription from public.products where organization_id = $1 and sku = $2`, [org.id, good]))[0]).toEqual({ product_class: 'GSL', requires_prescription: false })
  })

  it('reuses manufacturers, categories and identities (also across spellings) instead of duplicating them', async () => {
    const org = await createOrg('P5-IMP3')
    await results(importProducts(org.ownerId, [
      augmentin(sku('A1'), { barcode: '', manufacturer: 'GlaxoSmithKline', category: 'Antibiotics' }),
      augmentin(sku('A2'), { barcode: '', manufacturer: 'glaxosmithkline', category: 'ANTIBIOTICS', strength: '500MG + 125MG', dosage_form: 'TABLET' }),
      augmentin(sku('A3'), { barcode: '', manufacturer: 'Pfizer', category: 'Anti-biotics' }),
    ], false))
    expect((await q(`select count(*)::int n from public.manufacturers where organization_id = $1`, [org.id]))[0].n).toBe(2)
    expect((await q(`select count(*)::int n from public.product_identities where organization_id = $1`, [org.id]))[0].n).toBe(1)
    const cats = await q(`select code, name from public.product_categories where organization_id = $1 order by code`, [org.id])
    expect(cats.map((c) => c.name)).toEqual(['Anti-biotics', 'Antibiotics'])         // different names are different categories, with distinct generated codes
    expect(new Set(cats.map((c) => c.code)).size).toBe(2)
  })

  it('refuses a barcode that another product already has, without losing the rest of that row’s siblings', async () => {
    const org = await createOrg('P5-IMP4')
    const out = await results(importProducts(org.ownerId, [augmentin(sku('B1')), augmentin(sku('B2'))], false))
    expect(out.map((r) => r.status)).toEqual(['CREATED', 'ERROR'])
    expect(out[1]!.message).toBe('that barcode is already used by another product')
    expect((await q(`select count(*)::int n from public.products where organization_id = $1`, [org.id]))[0].n).toBe(1)
  })

  it('needs products.create for the whole organization, rejects empty and oversized batches, and stays inside the tenant', async () => {
    const officer = await addUser(a.id, 'PROCUREMENT_OFFICER')           // products.create, organization-wide
    const branchOfficer = await addUser(a.id, 'PROCUREMENT_OFFICER', branch2)
    const cashier = await addUser(a.id, 'CASHIER')
    const row = augmentin(sku('PERM'), { barcode: '' })
    expect(await code(importProducts(officer, [row]))).toBe('ok')
    expect(await code(importProducts(branchOfficer, [row]))).toBe('42501')
    expect(await code(importProducts(cashier, [row]))).toBe('42501')
    expect(await code(importProducts(officer, []))).toBe('22023')
    expect(await code(importProducts(officer, Array.from({ length: 501 }, (_, i) => ({ sku: `S${i}`, brand_name: 'x', base_unit: 'TABLET', product_class: 'GSL' }))))).toBe('22023')
    const before = await productCount()
    await results(importProducts(officer, [row], false))
    expect(await productCount()).toBe(before + 1)
    // the other organization never sees it, and can import the same SKU independently
    await withUser(b.ownerId, async (c) => expect((await c.q(`select count(*)::int n from public.products where sku = $1`, [row.sku])).rows[0].n).toBe(0))
    expect((await results(importProducts(b.ownerId, [row], false)))[0]!.status).toBe('CREATED')
    const anon = await withUser(null, (c) => c.attempt(`select public.import_products('[]'::jsonb)`))
    expect(!anon.ok && anon.code).toBe('42501')
  })

  it('imports suppliers: dry run, real run, existing codes, duplicate names, bad dates and types', async () => {
    const org = await createOrg('P5-IMP5')
    const rows = [
      { code: 'emp', name: 'Emmanuel Pharma Ltd', supplier_type: 'distributor', licence_number: 'FDA/123', licence_expiry: '2027-03-31', payment_terms_days: '45', country: 'gh', currency_code: 'ghs', email: 'orders@emp.example' },
      { code: 'KOF', name: 'Kofi Imports' },
    ]
    expect((await results(importSuppliers(org.ownerId, rows, true))).map((r) => r.status)).toEqual(['VALID', 'VALID'])
    expect((await q(`select count(*)::int n from public.suppliers where organization_id = $1`, [org.id]))[0].n).toBe(0)
    expect((await results(importSuppliers(org.ownerId, rows, false))).map((r) => r.status)).toEqual(['CREATED', 'CREATED'])
    const [s] = await q(`select code, supplier_type, licence_expiry::text le, payment_terms_days, country, currency_code from public.suppliers where organization_id = $1 and code = 'EMP'`, [org.id])
    expect(s).toEqual({ code: 'EMP', supplier_type: 'DISTRIBUTOR', le: '2027-03-31', payment_terms_days: 45, country: 'GH', currency_code: 'GHS' })
    expect((await q(`select payment_terms_days from public.suppliers where organization_id = $1 and code = 'KOF'`, [org.id]))[0].payment_terms_days).toBe(30)

    const out = await results(importSuppliers(org.ownerId, [
      { code: 'EMP', name: 'Whatever' },
      { code: 'NEW1', name: 'emmanuel pharma ltd' },
      { code: 'NEW2', name: 'Bad date', licence_expiry: '31/12/2027' },
      { code: 'NEW3', name: 'Bad type', supplier_type: 'PIRATE' },
      { code: 'NEW4', name: 'Bad terms', payment_terms_days: '1000' },
      { code: 'NEW5', name: 'Bad country', country: 'GHA' },
      { code: 'bad code', name: 'x' },
      { code: 'NEW6', name: '' },
      { code: 'NEW7', name: 'Fine supplier' },
    ], false))
    expect(out.map((r) => r.status)).toEqual(['EXISTS', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'CREATED'])
    expect(out[1]!.message).toBe('a supplier with that name already exists')
    expect(out[2]!.message).toMatch(/date is not valid/)
    expect(out[3]!.message).toMatch(/unknown supplier type/)
    expect(out[6]!.message).toMatch(/code is missing or not valid/)
    expect((await q(`select count(*)::int n from public.suppliers where organization_id = $1`, [org.id]))[0].n).toBe(3)

    const officer = await addUser(a.id, 'PROCUREMENT_OFFICER')
    expect(await code(importSuppliers(officer, [{ code: 'IMP1', name: 'Imported by officer' }]))).toBe('ok')
    expect(await code(importSuppliers(await addUser(a.id, 'CASHIER'), [{ code: 'IMP2', name: 'No' }]))).toBe('42501')
    expect(await code(importSuppliers(await addUser(a.id, 'PROCUREMENT_OFFICER', branch2), [{ code: 'IMP3', name: 'No' }]))).toBe('42501')
  })
})
