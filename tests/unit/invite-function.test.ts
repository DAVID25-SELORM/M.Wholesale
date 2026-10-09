import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleInvite, validateRequest, type InviteDeps } from '../../supabase/functions/invite-user/index'

const ROLE = '3f6f708c-dd50-4026-b94d-ef651bddd692'
const BRANCH = '27099ab0-e6c9-4c1b-8556-6dd777298ed3'
const ACTOR = '7ec47535-1402-4d87-85d7-455067df9d61'
const ORG = '0d03f85b-cfe7-4135-9d5c-e0cff2e887e5'
const NEW_USER = '11111111-1111-4111-8111-111111111111'
const ORIGIN = 'https://m-wholesale.vercel.app'

const validBody = { action: 'invite', email: ' New.Person@Example.com ', first_name: 'Esi', last_name: 'Appiah', role_id: ROLE, branch_id: BRANCH, job_title: 'Lead' }

function makeDeps() {
  const userRpc = vi.fn()
  const adminRpc = vi.fn()
  const invite = vi.fn()
  const getUserById = vi.fn()
  const deleteUser = vi.fn().mockResolvedValue({ error: null })
  const userClient = vi.fn(() => ({ rpc: userRpc }))
  const deps: InviteDeps = {
    allowedOrigins: [ORIGIN], defaultSiteUrl: ORIGIN,
    userClient, adminRpc: { rpc: adminRpc },
    adminAuth: { inviteUserByEmail: invite, getUserById, deleteUser },
  }
  return { deps, userRpc, adminRpc, invite, getUserById, deleteUser, userClient }
}

const call = (deps: InviteDeps, body: unknown, init: { method?: string; auth?: string | null; origin?: string | null } = {}) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (init.auth !== null) headers.Authorization = init.auth ?? 'Bearer user-jwt'
  if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN
  const method = init.method ?? 'POST'
  const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
  return handleInvite(new Request('https://x.supabase.co/functions/v1/invite-user', {
    method, headers, ...(hasBody ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  }), deps)
}

describe('validateRequest', () => {
  it('normalises a valid invite', () => {
    const r = validateRequest(validBody)
    expect(r).toEqual({ ok: true, value: { action: 'invite', email: 'new.person@example.com', first_name: 'Esi', last_name: 'Appiah', role_id: ROLE, branch_id: BRANCH, job_title: 'Lead' } })
  })
  it('rejects bad input', () => {
    for (const bad of [
      null, 'x', { action: 'nope' },
      { ...validBody, email: 'not-an-email' }, { ...validBody, email: '' },
      { ...validBody, first_name: '  ' }, { ...validBody, last_name: 'x'.repeat(101) },
      { ...validBody, role_id: 'abc' }, { ...validBody, branch_id: 'abc' },
      { action: 'resend', user_id: 'nope' },
    ]) expect(validateRequest(bad).ok, JSON.stringify(bad)).toBe(false)
  })
  it('treats missing branch as organization-wide', () => {
    expect(validateRequest({ ...validBody, branch_id: undefined })).toMatchObject({ ok: true, value: { branch_id: null } })
  })
})

