import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, InlineError } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import { exportRecords, textValue, type PlatformResult } from './api'

export function OrganizationActivity({ organization }: { organization: string }) {
  const [page, setPage] = useState(0)
  const query = useQuery({ queryKey: ['platform', 'organization-activity', organization, page], queryFn: async () => unwrap(await supabase.rpc('platform_organization_activity', { p_organization: organization, p_page: page }), 'platform.organization.activity') as PlatformResult })
  return <div className="space-y-4">
    <p className="text-sm text-slate-500">Platform administration events for this organization. Organization and audit permissions are required.</p>
    <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh activity</Button><Button variant="secondary" disabled={!query.data?.rows.length} onClick={() => exportRecords(query.data!.rows, 'organization-activity')}>Export current page</Button></div>
    <InlineError message={query.isError ? query.error.message : null} />
    {query.isPending && <p role="status">Loading activity…</p>}
    {query.data?.rows.map(row => <article key={textValue(row.id)} className="space-y-2 rounded-lg border p-4">
      <div className="flex flex-wrap justify-between gap-2"><h3 className="break-words font-medium">{textValue(row.action)}</h3><span className="text-sm">{textValue(row.result)}</span></div>
      <p className="break-all text-xs text-slate-500">{textValue(row.created_at)} · Actor: {textValue(row.actor_id) || 'System'}</p>
      <pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(row.metadata, null, 2)}</pre>
    </article>)}
    {query.data && !query.data.rows.length && <p>No platform activity recorded.</p>}
    <div className="flex flex-wrap items-center gap-3"><Button variant="secondary" disabled={page === 0 || query.isFetching} onClick={() => setPage(value => value - 1)}>Previous</Button><span>Page {page + 1} · {query.data?.total ?? 0} events</span><Button variant="secondary" disabled={query.isFetching || (page + 1) * 25 >= (query.data?.total ?? 0)} onClick={() => setPage(value => value + 1)}>Next</Button></div>
  </div>
}
