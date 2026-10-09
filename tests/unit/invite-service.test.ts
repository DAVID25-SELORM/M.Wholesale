import { FunctionsHttpError } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke } } }))

import { AppError } from '@/lib/errors'
import { inviteUser, resendInvitation } from '@/services/users'

const input = { email: ' Esi@Example.com ', first_name: ' Esi ', last_name: 'Appiah', role_id: 'r1', branch_id: null, job_title: '  ' }

const httpError = (status: number, body: unknown) => new FunctionsHttpError(new Response(JSON.stringify(body), { status }))

describe('invitation service (talks to the invite-user Edge Function)', () => {
  beforeEach(() => invoke.mockReset())

  it('sends trimmed values and never an organization id', async () => {
    invoke.mockResolvedValue({ data: { ok: true }, error: null })
    await inviteUser(input)
    expect(invoke).toHaveBeenCalledWith('invite-user', {
      body: { action: 'invite', email: 'Esi@Example.com', first_name: 'Esi', last_name: 'Appiah', role_id: 'r1', branch_id: null, job_title: undefined },
    })
    expect(JSON.stringify(invoke.mock.calls[0])).not.toMatch(/organization/)
  })

  it.each([
    [403, 'permission', 'cannot invite someone with a role more powerful than your own'],
    [409, 'duplicate', 'Someone with that email address already has an account.'],
    [400, 'validation', 'Enter a valid email address.'],
    [404, 'not_found', 'role not found'],
  ])('turns HTTP %i into a %s error carrying the server message', async (status, kind, message) => {
    invoke.mockResolvedValue({ data: null, error: httpError(status, { error: message }) })
    const err = await inviteUser(input).catch((e) => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err).toMatchObject({ kind, message })
  })

  it('falls back to a generic message when the function body is not JSON', async () => {
    invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(new Response('<html>bad gateway</html>', { status: 502 })) })
    const err = await inviteUser(input).catch((e) => e)
    expect(err).toMatchObject({ message: 'The invitation could not be sent.' })
  })

  it('reports network failures as such', async () => {
    invoke.mockResolvedValue({ data: null, error: new TypeError('Failed to fetch') })
    expect(await inviteUser(input).catch((e) => e)).toMatchObject({ kind: 'network' })
  })

  it('resend sends only the user id', async () => {
    invoke.mockResolvedValue({ data: { ok: true }, error: null })
    await resendInvitation('user-1')
    expect(invoke).toHaveBeenCalledWith('invite-user', { body: { action: 'resend', user_id: 'user-1' } })
  })
})
