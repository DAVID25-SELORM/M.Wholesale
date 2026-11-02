import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Field, InlineError, Input, Modal } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import type { RecordData } from './api'

export function PlanFeatures({ plan, onClose }: { plan: string; onClose: () => void }) {
  const cache = useQueryClient()
  const [selection, setSelection] = useState<string[] | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const query = useQuery({ queryKey: ['platform', 'plan-features', plan], queryFn: async () => unwrap(await supabase.rpc('platform_plan_features', { p_plan: plan }), 'platform.plan.features') as RecordData })
  const disabled = selection ?? ((query.data?.disabled_modules as string[] | undefined) ?? [])
  return <Modal open title="Plan feature availability" onClose={() => { if (!busy) onClose() }}>
    <form className="space-y-4" onSubmit={async event => {
      event.preventDefault(); if (busy || !query.data) return
      setBusy(true); setError('')
      try {
        unwrap(await supabase.rpc('platform_set_plan_features', { p_plan: plan, p_disabled: disabled, p_reason: reason }), 'platform.plan.features.save')
        await cache.invalidateQueries({ queryKey: ['platform'] }); onClose()
      } catch (e) { setError(e instanceof Error ? e.message : 'Could not save features') }
      finally { setBusy(false) }
    }}>
      <p className="text-sm">Checked modules are available to subscribed organizations, subject to user roles. Unchecking a module restricts its permissions immediately. Foundational administration remains available.</p>
      <InlineError message={error || (query.isError ? query.error.message : null)} />
      {query.isPending && <p role="status">Loading features…</p>}
      <fieldset disabled={busy} className="grid gap-2 sm:grid-cols-2"><legend className="sr-only">Available modules</legend>{(query.data?.modules as string[] | undefined)?.map(module => <label className="flex gap-2" key={module}><input type="checkbox" checked={!disabled.includes(module)} onChange={e => setSelection(e.target.checked ? disabled.filter(m => m !== module) : [...disabled, module])} />{module}</label>)}</fieldset>
      <Field label="Reason"><Input required minLength={5} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></Field>
      <Button type="submit" disabled={busy || !query.data}>{busy ? 'Saving…' : 'Save feature availability'}</Button>
    </form>
  </Modal>
}