describe('invite-user handler', () => {
  let t: ReturnType<typeof makeDeps>
  beforeEach(() => {
    t = makeDeps()
    t.userRpc.mockResolvedValue({ data: { actor_id: ACTOR, organization_id: ORG, role_code: 'BRANCH_MANAGER' }, error: null })
    t.invite.mockResolvedValue({ data: { user: { id: NEW_USER } }, error: null })
    t.adminRpc.mockResolvedValue({ data: null, error: null })
  })

  it('answers CORS preflight only for allowed origins', async () => {
    const ok = await call(t.deps, '', { method: 'OPTIONS' })
    expect(ok.status).toBe(204)
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    const evil = await call(t.deps, '', { method: 'OPTIONS', origin: 'https://evil.example' })
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('requires a bearer token and POST, and never touches the database without them', async () => {
    expect((await call(t.deps, validBody, { auth: null })).status).toBe(401)
    expect((await call(t.deps, validBody, { auth: 'Basic abc' })).status).toBe(401)
    expect((await call(t.deps, validBody, { method: 'GET' })).status).toBe(405)
    expect(t.userRpc).not.toHaveBeenCalled()
    expect(t.invite).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON and invalid fields before any side effect', async () => {
    expect((await call(t.deps, '{not json')).status).toBe(400)
    expect((await call(t.deps, { ...validBody, email: 'nope' })).status).toBe(400)
    expect(t.userRpc).not.toHaveBeenCalled()
    expect(t.invite).not.toHaveBeenCalled()
  })

  it('happy path: pre-check with the CALLER token, invite, then complete with the inviter as actor', async () => {
    const res = await call(t.deps, validBody)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, user_id: NEW_USER })
    expect(t.userClient).toHaveBeenCalledWith('Bearer user-jwt')
    expect(t.userRpc).toHaveBeenCalledWith('prepare_invitation', { p_role_id: ROLE, p_branch_id: BRANCH })
    expect(t.invite).toHaveBeenCalledWith('new.person@example.com', { redirectTo: `${ORIGIN}/accept-invite` })
    expect(t.adminRpc).toHaveBeenCalledWith('complete_invitation', {
      p_actor_id: ACTOR, p_user_id: NEW_USER, p_organization_id: ORG, p_first_name: 'Esi', p_last_name: 'Appiah',
      p_role_id: ROLE, p_branch_id: BRANCH, p_job_title: 'Lead',
    })
  })

  it('ignores any organization_id / actor supplied by the client', async () => {
    await call(t.deps, { ...validBody, organization_id: 'attacker-org', actor_id: 'attacker', p_organization_id: 'x' })
    const args = t.adminRpc.mock.calls[0]![1] as Record<string, unknown>
    expect(args.p_organization_id).toBe(ORG)
    expect(args.p_actor_id).toBe(ACTOR)
  })

  it('stops with 403 and sends NO email when the database refuses the inviter', async () => {
    t.userRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'cannot invite someone with a role more powerful than your own' } })
    const res = await call(t.deps, validBody)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/more powerful/)
    expect(t.invite).not.toHaveBeenCalled()
    expect(t.adminRpc).not.toHaveBeenCalled()
  })

  it('answers 401 when the database rejects the caller\'s token, and sends no email', async () => {
    for (const code of ['PGRST301', 'PGRST303', '28000']) {
      t.userRpc.mockResolvedValue({ data: null, error: { code, message: 'JWT expired' } })
      const res = await call(t.deps, validBody)
      expect(res.status, code).toBe(401)
    }
    expect(t.invite).not.toHaveBeenCalled()
  })

  it('maps unknown role/branch to 404', async () => {
    t.userRpc.mockResolvedValue({ data: null, error: { code: 'P0002', message: 'role not found' } })
    expect((await call(t.deps, validBody)).status).toBe(404)
  })

  it('returns 409 when the email already has an account', async () => {
    t.invite.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists', message: 'A user with this email address has already been registered' } })
    const res = await call(t.deps, validBody)
    expect(res.status).toBe(409)
    expect(t.adminRpc).not.toHaveBeenCalled()
  })

  it('returns 502 when the email cannot be sent', async () => {
    t.invite.mockResolvedValue({ data: { user: null }, error: { message: 'smtp down' } })
    const res = await call(t.deps, validBody)
    expect(res.status).toBe(502)
    expect(JSON.stringify(await res.json())).not.toMatch(/smtp/)
  })

  it('removes the freshly created auth user when completing the invitation fails', async () => {
    t.adminRpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key' } })
    const res = await call(t.deps, validBody)
    expect(res.status).toBe(409)
    expect(t.deleteUser).toHaveBeenCalledWith(NEW_USER)
  })

  it('never leaks internal error text', async () => {
    t.adminRpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'relation "secret" exploded' } })
    const res = await call(t.deps, validBody)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toMatch(/secret|exploded/)
  })

  describe('resend', () => {
    const body = { action: 'resend', user_id: NEW_USER }
    beforeEach(() => {
      t.userRpc.mockResolvedValue({ data: { actor_id: ACTOR, organization_id: ORG, email: 'new.person@example.com' }, error: null })
      t.getUserById.mockResolvedValue({ data: { user: { email_confirmed_at: null, last_sign_in_at: null } }, error: null })
    })
    it('re-sends to a pending user after the database pre-check', async () => {
      const res = await call(t.deps, body)
      expect(res.status).toBe(200)
      expect(t.userRpc).toHaveBeenCalledWith('prepare_resend', { p_user_id: NEW_USER })
      expect(t.invite).toHaveBeenCalledWith('new.person@example.com', { redirectTo: `${ORIGIN}/accept-invite` })
    })
    it('refuses when the invitation was already accepted', async () => {
      t.getUserById.mockResolvedValue({ data: { user: { email_confirmed_at: '2026-10-09T10:00:00Z' } }, error: null })
      expect((await call(t.deps, body)).status).toBe(409)
      expect(t.invite).not.toHaveBeenCalled()
    })
    it('refuses without permission', async () => {
      t.userRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'insufficient privilege to invite users' } })
      expect((await call(t.deps, body)).status).toBe(403)
      expect(t.getUserById).not.toHaveBeenCalled()
    })
  })

  it('falls back to the configured site URL for unknown origins (no open redirect)', async () => {
    await call(t.deps, validBody, { origin: 'https://evil.example' })
    expect(t.invite).toHaveBeenCalledWith('new.person@example.com', { redirectTo: `${ORIGIN}/accept-invite` })
  })
})
