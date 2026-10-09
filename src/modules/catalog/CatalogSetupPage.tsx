import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Button, Card, Checkbox, DataTable, Field, InlineError, Input, Modal, PageHeader, Pagination, SearchInput, StatusBadge, Tabs, useToast, type Column } from '@/components/ui'
import { useTableState } from '@/hooks/useTableState'
import { toAppError } from '@/lib/errors'
import { entityCode, optionalText, requiredText, validate } from '@/lib/validation'
import { useSession } from '@/modules/session/SessionProvider'
import { StatusFilter } from '@/modules/shared/StatusFilter'
import {
  createCategory, createManufacturer, listCategories, listIdentities, listManufacturers, updateCategory, updateManufacturer,
  type Manufacturer, type ProductCategory, type ProductIdentity,
} from '@/services/catalog'
import { IdentityForm } from './IdentityForm'

const PAGE_SIZE = 20

export function CatalogSetupPage() {
  const [tab, setTab] = useState('identities')
  return (
    <>
      <PageHeader title="Catalogue setup" description="The building blocks products are made from: pharmaceutical identities, manufacturers and categories." />
      <Tabs label="Catalogue setup sections" value={tab} onChange={setTab} items={[
        { id: 'identities', label: 'Pharmaceutical identities' }, { id: 'manufacturers', label: 'Manufacturers' }, { id: 'categories', label: 'Categories' },
      ]} />
      <div className="mt-4">
        {tab === 'identities' && <IdentitiesSection />}
        {tab === 'manufacturers' && <ManufacturersSection />}
        {tab === 'categories' && <CategoriesSection />}
      </div>
    </>
  )
}

function SectionShell({ title, search, onSearch, status, onStatus, action, children }: {
  title: string; search: string; onSearch: (s: string) => void; status: 'all' | 'active' | 'inactive'; onStatus: (s: 'all' | 'active' | 'inactive') => void
  action: React.ReactNode; children: React.ReactNode
}) {
  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
        <div className="flex-1"><SearchInput value={search} onChange={onSearch} placeholder={`Search ${title.toLowerCase()}`} label={`Search ${title.toLowerCase()}`} /></div>
        <StatusFilter value={status} onChange={onStatus} label={`${title} status`} />
        {action}
      </div>
      {children}
    </Card>
  )
}

