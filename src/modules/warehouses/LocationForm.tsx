import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Button, Checkbox, Field, InlineError, Input, Modal, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { entityCode, optionalText, validate } from '@/lib/validation'
import { createLocation, updateLocation, type WarehouseLocation } from '@/services/warehouses'

const part = z.string().trim().max(32, 'Max 32 characters').optional().transform((v) => v || undefined)

const schema = z.object({
  code: entityCode,
  aisle: part, rack: part, shelf: part, bin: part,
  description: optionalText(1000),
  picking_sequence: z.coerce.number({ message: 'Enter a number' }).int('Whole numbers only').min(0, 'Must be 0 or more').max(1_000_000, 'Too large'),
  is_active: z.boolean(),
})

interface Values { code: string; aisle: string; rack: string; shelf: string; bin: string; description: string; picking_sequence: string; is_active: boolean }

export function LocationForm({ open, location, warehouseId, canEdit, onClose }: {
  open: boolean; location: WarehouseLocation | null; warehouseId: string; canEdit: boolean; onClose: () => void
}) {
  return open ? <Inner location={location} warehouseId={warehouseId} canEdit={canEdit} onClose={onClose} /> : null
}

function Inner({ location, warehouseId, canEdit, onClose }: { location: WarehouseLocation | null; warehouseId: string; canEdit: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [values, setValues] = useState<Values>(
    location
      ? { code: location.code, aisle: location.aisle ?? '', rack: location.rack ?? '', shelf: location.shelf ?? '', bin: location.bin ?? '', description: location.description ?? '', picking_sequence: String(location.picking_sequence), is_active: location.is_active }
      : { code: '', aisle: '', rack: '', shelf: '', bin: '', description: '', picking_sequence: '0', is_active: true },
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (v: z.output<typeof schema>) => (location ? updateLocation(location.id, v) : createLocation({ warehouse_id: warehouseId, ...v })),
    onSuccess: async () => {
      toast.success(location ? 'Location updated.' : 'Location created.')
      await Promise.all([qc.invalidateQueries({ queryKey: ['locations'] }), qc.invalidateQueries({ queryKey: ['dashboard'] })])
      onClose()
    },
    onError: (e) => setServerError(toAppError(e).message),
  })

  const set = (k: keyof Values) => (e: { target: { value: string } }) => setValues({ ...values, [k]: e.target.value })

  function submit(e: FormEvent) {
    e.preventDefault()
    setServerError(null)
    const r = validate(schema, values)
    if (!r.ok) { setErrors(r.errors); return }
    setErrors({})
    save.mutate(r.data)
  }

  const formId = 'location-form'
  return (
    <Modal
      open
      variant="drawer"
      title={location ? (canEdit ? 'Edit location' : 'Location details') : 'New location'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button type="submit" form={formId} loading={save.isPending}>{location ? 'Save changes' : 'Create location'}</Button>}
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={serverError} />
        <Field label="Code" required error={errors.code} hint="Unique within the warehouse, e.g. A-01-02-03">
          <Input value={values.code} onChange={set('code')} maxLength={32} readOnly={!canEdit} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Aisle" error={errors.aisle}><Input value={values.aisle} onChange={set('aisle')} readOnly={!canEdit} /></Field>
          <Field label="Rack" error={errors.rack}><Input value={values.rack} onChange={set('rack')} readOnly={!canEdit} /></Field>
          <Field label="Shelf" error={errors.shelf}><Input value={values.shelf} onChange={set('shelf')} readOnly={!canEdit} /></Field>
          <Field label="Bin" error={errors.bin}><Input value={values.bin} onChange={set('bin')} readOnly={!canEdit} /></Field>
        </div>
        <Field label="Pick order" required error={errors.picking_sequence} hint="Lower numbers are visited first on pick lists">
          <Input type="number" inputMode="numeric" min={0} value={values.picking_sequence} onChange={set('picking_sequence')} readOnly={!canEdit} />
        </Field>
        <Field label="Description" error={errors.description}><Textarea value={values.description} onChange={set('description')} readOnly={!canEdit} /></Field>
        <Checkbox label="Active" checked={values.is_active} disabled={!canEdit} onChange={(e) => setValues({ ...values, is_active: e.target.checked })} />
      </form>
    </Modal>
  )
}
