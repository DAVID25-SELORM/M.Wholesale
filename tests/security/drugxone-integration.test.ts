import { afterAll, beforeAll, expect, it } from 'vitest'
import { addProduct, admin, closePool, createOrg, withUser, type Org } from '../helpers/db'

let org: Org
let other: Org
let connection: string
let product: string

beforeAll(async () => {
  org = await createOrg('DRUGXONE')
  other = await createOrg('DRUGXONE-OTHER')
  product = (await addProduct(org.id)).id
  connection = (await withUser(org.ownerId, c => c.q("select public.drugxone_set_connection('SANDBOX','https://sandbox.drugxone.test/api','business-1','READY','Configure sandbox') id"), { commit: true })).rows[0].id
})

afterAll(closePool)

it('keeps credentials out of the connection record and supports safe product mappings', async () => {
  const connectionData = (await withUser(org.ownerId, c => c.q('select public.drugxone_connection_read() data'))).rows[0].data
  expect(connectionData).toMatchObject({ status: 'READY', environment: 'SANDBOX', base_url: 'https://sandbox.drugxone.test/api', external_business_id: 'business-1' })
  expect(JSON.stringify(connectionData)).not.toMatch(/token|secret|key/i)

  const mapping = (await withUser(org.ownerId, c => c.q("select public.drugxone_set_product_mapping($1,'master-1','offer-1','SKU-1','Amoxicillin 500 mg','Map product') id", [product]), { commit: true })).rows[0].id
  const row = (await withUser(org.ownerId, c => c.q('select id,product_id,external_offer_id,status from public.drugxone_product_mappings'))).rows[0]
  expect(row).toEqual({ id: mapping, product_id: product, external_offer_id: 'offer-1', status: 'PENDING' })
})

it('is tenant isolated and makes sync events idempotent', async () => {
  const key = `catalogue-${connection}`
  const first = (await admin.query("select private.drugxone_enqueue_event($1,$2,'ERP_TO_DRUGXONE','CATALOGUE',null,null,$3,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',jsonb_build_object('product','offer-1')) id", [org.id, connection, key])).rows[0].id
  const second = (await admin.query("select private.drugxone_enqueue_event($1,$2,'ERP_TO_DRUGXONE','CATALOGUE',null,null,$3,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',jsonb_build_object('product','offer-1')) id", [org.id, connection, key])).rows[0].id
  expect(second).toBe(first)
  await expect(admin.query("select private.drugxone_enqueue_event($1,$2,'ERP_TO_DRUGXONE','CATALOGUE',null,null,$3,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',jsonb_build_object('product','different'))", [org.id, connection, key])).rejects.toMatchObject({ code: '22023' })
  const queue = (await withUser(org.ownerId, c => c.q('select public.drugxone_sync_queue() data'))).rows[0].data
  expect(queue.total).toBe(1)
  expect(queue.rows[0].payload).toBeUndefined()
  expect((await withUser(other.ownerId, c => c.q('select public.drugxone_sync_queue() data'))).rows[0].data.total).toBe(0)
  expect((await withUser(org.ownerId, c => c.attempt("select public.drugxone_set_connection('PRODUCTION','http://prod.example','business-1','Invalid URL')", []))).ok).toBe(false)
  expect((await withUser(null, c => c.attempt('select public.drugxone_connection_read()'))).ok).toBe(false)
})