// ---- identities ---------------------------------------------------------------------------------------------------
function IdentitiesSection() {
  const { ability } = useSession()
  const { state, setPage, setSearch, setStatus } = useTableState<'name'>({ key: 'name', direction: 'asc' })
  const [editing, setEditing] = useState<ProductIdentity | 'new' | null>(null)
  const params = { page: state.page, pageSize: PAGE_SIZE, search: state.search, status: state.status }
  const query = useQuery({ queryKey: ['identities', params], queryFn: () => listIdentities(params), placeholderData: (p) => p })
  const canCreate = ability.can('products.create')
  const canEdit = ability.can('products.edit')
  const columns: Column<ProductIdentity>[] = [
    { key: 'name', header: 'Generic name', render: (i) => <span className="font-medium text-slate-900">{i.generic_name}</span> },
    { key: 'strength', header: 'Strength', render: (i) => i.strength_text },
    { key: 'form', header: 'Form', render: (i) => i.dosage_form?.name ?? '—' },
    { key: 'status', header: 'Status', render: (i) => <StatusBadge active={i.is_active} /> },
    { key: 'actions', header: '', className: 'text-right', render: (i) => <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>{canEdit ? 'Edit' : 'View'}</Button> },
  ]
  return (
    <>
      <SectionShell title="Identities" search={state.search} onSearch={setSearch} status={state.status} onStatus={setStatus}
        action={canCreate && <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> New identity</Button>}>
        <DataTable caption="Pharmaceutical identities" columns={columns} rows={query.data?.rows} rowKey={(i) => i.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle="No identities yet" emptyDescription="An identity is generic name + dosage form + strength, e.g. Paracetamol · tablet · 500 mg." />
        <Pagination page={state.page} pageSize={PAGE_SIZE} total={query.data?.total} onPageChange={setPage} loading={query.isFetching} />
      </SectionShell>
      <IdentityForm open={editing !== null} identity={editing === 'new' ? null : editing} canEdit={editing === 'new' ? canCreate : canEdit} onClose={() => setEditing(null)} />
    </>
  )
}

// ---- manufacturers -------------------------------------------------------------------------------------------
const manufacturerSchema = z.object({
  name: requiredText('Name', 200),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a 2-letter country code, e.g. GH').or(z.literal('')).optional().transform((v) => v || undefined),
  notes: optionalText(2000),
  is_active: z.boolean(),
})

function ManufacturersSection() {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const { state, setPage, setSearch, setStatus } = useTableState<'name'>({ key: 'name', direction: 'asc' })
  const [editing, setEditing] = useState<Manufacturer | 'new' | null>(null)
  const params = { page: state.page, pageSize: PAGE_SIZE, search: state.search, status: state.status }
  const query = useQuery({ queryKey: ['manufacturers', params], queryFn: () => listManufacturers(params), placeholderData: (p) => p })
  const canCreate = ability.can('products.create')
  const canEdit = ability.can('products.edit')
  const columns: Column<Manufacturer>[] = [
    { key: 'name', header: 'Name', render: (m) => <span className="font-medium text-slate-900">{m.name}</span> },
    { key: 'country', header: 'Country', render: (m) => m.country ?? '—' },
    { key: 'status', header: 'Status', render: (m) => <StatusBadge active={m.is_active} /> },
    { key: 'actions', header: '', className: 'text-right', render: (m) => <Button size="sm" variant="ghost" onClick={() => setEditing(m)}>{canEdit ? 'Edit' : 'View'}</Button> },
  ]
  const [values, setValues] = useState({ name: '', country: '', notes: '', is_active: true })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const open = (m: Manufacturer | 'new') => {
    setValues(m === 'new' ? { name: '', country: '', notes: '', is_active: true } : { name: m.name, country: m.country ?? '', notes: m.notes ?? '', is_active: m.is_active })
    setErrors({}); setServerError(null); setEditing(m)
  }
  const save = useMutation({
    mutationFn: (v: z.output<typeof manufacturerSchema>) => (editing && editing !== 'new' ? updateManufacturer(editing.id, v) : createManufacturer(v)),
    onSuccess: async () => { toast.success('Manufacturer saved.'); await qc.invalidateQueries({ queryKey: ['manufacturers'] }); setEditing(null) },
    onError: (e) => setServerError(toAppError(e).message),
  })
  function submit(e: FormEvent) {
    e.preventDefault()
    const r = validate(manufacturerSchema, values)
    if (!r.ok) { setErrors(r.errors); return }
    setErrors({}); setServerError(null); save.mutate(r.data)
  }
  const ro = editing === 'new' ? !canCreate : !canEdit
  return (
    <>
      <SectionShell title="Manufacturers" search={state.search} onSearch={setSearch} status={state.status} onStatus={setStatus}
        action={canCreate && <Button onClick={() => open('new')}><Plus className="h-4 w-4" aria-hidden /> New manufacturer</Button>}>
        <DataTable caption="Manufacturers" columns={columns.map((c) => c.key === 'actions' ? { ...c, render: (m: Manufacturer) => <Button size="sm" variant="ghost" onClick={() => open(m)}>{canEdit ? 'Edit' : 'View'}</Button> } : c)}
          rows={query.data?.rows} rowKey={(m) => m.id} loading={query.isFetching} error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()} emptyTitle="No manufacturers yet" />
        <Pagination page={state.page} pageSize={PAGE_SIZE} total={query.data?.total} onPageChange={setPage} loading={query.isFetching} />
      </SectionShell>
      <Modal open={editing !== null} title={editing === 'new' ? 'New manufacturer' : 'Manufacturer'} onClose={() => setEditing(null)}
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>{ro ? 'Close' : 'Cancel'}</Button>{!ro && <Button type="submit" form="manufacturer-form" loading={save.isPending}>Save</Button>}</>}>
        <form id="manufacturer-form" onSubmit={submit} noValidate className="space-y-4">
          <InlineError message={serverError} />
          <Field label="Name" required error={errors.name}><Input value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} readOnly={ro} /></Field>
          <Field label="Country (ISO code)" error={errors.country}><Input value={values.country} maxLength={2} onChange={(e) => setValues({ ...values, country: e.target.value })} readOnly={ro} /></Field>
          <Field label="Notes" error={errors.notes}><Input value={values.notes} onChange={(e) => setValues({ ...values, notes: e.target.value })} readOnly={ro} /></Field>
          <Checkbox label="Active" checked={values.is_active} disabled={ro} onChange={(e) => setValues({ ...values, is_active: e.target.checked })} />
        </form>
      </Modal>
    </>
  )
}

