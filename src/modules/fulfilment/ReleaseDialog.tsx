import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, DateInput, Field, InlineError, Input, Modal, Select, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { releaseToWarehouse } from '@/services/fulfilment'

/** Release a posted invoice to the warehouse for picking. */
export function ReleaseDialog({ invoiceId, canView, onClose }: { invoiceId: string; canView: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const [priority, setPriority] = useState('2')
  const [requiredBy, setRequiredBy] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const release = useMutation({
    mutationFn: () => releaseToWarehouse({ invoiceId, priority: Number(priority), requiredBy, notes }),
    onSuccess: async (id) => {
      toast.success('Released to the warehouse.')
      await Promise.all(['invoice-fulfilment', 'fulfilment-queue'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
      onClose()
      if (canView) navigate(`/warehouse/picking/${id}`)
    },
    onError: (e) => setError(toAppError(e).message),
  })
  function submit(e: FormEvent) { e.preventDefault(); setError(null); release.mutate() }
  return (
    <Modal
      open size="sm" title="Release to warehouse" description="The warehouse sees this invoice as a pick order, with the batches and shelves already chosen. Stock and the invoice are not changed." onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={release.isPending}>Back</Button><Button type="submit" form="release-form" loading={release.isPending}>Release</Button></>}
    >
      <form id="release-form" onSubmit={submit} noValidate className="space-y-3">
        <InlineError message={error} />
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="1">Urgent</option><option value="2">Normal</option><option value="3">Low</option>
          </Select>
        </Field>
        <Field label="Needed by (optional)"><DateInput value={requiredBy} onChange={(e) => setRequiredBy(e.target.value)} /></Field>
        <Field label="Note for the warehouse (optional)"><Input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} /></Field>
      </form>
    </Modal>
  )
}
