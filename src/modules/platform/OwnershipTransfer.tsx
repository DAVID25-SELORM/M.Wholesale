import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Field, Input, InlineError } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import { textValue, type RecordData } from './api'

export function OwnershipTransfer({ organization }: { organization: string }) {
  const [previous, setPrevious] = useState('')
  const [next, setNext] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const qc = useQueryClient()
  const options = useQuery({ queryKey: ['platform', 'ownership', organization], queryFn: async () => unwrap(await supabase.rpc('platform_ownership_options', { p_organization: organization }), 'platform.ownership.options') as RecordData[] })
  const members = options.data ?? []
  return <form className="space-y-4" onSubmit={async event => {
    event.preventDefault()
    if (busy || !window.confirm('Transfer the selected owner role? The previous owner retains any other assigned roles.')) return
    setBusy(true); setError(''); setDone(false)
    try {
      unwrap(await supabase.rpc('platform_transfer_ownership', { p_organization: organization, p_previous: previous, p_next: next, p_reason: reason }), 'platform.ownership')
      setDone(true); setPrevious(''); setNext(''); setReason('')
      await qc.invalidateQueries({ queryKey: ['platform'] })
    } catch (e) { setError(e instanceof Error ? e.message : 'Transfer failed') } finally { setBusy(false) }
  }}>
    <p className="text-sm">An independent administrator with organization and user management access can transfer ownership to an active, verified member. The server verifies the current owner before applying the change.</p>
    <InlineError message={error || (options.isError ? options.error.message : null)} />
    {options.isPending && <p role="status">Loading eligible members…</p>}
    {done && <p role="status">Ownership transferred successfully.</p>}
    <Field label="Previous owner"><select required disabled={busy} className="w-full rounded border p-2" value={previous} onChange={e => setPrevious(e.target.value)}><option value="">Select current owner</option>{members.filter(member => member.is_owner).map(member => <option key={textValue(member.id)} value={textValue(member.id)}>{textValue(member.name)} — {textValue(member.email)}</option>)}</select></Field>
    <Field label="New owner"><select required disabled={busy} className="w-full rounded border p-2" value={next} onChange={e => setNext(e.target.value)}><option value="">Select active member</option>{members.filter(member => member.eligible && member.id !== previous).map(member => <option key={textValue(member.id)} value={textValue(member.id)}>{textValue(member.name)} — {textValue(member.email)}</option>)}</select></Field>
    <Field label="Transfer reason"><Input required disabled={busy} minLength={5} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></Field>
    <Button type="submit" disabled={busy || options.isPending || options.isError || !previous || !next || previous === next}>{busy ? 'Transferring…' : 'Transfer ownership'}</Button>
  </form>
}
