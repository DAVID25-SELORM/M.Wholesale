import { logError, toAppError } from '@/lib/errors'
import type { PageParams, Paged } from '@/types/domain'

/** Converts a Supabase `{ data, error }` result into data-or-throw with a user-safe AppError. */
export function unwrap<T>(result: { data: T | null; error: unknown }, context: string): T {
  if (result.error) {
    logError(context, result.error)
    throw toAppError(result.error)
  }
  return result.data as T
}

/** Same as unwrap, for `select(..., { count: 'exact' })` queries: returns rows + total. */
export function unwrapPaged<T>(
  result: { data: T[] | null; error: unknown; count: number | null },
  context: string,
  page: PageParams,
): Paged<T> {
  if (result.error) {
    logError(context, result.error)
    throw toAppError(result.error)
  }
  const total = result.count ?? 0
  return { rows: result.data ?? [], total, hasNext: (page.page + 1) * page.pageSize < total }
}

export function rangeFor({ page, pageSize }: PageParams): [number, number] {
  return [page * pageSize, page * pageSize + pageSize - 1]
}

export const emptyToNull = (v: string | undefined | null): string | null => {
  const t = v?.trim()
  return t ? t : null
}
