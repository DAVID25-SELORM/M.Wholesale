import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, admin, closePool, createOrg, type Org } from '../helpers/db'

let org: Org

beforeAll(async () => {
  org = await createOrg('NUM')
})
afterAll(closePool)

const gen = (branch: string | null, type: string, prefix?: string) =>
  admin.query('select private.generate_document_number($1, $2, $3, $4) as n', [org.id, branch, type, prefix ?? null]).then((r) => r.rows[0].n as string)

describe('15: atomic document numbering', () => {
  it('60 concurrent callers receive 60 distinct, gap-free numbers', async () => {
    const results = await Promise.all(Array.from({ length: 60 }, () => gen(null, 'INVOICE', 'INV')))
    expect(new Set(results).size).toBe(60)
    const nums = results.map((r) => Number(r.split('-').pop())).sort((x, y) => x - y)
    expect(nums[0]).toBe(1)
    expect(nums[59]).toBe(60)
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBe(nums[i - 1]! + 1)
    expect(results[0]).toMatch(/^INV-\d{4}-\d{6}$/)
  })

  it('sequences are independent per document type and per branch', async () => {
    const b2 = await addBranch(org.id, 'NB2')
    expect(await gen(null, 'PURCHASE_ORDER', 'PO')).toMatch(/-000001$/)
    expect(await gen(b2, 'PURCHASE_ORDER', 'PO')).toMatch(/-000001$/)
    expect(await gen(null, 'PURCHASE_ORDER', 'PO')).toMatch(/-000002$/)
    expect(await gen(b2, 'PURCHASE_ORDER', 'PO')).toMatch(/-000002$/)
  })

  it('a rolled-back transaction releases its number (no gaps)', async () => {
    const c = await admin.connect()
    try {
      await c.query('begin')
      const r = await c.query('select private.generate_document_number($1, null, $2, $3) as n', [org.id, 'GRN', 'GRN'])
      await c.query('rollback')
      const next = await gen(null, 'GRN', 'GRN')
      expect(next).toBe(r.rows[0].n)
      expect(next).toMatch(/-000001$/)
    } finally {
      c.release()
    }
  })

  it('resets per period, supports NEVER/MONTHLY, and never truncates wide numbers', async () => {
    await gen(null, 'RETURN', 'RET')
    await admin.query(`update public.number_sequences set next_number = 500, current_period = '1999' where organization_id = $1 and document_type = 'RETURN'`, [org.id])
    expect(await gen(null, 'RETURN', 'RET')).toMatch(/^RET-\d{4}-000001$/)

    await gen(null, 'TRANSFER', 'TRF')
    await admin.query(`update public.number_sequences set reset_period = 'NEVER', current_period = '', next_number = 7 where organization_id = $1 and document_type = 'TRANSFER'`, [org.id])
    expect(await gen(null, 'TRANSFER', 'TRF')).toBe('TRF-000007')

    await gen(null, 'PAYMENT', 'PAY')
    await admin.query(`update public.number_sequences set reset_period = 'MONTHLY', current_period = '' where organization_id = $1 and document_type = 'PAYMENT'`, [org.id])
    expect(await gen(null, 'PAYMENT', 'PAY')).toMatch(/^PAY-\d{6}-000001$/)

    await gen(null, 'QUOTE', 'QT')
    await admin.query(`update public.number_sequences set reset_period = 'NEVER', current_period = '', padding = 3, next_number = 12345 where organization_id = $1 and document_type = 'QUOTE'`, [org.id])
    expect(await gen(null, 'QUOTE', 'QT')).toBe('QT-12345')
  })

  it('rejects unknown organizations and malformed document types', async () => {
    await expect(admin.query(`select private.generate_document_number(gen_random_uuid(), null, 'INVOICE')`)).rejects.toMatchObject({ code: '23503' })
    await expect(admin.query(`select private.generate_document_number($1, null, 'bad type')`, [org.id])).rejects.toMatchObject({ code: '23514' })
  })
})
