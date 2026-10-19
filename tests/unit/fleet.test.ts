import { describe, expect, it } from 'vitest'
import { daysUntil, expiryState } from '@/modules/fleet/expiry'
import { registration, vehicleSchema } from '@/modules/fleet/VehicleForm'
import { driverSchema } from '@/modules/fleet/DriverForm'

const today = new Date(2026, 9, 20)   // 20 October 2026, local

describe('expiry state', () => {
  it('counts calendar days without time-zone drift', () => {
    expect(daysUntil('2026-10-20', today)).toBe(0)
    expect(daysUntil('2026-10-21', today)).toBe(1)
    expect(daysUntil('2026-10-19', today)).toBe(-1)
    expect(daysUntil('2027-10-20', today)).toBe(365)
  })
  it('treats the expiry day as the last valid day and warns inside the window', () => {
    expect(expiryState(null, 30, today)).toBe('missing')
    expect(expiryState('', 30, today)).toBe('missing')
    expect(expiryState('2026-10-19', 30, today)).toBe('expired')
    expect(expiryState('2026-10-20', 30, today)).toBe('soon')
    expect(expiryState('2026-11-19', 30, today)).toBe('soon')
    expect(expiryState('2026-11-20', 30, today)).toBe('valid')
    expect(expiryState('2026-11-20', 31, today)).toBe('soon')
  })
})

describe('vehicle form rules', () => {
  it('normalises the registration like the database does', () => {
    expect(registration.parse(' gr 1234-24 ')).toBe('GR1234-24')
    for (const bad of ['A', 'GR/123', 'X'.repeat(21)]) expect(registration.safeParse(bad).success, bad).toBe(false)
  })
  const base = { branch_id: 'b1', registration_number: 'gr 1', name: '', vehicle_type: 'VAN', capacity_packages: '', capacity_kg: '', refrigerated: false, insurance_expiry: '', roadworthy_expiry: '', notes: '', is_active: true }
  it('accepts a minimal vehicle and rejects bad numbers, types and dates', () => {
    expect(vehicleSchema.safeParse({ ...base, registration_number: 'GR 1234-24' }).success).toBe(true)
    expect(vehicleSchema.safeParse({ ...base, registration_number: 'GR1234', capacity_packages: '12.5' }).success).toBe(false)
    expect(vehicleSchema.safeParse({ ...base, registration_number: 'GR1234', capacity_kg: '-1' }).success).toBe(false)
    expect(vehicleSchema.safeParse({ ...base, registration_number: 'GR1234', vehicle_type: 'ROCKET' }).success).toBe(false)
    expect(vehicleSchema.safeParse({ ...base, registration_number: 'GR1234', insurance_expiry: '31/12/2026' }).success).toBe(false)
  })
})

describe('driver form rules', () => {
  const base = { branch_id: 'b1', code: 'drv-01', name: 'Kofi', phone: '', licence_number: '', licence_class: '', licence_expiry: '', notes: '', is_active: true }
  it('upper-cases the code and needs a name and a branch', () => {
    const r = driverSchema.safeParse(base)
    expect(r.success && r.data.code).toBe('DRV-01')
    expect(driverSchema.safeParse({ ...base, name: ' ' }).success).toBe(false)
    expect(driverSchema.safeParse({ ...base, branch_id: '' }).success).toBe(false)
    expect(driverSchema.safeParse({ ...base, code: 'has space' }).success).toBe(false)
  })
})
