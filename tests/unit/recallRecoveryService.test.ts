import { beforeEach, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ from: vi.fn(), scopes: vi.fn(), filter: vi.fn(), order: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: db.from } }))
import { listRecallRecoveries } from '@/services/recalls'
beforeEach(() => {
  vi.clearAllMocks()
  db.from.mockImplementation((table: string) => table === 'recall_batch_scope' ? { select: () => ({ eq: db.scopes }) } : { select: () => ({ in: db.filter }) })
  db.filter.mockReturnValue({ order: db.order })
  db.order.mockResolvedValue({ data: [{ id: 'recovery' }], error: null })
})
it('restricts recovery records to the selected recall scopes', async () => {
  db.scopes.mockResolvedValue({ data: [{ id: 'scope-a' }, { id: 'scope-b' }], error: null })
  expect(await listRecallRecoveries('recall')).toEqual([{ id: 'recovery' }])
  expect(db.scopes).toHaveBeenCalledWith('recall_id', 'recall')
  expect(db.filter).toHaveBeenCalledWith('recall_batch_scope_id', ['scope-a', 'scope-b'])
})
it('does not query unrelated recoveries for an empty recall', async () => {
  db.scopes.mockResolvedValue({ data: [], error: null })
  expect(await listRecallRecoveries('empty')).toEqual([])
  expect(db.filter).not.toHaveBeenCalled()
})
