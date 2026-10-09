import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Button, Checkbox, DateInput, Field, InlineError, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { optionalText, requiredText, validate } from '@/lib/validation'
import {
  IDENTITY_REQUIRED, PRODUCT_CLASSES, PRODUCT_CLASS_LABEL, STORAGE_CONDITIONS, STORAGE_LABEL,
  createProduct, listCategoryOptions, listManufacturerOptions, listUnitsOfMeasure, updateProduct,
  type ProductClass, type ProductDetail,
} from '@/services/catalog'
import { IdentityPicker } from './IdentityPicker'

const schema = z
  .object({
    sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/, 'Use letters, numbers, ".", "-" or "_" (max 64, no spaces).'),
    brand_name: requiredText('Product name', 300),
    identity_id: z.string().uuid().or(z.literal('')).transform((v) => v || null),
    description: optionalText(2000),
    manufacturer_id: z.string().uuid().or(z.literal('')).transform((v) => v || null),
    category_id: z.string().uuid().or(z.literal('')).transform((v) => v || null),
    product_class: z.enum(PRODUCT_CLASSES),
    storage_condition: z.enum(STORAGE_CONDITIONS),
    requires_prescription: z.boolean(),
    fda_registration_number: optionalText(60),
    fda_registration_expiry: z.string().optional(),
    base_unit_id: z.string().uuid('Choose the base unit'),
    track_batches: z.boolean(),
    is_active: z.boolean(),
  })
  .refine((v) => !IDENTITY_REQUIRED.includes(v.product_class) || v.identity_id !== null, {
    path: ['identity_id'], message: 'Medicines need a pharmaceutical identity (generic name, form and strength).',
  })

interface Values {
  sku: string; brand_name: string; identity_id: string; description: string; manufacturer_id: string; category_id: string
  product_class: ProductClass; storage_condition: (typeof STORAGE_CONDITIONS)[number]; requires_prescription: boolean
  fda_registration_number: string; fda_registration_expiry: string; base_unit_id: string; track_batches: boolean; is_active: boolean
}

const blank: Values = {
  sku: '', brand_name: '', identity_id: '', description: '', manufacturer_id: '', category_id: '', product_class: 'POM', storage_condition: 'AMBIENT',
  requires_prescription: true, fda_registration_number: '', fda_registration_expiry: '', base_unit_id: '', track_batches: true, is_active: true,
}

const fromProduct = (p: ProductDetail): Values => ({
  sku: p.sku, brand_name: p.brand_name, identity_id: p.identity_id ?? '', description: p.description ?? '', manufacturer_id: p.manufacturer_id ?? '',
  category_id: p.category_id ?? '', product_class: p.product_class as ProductClass, storage_condition: p.storage_condition as Values['storage_condition'],
  requires_prescription: p.requires_prescription, fda_registration_number: p.fda_registration_number ?? '', fda_registration_expiry: p.fda_registration_expiry ?? '',
  base_unit_id: p.base_unit_id, track_batches: p.track_batches, is_active: p.is_active,
})

export function ProductForm({ open, product, canEdit, canCreateIdentity, onClose, onSaved }: {
  open: boolean; product: ProductDetail | null; canEdit: boolean; canCreateIdentity: boolean; onClose: () => void; onSaved?: (id: string) => void
}) {
  return open ? <Inner product={product} canEdit={canEdit} canCreateIdentity={canCreateIdentity} onClose={onClose} {...(onSaved ? { onSaved } : {})} /> : null
}

