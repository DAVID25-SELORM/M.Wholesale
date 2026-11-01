import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, InlineError } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import { textValue, type PlatformResult } from './api'

export function OrganizationRecords({ organization, section }: { organization: string; section: string }) {
  const [page, setPage] = useState(0)
  const query = useQuery({ queryKey: ['platform', 'organization-records', organization, section, page], queryFn: async () => unwrap(await supabase.rpc('platform_organization_records', { p_organization: organization, p_section: section, p_page: page }), 'platform.organization.records') as PlatformResult })
  return <div className="space-y-4">
    {section === 'security' && <p className="text-sm text-slate-500">Account status and most recent sign-in. This is not a complete login history.</p>}
    {section === 'settings' && <p className="text-sm text-slate-500">Configuration inventory. Values are managed within the organization.</p>}
    <Button variant="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh</Button>
    <InlineError message={query.isError ? query.error.message : null} />
    {query.isPending && <p role="status">Loading records…</p>}
    {query.data?.rows.map(row => <dl key={textValue(row.id)} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
      {Object.entries(row).filter(([key]) => key !== 'id').map(([key, value]) => <div key={key} className="min-w-0"><dt className="text-xs capitalize text-slate-500">{key.replaceAll('_', ' ')}</dt><dd className="break-words text-sm">{typeof value === 'boolean' ? (value ? 'Yes' : 'No') : textValue(value) || '—'}</dd></div>)}
    </dl>)}
    {query.data && !query.data.rows.length && <p>No records found.</p>}
    <div className="flex flex-wrap items-center gap-3"><Button variant="secondary" disabled={page === 0 || query.isFetching} onClick={() => setPage(value => value - 1)}>Previous</Button><span>Page {page + 1} · {query.data?.total ?? 0} records</span><Button variant="secondary" disabled={query.isFetching || (page + 1) * 25 >= (query.data?.total ?? 0)} onClick={() => setPage(value => value + 1)}>Next</Button></div>
  </div>
}
