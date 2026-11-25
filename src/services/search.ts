import { supabase } from '@/lib/supabase'
import { unwrap } from './common'

export interface SearchHit { section: string; id: string; title: string; detail: string; to: string }

/** Removes the characters that have a meaning inside a PostgREST filter or a LIKE pattern. */
export function cleanTerm(raw: string): string {
  return raw.replace(/[%_*"\\(),]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
}
const like = (columns: string[], term: string) => columns.map((c) => `${c}.ilike."%${term}%"`).join(',')
const PER_SECTION = 5

interface Source { permission: string; run: (term: string) => Promise<SearchHit[]> }

const SOURCES: Source[] = [
  { permission: 'products.view', run: async (t) => unwrap(await supabase.from('products').select('id,sku,brand_name').or(like(['brand_name', 'sku'], t)).order('brand_name').limit(PER_SECTION), 'search.products')
    .map((r) => ({ section: 'Products', id: r.id, title: r.brand_name, detail: r.sku, to: `/catalog/products/${r.id}` })) },
  { permission: 'customers.view', run: async (t) => unwrap(await supabase.from('customers').select('id,code,name').or(like(['name', 'code'], t)).order('name').limit(PER_SECTION), 'search.customers')
    .map((r) => ({ section: 'Customers', id: r.id, title: r.name, detail: r.code, to: `/sales/customers/${r.id}` })) },
  { permission: 'suppliers.view', run: async (t) => unwrap(await supabase.from('suppliers').select('id,code,name').or(like(['name', 'code'], t)).order('name').limit(PER_SECTION), 'search.suppliers')
    .map((r) => ({ section: 'Suppliers', id: r.id, title: r.name, detail: r.code, to: '/purchasing/suppliers' })) },
  { permission: 'sales.view', run: async (t) => unwrap(await supabase.from('sales_invoices').select('id,invoice_number,status').ilike('invoice_number', `%${t}%`).order('invoice_number', { ascending: false }).limit(PER_SECTION), 'search.invoices')
    .map((r) => ({ section: 'Sales invoices', id: r.id, title: r.invoice_number ?? '', detail: r.status, to: `/sales/invoices/${r.id}` })) },
  { permission: 'purchasing.view', run: async (t) => unwrap(await supabase.from('purchase_orders').select('id,po_number,status').ilike('po_number', `%${t}%`).order('po_number', { ascending: false }).limit(PER_SECTION), 'search.purchaseOrders')
    .map((r) => ({ section: 'Purchase orders', id: r.id, title: r.po_number ?? '', detail: r.status, to: `/purchasing/orders/${r.id}` })) },
]

/**
 * Looks across the records the signed-in person may open. Which sections are asked for follows their permissions
 * (so nothing is offered that they cannot open); what comes back is decided by row-level security, so results
 * never cross an organization or a branch the person has no access to.
 */
export async function globalSearch(raw: string, can: (permission: string) => boolean): Promise<SearchHit[]> {
  const term = cleanTerm(raw)
  if (term.length < 2) return []
  const results = await Promise.all(SOURCES.filter((s) => can(s.permission)).map((s) => s.run(term)))
  return results.flat()
}
