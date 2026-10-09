import { useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useState } from 'react'
import { Input } from '@/components/ui'
import { cn, useDebouncedValue } from '@/lib/utils'
import { listProducts, type ProductRow } from '@/services/catalog'

/** Type-ahead product finder backed by search_products (name, SKU, generic, strength, alias, exact barcode). */
export function ProductPicker({ value, onChange }: { value: ProductRow | null; onChange: (p: ProductRow | null) => void }) {
  const [text, setText] = useState('')
  const debounced = useDebouncedValue(text, 250)
  const results = useQuery({
    queryKey: ['products', 'picker', debounced],
    queryFn: () => listProducts({ page: 0, pageSize: 8, search: debounced, status: 'active', productClass: '', categoryId: '' }),
    enabled: debounced.trim().length >= 2,
    staleTime: 30_000,
  })

  return (
    <div className="space-y-2">
      {value ? (
        <div className="flex items-center justify-between rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-sm">
          <span><span className="font-medium text-slate-900">{value.brand_name}</span> <span className="font-mono text-xs text-slate-500">{value.sku}</span></span>
          <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => onChange(null)}>Change</button>
        </div>
      ) : (
        <>
          <Input aria-label="Search products" placeholder="Search by name, SKU or barcode…" value={text} onChange={(e) => setText(e.target.value)} />
          {debounced.trim().length >= 2 && (
            <ul role="listbox" aria-label="Product results" className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
              {results.isFetching && <li className="px-3 py-2 text-sm text-slate-500">Searching…</li>}
              {!results.isFetching && (results.data?.rows ?? []).length === 0 && <li className="px-3 py-2 text-sm text-slate-500">No active products match.</li>}
              {(results.data?.rows ?? []).map((p) => (
                <li key={p.id} role="option" aria-selected={false}>
                  <button type="button" onClick={() => { onChange(p); setText('') }} className={cn('flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50')}>
                    <span className="min-w-0"><span className="font-medium text-slate-900">{p.brand_name}</span>
                      <span className="block truncate text-xs text-slate-500">{[p.sku, p.generic_name, p.strength_text].filter(Boolean).join(' · ')}</span></span>
                    <Check className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
