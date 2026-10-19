import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeContext, renderWithApp } from './helpers'

const svc = vi.hoisted(() => ({
  getSettingsOverview: vi.fn(),
  getNumberingOverview: vi.fn(),
  saveSetting: vi.fn(() => Promise.resolve()),
  configureNumbering: vi.fn(() => Promise.resolve()),
  getAppSettings: vi.fn(),
}))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/services/warehouses', () => ({ listWarehouseOptions: () => Promise.resolve([]) }))
vi.mock('@/services/settings', async (orig) => ({ ...(await orig<typeof import('@/services/settings')>()), ...svc }))

import { SettingsPage } from '@/modules/settings/SettingsPage'
import { IdleSignOut } from '@/modules/settings/IdleSignOut'
import { typed } from '@/modules/settings/useAppSettings'
import { SETTING_DEFAULTS, numberExample, type SettingRow } from '@/services/settings'

const row = (category: string, key: string, over: Partial<SettingRow> = {}): SettingRow => ({
  category, key, kind: 'int', min_num: 0, max_num: 365, min_nonzero: null, max_len: null, branch_scoped: false, sensitive: false, default_value: 0, value: 0, source: 'default', updated_at: null, ...over,
})
const ROWS: SettingRow[] = [
  row('invoice', 'footer', { kind: 'text', max_len: 300, min_num: null, max_num: null, default_value: '', value: '' }),
  row('invoice', 'payment_instructions', { kind: 'text', max_len: 500, min_num: null, max_num: null, default_value: '', value: '' }),
  row('sales', 'default_payment_terms_days', { default_value: 0, value: 0 }),
  row('sales', 'quotation_validity_days', { min_num: 1, default_value: 30, value: 30 }),
  row('credit', 'default_credit_limit', { kind: 'number', max_num: 1_000_000_000 }),
  row('purchasing', 'default_payment_terms_days', { default_value: 30, value: 30 }),
  row('inventory', 'near_expiry_days', { min_num: 1, max_num: 730, default_value: 90, value: 90 }),
  row('inventory', 'default_sales_warehouse', { kind: 'warehouse', branch_scoped: true, min_num: null, max_num: null, default_value: null, value: null }),
  row('security', 'idle_timeout_minutes', { max_num: 480, min_nonzero: 5, sensitive: true }),
]
const canManage = makeContext({ org_permissions: ['settings.view', 'settings.manage'] })
const viewOnly = makeContext({ org_permissions: ['settings.view'] })

beforeEach(() => {
  svc.getSettingsOverview.mockResolvedValue(ROWS)
  svc.getNumberingOverview.mockResolvedValue([
    { document_type: 'SALES_INVOICE', prefix: 'INV', padding: 6, reset_period: 'YEARLY', next_number: 1, configured: false, in_use: false },
    { document_type: 'SALES_ORDER', prefix: 'SO', padding: 6, reset_period: 'YEARLY', next_number: 41, configured: true, in_use: true },
  ])
  svc.saveSetting.mockClear(); svc.configureNumbering.mockClear()
})

