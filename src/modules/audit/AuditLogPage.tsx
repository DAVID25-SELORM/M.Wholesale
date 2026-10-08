import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, DataTable, DateInput, Input, PageHeader, Pagination, Select, type Column } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { ALL_BRANCHES, useSession } from '@/modules/session/SessionProvider'
import { AUDIT_ENTITY_TYPES, listAudit, type AuditEntry } from '@/services/audit'

const PAGE_SIZE = 25

function Diff({ entry }: { entry: AuditEntry }) {
  const prev = (entry.previous_values ?? {}) as Record<string, unknown>
  const next = (entry.new_values ?? {}) as Record<string, unknown>
  const keys = [...new Set([...Object.keys(prev), ...Object.keys(next)])].filter((k) => k !== 'id')
  return (
    <div className="space-y-2 text-xs">
      {entry.reason && <p><span className="font-semibold text-slate-600">Reason:</span> {entry.reason}</p>}
      {keys.length === 0 ? <p className="text-slate-400">No field details recorded.</p> : (
        <table className="w-full max-w-2xl">
          <thead><tr className="text-left text-slate-400"><th className="pr-3 font-medium">Field</th><th className="pr-3 font-medium">Before</th><th className="font-medium">After</th></tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k} className="border-t border-slate-100">
                <td className="pr-3 py-1 font-mono text-slate-600">{k}</td>
                <td className="pr-3 py-1 text-slate-500">{k in prev ? JSON.stringify(prev[k]) : '—'}</td>
                <td className="py-1 text-slate-800">{k in next ? JSON.stringify(next[k]) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function AuditLogPage() {
  const { branches, selectedBranch, context, ability } = useSession()
  const tz = context.organization?.timezone
  const [page, setPage] = useState(0)
  const [entityType, setEntityType] = useState('')
  const [action, setAction] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [branchOverride, setBranchOverride] = useState<string | null | undefined>(undefined)
  // Organization-wide viewers start on ALL branches so organization-level events (users, roles, company
  // profile) are visible; branch-scoped viewers start on their own branch.
  const defaultBranch = ability.hasOrgWideAccess || selectedBranch === ALL_BRANCHES ? null : selectedBranch
  const branchId = branchOverride !== undefined ? branchOverride : defaultBranch
  const [openId, setOpenId] = useState<string | null>(null)

  const params = { page, pageSize: PAGE_SIZE, branchId, entityType, action, from, to }
  const query = useQuery({ queryKey: ['audit', params], queryFn: () => listAudit(params), placeholderData: (prev) => prev })
  const reset = (fn: () => void) => { fn(); setPage(0) }

  const columns: Column<AuditEntry>[] = [
    {
      key: 'expand', header: '', className: 'w-8',
      render: (e) => (
        <button type="button" aria-label={openId === e.id ? 'Hide details' : 'Show details'} aria-expanded={openId === e.id}
          onClick={() => setOpenId(openId === e.id ? null : e.id)} className="rounded p-1 text-slate-400 hover:bg-slate-100">
          {openId === e.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      ),
    },
    { key: 'when', header: 'When', render: (e) => <span className="whitespace-nowrap">{formatDateTime(e.created_at, tz)}</span> },
    { key: 'actor', header: 'Actor', render: (e) => e.actor_name ?? (e.actor_user_id ? <span className="font-mono text-xs text-slate-400">{e.actor_user_id.slice(0, 8)}…</span> : <Badge>System</Badge>) },
    { key: 'action', header: 'Action', render: (e) => <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{e.action}</code> },
    { key: 'entity', header: 'Entity', hideOnMobile: true, render: (e) => <span>{e.entity_type}<span className="ml-1 font-mono text-[11px] text-slate-400">{e.entity_id?.slice(0, 8)}</span></span> },
    { key: 'branch', header: 'Branch', hideOnMobile: true, render: (e) => branches.find((b) => b.id === e.branch_id)?.name ?? (e.branch_id ? 'Branch' : '—') },
  ]

  const rows = query.data?.rows
  const expanded = rows?.find((r) => r.id === openId)

  return (
    <>
      <PageHeader title="Audit log" description="A permanent, tamper-resistant record of sensitive changes. Entries can never be edited or deleted." />
      <Card>
        <div className="grid gap-3 border-b border-slate-100 p-4 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label htmlFor="audit-entity" className="sr-only">Entity type</label>
            <Select id="audit-entity" value={entityType} onChange={(e) => reset(() => setEntityType(e.target.value))}>
              <option value="">All entities</option>
              {AUDIT_ENTITY_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor="audit-branch" className="sr-only">Branch</label>
            <Select id="audit-branch" value={branchId ?? ''} onChange={(e) => reset(() => setBranchOverride(e.target.value || null))}>
              {ability.hasOrgWideAccess && <option value="">All branches</option>}
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </div>
          <Input aria-label="Action contains" placeholder="Action, e.g. created" value={action} onChange={(e) => reset(() => setAction(e.target.value))} />
          <DateInput aria-label="From date" value={from} max={to || undefined} onChange={(e) => reset(() => setFrom(e.target.value))} />
          <DateInput aria-label="To date" value={to} min={from || undefined} onChange={(e) => reset(() => setTo(e.target.value))} />
        </div>
        {(entityType || action || from || to) && (
          <div className="border-b border-slate-100 px-4 py-2">
            <Button size="sm" variant="ghost" onClick={() => { setEntityType(''); setAction(''); setFrom(''); setTo(''); setPage(0) }}>Clear filters</Button>
          </div>
        )}
        <DataTable
          caption="Audit log"
          columns={columns}
          rows={rows}
          rowKey={(e) => e.id}
          loading={query.isFetching}
          error={query.isError ? toAppError(query.error).message : null}
          onRetry={() => void query.refetch()}
          emptyTitle="No audit entries match"
          emptyDescription="Entries appear here as soon as sensitive actions happen."
        />
        {expanded && (
          <div className="border-t border-slate-100 bg-slate-50 px-5 py-3" aria-live="polite">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Details · {expanded.action}</p>
            <Diff entry={expanded} />
          </div>
        )}
        <Pagination page={page} pageSize={PAGE_SIZE} hasNext={query.data?.hasNext} onPageChange={setPage} loading={query.isFetching} />
      </Card>
    </>
  )
}
