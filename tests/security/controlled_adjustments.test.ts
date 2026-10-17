import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addProduct, addUser, addWarehouse, admin, closePool, createOrg, withUser, type Org } from '../helpers/db'

let a: Org
let b: Org
let wh: string
let branch2: string
let whB2: string
let owner: string
let storeman: string     // WAREHOUSE_MANAGER: inventory.adjust, no approval right
let pharmacist: string   // PHARMACIST: approval right, no adjust right
let pharmacistB2: string // PHARMACIST limited to branch 2
let cashier: string
let controlled: { id: string }
let ordinary: { id: string }
let batchId: string

type Out = { ok: true; rows: any[] } | { ok: false; code: string; message: string }
const call = (user: string, sql: string, params: unknown[] = []): Promise<Out> => withUser(user, (c) => c.attempt(sql, params), { commit: true }) as Promise<Out>
const ok = async (p: Promise<Out>) => { const r = await p; if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`); return r.rows[0] }
const failure = async (p: Promise<Out>) => { const r = await p; return r.ok ? { code: 'ok', message: '' } : { code: r.code, message: r.message } }
const code = async (p: Promise<Out>) => (await failure(p)).code
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const onHand = async (productId: string) => Number((await q(`select coalesce(sum(quantity), 0) n from public.stock_balances where product_id = $1`, [productId]))[0].n)

const direct = (user: string, productId: string, qty = 1) =>
  call(user, `select public.post_stock_document('ADJUSTMENT', $1, $2::jsonb, null, 'DAMAGE', 'broken') as r`, [wh, JSON.stringify([{ product_id: productId, batch_id: batchId, quantity: qty, direction: 'OUT' }])])
const request = (user: string, o: { qty?: number; reason?: string | null; notes?: string | null; product?: string; warehouse?: string } = {}) =>
  call(user, `select public.request_controlled_adjustment($1, $2::jsonb, $3, $4) as r`,
    [o.warehouse ?? wh, JSON.stringify([{ product_id: o.product ?? controlled.id, batch_id: batchId, quantity: o.qty ?? 2, direction: 'OUT' }]), o.reason === undefined ? 'DAMAGE' : o.reason, o.notes === undefined ? 'Two ampoules broken in the cold room' : o.notes])
const row = async (id: string) => (await q(`select * from public.controlled_adjustments where id = $1`, [id]))[0]

beforeAll(async () => {
  a = await createOrg('CDA-A')
  b = await createOrg('CDA-B')
  wh = await addWarehouse(a.id, a.hq, 'W1')
  branch2 = await addBranch(a.id, 'B2')
  whB2 = await addWarehouse(a.id, branch2, 'W2')
  owner = a.ownerId
  storeman = await addUser(a.id, 'WAREHOUSE_MANAGER')
  pharmacist = await addUser(a.id, 'PHARMACIST')
  pharmacistB2 = await addUser(a.id, 'PHARMACIST', branch2)
  cashier = await addUser(a.id, 'CASHIER')
  controlled = await addProduct(a.id, { cls: 'CONTROLLED' })
  ordinary = await addProduct(a.id, { cls: 'GSL' })
  for (const p of [controlled, ordinary]) {
    await ok(call(owner, `select public.post_stock_document('OPENING', $1, $2::jsonb) as r`, [wh, JSON.stringify([{ product_id: p.id, quantity: 50, batch_number: 'CB1', expiry_date: day(400) }])]))
  }
  batchId = (await q(`select id from public.batches where product_id = $1`, [controlled.id]))[0].id
})
afterAll(closePool)

describe('controlled medicines cannot be adjusted by one person', () => {
  it('refuses a direct adjustment of a controlled product for everyone, but not of an ordinary one', async () => {
    expect((await failure(direct(storeman, controlled.id))).message).toMatch(/second person's approval/)
    expect(await code(direct(owner, controlled.id))).toBe('42501')
    const ordinaryBatch = (await q(`select id from public.batches where product_id = $1`, [ordinary.id]))[0].id
    const r = await call(storeman, `select public.post_stock_document('ADJUSTMENT', $1, $2::jsonb, null, 'DAMAGE', 'broken') as r`, [wh, JSON.stringify([{ product_id: ordinary.id, batch_id: ordinaryBatch, quantity: 1, direction: 'OUT' }])])
    expect(r.ok).toBe(true)
    expect(await onHand(controlled.id)).toBe(50)
  })
})

describe('requesting', () => {
  it('lets someone with the adjust right request, with a reason and an explanation, for controlled products only', async () => {
    expect(await code(request(pharmacist))).toBe('42501')                                   // approves, but does not adjust
    expect(await code(request(cashier))).toBe('42501')
    expect(await code(request(storeman, { reason: null }))).toBe('22023')
    expect(await code(request(storeman, { reason: 'WHIM' }))).toBe('22023')
    expect(await code(request(storeman, { notes: 'x' }))).toBe('22023')
    expect(await code(request(storeman, { notes: null }))).toBe('22023')
    expect(await code(request(storeman, { product: ordinary.id }))).toBe('22023')            // ordinary stock is adjusted directly
    expect(await code(request(storeman, { warehouse: whB2 }))).toBe('ok')                    // (an adjust right at the head office branch covers every branch here)
    const r = (await ok(request(storeman))).r
    expect(r.request_number).toMatch(/^CDA-\d{4}-\d{6}$/)
    expect(await row(r.id)).toMatchObject({ status: 'PENDING', requested_by: storeman, reason_code: 'DAMAGE', branch_id: a.hq })
    expect(await onHand(controlled.id)).toBe(50)                                              // nothing moved yet
    expect((await q(`select count(*)::int n from public.audit_logs where action = 'controlled_adjustment.created' and entity_id = $1`, [r.id]))[0].n).toBe(1)
  })

  it('shows requests to the people who raise or decide them, and to nobody else', async () => {
    const seen = async (user: string) => withUser(user, async (c) => (await c.q(`select count(*)::int n from public.controlled_adjustments`)).rows[0].n)
    expect(await seen(storeman)).toBeGreaterThan(0)
    expect(await seen(pharmacist)).toBeGreaterThan(0)
    expect(await seen(cashier)).toBe(0)
    expect(await seen(b.ownerId)).toBe(0)
    for (const sql of [`update public.controlled_adjustments set status = 'APPROVED'`, `delete from public.controlled_adjustments`, `insert into public.controlled_adjustments (request_number) values ('x')`]) {
      expect(await code(call(owner, sql)), sql).toBe('42501')
    }
  })
})

describe('deciding', () => {
  it('needs a second person with the approval right: not the requester, even an owner, and not someone without the right', async () => {
    const id = (await ok(request(owner))).r.id
    expect((await failure(call(owner, `select public.approve_controlled_adjustment($1)`, [id]))).message).toMatch(/second person/)
    expect(await code(call(storeman, `select public.approve_controlled_adjustment($1)`, [id]))).toBe('42501')
    expect(await code(call(cashier, `select public.approve_controlled_adjustment($1)`, [id]))).toBe('42501')
    expect(await code(call(b.ownerId, `select public.approve_controlled_adjustment($1)`, [id]))).toBe('P0002')
    expect(await row(id)).toMatchObject({ status: 'PENDING', stock_document_id: null })
    expect(await onHand(controlled.id)).toBe(50)
  })

  it('posts the stock document on approval, attributed to the approver, and cannot be approved twice', async () => {
    const id = (await ok(request(storeman, { qty: 3 }))).r.id
    const doc = (await ok(call(pharmacist, `select public.approve_controlled_adjustment($1) as r`, [id]))).r
    expect(await onHand(controlled.id)).toBe(47)
    expect(await row(id)).toMatchObject({ status: 'APPROVED', decided_by: pharmacist, stock_document_id: doc.document_id })
    const [d] = await q(`select document_type, source_type, source_id, posted_by, reason_code, notes from public.stock_documents where id = $1`, [doc.document_id])
    expect(d).toMatchObject({ document_type: 'ADJUSTMENT', source_type: 'CONTROLLED_ADJUSTMENT', source_id: id, posted_by: pharmacist, reason_code: 'DAMAGE' })
    expect(d.notes).toMatch(/^CDA-\d{4}-\d{6}: Two ampoules/)
    expect((await q(`select quantity::float8 q from public.stock_movements where document_id = $1`, [doc.document_id]))).toEqual([{ q: -3 }])
    expect((await failure(call(pharmacist, `select public.approve_controlled_adjustment($1)`, [id]))).message).toMatch(/already approved/)
    expect((await failure(call(pharmacist, `select public.reject_controlled_adjustment($1, 'too late now')`, [id]))).message).toMatch(/already approved/)
  })

  it('stays pending when the stock is not there, so the approver can reject it', async () => {
    const id = (await ok(request(storeman, { qty: 5000 }))).r.id
    expect((await failure(call(pharmacist, `select public.approve_controlled_adjustment($1)`, [id]))).code).not.toBe('ok')
    expect((await row(id)).status).toBe('PENDING')
    expect(await code(call(pharmacist, `select public.reject_controlled_adjustment($1, 'no')`, [id]))).toBe('22023')
    expect(await code(call(storeman, `select public.reject_controlled_adjustment($1, 'not mine to reject')`, [id]))).toBe('42501')
    await ok(call(pharmacist, `select public.reject_controlled_adjustment($1, 'The count shows only 47 on the shelf')`, [id]))
    expect(await row(id)).toMatchObject({ status: 'REJECTED', decided_by: pharmacist, decision_note: 'The count shows only 47 on the shelf' })
    expect((await failure(call(pharmacist, `select public.approve_controlled_adjustment($1)`, [id]))).message).toMatch(/already rejected/)
  })

  it('lets only the requester withdraw a pending request', async () => {
    const id = (await ok(request(storeman))).r.id
    expect(await code(call(pharmacist, `select public.cancel_controlled_adjustment($1)`, [id]))).toBe('42501')
    expect(await code(call(owner, `select public.cancel_controlled_adjustment($1)`, [id]))).toBe('42501')
    await ok(call(storeman, `select public.cancel_controlled_adjustment($1)`, [id]))
    expect((await row(id)).status).toBe('CANCELLED')
    expect((await failure(call(pharmacist, `select public.approve_controlled_adjustment($1)`, [id]))).message).toMatch(/already cancelled/)
    expect(await code(call(storeman, `select public.cancel_controlled_adjustment($1)`, [id]))).toBe('22023')
  })

  it('keeps a branch-limited approver to their own branch', async () => {
    const id = (await ok(request(storeman, { qty: 1 }))).r.id                              // a request at the head office branch
    expect(await code(call(pharmacistB2, `select public.approve_controlled_adjustment($1)`, [id]))).toBe('42501')
    expect(await code(call(pharmacistB2, `select public.reject_controlled_adjustment($1, 'not my branch to decide')`, [id]))).toBe('42501')
    await ok(call(pharmacist, `select public.approve_controlled_adjustment($1)`, [id]))
  })

  it('leaves a trail: audit entries for the request and the decision, and the controlled-drugs register shows the movement', async () => {
    const id = (await q(`select id from public.controlled_adjustments where status = 'APPROVED' order by created_at limit 1`))[0].id
    const actions = (await q(`select action from public.audit_logs where entity_type = 'controlled_adjustment' and entity_id = $1 order by created_at`, [id])).map((r) => r.action)
    expect(actions).toEqual(['controlled_adjustment.created', 'controlled_adjustment.updated'])
    const reg = await withUser(owner, async (c) => (await c.q(`select movement_type from public.controlled_drug_register($1, current_date - 1, current_date + 1, null) where movement_type = 'ADJUSTMENT_OUT'`, [controlled.id])).rows)
    expect(reg.length).toBeGreaterThanOrEqual(2)
  })
})