describe('Settings page', () => {
  it('refuses people without the settings right, and shows a view-only notice with disabled fields to viewers', async () => {
    renderWithApp(<SettingsPage />, { context: makeContext({ org_permissions: [] }) })
    expect(screen.getByText(/do not have permission to view settings/i)).toBeInTheDocument()
    expect(svc.getSettingsOverview).not.toHaveBeenCalled()
  })

  it('is read-only for viewers', async () => {
    renderWithApp(<SettingsPage />, { context: viewOnly })
    expect(await screen.findByText(/view settings but not change them/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Document footer')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('validates a value against the database rules before sending, then saves it', async () => {
    const user = userEvent.setup()
    renderWithApp(<SettingsPage />, { context: canManage })
    await user.click(await screen.findByRole('tab', { name: 'Sales and credit' }))
    const terms = await screen.findByLabelText('Default payment terms for new customers')
    await user.clear(terms); await user.type(terms, '400')
    expect(await screen.findByText('At most 365.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Save' })[0]).toBeDisabled()
    await user.clear(terms); await user.type(terms, '45')
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]!)
    await waitFor(() => expect(svc.saveSetting).toHaveBeenCalledWith({ category: 'sales', key: 'default_payment_terms_days', value: 45 }))
  })

  it('asks for a reason before changing a security setting, and sends it with the change', async () => {
    const user = userEvent.setup()
    renderWithApp(<SettingsPage />, { context: canManage })
    await user.click(await screen.findByRole('tab', { name: 'Security and session' }))
    const idle = await screen.findByLabelText('Sign out after inactivity')
    await user.clear(idle); await user.type(idle, '3')
    expect(await screen.findByText('Use 0 (off) or at least 5.')).toBeInTheDocument()
    await user.clear(idle); await user.type(idle, '30')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(svc.saveSetting).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText(/Give a reason/)).toBeInTheDocument()
    await user.type(screen.getByLabelText(/Reason/), 'Shared counter computers')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(svc.saveSetting).toHaveBeenCalledWith({ category: 'security', key: 'idle_timeout_minutes', value: 30, reason: 'Shared counter computers' }))
  })

  it('shows document numbering with a live preview, and locks the restart period once numbers are issued', async () => {
    const user = userEvent.setup()
    renderWithApp(<SettingsPage />, { context: canManage })
    await user.click(await screen.findByRole('tab', { name: 'Document numbering' }))
    const edits = await screen.findAllByRole('button', { name: 'Edit' })
    await user.click(edits[1]!)                                                            // sales orders: in use
    expect(await screen.findByText(/counter carries on/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Restart numbering')).toBeDisabled()
    expect(screen.getAllByText(new RegExp(`SO-${new Date().getFullYear()}-000041`)).length).toBe(2)               // the table row and the preview
    const prefix = screen.getByLabelText(/Prefix/)
    await user.clear(prefix); await user.type(prefix, 'x y')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/cannot start or end with a dash/)).toBeInTheDocument()
    expect(svc.configureNumbering).not.toHaveBeenCalled()
    await user.clear(prefix); await user.type(prefix, 'ord')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(svc.configureNumbering).toHaveBeenCalledWith({ documentType: 'SALES_ORDER', prefix: 'ORD', padding: 6, resetPeriod: 'YEARLY' }))
  })

  it('does not pretend notifications or integrations can be configured', async () => {
    const user = userEvent.setup()
    renderWithApp(<SettingsPage />, { context: canManage })
    await user.click(await screen.findByRole('tab', { name: 'Notifications and integrations' }))
    expect(await screen.findByText(/nothing to configure/i)).toBeInTheDocument()
    expect(screen.getAllByText('Not connected').length).toBe(3)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})

describe('settings helpers', () => {
  it('maps the effective values and falls back to the defaults', () => {
    const t = typed({ ...SETTING_DEFAULTS, 'inventory.near_expiry_days': 60, 'inventory.default_sales_warehouse': 'w-1', 'invoice.footer': 'Thanks' }, true)
    expect(t).toMatchObject({ loaded: true, nearExpiryDays: 60, defaultSalesWarehouse: 'w-1', invoiceFooter: 'Thanks', quotationValidityDays: 30, defaultSupplierTerms: 30, idleTimeoutMinutes: 0 })
    expect(typed({}, false)).toMatchObject({ loaded: false, nearExpiryDays: 90, defaultSalesWarehouse: null, paymentInstructions: '' })
  })
  it('previews numbers the way the database builds them', () => {
    const now = new Date(2026, 2, 5)
    expect(numberExample('INV', 6, 'YEARLY', 1, now)).toBe('INV-2026-000001')
    expect(numberExample('INV', 4, 'MONTHLY', 12, now)).toBe('INV-202603-0012')
    expect(numberExample('INV', 5, 'NEVER', 7, now)).toBe('INV-00007')
  })
})

describe('idle sign-out', () => {
  const signOut = vi.fn(() => Promise.resolve())
  beforeEach(() => { vi.useFakeTimers(); signOut.mockClear() })
  afterEach(() => vi.useRealTimers())

  async function mount(minutes: number) {
    vi.resetModules()
    vi.doMock('@/modules/auth/AuthProvider', () => ({ useAuth: () => ({ signOut }) }))
    vi.doMock('@/modules/settings/useAppSettings', () => ({ useAppSettings: () => ({ idleTimeoutMinutes: minutes }) }))
    const { IdleSignOut: Fresh } = await import('@/modules/settings/IdleSignOut')
    return render(<Fresh />)
  }

  it('does nothing when the time-out is off', async () => {
    await mount(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(24 * 3_600_000) })
    expect(signOut).not.toHaveBeenCalled()
  })
  it('signs out after the configured minutes without activity, and activity postpones it', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    await mount(10)
    await act(async () => { await vi.advanceTimersByTimeAsync(9 * 60_000) })
    act(() => { window.dispatchEvent(new Event('keydown')) })                              // activity at minute 9
    await act(async () => { await vi.advanceTimersByTimeAsync(9 * 60_000) })
    expect(signOut).not.toHaveBeenCalled()                                                // minute 18: only 9 idle
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60_000) })              // minute 20: 11 idle
    expect(signOut).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
  it('is exported for the app shell', () => { expect(IdleSignOut).toBeTypeOf('function') })
})