// ---- categories -----------------------------------------------------------------------------------------------
const categorySchema = z.object({ code: entityCode, name: requiredText('Name', 120), is_active: z.boolean() })

function CategoriesSection() {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const { state, setPage, setSearch, setStatus } = useTableState<'name'>({ key: 'name', direction: 'asc' })
  const [editing, setEditing] = useState<ProductCategory | 'new' | null>(null)
  const params = { page: state.page, pageSize: PAGE_SIZE, search: state.search, status: state.status }
  const query = useQuery({ queryKey: ['categories', params], queryFn: () => listCategories(params), placeholderData: (p) => p })
  const canCreate = ability.can('products.create')
  const canEdit = ability.can('products.edit')
  const [values, setValues] = useState({ code: '', name: '', is_active: true })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const open = (c: ProductCategory | 'new') => {
    setValues(c === 'new' ? { code: '', name: '', is_active: true } : { code: c.code, name: c.name, is_active: c.is_active })
    setErrors({}); setServerError(null); setEditing(c)
  }
  const columns: Column<ProductCategory>[] = [
    { key: 'code', header: 'Code', render: (c) => <span className="font-mono text-xs font-semibold">{c.code}</span> },
    { key: 'name', header: 'Name', render: (c) => <span className="font-medium text-slate-900">{c.name}</span> },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge active={c.is_active} /> },
    { key: 'actions', header: '', className: 'text-right', render: (c) => <Button size="sm" variant="ghost" onClick={() => open(c)}>{canEdit ? 'Edit' : 'View'}</Button> },
  ]
  const save = useMutation({
    mutationFn: (v: z.output<typeof categorySchema>) => (editing && editing !== 'new' ? updateCategory(editing.id, v) : createCategory(v)),
    onSuccess: async () => { toast.success('Category saved.'); await qc.invalidateQueries({ queryKey: ['categories'] }); setEditing(null) },
    onError: (e) => setServerError(toAppError(e).message),
  })
  function submit(e: FormEvent) {
    e.preventDefault()
    const r = validate(categorySchema, values)
    if (!r.ok) { setErrors(r.errors); return }
    setErrors({}); setServerError(null); save.mutate(r.data)
  }
  const ro = editing === 'new' ? !canCreate : !canEdit
  return (
    <>
      <SectionShell title="Categories" search={state.search} onSearch={setSearch} status={state.status} onStatus={setStatus}
        action={canCreate && <Button onClick={() => open('new')}><Plus className="h-4 w-4" aria-hidden /> New category</Button>}>
        <DataTable caption="Categories" columns={columns} rows={query.data?.rows} rowKey={(c) => c.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()} emptyTitle="No categories yet" />
        <Pagination page={state.page} pageSize={PAGE_SIZE} total={query.data?.total} onPageChange={setPage} loading={query.isFetching} />
      </SectionShell>
      <Modal open={editing !== null} title={editing === 'new' ? 'New category' : 'Category'} onClose={() => setEditing(null)}
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>{ro ? 'Close' : 'Cancel'}</Button>{!ro && <Button type="submit" form="category-form" loading={save.isPending}>Save</Button>}</>}>
        <form id="category-form" onSubmit={submit} noValidate className="space-y-4">
          <InlineError message={serverError} />
          <Field label="Code" required error={errors.code}><Input value={values.code} maxLength={32} onChange={(e) => setValues({ ...values, code: e.target.value })} readOnly={ro} /></Field>
          <Field label="Name" required error={errors.name}><Input value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} readOnly={ro} /></Field>
          <Checkbox label="Active" checked={values.is_active} disabled={ro} onChange={(e) => setValues({ ...values, is_active: e.target.checked })} />
        </form>
      </Modal>
    </>
  )
}
