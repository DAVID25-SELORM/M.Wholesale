import { supabase } from '@/lib/supabase'

// Reports unexpected application errors (a crashed screen, an uncaught exception) to the error log the owner can read under Administration → Application errors.
// Best effort: it never throws, never blocks the UI, sends only the error text, its stack and the page PATH (no query string, no form data, no tokens), and the
// database caps each user at 50 reports an hour.

export type ErrorSource = 'render' | 'window' | 'promise' | 'route'

const recent = new Map<string, number>()
const DEDUPE_MS = 60_000

/** Errors the screens already show to the user in words (permission, validation, network ...) are not application faults. */
function isExpected(error: unknown): boolean {
  const kind = (error as { kind?: string } | null)?.kind
  return kind !== undefined && kind !== 'unknown'
}

export function reportClientError(source: ErrorSource, error: unknown): void {
  try {
    if (isExpected(error)) return
    const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unknown error')
    const message = (e.message || e.name || 'Unknown error').slice(0, 500)
    const key = `${source}|${message}|${window.location.pathname}`
    const now = Date.now()
    if (now - (recent.get(key) ?? 0) < DEDUPE_MS) return
    recent.set(key, now)
    if (recent.size > 100) recent.clear()
    void supabase.rpc('report_client_error', {
      p_source: source, p_message: message, p_stack: (e.stack ?? '').slice(0, 4000), p_page_path: window.location.pathname,
      p_app_version: (import.meta.env.VITE_APP_VERSION as string | undefined) ?? 'dev', p_user_agent: navigator.userAgent.slice(0, 300),
    }).then(() => undefined, () => undefined)
  } catch {
    // reporting must never make things worse
  }
}

/** Catches what no component caught: call once at start-up. */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (ev) => {
    if (ev.error || ev.message) reportClientError('window', ev.error ?? ev.message)
  })
  window.addEventListener('unhandledrejection', (ev) => reportClientError('promise', ev.reason))
}
