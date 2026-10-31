import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { RevenueSummary } from '@/modules/platform/RevenueSummary'
it('keeps currencies separate and distinguishes commitments from collections', () => {
  render(<RevenueSummary data={{ recurring: [{ currency: 'GHS', monthly_recurring_value: 100 }, { currency: 'USD', monthly_recurring_value: 20 }], collected: [], collection_status: 'UNCONFIGURED' }} />)
  expect(screen.getByText('GHS')).toBeInTheDocument()
  expect(screen.getByText('USD')).toBeInTheDocument()
  expect(screen.getByText('No records available.')).toBeInTheDocument()
  expect(screen.getByText(/not received payments/)).toBeInTheDocument()
})
