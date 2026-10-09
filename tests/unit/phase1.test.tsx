import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
const createProduct = vi.hoisted(() => vi.fn())
const createSupplier = vi.hoisted(() => vi.fn())
const listProducts = vi.hoisted(() => vi.fn())
const FORM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UNIT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const IDENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))
vi.mock('@/services/catalog', async (orig) => ({
  ...(await orig<typeof import('@/services/catalog')>()),
  createProduct, listProducts,
  updateProduct: vi.fn(),
  listUnitsOfMeasure: async () => [{ id: UNIT_ID, code: 'TABLET', name: 'Tablet', kind: 'COUNT', is_active: true }],
  listDosageForms: async () => [{ id: FORM_ID, code: 'TABLET', name: 'Tablet', is_active: true }],
  listManufacturerOptions: async () => [],
  listCategoryOptions: async () => [],
  searchIdentityOptions: async () => [{ id: IDENT_ID, generic_name: 'Paracetamol', strength_text: '500 mg', dosage_form_id: FORM_ID, dosage_form: { code: 'TABLET', name: 'Tablet' }, is_active: true }],
  getIdentity: async () => null,
}))
vi.mock('@/services/suppliers', async (orig) => ({ ...(await orig<typeof import('@/services/suppliers')>()), createSupplier, updateSupplier: vi.fn() }))

import { Sidebar } from '@/layouts/Sidebar'
import { ProductForm } from '@/modules/catalog/ProductForm'
import { ProductPicker } from '@/modules/catalog/ProductPicker'
import { SupplierForm } from '@/modules/suppliers/SupplierForm'
import { licenceDaysLeft } from '@/modules/suppliers/SuppliersPage'
import { makeContext, renderWithApp } from './helpers'

vi.mock('@/modules/auth/AuthProvider', () => ({ useAuth: () => ({ auth: { status: 'signedIn' }, signOut: vi.fn() }) }))

