import clsx, { type ClassValue } from 'clsx'
import { useEffect, useState } from 'react'

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}

export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

export function formatDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}),
  }).format(d)
}

/** Escape % and _ so user text is matched literally inside ilike patterns. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** PostgREST `or(...)` filter values are comma/paren delimited; strip those characters. */
export function sanitizeForOrFilter(text: string): string {
  return escapeLike(text).replace(/[,()"']/g, ' ').trim()
}
