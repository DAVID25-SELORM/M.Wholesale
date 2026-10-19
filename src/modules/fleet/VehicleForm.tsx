import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Button, Checkbox, DateInput, Field, InlineError, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { optionalText, validate } from '@/lib/validation'
import { useSession } from '@/modules/session/SessionProvider'
import { VEHICLE_TYPES, createVehicle, updateVehicle, type Vehicle } from '@/services/fleet'

const date = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date').or(z.literal('')).optional().transform((v) => v || undefined)
const optionalInt = (label: string, max: number) =>
  z.string().trim().optional().transform((v, ctx) => {
    if (!v) return undefined
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0 || n > max) { ctx.addIssue({ code: 'custom', message: `${label} must be a whole number from 0 to ${max}` }); return z.NEVER }
    return n
  })
const optionalKg = z.string().trim().optional().transform((v, ctx) => {
  if (!v) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) { ctx.addIssue({ code: 'custom', message: 'Capacity must be from 0 to 1,000,000 kg' }); return z.NEVER }
  return n
})

/** Stored the way the database stores it: capitals, no spaces. */
export const registration = z.string().transform((v) => v.replace(/\s+/g, '').toUpperCase()).pipe(
  z.string().regex(/^[A-Z0-9-]{3,20}$/, 'Use 3–20 letters, numbers or "-" (spaces are ignored).'),
)

export const vehicleSchema = z.object({
  branch_id: z.string().min(1, 'Choose a branch'),
  registration_number: registration,
  name: optionalText(80),
  vehicle_type: z.enum(VEHICLE_TYPES),
  capacity_packages: optionalInt('Capacity', 100000),
  capacity_kg: optionalKg,
  refrigerated: z.boolean(),
  insurance_expiry: date,
  roadworthy_expiry: date,
  notes: optionalText(1000),
  is_active: z.boolean(),
})

interface Values {
  branch_id: string; registration_number: string; name: string; vehicle_type: string; capacity_packages: string; capacity_kg: string
  refrigerated: boolean; insurance_expiry: string; roadworthy_expiry: string; notes: string; is_active: boolean
}
const blank = (branch: string): Values => ({ branch_id: branch, registration_number: '', name: '', vehicle_type: 'VAN', capacity_packages: '', capacity_kg: '', refrigerated: false, insurance_expiry: '', roadworthy_expiry: '', notes: '', is_active: true })
const fromVehicle = (v: Vehicle): Values => ({
  branch_id: v.branch_id, registration_number: v.registration_number, name: v.name ?? '', vehicle_type: v.vehicle_type,
  capacity_packages: v.capacity_packages == null ? '' : String(v.capacity_packages), capacity_kg: v.capacity_kg == null ? '' : String(v.capacity_kg),
  refrigerated: v.refrigerated, insurance_expiry: v.insurance_expiry ?? '', roadworthy_expiry: v.roadworthy_expiry ?? '', notes: v.notes ?? '', is_active: v.is_active,
})

export function VehicleForm({ open, vehicle, canEdit, onClose }: { open: boolean; vehicle: Vehicle | null; canEdit: boolean; onClose: () => void }) {
  return open ? <VehicleFormInner vehicle={vehicle} canEdit={canEdit} onClose={onClose} /> : null
}

function VehicleFormInner({ vehicle, canEdit, onClose }: { vehicle: Vehicle | null; canEdit: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { branches, ability, selectedBranch } = useSession()
  const choices = branches.filter((b) => b.is_active && ability.can('fleet.manage', b.id))
  const firstBranch = (selectedBranch !== 'ALL' && choices.some((b) => b.id === selectedBranch) ? selectedBranch : choices[0]?.id) ?? ''
  const [values, setValues] = useState<Values>(vehicle ? fromVehicle(vehicle) : blank(firstBranch))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (v: z.output<typeof vehicleSchema>) => (vehicle ? updateVehicle(vehicle.id, v) : createVehicle(v)),
    onSuccess: async () => {
      toast.success(vehicle ? 'Vehicle updated.' : 'Vehicle created.')
      await qc.invalidateQueries({ queryKey: ['vehicles'] })
      onClose()
    },
    onError: (e) => setServerError(toAppError(e).message),
  })

  const set = (k: keyof Values) => (e: { target: { value: string } }) => setValues({ ...values, [k]: e.target.value })
  function submit(e: FormEvent) {
    e.preventDefault()
    setServerError(null)
    const r = validate(vehicleSchema, values)
    if (!r.ok) { setErrors(r.errors); return }
    setErrors({})
    save.mutate(r.data)
  }

  const formId = 'vehicle-form'
  const ro = !canEdit
  return (
    <Modal
      open
      variant="drawer"
      title={vehicle ? (canEdit ? 'Edit vehicle' : 'Vehicle details') : 'New vehicle'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button type="submit" form={formId} loading={save.isPending}>{vehicle ? 'Save changes' : 'Create vehicle'}</Button>}
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={serverError} />
        <Field label="Registration number" required error={errors.registration_number} hint="Stored in capitals without spaces, unique within your organization">
          <Input value={values.registration_number} onChange={set('registration_number')} maxLength={24} readOnly={ro} />
        </Field>
        <Field label="Name or description" error={errors.name}><Input value={values.name} onChange={set('name')} maxLength={80} readOnly={ro} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type" required error={errors.vehicle_type}>
            <Select value={values.vehicle_type} onChange={set('vehicle_type')} disabled={ro}>
              {VEHICLE_TYPES.map((t) => <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>)}
            </Select>
          </Field>
          <Field label="Branch" required error={errors.branch_id}>
            <Select value={values.branch_id} onChange={set('branch_id')} disabled={ro}>
              {vehicle && !choices.some((b) => b.id === vehicle.branch_id) && <option value={vehicle.branch_id}>{branches.find((b) => b.id === vehicle.branch_id)?.name ?? 'Current branch'}</option>}
              {choices.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Capacity (packages)" error={errors.capacity_packages}><Input inputMode="numeric" value={values.capacity_packages} onChange={set('capacity_packages')} readOnly={ro} /></Field>
          <Field label="Capacity (kg)" error={errors.capacity_kg}><Input inputMode="decimal" value={values.capacity_kg} onChange={set('capacity_kg')} readOnly={ro} /></Field>
        </div>
        <Checkbox label="Refrigerated (can carry cold-chain medicines)" checked={values.refrigerated} disabled={ro} onChange={(e) => setValues({ ...values, refrigerated: e.target.checked })} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Insurance expiry" error={errors.insurance_expiry}><DateInput value={values.insurance_expiry} onChange={set('insurance_expiry')} readOnly={ro} /></Field>
          <Field label="Roadworthy expiry" error={errors.roadworthy_expiry}><DateInput value={values.roadworthy_expiry} onChange={set('roadworthy_expiry')} readOnly={ro} /></Field>
        </div>
        <Field label="Notes" error={errors.notes}><Textarea value={values.notes} onChange={set('notes')} rows={3} maxLength={1000} readOnly={ro} /></Field>
        <Checkbox label="Active" checked={values.is_active} disabled={ro} onChange={(e) => setValues({ ...values, is_active: e.target.checked })} />
      </form>
    </Modal>
  )
}
