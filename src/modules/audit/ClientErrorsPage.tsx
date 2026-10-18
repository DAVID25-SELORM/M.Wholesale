import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Badge, Card, DataTable, Modal, PageHeader, Pagination, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { listClientErrors, type ClientError } from '@/services/clientErrors'

const PAGE_SIZE = 25
const SOURCE_LABEL: Record<string, string> = { render: 'Screen crashed', window: 'Uncaught error', promise: 'Failed background task', route: 'Page failed to load' }

export function ClientErrorsPage() {
  const [page, setPage] = useState(0)
  const [source, setSource] = useState('')
  const [open, setOpen] = useState<ClientError | null>(null)
  const params = { page, pageSize: PAGE_SIZE, source }
  const query = useQuery({ queryKey: ['client-errors', params], queryFn: () => listClientErrors(params), placeholderData: (p) => p })

  const columns: Column<ClientError>[] = [
    { key: 'when', header: 'When', render: (e) => <span className="whitespace-nowrap text-slate-600">{formatDateTime(e.created_at)}</span> },
    { key: 'src', header: 'Kind', render: (e) => <Badge tone={e.source === 'render' || e.source === 'route' ? 'red' : 'amber'}>{SOURCE_LABEL[e.source] ?? e.source}</Badge> },
    { key: 'msg', header: 'Error', render: (e) => <button type="button" className="max-w-md truncate text-left text-slate-900 hover:underline" onClick={() => setOpen(e)}>{e.message}</button> },
    { key: 'page', header: 'Page', hideOnMobile: true, render: (e) => <span className="font-mono text-xs text-slate-600">{e.page_path ?? '—'}</span> },
    { key: 'ver', header: 'Version', hideOnMobile: true, render: (e) => <span className="font-mono text-xs text-slate-500">{e.app_version ?? '—'}</span> },
  ]

  return (
    <>
      <PageHeader title="Application errors" description="Problems the app hit on someone's screen: a crashed page, an uncaught error. Expected messages (a permission refusal, a validation message) are not listed. Send a repeating error, with its page and version, to whoever maintains the system." />
      <Card>
        <div className="border-b border-slate-100 p-4 sm:w-64">
          <label htmlFor="ce-source" className="sr-only">Kind</label>
          <Select id="ce-source" value={source} onChange={(e) => { setSource(e.target.value); setPage(0) }}>
            <option value="">All kinds</option>{Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </div>
        <DataTable caption="Application errors" columns={columns} rows={query.data?.rows} rowKey={(e) => e.id} loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null} onRetry={() => void query.refetch()}
          emptyTitle="No errors reported" emptyDescription="Good news: nothing has crashed." />
        <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
      {open && (
        <Modal open size="lg" onClose={() => setOpen(null)} title={SOURCE_LABEL[open.source] ?? open.source} description={`${formatDateTime(open.created_at)} · ${open.page_path ?? ''} · version ${open.app_version ?? 'unknown'}`}>
          <div className="space-y-3 text-sm">
            <p className="font-medium text-slate-900">{open.message}</p>
            {open.stack && <pre className="max-h-72 overflow-auto rounded-md bg-slate-50 p-3 text-xs text-slate-700">{open.stack}</pre>}
            {open.user_agent && <p className="text-xs text-slate-500">{open.user_agent}</p>}
          </div>
        </Modal>
      )}
    </>
  )
}
