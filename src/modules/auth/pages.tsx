import { LockKeyhole, ShieldAlert, UserX } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Button, Field, Input, InlineError } from '@/components/ui'
import { envProblem } from '@/lib/env'
import { toAppError } from '@/lib/errors'
import { useAuth } from './AuthProvider'

function CenteredCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
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

export function LoginPage() {
  const { auth, signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (auth.status === 'signedIn') return <Navigate to={from} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!email.trim() || !password) { setError('Enter your email and password.'); return }
    setSubmitting(true)
    try {
      await signIn(email, password)
      navigate(from, { replace: true })
    } catch (err) {
      setError(toAppError(err).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white">Rx</div>
          <h1 className="text-2xl font-semibold text-slate-900">Pharmacy Wholesale ERP</h1>
          <p className="mt-1 text-sm text-slate-500">Sign in to your organization</p>
        </div>
        <form onSubmit={onSubmit} noValidate className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {envProblem && <InlineError message={envProblem} />}
          <InlineError message={error} />
          <Field label="Email" required>
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" required>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full" loading={submitting} disabled={Boolean(envProblem)}>Sign in</Button>
          <p className="text-center text-xs text-slate-400">Accounts are created by your administrator.</p>
        </form>
      </div>
    </main>
  )
}

export function AccessDisabledPage() {
  const { signOut } = useAuth()
  const reason = (useLocation().state as { reason?: string } | null)?.reason
  return (
    <CenteredCard icon={<UserX className="h-5 w-5" />} title="Access disabled">
      <p>
        {reason === 'inactive_organization'
          ? 'Your organization is currently deactivated.'
          : 'Your account has been deactivated.'}{' '}
        Contact your administrator if you believe this is a mistake.
      </p>
      <Button variant="secondary" className="mt-5" onClick={() => void signOut()}>Sign out</Button>
    </CenteredCard>
  )
}

export function NoAccessPage() {
  const { signOut } = useAuth()
  return (
    <CenteredCard icon={<LockKeyhole className="h-5 w-5" />} title="No workspace for this account">
      <p>You are signed in, but this account has not been added to an organization yet. Ask your administrator to set it up.</p>
      <Button variant="secondary" className="mt-5" onClick={() => void signOut()}>Sign out</Button>
    </CenteredCard>
  )
}

export function UnauthorizedPage() {
  return (
    <CenteredCard icon={<ShieldAlert className="h-5 w-5" />} title="You don’t have access to this page">
      <p>Your role does not include the permission required here. If you need it, ask an administrator.</p>
      <Link to="/" className="mt-5 inline-block text-sm font-medium text-brand-700 hover:underline">Back to dashboard</Link>
    </CenteredCard>
  )
}

export function NotFoundPage() {
  return (
    <CenteredCard icon={<ShieldAlert className="h-5 w-5" />} title="Page not found">
      <p>The page you are looking for does not exist.</p>
      <Link to="/" className="mt-5 inline-block text-sm font-medium text-brand-700 hover:underline">Back to dashboard</Link>
    </CenteredCard>
  )
}
