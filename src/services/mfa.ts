import { toAppError, logError } from '@/lib/errors'
import { supabase } from '@/lib/supabase'

export interface Factor { id: string; friendly_name: string | null; status: string; created_at: string }
export interface Enrolment { factorId: string; qrCode: string; secret: string }

function check<T>(result: { data: T | null; error: unknown }, context: string): T {
  if (result.error) { logError(context, result.error); throw toAppError(result.error) }
  return result.data as T
}

export async function listFactors(): Promise<Factor[]> {
  const data = check(await supabase.auth.mfa.listFactors(), 'mfa.list')
  return data.all.filter((f) => f.factor_type === 'totp').map((f) => ({ id: f.id, friendly_name: f.friendly_name ?? null, status: f.status, created_at: f.created_at }))
}

/** Starts a new authenticator enrolment. Unfinished earlier attempts are removed so they cannot pile up. */
export async function startEnrolment(): Promise<Enrolment> {
  for (const f of await listFactors()) if (f.status !== 'verified') await removeFactor(f.id)
  const data = check(await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Authenticator ${new Date().toISOString().slice(0, 19)}` }), 'mfa.enroll')
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret }
}

/** Proves possession of the authenticator. On success the current session is upgraded to the second assurance level. */
export async function verifyCode(factorId: string, code: string): Promise<void> {
  check(await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\s/g, '') }), 'mfa.verify')
}

export async function removeFactor(factorId: string): Promise<void> {
  check(await supabase.auth.mfa.unenroll({ factorId }), 'mfa.unenroll')
  await supabase.auth.refreshSession()
}
