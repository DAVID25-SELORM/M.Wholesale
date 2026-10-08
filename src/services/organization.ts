import { supabase } from '@/lib/supabase'
import type { Tables } from '@/types/domain'
import { emptyToNull, unwrap } from './common'

export type Organization = Tables<'organizations'>

export interface OrganizationInput {
  name: string
  legal_name?: string | undefined
  trading_name?: string | undefined
  registration_number?: string | undefined
  tax_number?: string | undefined
  phone?: string | undefined
  email?: string | undefined
  address?: string | undefined
  city?: string | undefined
  region?: string | undefined
  country: string
  currency_code: string
  timezone: string
}

export async function getOrganization(): Promise<Organization> {
  // RLS returns exactly one row: the caller's own organization.
  return unwrap(await supabase.from('organizations').select('*').single(), 'organization.get')
}

export async function updateOrganization(id: string, input: OrganizationInput): Promise<void> {
  unwrap(
    await supabase.from('organizations').update({
      name: input.name.trim(),
      legal_name: emptyToNull(input.legal_name),
      trading_name: emptyToNull(input.trading_name),
      registration_number: emptyToNull(input.registration_number),
      tax_number: emptyToNull(input.tax_number),
      phone: emptyToNull(input.phone),
      email: emptyToNull(input.email),
      address: emptyToNull(input.address),
      city: emptyToNull(input.city),
      region: emptyToNull(input.region),
      country: input.country,
      currency_code: input.currency_code,
      timezone: input.timezone,
    }).eq('id', id).select('id').single(),
    'organization.update',
  )
}
