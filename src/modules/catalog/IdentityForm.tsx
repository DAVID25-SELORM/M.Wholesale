import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Button, Checkbox, Field, InlineError, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { optionalText, requiredText, validate } from '@/lib/validation'
import { createIdentity, listDosageForms, updateIdentity, type ProductIdentity } from '@/services/catalog'

const schema = z.object({
  generic_name: requiredText('Generic name', 300),
  dosage_form_id: z.string().uuid('Choose a dosage form'),
  strength_text: requiredText('Strength', 120),
  notes: optionalText(2000),
  is_active: z.boolean(),
})

interface Values { generic_name: string; dosage_form_id: string; strength_text: string; notes: string; is_active: boolean }

/**
 * A canonical pharmaceutical identity: generic (INN) name + dosage form + strength. Brands and pack sizes
 * are products that point at it, so "Augmentin 625" and "Co-amoxiclav 500/125 tablets" can be recognised
 * as the same medicine.
 */
export function IdentityForm({ open, identity, canEdit, onClose, onSaved }: {
  open: boolean; identity: ProductIdentity | null; canEdit: boolean; onClose: () => void; onSaved?: (id: string) => void
}) {
  return open ? <Inner identity={identity} canEdit={canEdit} onClose={onClose} {...(onSaved ? { onSaved } : {})} /> : null
}

function Inner({ identity, canEdit, onClose, onSaved }: { identity: ProductIdentity | null; canEdit: boolean; onClose: () => void; onSaved?: (id: string) => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const forms = useQuery({ queryKey: ['dosage-forms'], queryFn: listDosageForms, staleTime: Infinity })
  const [values, setValues] = useState<Values>(
    identity
      ? { generic_name: identity.generic_name, dosage_form_id: identity.dosage_form_id, strength_text: identity.strength_text, notes: identity.notes ?? '', is_active: identity.is_active }
      : { generic_name: '', dosage_form_id: '', strength_text: '', notes: '', is_active: true },
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async (v: z.output<typeof schema>) => {
      if (identity) { await updateIdentity(identity.id, v); return identity.id }
      return createIdentity(v)
    },
    onSuccess: async (id) => {
      toast.success(identity ? 'Identity updated.' : 'Identity created.')
      await qc.invalidateQueries({ queryKey: ['identities'] })
      onSaved?.(id)
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

  const formId = 'identity-form'
  return (
    <Modal
      open
      title={identity ? (canEdit ? 'Edit identity' : 'Identity details') : 'New pharmaceutical identity'}
      description="The same medicine, however it is branded or packed."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button type="submit" form={formId} loading={save.isPending}>{identity ? 'Save changes' : 'Create identity'}</Button>}
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={serverError} />
        <Field label="Generic (INN) name" required error={errors.generic_name} hint="e.g. Amoxicillin + Clavulanic acid">
          <Input value={values.generic_name} onChange={set('generic_name')} readOnly={!canEdit} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Dosage form" required error={errors.dosage_form_id}>
            <Select value={values.dosage_form_id} onChange={set('dosage_form_id')} disabled={!canEdit}>
              <option value="">Select…</option>
              {(forms.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
          </Field>
          <Field label="Strength" required error={errors.strength_text} hint="e.g. 500 mg + 125 mg">
            <Input value={values.strength_text} onChange={set('strength_text')} readOnly={!canEdit} />
          </Field>
        </div>
        <Field label="Notes" error={errors.notes}><Textarea value={values.notes} onChange={set('notes')} readOnly={!canEdit} /></Field>
        <Checkbox label="Active" checked={values.is_active} disabled={!canEdit} onChange={(e) => setValues({ ...values, is_active: e.target.checked })} />
        {identity && <p className="text-xs text-slate-500">Once products use an identity its name, form and strength can no longer change in a way that alters its meaning — create a new identity instead.</p>}
      </form>
    </Modal>
  )
}
