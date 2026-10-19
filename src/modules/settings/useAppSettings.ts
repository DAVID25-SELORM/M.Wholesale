import { useQuery } from '@tanstack/react-query'
import { ALL_BRANCHES, useSession } from '@/modules/session/SessionProvider'
import { SETTING_DEFAULTS, getAppSettings, type AppSettings } from '@/services/settings'

export const APP_SETTINGS_KEY = 'app-settings'

export interface TypedSettings {
  loaded: boolean
  invoiceFooter: string
  paymentInstructions: string
  defaultCustomerTerms: number
  quotationValidityDays: number
  defaultCreditLimit: number
  defaultSupplierTerms: number
  nearExpiryDays: number
  /** the warehouse the selected branch sells from by default, when one is set */
  defaultSalesWarehouse: string | null
  idleTimeoutMinutes: number
  fleetExpiryWarningDays: number
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function typed(s: AppSettings, loaded: boolean): TypedSettings {
  const d = SETTING_DEFAULTS
  return {
    loaded,
    invoiceFooter: str(s['invoice.footer']),
    paymentInstructions: str(s['invoice.payment_instructions']),
    defaultCustomerTerms: num(s['sales.default_payment_terms_days'], num(d['sales.default_payment_terms_days'], 0)),
    quotationValidityDays: num(s['sales.quotation_validity_days'], num(d['sales.quotation_validity_days'], 30)),
    defaultCreditLimit: num(s['credit.default_credit_limit'], 0),
    defaultSupplierTerms: num(s['purchasing.default_payment_terms_days'], num(d['purchasing.default_payment_terms_days'], 30)),
    nearExpiryDays: num(s['inventory.near_expiry_days'], num(d['inventory.near_expiry_days'], 90)),
    defaultSalesWarehouse: typeof s['inventory.default_sales_warehouse'] === 'string' ? (s['inventory.default_sales_warehouse'] as string) : null,
    idleTimeoutMinutes: num(s['security.idle_timeout_minutes'], 0),
    fleetExpiryWarningDays: num(s['fleet.expiry_warning_days'], num(d['fleet.expiry_warning_days'], 30)),
  }
}

/** The organization's settings (and the selected branch's overrides), cached; falls back to the defaults while loading or if the server cannot be reached. */
export function useAppSettings(): TypedSettings {
  const { selectedBranch } = useSession()
  const branch = selectedBranch === ALL_BRANCHES ? null : selectedBranch
  const query = useQuery({ queryKey: [APP_SETTINGS_KEY, branch], queryFn: () => getAppSettings(branch), staleTime: 60_000 })
  return typed(query.data ?? SETTING_DEFAULTS, query.isSuccess)
}
