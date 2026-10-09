import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge, Button, Card, DataTable, PageHeader, Pagination, SearchInput, Select, StatusBadge, type Column } from '@/components/ui'
import { useTableState } from '@/hooks/useTableState'
import { toAppError } from '@/lib/errors'
import { useSession } from '@/modules/session/SessionProvider'
import { StatusFilter } from '@/modules/shared/StatusFilter'
import { PRODUCT_CLASSES, PRODUCT_CLASS_LABEL, listProducts, type ProductClass, type ProductRow } from '@/services/catalog'
import { ProductForm } from './ProductForm'

const PAGE_SIZE = 20

export function ProductsPage() {
  const { ability } = useSession()
  const navigate = useNavigate()
  const { state, setPage, setSearch, setStatus } = useTableState<'name'>({ key: 'name', direction: 'asc' })
  const [productClass, setProductClass] = useState<ProductClass | ''>('')
  const [creating, setCreating] = useState(false)

  const params = { page: state.page, pageSize: PAGE_SIZE, search: state.search, status: state.status, productClass, categoryId: '' }
  const query = useQuery({ queryKey: ['products', params], queryFn: () => listProducts(params), placeholderData: (prev) => prev })

  const columns: Column<ProductRow>[] = [
    { key: 'sku', header: 'SKU', render: (p) => <span className="font-mono text-xs font-semibold">{p.sku}</span> },
    {
      key: 'name', header: 'Product',
      render: (p) => (
        <Link to={`/catalog/products/${p.id}`} className="block min-w-0 hover:underline">
          <span className="font-medium text-slate-900">{p.brand_name}</span>
          {p.matched_on && p.matched_on !== 'match' && p.matched_on !== 'name' && <Badge tone="blue" className="ml-2">{p.matched_on}</Badge>}
          <span className="block truncate text-xs text-slate-500">
            {[p.generic_name, p.strength_text, p.dosage_form].filter(Boolean).join(' · ') || 'No identity (non-medicine)'}
          </span>
        </Link>
      ),
    },
    { key: 'class', header: 'Class', hideOnMobile: true, render: (p) => <Badge tone={p.product_class === 'CONTROLLED' ? 'red' : 'slate'}>{PRODUCT_CLASS_LABEL[p.product_class as ProductClass] ?? p.product_class}</Badge> },
    { key: 'maker', header: 'Manufacturer', hideOnMobile: true, render: (p) => p.manufacturer_name ?? '—' },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge active={p.is_active} /> },
  ]

  return (
    <>
      <PageHeader
        title="Products"
        description="Sellable SKUs. Search by brand, generic name, strength, SKU, barcode or any alias."
        actions={ability.can('products.create') && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> New product</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center">
          <div className="flex-1"><SearchInput value={state.search} onChange={setSearch} placeholder="Search products — e.g. “augmentin 625”, a SKU or a barcode" label="Search products" /></div>
          <div className="w-full lg:w-56">
            <label htmlFor="product-class" className="sr-only">Class</label>
            <Select id="product-class" value={productClass} onChange={(e) => { setProductClass(e.target.value as ProductClass | ''); setPage(0) }}>
              <option value="">All classes</option>
              {PRODUCT_CLASSES.map((c) => <option key={c} value={c}>{PRODUCT_CLASS_LABEL[c]}</option>)}
            </Select>
          </div>
          <StatusFilter value={state.status} onChange={setStatus} label="Product status" />
        </div>
        <DataTable
          caption="Products"
          columns={columns}
          rows={query.data?.rows}
          rowKey={(p) => p.id}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          emptyTitle={state.search || state.status !== 'all' || productClass ? 'No products match' : 'No products yet'}
          emptyDescription={state.search ? 'Try fewer words, the SKU, or a barcode. Aliases are searched too.' : 'Create your first product, or ask for a bulk import later.'}
        />
        <Pagination page={state.page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>

      <ProductForm
        open={creating}
        product={null}
        canEdit={ability.can('products.create')}
        canCreateIdentity={ability.can('products.create')}
        onClose={() => setCreating(false)}
        onSaved={(id) => navigate(`/catalog/products/${id}`)}
      />
    </>
  )
}
