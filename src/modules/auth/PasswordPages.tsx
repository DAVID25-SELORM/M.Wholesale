import { KeyRound, MailCheck } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { z } from 'zod'
import { Button, Field, InlineError, Input, LoadingState, useToast } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { supabase } from '@/lib/supabase'
import { validate } from '@/lib/validation'
import { useAuth } from './AuthProvider'

/** Mirrors the Supabase Auth password policy configured for the project (12+ chars, upper, lower, digit). */
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(72, 'Use at most 72 characters.')
  .regex(/[a-z]/, 'Include a lowercase letter.')
  .regex(/[A-Z]/, 'Include an uppercase letter.')
  .regex(/[0-9]/, 'Include a number.')

const formSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'The passwords do not match.' })

function Shell({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-700">{icon}</div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        <div className="mt-2 text-sm text-slate-600">{children}</div>
      </div>
    </main>
  )
}

/**
 * Landing page for invitation and password-reset links. supabase-js has already exchanged the one-time token
 * in the URL for a session; here the person chooses their password. Without a session the link is
 * invalid / expired / already used.
 */
export function SetPasswordPage({ mode }: { mode: 'invite' | 'reset' }) {
  const { auth } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  if (auth.status === 'loading') return <LoadingState label="Checking your link…" className="min-h-screen" />
  if (auth.status === 'signedOut') {
    return (
      <Shell icon={<KeyRound className="h-5 w-5" />} title="This link is no longer valid">
        <p>
          {mode === 'invite' ? 'Invitation links can be used once and expire after a while.' : 'Password reset links can be used once and expire quickly.'}{' '}
          If you already chose a password, sign in. Otherwise request a new link.
        </p>
        <div className="mt-5 flex gap-4 text-sm font-medium text-brand-700">
          <Link to="/login" className="hover:underline">Go to sign in</Link>
          <Link to="/forgot-password" className="hover:underline">Reset my password</Link>
        </div>
      </Shell>
    )
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setServerError(null)
    const r = validate(formSchema, { password, confirm })
    if (!r.ok) { setErrors(r.errors); return }
    setErrors({})
    setSaving(true)
    try {
      const { error } = await supabase.auth.updateUser({ password: r.data.password })
      if (error) throw error
      toast.success('Password saved. Welcome!')
      navigate('/', { replace: true })
    } catch (err) {
      setServerError(toAppError(err, 'Could not save your password. Please try again.').message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Shell icon={<KeyRound className="h-5 w-5" />} title={mode === 'invite' ? 'Welcome — choose your password' : 'Choose a new password'}>
      <form onSubmit={onSubmit} noValidate className="mt-3 space-y-4">
        <InlineError message={serverError} />
        <Field label="New password" required error={errors.password} hint="At least 12 characters with upper-case, lower-case and a number.">
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password" required error={errors.confirm}>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" loading={saving}>Save password and continue</Button>
      </form>
    </Shell>
  )
}

export function ForgotPasswordPage() {
  const { auth } = useAuth()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  if (auth.status === 'signedIn') return <Navigate to="/" replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!z.string().trim().email().safeParse(email).success) { setError('Enter a valid email address.'); return }
    setBusy(true)
    try {
      const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/reset-password` })
      // Same answer whether or not the account exists, so this form cannot be used to discover accounts.
      // Only throttling is reported, since the person can act on it.
      if (err && /rate limit|too many/i.test(err.message)) throw err
      if (err) console.error('[resetPasswordForEmail]', { message: err.message })
      setSent(true)
    } catch (err) {
      setError(toAppError(err, 'Could not send the e-mail. Please try again in a few minutes.').message)
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <Shell icon={<MailCheck className="h-5 w-5" />} title="Check your e-mail">
        <p>If an account exists for that address, we have sent a link to choose a new password.</p>
        <Link to="/login" className="mt-5 inline-block text-sm font-medium text-brand-700 hover:underline">Back to sign in</Link>
      </Shell>
    )
  }
  return (
    <Shell icon={<KeyRound className="h-5 w-5" />} title="Reset your password">
      <form onSubmit={onSubmit} noValidate className="mt-3 space-y-4">
        <InlineError message={error} />
        <Field label="Email" required>
          <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" loading={busy}>Send reset link</Button>
        <Link to="/login" className="block text-center text-sm font-medium text-brand-700 hover:underline">Back to sign in</Link>
      </form>
    </Shell>
  )
}
