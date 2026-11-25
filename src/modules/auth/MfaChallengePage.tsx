import { useQuery } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button, Field, InlineError, Input, LoadingState } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { listFactors, verifyCode } from '@/services/mfa'
import { useAuth } from './AuthProvider'

/** Shown after the password step to anyone with an authenticator. Until the code is accepted the database gives this session nothing. */
export function MfaChallengePage({ onVerified }: { onVerified: () => void | Promise<unknown> }) {
  const { signOut } = useAuth()
  const factors = useQuery({ queryKey: ['mfa-factors', 'challenge'], queryFn: listFactors, gcTime: 0 })
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const factor = factors.data?.find((f) => f.status === 'verified')

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!factor || busy) return
    setBusy(true); setError(null)
    try { await verifyCode(factor.id, code); await onVerified() } catch (err) { setError(toAppError(err).message); setCode('') } finally { setBusy(false) }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-700"><ShieldCheck className="h-5 w-5" aria-hidden /></div>
        <h1 className="text-xl font-semibold text-slate-900">Enter your sign-in code</h1>
        <p className="mt-2 text-sm text-slate-600">Open your authenticator app and type the 6-digit code for this account.</p>
        {factors.isPending && <LoadingState label="Checking your authenticator…" />}
        <InlineError message={factors.isError ? toAppError(factors.error).message : null} />
        <form className="mt-4 space-y-4" onSubmit={(e) => void submit(e)}>
          <InlineError message={error} />
          <Field label="6-digit code" required><Input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Button type="submit" loading={busy} disabled={!factor || !/^\d{6}$/.test(code.replace(/\s/g, ''))}>Verify</Button>
        </form>
        <p className="mt-4 text-sm text-slate-600">Lost your phone? Ask your system administrator to reset your second step after confirming it is you.</p>
        <button type="button" className="mt-3 text-sm font-medium text-brand-700 hover:underline" onClick={() => void signOut()}>Sign out</button>
      </div>
    </main>
  )
}
