import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Card, CardBody, CardHeader, Field, InlineError, Input, Select, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { getDrugXoneConnection, queueDrugXoneCatalogue, setDrugXoneConnection, type DrugXoneConnection } from '@/services/drugxone'

const empty: DrugXoneConnection = { configured: false, environment: null, base_url: null, external_business_id: null, status: null, api_version: null, last_sync_at: null, last_error: null, updated_at: null }

export function DrugXoneConnectionCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const query = useQuery({ queryKey: ['drugxone-connection'], queryFn: getDrugXoneConnection })
  const connection = query.data ?? empty
  const [draft, setDraft] = useState<{ environment: 'SANDBOX' | 'PRODUCTION'; baseUrl: string; businessId: string; status: 'DISCONNECTED' | 'READY' | 'PAUSED' } | null>(null)
  const environment = draft?.environment ?? connection.environment ?? 'SANDBOX'
  const baseUrl = draft?.baseUrl ?? connection.base_url ?? ''
  const businessId = draft?.businessId ?? connection.external_business_id ?? ''
  const status = draft?.status ?? (connection.status === 'READY' || connection.status === 'PAUSED' ? connection.status : 'DISCONNECTED')
  const [reason, setReason] = useState('')

  const save = useMutation({
    mutationFn: () => setDrugXoneConnection({ environment, base_url: baseUrl.trim(), external_business_id: businessId.trim(), status, reason: reason.trim() }),
    onSuccess: async () => { toast.success('DrugXOne connection settings saved.'); setReason(''); setDraft(null); await qc.invalidateQueries({ queryKey: ['drugxone-connection'] }) },
  })
  const queue = useMutation({
    mutationFn: () => queueDrugXoneCatalogue('Queue catalogue snapshot from DrugXOne settings'),
    onSuccess: async (result) => { toast.success(`${result.queued} catalogue item${result.queued === 1 ? '' : 's'} queued.`); await qc.invalidateQueries({ queryKey: ['drugxone-connection'] }) },
  })
  const error = query.isError ? toAppError(query.error).message : save.isError ? toAppError(save.error).message : null

  return <Card>
    <CardHeader title="DrugXOne" description="Catalog and order exchange is server-to-server. Credentials are never stored in this ERP or exposed to the browser." actions={<Badge tone={connection.status === 'READY' ? 'green' : connection.status === 'ERROR' ? 'red' : 'amber'}>{connection.status ?? 'Not configured'}</Badge>} />
    <CardBody className="space-y-4">
      <InlineError message={error} />
      {query.isPending ? <p className="text-sm text-slate-600">Loading connection status…</p> : <>
        <p className="text-sm text-slate-600">Use the DrugXOne partner base URL and external business ID. Configure the secret token in the server environment when the partner API is ready.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Environment"><Select value={environment} disabled={!canEdit} onChange={(e) => setDraft({ environment: e.target.value as 'SANDBOX' | 'PRODUCTION', baseUrl, businessId, status })}><option value="SANDBOX">Sandbox</option><option value="PRODUCTION">Production</option></Select></Field>
          <Field label="Connection status"><Select value={status} disabled={!canEdit} onChange={(e) => setDraft({ environment, baseUrl, businessId, status: e.target.value as 'DISCONNECTED' | 'READY' | 'PAUSED' })}><option value="DISCONNECTED">Disconnected</option><option value="READY">Ready</option><option value="PAUSED">Paused</option></Select></Field>
          <Field label="Partner base URL" hint="HTTPS URL without query parameters"><Input value={baseUrl} disabled={!canEdit} onChange={(e) => setDraft({ environment, baseUrl: e.target.value, businessId, status })} placeholder="https://drugxone.example.com" /></Field>
          <Field label="DrugXOne business ID"><Input value={businessId} disabled={!canEdit} onChange={(e) => setDraft({ environment, baseUrl, businessId: e.target.value, status })} /></Field>
          {canEdit && <Field label="Change reason" className="sm:col-span-2"><Input required minLength={5} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this connection being changed?" /></Field>}
        </div>
        {connection.last_error && <p className="text-sm text-red-700">Last sync error: {connection.last_error}</p>}
        <div className="flex flex-wrap gap-2">
          {canEdit && <Button disabled={save.isPending || reason.trim().length < 5} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save connection'}</Button>}
          {canEdit && status === 'READY' && <Button variant="secondary" disabled={queue.isPending} onClick={() => queue.mutate()}>{queue.isPending ? 'Queueing…' : 'Queue catalogue snapshot'}</Button>}
        </div>
      </>}
    </CardBody>
  </Card>
}
