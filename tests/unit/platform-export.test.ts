import { beforeEach, expect, it, vi } from 'vitest'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))
import { collectPlatformExport } from '@/modules/platform/api'
beforeEach(() => rpc.mockReset())
it('collects all pages with the same filters', async () => {
  rpc.mockResolvedValueOnce({ data: { rows: Array.from({ length: 25 }, (_, i) => ({ id: String(i) })), total: 26 }, error: null })
    .mockResolvedValueOnce({ data: { rows: [{ id: '25' }], total: 26 }, error: null })
  const progress = vi.fn()
  const rows = await collectPlatformExport('organizations', 'Pharmacy', '2026-01-01', '2026-12-31', undefined, 'ACTIVE', new AbortController().signal, progress)
  expect(rows).toHaveLength(26)
  expect(rpc.mock.calls[1]![1]).toMatchObject({ p_page: 1, p_search: 'Pharmacy', p_filter: 'ACTIVE' })
  expect(progress).toHaveBeenLastCalledWith(26)
})
it('rejects changing totals instead of downloading a known incomplete export', async () => {
  rpc.mockResolvedValueOnce({ data: { rows: [{ id: 'a' }], total: 2 }, error: null })
    .mockResolvedValueOnce({ data: { rows: [{ id: 'b' }], total: 3 }, error: null })
  await expect(collectPlatformExport('users', '', '', '', undefined, 'ALL', new AbortController().signal, vi.fn())).rejects.toThrow('Records changed')
})
it('cancels before making a request', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(collectPlatformExport('users', '', '', '', undefined, 'ALL', controller.signal, vi.fn())).rejects.toThrow()
  expect(rpc).not.toHaveBeenCalled()
})
it('rejects duplicate records caused by page movement', async () => {
  rpc.mockResolvedValueOnce({ data: { rows: [{ id: 'a' }], total: 2 }, error: null })
    .mockResolvedValueOnce({ data: { rows: [{ id: 'a' }], total: 2 }, error: null })
  await expect(collectPlatformExport('users', '', '', '', undefined, 'ALL', new AbortController().signal, vi.fn())).rejects.toThrow('Records moved')
})
