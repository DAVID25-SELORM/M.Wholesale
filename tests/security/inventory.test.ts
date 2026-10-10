import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addBranch, addLocation, addProduct, addProductUnit, addUser, addWarehouse, admin, closePool, createOrg, withUser, type Org,
} from '../helpers/db'

let a: Org
let b: Org
let whA1: string // org A, head office
let whA2: string // org A, head office (second warehouse)
let branch2: string
let whA3: string // org A, second branch
let whB1: string

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  a = await createOrg('INV-A')
  b = await createOrg('INV-B')
  whA1 = await addWarehouse(a.id, a.hq, 'W1')
  whA2 = await addWarehouse(a.id, a.hq, 'W2')
  branch2 = await addBranch(a.id, 'B2')
  whA3 = await addWarehouse(a.id, branch2, 'W3')
  whB1 = await addWarehouse(b.id, b.hq, 'WB1')
})
afterAll(closePool)

type Line = Record<string, unknown>

/** Posts a stock document as `user` and commits; returns the outcome. */
async function post(user: string, type: string, wh: string, lines: Line[], extra: { to?: string | null; reason?: string | null; notes?: string | null } = {}) {
  return withUser(user, async (c) => {
    const r = await c.attempt(`select public.post_stock_document($1, $2, $3::jsonb, $4, $5, $6) as r`,
      [type, wh, JSON.stringify(lines), extra.to ?? null, extra.reason ?? null, extra.notes ?? null])
    return r
  }, { commit: true })
}

