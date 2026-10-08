import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Button, Checkbox, Field, InlineError, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { entityCode, optionalText, requiredText, validate } from '@/lib/validation'
import { useSession } from '@/modules/session/SessionProvider'
import { listBranchOptions } from '@/services/branches'
import { createWarehouse, updateWarehouse, type Warehouse } from '@/services/warehouses'
import { WAREHOUSE_TYPES, type WarehouseType } from '@/types/domain'

const schema = z.object({
  branch_id: z.string().uuid('Choose a branch'),
  code: entityCode,
  name: requiredText('Name'),
  description: optionalText(1000),
  warehouse_type: z.enum(['MAIN', 'RETURNS', 'QUARANTINE', 'DAMAGED', 'TRANSIT', 'OTHER']),
  is_active: z.boolean(),
})

interface Values { branch_id: string; code: string; name: string; description: string; warehouse_type: WarehouseType; is_active: boolean }

export const WAREHOUSE_TYPE_LABEL: Record<WarehouseType, string> = {
  MAIN: 'Main', RETURNS: 'Returns', QUARANTINE: 'Quarantine', DAMAGED: 'Damaged', TRANSIT: 'In transit', OTHER: 'Other',
}

export function WarehouseForm({ open, warehouse, canEdit, defaultBranchId, onClose }: {
  open: boolean; warehouse: Warehouse | null; canEdit: boolean; defaultBranchId: string | null; onClose: () => void
}) {
  return open ? <Inner warehouse={warehouse} canEdit={canEdit} defaultBranchId={defaultBranchId} onClose={onClose} /> : null
}

function Inner({ warehouse, canEdit, defaultBranchId, onClose }: { warehouse: Warehouse | null; canEdit: boolean; defaultBranchId: string | null; onClose: () => void }) {
  const { ability } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const branchesQ = useQuery({ queryKey: ['branches', 'options'], queryFn: listBranchOptions, staleTime: 60_000 })
  const [values, setValues] = useState<Values>(
    warehouse
      ? { branch_id: warehouse.branch_id, code: warehouse.code, name: warehouse.name, description: warehouse.description ?? '', warehouse_type: warehouse.warehouse_type, is_active: warehouse.is_active }
      : { branch_id: defaultBranchId ?? '', code: '', name: '', description: '', warehouse_type: 'MAIN', is_active: true },
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (v: z.output<typeof schema>) => (warehouse ? updateWarehouse(warehouse.id, v) : createWarehouse(v)),
    onSuccess: async () => {
      toast.success(warehouse ? 'Warehouse updated.' : 'Warehouse created.')
      await Promise.all([qc.invalidateQueries({ queryKey: ['warehouses'] }), qc.invalidateQueries({ queryKey: ['dashboard'] })])
      onClose()
    },
    onError: (e) => setServerError(toAppError(e).message),
  })

  const branchOptions = (branchesQ.data ?? []).filter((b) => b.is_active && (warehouse ? true : ability.can('warehouses.create', b.id)))
  const set = (k: keyof Values) => (e: { target: { value: string } }) => setValues({ ...values, [k]: e.target.value })

  function submit(e: FormEvent) {
    e.preventDefault()
    setServerError(null)
    const r = validate(schema, values)
    if (!r.ok) { setErrors(r.errors); return }
    setErrors({})
    save.mutate(r.data)
  }

  const formId = 'warehouse-form'
  return (
    <Modal
      open
      variant="drawer"
      title={warehouse ? (canEdit ? 'Edit warehouse' : 'Warehouse details') : 'New warehouse'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button type="submit" form={formId} loading={save.isPending}>{warehouse ? 'Save changes' : 'Create warehouse'}</Button>}
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={serverError} />
        <Field label="Branch" required error={errors.branch_id} hint={warehouse ? 'A warehouse cannot move to another branch.' : undefined}>
          <Select value={values.branch_id} onChange={set('branch_id')} disabled={Boolean(warehouse) || !canEdit}>
            <option value="" disabled>Select a branch…</option>
            {(warehouse ? (branchesQ.data ?? []) : branchOptions).map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
          </Select>
        </Field>
        <Field label="Code" required error={errors.code} hint="Unique within your organization"><Input value={values.code} onChange={set('code')} maxLength={32} readOnly={!canEdit} /></Field>
        <Field label="Name" required error={errors.name}><Input value={values.name} onChange={set('name')} readOnly={!canEdit} /></Field>
        <Field label="Type" required error={errors.warehouse_type}>
          <Select value={values.warehouse_type} onChange={set('warehouse_type')} disabled={!canEdit}>
            {WAREHOUSE_TYPES.map((t) => <option key={t} value={t}>{WAREHOUSE_TYPE_LABEL[t]}</option>)}
          </Select>
        </Field>
        <Field label="Description" error={errors.description}><Textarea value={values.description} onChange={set('description')} readOnly={!canEdit} /></Field>
        <Checkbox label="Active" checked={values.is_active} disabled={!canEdit} onChange={(e) => setValues({ ...values, is_active: e.target.checked })} />
      </form>
    </Modal>
  )
}
