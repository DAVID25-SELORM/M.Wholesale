import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn((..._args: unknown[]) => Promise.resolve({ data: null, error: null })))
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))

import { ErrorBoundary } from '@/components/ErrorBoundary'
import { AppError } from '@/lib/errors'
import { reportClientError } from '@/lib/errorReport'

function Boom(): never {
  throw new Error('render exploded')
}

describe('error reporting', () => {
  beforeEach(() => { rpc.mockClear(); vi.spyOn(console, 'error').mockImplementation(() => undefined) })

  it('shows a calm message instead of a white page when a screen crashes, and reports it once', () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('report_client_error', expect.objectContaining({ p_source: 'render', p_message: 'render exploded' }))
  })

  it('sends only the page path, never the query string, and de-duplicates a repeating error', () => {
    window.history.pushState({}, '', '/sales/invoices?token=secret#x')
    reportClientError('window', new Error('repeating fault'))
    reportClientError('window', new Error('repeating fault'))
    expect(rpc).toHaveBeenCalledTimes(1)
    const args = (rpc.mock.calls[0] as unknown as [string, Record<string, string>])[1]
    expect(args.p_page_path).toBe('/sales/invoices')
    expect(JSON.stringify(args)).not.toContain('secret')
  })

  it('ignores errors the screens already explain in words, and never throws', () => {
    reportClientError('promise', new AppError('permission', 'You do not have permission to do that.'))
    reportClientError('promise', new AppError('network', 'Cannot reach the server.'))
    expect(rpc).not.toHaveBeenCalled()
    rpc.mockImplementationOnce((..._a: unknown[]) => { throw new Error('reporting itself failed') })
    expect(() => reportClientError('window', new Error('another fault'))).not.toThrow()
  })
})