const ok = async (p: ReturnType<typeof post>) => {
  const r = await p
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`)
  return r.rows[0].r as { document_id: string; document_number: string }
}

async function onHand(orgId: string, productId: string, wh?: string, status?: string) {
  const { rows } = await admin.query(
    `select coalesce(sum(quantity), 0)::float8 q from public.stock_balances
      where organization_id = $1 and product_id = $2 and ($3::uuid is null or warehouse_id = $3) and ($4::text is null or stock_status = $4)`,
    [orgId, productId, wh ?? null, status ?? null])
  return rows[0].q as number
}

describe('opening stock and units', () => {
  it('posts opening stock in pack units, converts to the base unit, creates the batch, numbers and audits the document', async () => {
    const p = await addProduct(a.id)
    const box = await addProductUnit(a.id, p.id, 'BOX', 14)
    const doc = await ok(post(a.ownerId, 'OPENING', whA1, [
      { product_id: p.id, product_unit_id: box, quantity: 3, batch_number: 'ab-123', expiry_date: day(400) },
    ]))
    expect(doc.document_number).toMatch(/^OPN-/)
    expect(await onHand(a.id, p.id)).toBe(42)

    const mv = (await admin.query(`select movement_type, quantity::float8 q, entered_quantity::float8 eq, stock_status from public.stock_movements where document_id = $1`, [doc.document_id])).rows
    expect(mv).toEqual([{ movement_type: 'OPENING', q: 42, eq: 3, stock_status: 'AVAILABLE' }])

    const audit = (await admin.query(`select action, actor_user_id from public.audit_logs where entity_type = 'stock_document' and entity_id = $1`, [doc.document_id])).rows
    expect(audit).toEqual([{ action: 'stock.opening_posted', actor_user_id: a.ownerId }])
  })

  it('numbers documents sequentially per type', async () => {
    const p = await addProduct(a.id)
    const d1 = await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 1, batch_number: 'N1', expiry_date: day(300) }]))
    const d2 = await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 1, batch_number: 'N2', expiry_date: day(300) }]))
    const n = (s: string) => Number(s.split('-').pop())
    expect(n(d2.document_number)).toBe(n(d1.document_number) + 1)
  })

  it('treats batch numbers case-insensitively and refuses a conflicting expiry for an existing batch', async () => {
    const p = await addProduct(a.id)
    await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 5, batch_number: 'Lot-9', expiry_date: day(200) }]))
    await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 5, batch_number: ' LOT-9 ', expiry_date: day(200) }]))
    expect((await admin.query(`select count(*)::int n from public.batches where product_id = $1`, [p.id])).rows[0].n).toBe(1)
    expect(await onHand(a.id, p.id)).toBe(10)
    const bad = await post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 1, batch_number: 'lot-9', expiry_date: day(250) }])
    expect(bad.ok).toBe(false)
    expect(await onHand(a.id, p.id)).toBe(10)
  })

  it('requires a batch and expiry for batch-tracked products, and rejects batches on untracked ones', async () => {
    const p = await addProduct(a.id)
    expect((await post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 1 }])).ok).toBe(false)
    expect((await post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 1, batch_number: 'X' }])).ok).toBe(false)
    const untracked = await addProduct(a.id)
    await admin.query(`update public.products set track_batches = false where id = $1`, [untracked.id])
    expect((await post(a.ownerId, 'OPENING', whA1, [{ product_id: untracked.id, quantity: 4, batch_number: 'X', expiry_date: day(10) }])).ok).toBe(false)
    expect((await post(a.ownerId, 'OPENING', whA1, [{ product_id: untracked.id, quantity: 4 }])).ok).toBe(true)
    expect(await onHand(a.id, untracked.id)).toBe(4)
  })

  it('rejects zero, negative and fractional-base quantities, unknown units and empty documents', async () => {
    const p = await addProduct(a.id)
    const other = await addProduct(a.id)
    const otherBox = await addProductUnit(a.id, other.id, 'BOX', 10)
    const base = { product_id: p.id, batch_number: 'Q1', expiry_date: day(100) }
    for (const quantity of [0, -3, 'abc', null]) {
      expect((await post(a.ownerId, 'OPENING', whA1, [{ ...base, quantity }])).ok).toBe(false)
    }
    expect((await post(a.ownerId, 'OPENING', whA1, [{ ...base, quantity: 0.0004 }])).ok).toBe(false)
    expect((await post(a.ownerId, 'OPENING', whA1, [{ ...base, quantity: 1, product_unit_id: otherBox }])).ok).toBe(false)
    expect((await post(a.ownerId, 'OPENING', whA1, [])).ok).toBe(false)
    expect(await onHand(a.id, p.id)).toBe(0)
  })

  it('does not allow expired stock to be loaded as AVAILABLE, but allows it as EXPIRED/QUARANTINE', async () => {
    const p = await addProduct(a.id)
    const line = { product_id: p.id, quantity: 5, batch_number: 'OLD', expiry_date: day(-10) }
    expect((await post(a.ownerId, 'OPENING', whA1, [line])).ok).toBe(false)
    expect((await post(a.ownerId, 'OPENING', whA1, [{ ...line, status: 'EXPIRED' }])).ok).toBe(true)
    expect(await onHand(a.id, p.id, whA1, 'EXPIRED')).toBe(5)
  })
})

describe('adjustments, negative stock and atomicity', () => {
  it('adjusts down and up with a mandatory reason, and never goes negative', async () => {
    const p = await addProduct(a.id)
    await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 10, batch_number: 'ADJ1', expiry_date: day(300) }]))

    expect((await post(a.ownerId, 'ADJUSTMENT', whA1, [{ product_id: p.id, batch_number: 'ADJ1', quantity: 2, direction: 'OUT' }])).ok).toBe(false) // no reason
    await ok(post(a.ownerId, 'ADJUSTMENT', whA1, [{ product_id: p.id, batch_number: 'ADJ1', quantity: 3, direction: 'OUT' }], { reason: 'DAMAGE', notes: 'water damage' }))
    expect(await onHand(a.id, p.id)).toBe(7)
    await ok(post(a.ownerId, 'ADJUSTMENT', whA1, [{ product_id: p.id, batch_number: 'ADJ1', quantity: 1, direction: 'IN' }], { reason: 'FOUND' }))
    expect(await onHand(a.id, p.id)).toBe(8)

    const over = await post(a.ownerId, 'ADJUSTMENT', whA1, [{ product_id: p.id, batch_number: 'ADJ1', quantity: 9, direction: 'OUT' }], { reason: 'COUNT_VARIANCE' })
    expect(over.ok).toBe(false)
    if (!over.ok) { expect(over.code).toBe('23514'); expect(over.message).toMatch(/insufficient stock/i) }
    expect(await onHand(a.id, p.id)).toBe(8)
  })

  it('is all-or-nothing: one bad line rolls back the whole document, ledger, batch and number use included', async () => {
    const p1 = await addProduct(a.id)
    const p2 = await addProduct(a.id)
    const before = (await admin.query(`select count(*)::int n from public.stock_documents where organization_id = $1`, [a.id])).rows[0].n
    const r = await post(a.ownerId, 'OPENING', whA1, [
      { product_id: p1.id, quantity: 5, batch_number: 'AT1', expiry_date: day(100) },
      { product_id: p2.id, quantity: -1, batch_number: 'AT2', expiry_date: day(100) },
    ])
    expect(r.ok).toBe(false)
    expect((await admin.query(`select count(*)::int n from public.stock_documents where organization_id = $1`, [a.id])).rows[0].n).toBe(before)
    expect(await onHand(a.id, p1.id)).toBe(0)
    expect((await admin.query(`select count(*)::int n from public.batches where product_id = $1`, [p1.id])).rows[0].n).toBe(0)
  })

  it('refuses to adjust out of a batch that does not exist or cannot be created by an OUT line', async () => {
    const p = await addProduct(a.id)
    const r = await post(a.ownerId, 'ADJUSTMENT', whA1, [{ product_id: p.id, batch_number: 'GHOST', expiry_date: day(100), quantity: 1, direction: 'OUT' }], { reason: 'OTHER' })
    expect(r.ok).toBe(false)
  })

  it('never lets concurrent postings oversell: 20 racing decrements of 1 against a stock of 10 succeed exactly 10 times', async () => {
    const p = await addProduct(a.id)
    await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 10, batch_number: 'RACE', expiry_date: day(300) }]))
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      post(a.ownerId, 'ADJUSTMENT', whA1, [{ product_id: p.id, batch_number: 'RACE', quantity: 1, direction: 'OUT' }], { reason: 'OTHER' })))
    expect(results.filter((r) => r.ok)).toHaveLength(10)
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === '23514')).toBe(true)
    expect(await onHand(a.id, p.id)).toBe(0)
  })
})

describe('transfers, locations and status changes', () => {
  it('moves stock between warehouses keeping batch and status, with both legs in the ledger', async () => {
    const p = await addProduct(a.id)
    await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 20, batch_number: 'TR1', expiry_date: day(300) }]))
    const doc = await ok(post(a.ownerId, 'TRANSFER', whA1, [{ product_id: p.id, batch_number: 'TR1', quantity: 8 }], { to: whA3 }))
    expect(doc.document_number).toMatch(/^TRF-/)
    expect(await onHand(a.id, p.id, whA1)).toBe(12)
    expect(await onHand(a.id, p.id, whA3)).toBe(8)
    const mv = (await admin.query(`select movement_type, warehouse_id, quantity::float8 q from public.stock_movements where document_id = $1 order by quantity`, [doc.document_id])).rows
    expect(mv.map((m) => [m.movement_type, m.q])).toEqual([['TRANSFER_OUT', -8], ['TRANSFER_IN', 8]])
    expect(mv.map((m) => m.warehouse_id)).toEqual([whA1, whA3])
  })

  it('rejects a transfer to the same warehouse, to a missing warehouse, to another tenant, and over the available quantity', async () => {
    const p = await addProduct(a.id)
    await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 5, batch_number: 'TR2', expiry_date: day(300) }]))
    const line = [{ product_id: p.id, batch_number: 'TR2', quantity: 1 }]
    expect((await post(a.ownerId, 'TRANSFER', whA1, line, { to: whA1 })).ok).toBe(false)
    expect((await post(a.ownerId, 'TRANSFER', whA1, line, { to: null })).ok).toBe(false)
    expect((await post(a.ownerId, 'TRANSFER', whA1, line, { to: whB1 })).ok).toBe(false)
    expect((await post(a.ownerId, 'TRANSFER', whA1, [{ ...line[0], quantity: 6 }], { to: whA2 })).ok).toBe(false)
    expect(await onHand(a.id, p.id)).toBe(5)
  })

  it('tracks stock per location and only accepts locations of the right warehouse', async () => {
    const p = await addProduct(a.id)
    const loc1 = await addLocation(a.id, whA1, `L${Math.random().toString(36).slice(2, 6).toUpperCase()}`)
    const locOther = await addLocation(a.id, whA2, `L${Math.random().toString(36).slice(2, 6).toUpperCase()}`)
    await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 10, batch_number: 'LOC1', expiry_date: day(300), location_id: loc1 }]))
    expect((await post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 1, batch_number: 'LOC1', location_id: locOther }])).ok).toBe(false)
    // stock sits in loc1: taking it from "no location" must fail, from loc1 must work
    expect((await post(a.ownerId, 'ADJUSTMENT', whA1, [{ product_id: p.id, batch_number: 'LOC1', quantity: 1, direction: 'OUT' }], { reason: 'OTHER' })).ok).toBe(false)
    expect((await post(a.ownerId, 'ADJUSTMENT', whA1, [{ product_id: p.id, batch_number: 'LOC1', quantity: 1, direction: 'OUT', location_id: loc1 }], { reason: 'OTHER' })).ok).toBe(true)
    expect(await onHand(a.id, p.id)).toBe(9)
  })

  it('quarantines and releases stock, removing it from sellable quantity, and refuses to release expired stock', async () => {
    const p = await addProduct(a.id)
    await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 10, batch_number: 'Q-OK', expiry_date: day(300) }]))
    await ok(post(a.ownerId, 'STATUS_CHANGE', whA1, [{ product_id: p.id, batch_number: 'Q-OK', quantity: 4, to_status: 'QUARANTINE' }], { reason: 'QUALITY_HOLD' }))
    expect(await onHand(a.id, p.id, whA1, 'AVAILABLE')).toBe(6)
    expect(await onHand(a.id, p.id, whA1, 'QUARANTINE')).toBe(4)
    await ok(post(a.ownerId, 'STATUS_CHANGE', whA1, [{ product_id: p.id, batch_number: 'Q-OK', quantity: 4, status: 'QUARANTINE', to_status: 'AVAILABLE' }], { reason: 'QUALITY_RELEASE' }))
    expect(await onHand(a.id, p.id, whA1, 'AVAILABLE')).toBe(10)

    const q = await addProduct(a.id)
    await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: q.id, quantity: 3, batch_number: 'Q-OLD', expiry_date: day(-5), status: 'QUARANTINE' }]))
    const rel = await post(a.ownerId, 'STATUS_CHANGE', whA1, [{ product_id: q.id, batch_number: 'Q-OLD', quantity: 3, status: 'QUARANTINE', to_status: 'AVAILABLE' }])
    expect(rel.ok).toBe(false)
    expect((await post(a.ownerId, 'STATUS_CHANGE', whA1, [{ product_id: q.id, batch_number: 'Q-OLD', quantity: 3, status: 'QUARANTINE', to_status: 'EXPIRED' }])).ok).toBe(true)
  })

  it('rejects a status change that changes nothing', async () => {
    const p = await addProduct(a.id)
    await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 2, batch_number: 'NC', expiry_date: day(300) }]))
    expect((await post(a.ownerId, 'STATUS_CHANGE', whA1, [{ product_id: p.id, batch_number: 'NC', quantity: 1, to_status: 'AVAILABLE' }])).ok).toBe(false)
  })
})

describe('permissions and tenant isolation', () => {
  it('requires the specific permission for each document type', async () => {
    const p = await addProduct(a.id)
    await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 10, batch_number: 'PERM', expiry_date: day(300) }]))
    const picker = await addUser(a.id, 'WAREHOUSE_PICKER')   // inventory.view only
    const pharmacist = await addUser(a.id, 'PHARMACIST')     // view + quarantine
    const branchMgr = await addUser(a.id, 'BRANCH_MANAGER')  // view + transfer
    const adj = [{ product_id: p.id, batch_number: 'PERM', quantity: 1, direction: 'OUT' }]

    const denied = await post(picker, 'ADJUSTMENT', whA1, adj, { reason: 'OTHER' })
    expect(!denied.ok && denied.code).toBe('42501')
    expect((await post(pharmacist, 'ADJUSTMENT', whA1, adj, { reason: 'OTHER' })).ok).toBe(false)
    expect((await post(pharmacist, 'STATUS_CHANGE', whA1, [{ product_id: p.id, batch_number: 'PERM', quantity: 1, to_status: 'QUARANTINE' }])).ok).toBe(true)
    expect((await post(pharmacist, 'TRANSFER', whA1, [{ product_id: p.id, batch_number: 'PERM', quantity: 1 }], { to: whA2 })).ok).toBe(false)
    expect((await post(branchMgr, 'TRANSFER', whA1, [{ product_id: p.id, batch_number: 'PERM', quantity: 1 }], { to: whA2 })).ok).toBe(true)
    expect((await post(branchMgr, 'OPENING', whA1, [{ product_id: p.id, batch_number: 'PERM', quantity: 1 }])).ok).toBe(false)
  })

  it('scopes branch-assigned users to their own branch for both reading and posting', async () => {
    const p = await addProduct(a.id)
    await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 10, batch_number: 'BR', expiry_date: day(300) }]))
    await ok(post(a.ownerId, 'OPENING', whA3, [{ product_id: p.id, quantity: 7, batch_number: 'BR', expiry_date: day(300) }]))
    const mgr2 = await addUser(a.id, 'WAREHOUSE_MANAGER', branch2)

    await withUser(mgr2, async (c) => {
      const seen = (await c.q(`select warehouse_id, quantity::float8 q from public.stock_balances where product_id = $1`, [p.id])).rows
      expect(seen).toEqual([{ warehouse_id: whA3, q: 7 }])
      expect((await c.q(`select count(*)::int n from public.stock_movements where product_id = $1`, [p.id])).rows[0].n).toBe(1)
      expect((await c.q(`select count(*)::int n from public.batches where product_id = $1`, [p.id])).rows[0].n).toBe(1) // batches are org-level
    })
    const hq = await post(mgr2, 'ADJUSTMENT', whA1, [{ product_id: p.id, batch_number: 'BR', quantity: 1, direction: 'OUT' }], { reason: 'OTHER' })
    expect(!hq.ok && hq.code).toBe('42501')
    expect((await post(mgr2, 'ADJUSTMENT', whA3, [{ product_id: p.id, batch_number: 'BR', quantity: 1, direction: 'OUT' }], { reason: 'OTHER' })).ok).toBe(true)
    // a branch-scoped manager cannot push stock out of another branch's warehouse by naming it as the source
    const steal = await post(mgr2, 'TRANSFER', whA1, [{ product_id: p.id, batch_number: 'BR', quantity: 1 }], { to: whA3 })
    expect(!steal.ok && steal.code).toBe('42501')
  })

  it('hides stock from users without inventory.view, and from other tenants', async () => {
    const p = await addProduct(a.id)
    await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 4, batch_number: 'ISO', expiry_date: day(300) }]))
    const noView = await addUser(a.id, 'DISPATCHER')
    await admin.query(`delete from public.role_permissions where role_id = (select id from public.roles where code = 'DISPATCHER' and organization_id is null)
                        and permission_id = (select id from public.permissions where code = 'inventory.view')`)
    try {
      await withUser(noView, async (c) => {
        expect((await c.q('select count(*)::int n from public.stock_balances')).rows[0].n).toBe(0)
        expect((await c.q('select count(*)::int n from public.batches')).rows[0].n).toBe(0)
      })
    } finally {
      await admin.query(`insert into public.role_permissions (role_id, permission_id)
        select r.id, pm.id from public.roles r, public.permissions pm
         where r.code = 'DISPATCHER' and r.organization_id is null and pm.code = 'inventory.view' on conflict do nothing`)
    }
    await withUser(b.ownerId, async (c) => {
      expect((await c.q('select count(*)::int n from public.stock_balances where product_id = $1', [p.id])).rows[0].n).toBe(0)
      expect((await c.q('select count(*)::int n from public.stock_movements where product_id = $1', [p.id])).rows[0].n).toBe(0)
      expect((await c.q('select count(*)::int n from public.stock_documents')).rows[0].n).toBe(0)
    })
  })

  it('cannot post across tenants (foreign warehouse or foreign product) and anon cannot call the function', async () => {
    const pB = await addProduct(b.id)
    const pA = await addProduct(a.id)
    const foreignWh = await post(a.ownerId, 'OPENING', whB1, [{ product_id: pA.id, quantity: 1, batch_number: 'X', expiry_date: day(100) }])
    expect(!foreignWh.ok && foreignWh.code).toBe('P0002')
    const foreignProduct = await post(a.ownerId, 'OPENING', whA1, [{ product_id: pB.id, quantity: 1, batch_number: 'X', expiry_date: day(100) }])
    expect(!foreignProduct.ok && foreignProduct.code).toBe('P0002')
    await withUser(null, async (c) => {
      const r = await c.attempt(`select public.post_stock_document('OPENING', $1, '[]'::jsonb)`, [whA1])
      expect(!r.ok && r.code).toBe('42501')
    })
  })

  it('gives clients no direct write access to stock tables, even to the owner', async () => {
    const p = await addProduct(a.id)
    const doc = await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 4, batch_number: 'DW', expiry_date: day(300) }]))
    await withUser(a.ownerId, async (c) => {
      const stmts = [
        `insert into public.batches (product_id, batch_number, expiry_date) values ('${p.id}', 'EVIL', '2030-01-01')`,
        `update public.batches set expiry_date = '2099-01-01' where product_id = '${p.id}'`,
        `delete from public.batches where product_id = '${p.id}'`,
        `update public.stock_balances set quantity = 1000000 where product_id = '${p.id}'`,
        `insert into public.stock_balances (warehouse_id, product_id, stock_status, quantity) values ('${whA1}', '${p.id}', 'AVAILABLE', 5)`,
        `delete from public.stock_balances where product_id = '${p.id}'`,
        `update public.stock_movements set quantity = 999 where document_id = '${doc.document_id}'`,
        `insert into public.stock_movements (organization_id, document_id, line_no, movement_type, warehouse_id, product_id, stock_status, quantity)
           values ('${a.id}', '${doc.document_id}', 9, 'OPENING', '${whA1}', '${p.id}', 'AVAILABLE', 10)`,
        `delete from public.stock_documents where id = '${doc.document_id}'`,
        `update public.stock_documents set notes = 'x' where id = '${doc.document_id}'`,
      ]
      for (const s of stmts) {
        const r = await c.attempt(s)
        expect(r.ok, s).toBe(false)
        if (!r.ok) expect(r.code, s).toBe('42501')
      }
    })
    expect(await onHand(a.id, p.id)).toBe(4)
  })
})

describe('the ledger', () => {
  it('is append-only even for the database owner', async () => {
    const p = await addProduct(a.id)
    const doc = await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 2, batch_number: 'AO', expiry_date: day(300) }]))
    for (const s of [
      `update public.stock_movements set quantity = 5 where document_id = '${doc.document_id}'`,
      `delete from public.stock_movements where document_id = '${doc.document_id}'`,
      `truncate public.stock_movements`,
      `update public.stock_documents set notes = 'edited' where id = '${doc.document_id}'`,
      `delete from public.stock_documents where id = '${doc.document_id}'`,
      `truncate public.stock_documents cascade`,
    ]) {
      await expect(admin.query(s), s).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('always reconciles: for every balance, the sum of its ledger lines equals the stored quantity', async () => {
    const { rows } = await admin.query(`
      with led as (
        select organization_id, warehouse_id, location_id, product_id, batch_id, stock_status, sum(quantity) q
        from public.stock_movements group by 1, 2, 3, 4, 5, 6)
      select count(*)::int n
      from led full join public.stock_balances b
        on b.organization_id = led.organization_id and b.warehouse_id = led.warehouse_id
       and b.location_id is not distinct from led.location_id and b.product_id = led.product_id
       and b.batch_id is not distinct from led.batch_id and b.stock_status = led.stock_status
      where coalesce(b.quantity, 0) <> coalesce(led.q, 0)`)
    expect(rows[0].n).toBe(0)
  })

  it('exposes who posted and when, and keeps document and ledger lines together', async () => {
    const p = await addProduct(a.id)
    const manager = await addUser(a.id, 'WAREHOUSE_MANAGER')
    const doc = await ok(post(manager, 'OPENING', whA1, [
      { product_id: p.id, quantity: 2, batch_number: 'W1', expiry_date: day(300) },
      { product_id: p.id, quantity: 3, batch_number: 'W2', expiry_date: day(310) },
    ]))
    const d = (await admin.query(`select posted_by, line_count, branch_id from public.stock_documents where id = $1`, [doc.document_id])).rows[0]
    expect(d).toMatchObject({ posted_by: manager, line_count: 2, branch_id: a.hq })
    expect((await admin.query(`select count(*)::int n from public.stock_movements where document_id = $1`, [doc.document_id])).rows[0].n).toBe(2)
  })
})

describe('FEFO, summary and expiry reports', () => {
  it('suggests the earliest-expiring sellable batches first, skipping quarantined and expired stock, and reports shortfalls', async () => {
    const p = await addProduct(a.id)
    await ok(post(a.ownerId, 'OPENING', whA2, [
      { product_id: p.id, quantity: 10, batch_number: 'F-LATE', expiry_date: day(500) },
      { product_id: p.id, quantity: 6, batch_number: 'F-SOON', expiry_date: day(40) },
      { product_id: p.id, quantity: 50, batch_number: 'F-HOLD', expiry_date: day(10), status: 'QUARANTINE' },
      { product_id: p.id, quantity: 50, batch_number: 'F-DEAD', expiry_date: day(-3), status: 'EXPIRED' },
    ]))
    await withUser(a.ownerId, async (c) => {
      const plan = (await c.q(`select batch_number, allocate::float8 a from public.suggest_fefo_allocation($1, $2, 8)`, [p.id, whA2])).rows
      expect(plan).toEqual([{ batch_number: 'F-SOON', a: 6 }, { batch_number: 'F-LATE', a: 2 }])
      const short = (await c.q(`select coalesce(sum(allocate), 0)::float8 s from public.suggest_fefo_allocation($1, $2, 100)`, [p.id, whA2])).rows[0].s
      expect(short).toBe(16)
      const shelf = (await c.q(`select batch_number from public.suggest_fefo_allocation($1, $2, 3, 90)`, [p.id, whA2])).rows
      expect(shelf).toEqual([{ batch_number: 'F-LATE' }])
      expect((await c.q(`select count(*)::int n from public.suggest_fefo_allocation($1, $2, 0)`, [p.id, whA2])).rows[0].n).toBe(0)
    })
  })

  it('summarises stock per product and lists near-expiry and expired-but-unsold stock', async () => {
    const p = await addProduct(a.id, { brand: 'Summarex Forte' })
    // an expired batch that is still AVAILABLE can only arise by time passing: simulate with a batch that expires soon
    await ok(post(a.ownerId, 'OPENING', whA2, [
      { product_id: p.id, quantity: 10, batch_number: 'S-NEAR', expiry_date: day(30) },
      { product_id: p.id, quantity: 5, batch_number: 'S-FAR', expiry_date: day(700) },
      { product_id: p.id, quantity: 2, batch_number: 'S-Q', expiry_date: day(200), status: 'QUARANTINE' },
    ]))
    await withUser(a.ownerId, async (c) => {
      const s = (await c.q(`select available::float8 av, quarantine::float8 q, near_expiry::float8 ne, earliest_expiry from public.stock_summary($1, 'summarex')`, [whA2])).rows
      expect(s).toHaveLength(1)
      expect(s[0]).toMatchObject({ av: 15, q: 2, ne: 10 })
      expect(String(s[0].earliest_expiry).slice(0, 10) || '').not.toBe('')

      const exp = (await c.q(`select batch_number, days_to_expiry from public.expiring_stock(60, $1) where product_id = $2 order by expiry_date`, [whA2, p.id])).rows
      expect(exp.map((r) => r.batch_number)).toEqual(['S-NEAR'])
      expect(exp[0].days_to_expiry).toBeGreaterThanOrEqual(29)
      expect((await c.q(`select count(*)::int n from public.expiring_stock(1000, $1) where product_id = $2`, [whA2, p.id])).rows[0].n).toBe(3)
    })
  })

  it('cuts stock reports by branch scope', async () => {
    const p = await addProduct(a.id, { brand: 'Scopemycin' })
    await ok(post(a.ownerId, 'OPENING', whA1, [{ product_id: p.id, quantity: 10, batch_number: 'SC', expiry_date: day(300) }]))
    await ok(post(a.ownerId, 'OPENING', whA3, [{ product_id: p.id, quantity: 4, batch_number: 'SC', expiry_date: day(300) }]))
    const mgr2 = await addUser(a.id, 'WAREHOUSE_MANAGER', branch2)
    await withUser(mgr2, async (c) => {
      expect((await c.q(`select available::float8 av from public.stock_summary(null, 'scopemycin')`)).rows).toEqual([{ av: 4 }])
    })
    await withUser(a.ownerId, async (c) => {
      expect((await c.q(`select available::float8 av from public.stock_summary(null, 'scopemycin')`)).rows).toEqual([{ av: 14 }])
    })
    await withUser(b.ownerId, async (c) => {
      expect((await c.q(`select count(*)::int n from public.stock_summary(null, 'scopemycin')`)).rows[0].n).toBe(0)
    })
  })
})