describe('product form', () => {
  beforeEach(() => createProduct.mockReset())

  it('requires an SKU, a name and a base unit before anything is sent', async () => {
    renderWithApp(<ProductForm open product={null} canEdit canCreateIdentity onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Create product' }))
    expect(await screen.findByText('Product name is required')).toBeInTheDocument()
    expect(screen.getByText('Choose the base unit')).toBeInTheDocument()
    expect(createProduct).not.toHaveBeenCalled()
  })

  it('a medicine (POM) must have a pharmaceutical identity; a device need not', async () => {
    createProduct.mockResolvedValue('new-id')
    renderWithApp(<ProductForm open product={null} canEdit canCreateIdentity onClose={() => {}} />)
    await userEvent.type(screen.getByLabelText(/^SKU/), 'aug-625')
    await userEvent.type(screen.getByLabelText(/^Product \/ brand name/), 'Augmentin 625')
    await screen.findByRole('option', { name: 'Tablet' })
    await userEvent.selectOptions(screen.getByLabelText(/^Base unit/), 'Tablet')
    await userEvent.click(screen.getByRole('button', { name: 'Create product' }))
    expect(await screen.findByText(/Medicines need a pharmaceutical identity/i)).toBeInTheDocument()
    expect(createProduct).not.toHaveBeenCalled()

    await userEvent.selectOptions(screen.getByLabelText(/^Class/), 'Medical device')
    await userEvent.click(screen.getByRole('button', { name: 'Create product' }))
    await waitFor(() => expect(createProduct).toHaveBeenCalledTimes(1))
    expect(createProduct.mock.calls[0]![0]).toMatchObject({ sku: 'AUG-625', brand_name: 'Augmentin 625', product_class: 'MEDICAL_DEVICE', identity_id: null })
    expect(createProduct.mock.calls[0]![0]).not.toHaveProperty('organization_id')
  })

  it('prescription is forced on for POM and controlled classes', async () => {
    renderWithApp(<ProductForm open product={null} canEdit canCreateIdentity onClose={() => {}} />)
    const rx = screen.getByLabelText('Requires a prescription') as HTMLInputElement
    expect(rx.checked).toBe(true)
    expect(rx).toBeDisabled() // default class is POM
    await userEvent.selectOptions(screen.getByLabelText(/^Class/), 'General sale (GSL)')
    expect(rx).toBeEnabled()
    await userEvent.selectOptions(screen.getByLabelText(/^Class/), 'Controlled drug')
    expect(rx.checked).toBe(true)
    expect(rx).toBeDisabled()
  })

  it('is read-only without permission', () => {
    renderWithApp(<ProductForm open product={null} canEdit={false} canCreateIdentity={false} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Create product' })).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^SKU/)).toHaveAttribute('readonly')
  })
})

describe('supplier form', () => {
  beforeEach(() => createSupplier.mockReset())

  it('validates terms, email and codes; sends normalised values', async () => {
    createSupplier.mockResolvedValue(undefined)
    renderWithApp(<SupplierForm open supplier={null} canEdit onClose={() => {}} />)
    await userEvent.type(screen.getByLabelText(/^Code/), 'emp')
    await userEvent.type(screen.getByLabelText(/^Name/), 'Emmanuel Pharma Ltd')
    const terms = screen.getByLabelText(/^Payment terms/)
    await userEvent.clear(terms)
    await userEvent.type(terms, '400')
    await userEvent.type(screen.getByLabelText(/^Email/), 'not-an-email')
    await userEvent.click(screen.getByRole('button', { name: 'Create supplier' }))
    expect(await screen.findByText('At most 365 days')).toBeInTheDocument()
    expect(screen.getByText('Enter a valid email')).toBeInTheDocument()
    expect(createSupplier).not.toHaveBeenCalled()

    await userEvent.clear(terms)
    await userEvent.type(terms, '45')
    await userEvent.clear(screen.getByLabelText(/^Email/))
    await userEvent.type(screen.getByLabelText(/^Email/), 'orders@emp.example')
    await userEvent.click(screen.getByRole('button', { name: 'Create supplier' }))
    await waitFor(() => expect(createSupplier).toHaveBeenCalledTimes(1))
    expect(createSupplier.mock.calls[0]![0]).toMatchObject({ code: 'EMP', name: 'Emmanuel Pharma Ltd', payment_terms_days: 45, email: 'orders@emp.example', supplier_type: 'DISTRIBUTOR' })
    expect(createSupplier.mock.calls[0]![0]).not.toHaveProperty('organization_id')
  })
})

describe('licence expiry', () => {
  it('counts days to expiry and flags expired licences', () => {
    const today = new Date('2026-10-10T08:00:00Z')
    expect(licenceDaysLeft('2026-10-10', today)).toBe(0)
    expect(licenceDaysLeft('2026-10-09', today)).toBe(-1)
    expect(licenceDaysLeft('2026-12-09', today)).toBe(60)
    expect(licenceDaysLeft(null, today)).toBeNull()
  })
})

describe('ProductPicker', () => {
  beforeEach(() => listProducts.mockReset())

  it('searches after two characters and selects a result', async () => {
    listProducts.mockResolvedValue({ rows: [{ id: 'p1', sku: 'AUG-625-14', brand_name: 'Augmentin 625', generic_name: 'Amoxicillin + Clavulanic acid', strength_text: '500 mg + 125 mg', dosage_form: 'Tablet', manufacturer_name: null, product_class: 'POM', is_active: true }], hasNext: false })
    const onChange = vi.fn()
    renderWithApp(<ProductPicker value={null} onChange={onChange} />)
    await userEvent.type(screen.getByLabelText('Search products'), 'a')
    expect(listProducts).not.toHaveBeenCalled()
    await userEvent.type(screen.getByLabelText('Search products'), 'ug')
    const option = await screen.findByRole('option', { name: /Augmentin 625/ }, { timeout: 3000 })
    await userEvent.click(within(option).getByRole('button'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', sku: 'AUG-625-14' }))
  })
})

describe('search service mapping', () => {
  beforeEach(() => rpc.mockReset())
  // the catalog service is mocked for the component tests above; here we want the real implementation
  const real = () => vi.importActual<typeof import('@/services/catalog')>('@/services/catalog').then((m) => m.listProducts)

  it('uses the database search and applies status/class filters without losing the next-page signal', async () => {
    const row = (n: number, active: boolean, cls: string) => ({
      product_id: `p${n}`, sku: `S${n}`, brand_name: `B${n}`, generic_name: 'G', strength_text: '1 mg', dosage_form: 'Tablet',
      manufacturer_name: null, product_class: cls, is_active: active, matched_on: 'match',
    })
    rpc.mockResolvedValue({ data: [row(1, true, 'POM'), row(2, false, 'POM'), row(3, true, 'GSL')], error: null })
    const realListProducts = await real()
    const res = await realListProducts({ page: 0, pageSize: 2, search: ' augmentin ', status: 'active', productClass: '', categoryId: '' })
    expect(rpc).toHaveBeenCalledWith('search_products', { p_query: 'augmentin', p_limit: 3, p_offset: 0 })
    expect(res.rows.map((r) => r.id)).toEqual(['p1', 'p3'])
    expect(res.hasNext).toBe(true) // a third row came back, so another page exists
    const onlyGsl = await realListProducts({ page: 0, pageSize: 5, search: 'x', status: 'all', productClass: 'GSL', categoryId: '' })
    expect(onlyGsl.rows.map((r) => r.id)).toEqual(['p3'])
  })

  it('turns a database error into a friendly one', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied' } })
    const realListProducts = await real()
    await expect(realListProducts({ page: 0, pageSize: 5, search: 'x', status: 'all', productClass: '', categoryId: '' })).rejects.toMatchObject({ kind: 'permission' })
  })
})

describe('navigation', () => {
  it('shows Products and Suppliers only to people holding the permissions', () => {
    const { unmount } = renderWithApp(<Sidebar onNavigate={() => {}} />, { context: makeContext({ org_permissions: ['products.view', 'suppliers.view'] }) })
    expect(screen.getByRole('link', { name: 'Products' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Catalogue setup' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Suppliers' })).toBeInTheDocument()
    unmount()
    renderWithApp(<Sidebar onNavigate={() => {}} />, { context: makeContext({ org_permissions: ['branches.view'] }) })
    expect(screen.queryByRole('link', { name: 'Products' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Suppliers' })).not.toBeInTheDocument()
  })
})
