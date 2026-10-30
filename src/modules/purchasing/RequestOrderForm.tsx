import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { Button, Field, Input, Select, InlineError } from '@/components/ui'
import { listSupplierOptions } from '@/services/suppliers'
import { listWarehouseOptions } from '@/services/warehouses'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import { toAppError } from '@/lib/errors'
import type { Tables } from '@/types/domain'

export function RequestOrderForm({ request, refresh }: { request: Tables<'purchase_requests'>; refresh: () => Promise<unknown> }) {
  const navigate = useNavigate()
  const [supplier, setSupplier] = useState('')
  const [warehouse, setWarehouse] = useState(request.warehouse_id ?? '')
  const [costs, setCosts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const suppliers = useQuery({ queryKey: ['supplier-options'], queryFn: listSupplierOptions })
  const warehouses = useQuery({ queryKey: ['warehouse-options', request.branch_id], queryFn: () => listWarehouseOptions(request.branch_id) })
  if (request.purchase_order_id) return <Link to={`/purchasing/orders/${request.purchase_order_id}`}>View purchase order</Link>
  const lines = Array.isArray(request.lines) ? request.lines.flatMap(l => l && typeof l === 'object' && !Array.isArray(l) && typeof l.product_id === 'string' ? [{ id: l.product_id, label: String(l.label ?? l.product_id), quantity: String(l.quantity) }] : []) : []
  return <details><summary>Create draft purchase order</summary><form className="space-y-3 mt-3" onSubmit={e => {
    e.preventDefault(); if (busy) return
    setBusy(true); setError(null)
    void (async () => {
      try {
        const id = unwrap(await supabase.rpc('convert_purchase_request', { p_id: request.id, p_supplier: supplier, p_warehouse: warehouse, p_costs: Object.fromEntries(lines.map(l => [l.id, Number(costs[l.id])])) }), 'requests.convert')
        await refresh(); navigate(`/purchasing/orders/${id}`)
      } catch (err) { setError(toAppError(err).message) } finally { setBusy(false) }
    })()
  }}>
    <p>Approved quantities are copied in base units. The draft order still requires purchasing review and approval.</p>
    <InlineError message={error ?? (suppliers.isError ? toAppError(suppliers.error).message : warehouses.isError ? toAppError(warehouses.error).message : null)} />
    <Field label="Order supplier"><Select required value={supplier} onChange={e => setSupplier(e.target.value)}><option value="">Choose supplier</option>{suppliers.data?.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
    <Field label="Order warehouse"><Select required value={warehouse} onChange={e => setWarehouse(e.target.value)}><option value="">Choose warehouse</option>{warehouses.data?.filter(w => !request.warehouse_id || w.id === request.warehouse_id).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
    {lines.map(l => <Field key={l.id} label={`${l.label} (${l.quantity} base units): unit cost in supplier currency`}><Input required type="number" min="0" max="1000000000" step="0.0001" value={costs[l.id] ?? ''} onChange={e => setCosts({ ...costs, [l.id]: e.target.value })} /></Field>)}
    <Button disabled={busy || suppliers.isError || warehouses.isError || !lines.length}>Create draft order</Button>
  </form></details>
}
