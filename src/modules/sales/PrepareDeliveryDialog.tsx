import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Field, InlineError, Input, Modal, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import type { Customer } from '@/services/customers'
import { prepareDeliveryNote } from '@/services/deliveries'

/** Starts a delivery for a posted invoice: where it goes, who to ask for, how many packages. Creating it produces the pick list. */
export function PrepareDeliveryDialog({ invoiceId, customer, onClose }: { invoiceId: string; customer: Customer | null | undefined; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const [address, setAddress] = useState([customer?.address, customer?.city].filter(Boolean).join(', '))
  const [contact, setContact] = useState(customer?.contact_name ?? '')
  const [phone, setPhone] = useState(customer?.phone ?? '')
  const [packages, setPackages] = useState('1')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const prepare = useMutation({
    mutationFn: () => prepareDeliveryNote({ invoiceId, address, contactName: contact, contactPhone: phone, packages: Number(packages), notes }),
    onSuccess: async (id) => {
      toast.success('Delivery note prepared: print the pick list for the warehouse.')
      await Promise.all(['invoice-delivery', 'delivery-notes', 'dashboard'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
      onClose()
      navigate(`/sales/deliveries/${id}`)
    },
    onError: (e) => setError(toAppError(e).message),
  })
  function submit(e: FormEvent) {
    e.preventDefault()
    const n = Number(packages)
    if (!Number.isInteger(n) || n < 0 || n > 10000) { setError('Enter the number of packages (0 or more).'); return }
    setError(null)
    prepare.mutate()
  }
  return (
    <Modal
      open size="md" onClose={onClose} title="Prepare delivery" description="Creates the delivery note and its pick list: where in the warehouse to find each batch."
      footer={<><Button variant="secondary" onClick={onClose} disabled={prepare.isPending}>Back</Button><Button type="submit" form="prepare-delivery" loading={prepare.isPending}>Prepare delivery</Button></>}
    >
      <form id="prepare-delivery" onSubmit={submit} noValidate className="space-y-3">
        <InlineError message={error} />
        <Field label="Deliver to (address)"><Textarea rows={2} maxLength={300} value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Ask for"><Input value={contact} maxLength={120} onChange={(e) => setContact(e.target.value)} /></Field>
          <Field label="Phone"><Input value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="Packages" required><Input type="number" inputMode="numeric" min="0" step="1" value={packages} onChange={(e) => setPackages(e.target.value)} /></Field>
        </div>
        <Field label="Notes for the driver (cold chain, fragile ...)"><Input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} /></Field>
      </form>
    </Modal>
  )
}