function Inner({ product, canEdit, canCreateIdentity, onClose, onSaved }: {
  product: ProductDetail | null; canEdit: boolean; canCreateIdentity: boolean; onClose: () => void; onSaved?: (id: string) => void
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const units = useQuery({ queryKey: ['units'], queryFn: listUnitsOfMeasure, staleTime: Infinity })
  const manufacturers = useQuery({ queryKey: ['manufacturers', 'options'], queryFn: listManufacturerOptions, staleTime: 60_000 })
  const categories = useQuery({ queryKey: ['categories', 'options'], queryFn: listCategoryOptions, staleTime: 60_000 })
  const [values, setValues] = useState<Values>(product ? fromProduct(product) : blank)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async (v: z.output<typeof schema>) => {
      if (product) { await updateProduct(product.id, v); return product.id }
      return createProduct(v)
    },
    onSuccess: async (id) => {
      toast.success(product ? 'Product updated.' : 'Product created.')
      await Promise.all([qc.invalidateQueries({ queryKey: ['products'] }), qc.invalidateQueries({ queryKey: ['product', id] })])
      onSaved?.(id)
      onClose()
    },
    onError: (e) => setServerError(toAppError(e).message),
  })

  const set = (k: keyof Values) => (e: { target: { value: string } }) => setValues({ ...values, [k]: e.target.value })
  const setClass = (c: ProductClass) =>
    setValues({ ...values, product_class: c, requires_prescription: c === 'POM' || c === 'CONTROLLED' ? true : values.requires_prescription })
  const rxLocked = values.product_class === 'POM' || values.product_class === 'CONTROLLED'

  function submit(e: FormEvent) {
    e.preventDefault()
    setServerError(null)
    const r = validate(schema, values)
    if (!r.ok) { setErrors(r.errors); return }
    setErrors({})
    save.mutate(r.data)
  }

  const formId = 'product-form'
  return (
    <Modal
      open
      variant="drawer"
      title={product ? (canEdit ? 'Edit product' : 'Product details') : 'New product'}
      description={product ? product.sku : 'A sellable SKU: brand, pack and manufacturer.'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && <Button type="submit" form={formId} loading={save.isPending}>{product ? 'Save changes' : 'Create product'}</Button>}
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <InlineError message={serverError} />
        <Field label="SKU" required error={errors.sku} hint={product ? 'The SKU cannot be changed.' : 'Your own unique product code, e.g. AUG-625-14'}>
          <Input value={values.sku} onChange={set('sku')} maxLength={64} readOnly={!canEdit || Boolean(product)} />
        </Field>
        <Field label="Product / brand name" required error={errors.brand_name}><Input value={values.brand_name} onChange={set('brand_name')} readOnly={!canEdit} /></Field>
        <Field label="Class" required error={errors.product_class}>
          <Select value={values.product_class} onChange={(e) => setClass(e.target.value as ProductClass)} disabled={!canEdit}>
            {PRODUCT_CLASSES.map((c) => <option key={c} value={c}>{PRODUCT_CLASS_LABEL[c]}</option>)}
          </Select>
        </Field>
        <Field label="Pharmaceutical identity" required={IDENTITY_REQUIRED.includes(values.product_class)} error={errors.identity_id}
          hint="Generic name + form + strength. Brands and pack sizes of the same medicine share one identity.">
          {canEdit
            ? <IdentityPicker value={values.identity_id} onChange={(id) => setValues({ ...values, identity_id: id })} canCreate={canCreateIdentity} invalid={Boolean(errors.identity_id)} />
            : <Input readOnly value={product?.identity ? `${product.identity.generic_name} — ${product.identity.strength_text}` : '—'} />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Manufacturer" error={errors.manufacturer_id}>
            <Select value={values.manufacturer_id} onChange={set('manufacturer_id')} disabled={!canEdit}>
              <option value="">None</option>
              {(manufacturers.data ?? []).filter((m) => m.is_active || m.id === values.manufacturer_id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
          <Field label="Category" error={errors.category_id}>
            <Select value={values.category_id} onChange={set('category_id')} disabled={!canEdit}>
              <option value="">None</option>
              {(categories.data ?? []).filter((c) => c.is_active || c.id === values.category_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Base unit" required error={errors.base_unit_id} hint={product ? 'The base unit cannot be changed.' : 'The smallest unit you count, e.g. Tablet, Bottle, Vial. Packs (box of 14…) are added afterwards.'}>
          <Select value={values.base_unit_id} onChange={set('base_unit_id')} disabled={!canEdit || Boolean(product)}>
            <option value="">Select…</option>
            {(units.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
        <Field label="Storage" error={errors.storage_condition}>
          <Select value={values.storage_condition} onChange={set('storage_condition')} disabled={!canEdit}>
            {STORAGE_CONDITIONS.map((s) => <option key={s} value={s}>{STORAGE_LABEL[s]}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="FDA registration no." error={errors.fda_registration_number}><Input value={values.fda_registration_number} onChange={set('fda_registration_number')} readOnly={!canEdit} /></Field>
          <Field label="Registration expiry" error={errors.fda_registration_expiry}><DateInput value={values.fda_registration_expiry} onChange={set('fda_registration_expiry')} readOnly={!canEdit} /></Field>
        </div>
        <Field label="Description" error={errors.description}><Textarea value={values.description} onChange={set('description')} readOnly={!canEdit} /></Field>
        <div className="space-y-2">
          <Checkbox label="Requires a prescription" checked={values.requires_prescription || rxLocked} disabled={!canEdit || rxLocked}
            onChange={(e) => setValues({ ...values, requires_prescription: e.target.checked })} />
          <Checkbox label="Track batches and expiry" checked={values.track_batches} disabled={!canEdit} onChange={(e) => setValues({ ...values, track_batches: e.target.checked })} />
          <Checkbox label="Active" checked={values.is_active} disabled={!canEdit} onChange={(e) => setValues({ ...values, is_active: e.target.checked })} />
        </div>
      </form>
    </Modal>
  )
}
