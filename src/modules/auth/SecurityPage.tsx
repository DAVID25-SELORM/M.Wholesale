import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Badge, Button, Card, CardBody, ConfirmDialog, Field, InlineError, Input, LoadingState, PageHeader } from '@/components/ui'
import { toAppError } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import { listFactors, removeFactor, startEnrolment, verifyCode, type Enrolment } from '@/services/mfa'

/** Every signed-in person manages their own second sign-in step here. */
export function SecurityPage() {
  const qc = useQueryClient()
  const factors = useQuery({ queryKey: ['mfa-factors'], queryFn: listFactors })
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const verified = (factors.data ?? []).filter((f) => f.status === 'verified')

  async function act(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(null); setNotice(null)
    try { await fn(); await qc.invalidateQueries({ queryKey: ['mfa-factors'] }) } catch (e) { setError(toAppError(e).message) } finally { setBusy(false) }
  }
  const confirm = (e: FormEvent) => {
    e.preventDefault()
    if (!enrolment) return
    void act(async () => { await verifyCode(enrolment.factorId, code); setEnrolment(null); setCode(''); setNotice('Two-step sign-in is on. You will be asked for a code each time you sign in.') })
  }

  return (
    <>
      <PageHeader title="Sign-in security" description="Add a second step to your sign-in with an authenticator app. Strongly recommended for owners, accounts and anyone who manages users." />
      <InlineError message={error ?? (factors.isError ? toAppError(factors.error).message : null)} />
      {notice && <p role="status" className="mb-4">{notice}</p>}
      <Card><CardBody>
        <div className="flex items-center gap-3"><h2 className="font-semibold">Authenticator app</h2><Badge tone={verified.length ? 'green' : 'amber'}>{verified.length ? 'On' : 'Off'}</Badge></div>
        {factors.isPending && <LoadingState label="Loading…" />}
        {verified.map((f) => <div key={f.id} className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm"><span>Added {formatDateTime(f.created_at)}</span><Button variant="secondary" disabled={busy} onClick={() => setRemoving(f.id)}>Turn off</Button></div>)}
        {factors.isSuccess && verified.length === 0 && !enrolment && <div className="mt-3">
          <p className="mb-3 text-sm text-slate-600">You will need an authenticator app on your phone. Keep the phone safe: if you lose it, your system administrator has to reset this for you.</p>
          <Button loading={busy} onClick={() => void act(async () => setEnrolment(await startEnrolment()))}>Set up authenticator</Button>
        </div>}
        {enrolment && <form className="mt-4 space-y-4" onSubmit={confirm}>
          <p className="text-sm">1. Scan this picture with your authenticator app.</p>
          <img src={enrolment.qrCode} alt="QR code for the authenticator app" className="h-44 w-44 rounded border border-slate-200 bg-white p-1" />
          <p className="text-sm">Cannot scan? Type this key into the app: <code data-testid="mfa-secret" className="break-all rounded bg-slate-100 px-1.5 py-0.5">{enrolment.secret}</code></p>
          <Field label="2. Enter the 6-digit code the app shows" required><Input inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <div className="flex gap-2"><Button type="submit" loading={busy} disabled={!/^\d{6}$/.test(code.replace(/\s/g, ''))}>Turn on</Button>
            <Button type="button" variant="secondary" onClick={() => { const id = enrolment.factorId; setEnrolment(null); setCode(''); void act(() => removeFactor(id)) }}>Cancel</Button></div>
        </form>}
      </CardBody></Card>
      <ConfirmDialog open={removing !== null} title="Turn off two-step sign-in?" message="Your account will be protected by the password alone." confirmLabel="Turn off" tone="danger" loading={busy}
        onCancel={() => setRemoving(null)} onConfirm={() => { const id = removing!; void act(async () => { await removeFactor(id); setRemoving(null); setNotice('Two-step sign-in is off.') }) }} />
    </>
  )
}
