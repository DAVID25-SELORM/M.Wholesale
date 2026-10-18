import { supabase } from '@/lib/supabase'
import type { OpeningPlanRow, ProductLookup, StockLookups } from '@/modules/imports/openingStock'
import type { ImportKind, ImportRow, ImportSpec } from '@/modules/imports/specs'
import { unwrap } from './common'
import { postStockDocument, type PostLine } from './inventory'

export type RowStatus = 'VALID' | 'CREATED' | 'EXISTS' | 'ERROR'

export interface RowOutcome {
  /** the row number in the person's spreadsheet */
  line: number
  key: string
  status: RowStatus
  message: string | null
}

export const CHUNK = 200

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}

interface ServerRow { row: number; key: string; status: RowStatus; message: string | null }

/** Products and suppliers: the database checks (dry run) or creates (real run) each row on its own. */
export async function runDatabaseImport(
  kind: Exclude<ImportKind, 'opening_stock'>,
  rows: ImportRow[],
  dryRun: boolean,
  onProgress: (done: number) => void,
): Promise<RowOutcome[]> {
  const out: RowOutcome[] = []
  let done = 0
  for (const part of chunks(rows, CHUNK)) {
    const payload = part.map((r) => r.values)
    const args = { p_rows: payload as unknown as never, p_dry_run: dryRun }
    const call = kind === 'products' ? supabase.rpc('import_products', args)
      : kind === 'suppliers' ? supabase.rpc('import_suppliers', args)
      : kind === 'customers' ? supabase.rpc('import_customers', args)
      : kind === 'opening_receivables' ? supabase.rpc('import_opening_receivables', args)
      : supabase.rpc('import_opening_payables', args)
    const res = unwrap(await call, `import.${kind}`) as unknown as ServerRow[]
    for (const r of res) out.push({ line: part[r.row - 1]!.line, key: r.key, status: r.status, message: r.message })
    done += part.length
    onProgress(done)
  }
  return out
}

// ---- opening stock ---------------------------------------------------------------------------------------------------
/** Finds the products, warehouses and locations a stock file refers to. Only what the file mentions is fetched. */
export async function loadStockLookups(rows: ImportRow[]): Promise<StockLookups> {
  const skus = [...new Set(rows.map((r) => (r.values.sku ?? '').toUpperCase()).filter(Boolean))]
  const products = new Map<string, ProductLookup>()
  for (const part of chunks(skus, 150)) {
    const found = unwrap(await supabase.from('products').select('id, sku, track_batches').in('sku', part), 'import.lookup.products')
    const ids = found.map((p) => p.id)
    const units = ids.length
      ? unwrap(await supabase.from('product_units').select('id, product_id, factor_to_base, is_base, is_active, unit:units_of_measure(code)').in('product_id', ids), 'import.lookup.units')
      : []
    for (const p of found) {
      const map: ProductLookup['units'] = new Map()
      for (const u of units.filter((x) => x.product_id === p.id && x.is_active)) {
        const code = (u as unknown as { unit: { code: string } | null }).unit?.code
        if (code) map.set(code.toUpperCase(), { id: u.id, factor: Number(u.factor_to_base), isBase: u.is_base })
      }
      products.set(p.sku.toUpperCase(), { id: p.id, tracksBatches: p.track_batches, units: map })
    }
  }

  const whs = unwrap(await supabase.from('warehouses').select('id, code, is_active').eq('is_active', true).limit(1000), 'import.lookup.warehouses')
  const warehouses = new Map(whs.map((w) => [w.code.toUpperCase(), { id: w.id }]))
  const locations = new Map<string, string>()
  const wanted = [...new Set(rows.filter((r) => r.values.location).map((r) => (r.values.warehouse ?? '').toUpperCase()))]
    .map((c) => warehouses.get(c)?.id).filter((x): x is string => Boolean(x))
  for (const wid of wanted) {
    for (let from = 0; ; from += 1000) {
      const page = unwrap(await supabase.from('warehouse_locations').select('id, code').eq('warehouse_id', wid).eq('is_active', true).range(from, from + 999), 'import.lookup.locations')
      for (const l of page) locations.set(`${wid}|${l.code.toUpperCase()}`, l.id)
      if (page.length < 1000) break
    }
  }
  return { products, warehouses, locations }
}

/**
 * Posts the valid rows as OPENING stock, one document per warehouse and 200 lines. If a whole document is refused (for example one
 * batch has already expired), its rows are retried one by one so the good ones still go in and each bad one gets its own message.
 */
export async function runOpeningStock(plan: OpeningPlanRow[], note: string, onProgress: (done: number) => void): Promise<RowOutcome[]> {
  const outcomes = new Map<number, RowOutcome>()
  const good = plan.filter((p) => p.ok && p.stockLine && p.warehouseId)
  for (const p of plan.filter((x) => !x.ok)) outcomes.set(p.line, { line: p.line, key: p.key, status: 'ERROR', message: p.error ?? null })

  const byWarehouse = new Map<string, OpeningPlanRow[]>()
  for (const p of good) byWarehouse.set(p.warehouseId!, [...(byWarehouse.get(p.warehouseId!) ?? []), p])

  let done = plan.length - good.length
  onProgress(done)
  for (const [warehouseId, list] of byWarehouse) {
    for (const part of chunks(list, CHUNK)) {
      const post = (rows: OpeningPlanRow[]) => postStockDocument({ type: 'OPENING', warehouseId, lines: rows.map((r) => r.stockLine as PostLine), notes: note })
      try {
        await post(part)
        for (const r of part) outcomes.set(r.line, { line: r.line, key: r.key, status: 'CREATED', message: null })
      } catch (e) {
        if (part.length === 1) {
          outcomes.set(part[0]!.line, { line: part[0]!.line, key: part[0]!.key, status: 'ERROR', message: e instanceof Error ? e.message : 'could not be posted' })
        } else {
          for (const r of part) {
            try {
              await post([r])
              outcomes.set(r.line, { line: r.line, key: r.key, status: 'CREATED', message: null })
            } catch (err) {
              outcomes.set(r.line, { line: r.line, key: r.key, status: 'ERROR', message: err instanceof Error ? err.message : 'could not be posted' })
            }
          }
        }
      }
      done += part.length
      onProgress(done)
    }
  }
  return plan.map((p) => outcomes.get(p.line)!).filter(Boolean)
}

/** What a dry run says about stock rows that passed our own checks: they are "valid" if nothing stopped them. */
export function stockCheckOutcomes(plan: OpeningPlanRow[]): RowOutcome[] {
  return plan.map((p) => ({ line: p.line, key: p.key, status: p.ok ? 'VALID' : 'ERROR', message: p.ok ? null : (p.error ?? null) }))
}

export const specTitle = (s: ImportSpec) => s.title
