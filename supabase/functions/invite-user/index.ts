// Edge Function: invite-user
//
// Invites a person into the CALLER's organization. Why a function: sending an invitation needs the
// service-role key, which must never reach a browser. Authorization is still decided by the database:
//
//   browser --(user JWT)--> this function
//     1. prepare_invitation / prepare_resend   run WITH THE CALLER'S JWT  -> users.invite + anti-escalation
//     2. auth.admin.inviteUserByEmail          service role               -> creates the auth user + sends mail
//     3. complete_invitation                   service role only RPC      -> profile + role + audit(actor = caller)
//     (if step 3 fails the auth user from step 2 is deleted again)
//
// organization_id is NEVER taken from the request; it comes from the caller's session inside the database.
// The file is self-contained (single file, no local imports) so it can be pasted into the Supabase dashboard
// editor or deployed with `supabase functions deploy invite-user`, and it is unit-tested with fakes
// (tests/unit/invite-function.test.ts).

export interface RpcResult<T = unknown> {
  data: T | null
  error: { code?: string; message?: string } | null
}

export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult>
}

export interface AdminAuth {
  inviteUserByEmail(
    email: string,
    options: { redirectTo: string },
  ): PromiseLike<{ data: { user: { id: string } | null }; error: { message?: string; code?: string; status?: number } | null }>
  getUserById(
    id: string,
  ): PromiseLike<{ data: { user: { email_confirmed_at?: string | null; last_sign_in_at?: string | null } | null }; error: { message?: string } | null }>
  deleteUser(id: string): PromiseLike<{ error: { message?: string } | null }>
}

export interface InviteDeps {
  allowedOrigins: string[]
  /** used when the browser sends no (or a foreign) Origin */
  defaultSiteUrl: string
  /** client that carries the CALLER's JWT: RLS / auth.uid() apply */
  userClient: (authorizationHeader: string) => RpcClient
  /** service-role client (never exposed to callers) */
  adminRpc: RpcClient
  adminAuth: AdminAuth
}

export type InviteRequest =
  | { action: 'invite'; email: string; first_name: string; last_name: string; role_id: string; branch_id: string | null; job_title: string | null }
  | { action: 'resend'; user_id: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function validateRequest(body: unknown): { ok: true; value: InviteRequest } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'Request body must be a JSON object.' }
  const b = body as Record<string, unknown>
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim() : '').slice(0, max + 1)

  if (b.action === 'resend') {
    if (typeof b.user_id !== 'string' || !UUID.test(b.user_id)) return { ok: false, error: 'user_id must be a valid id.' }
    return { ok: true, value: { action: 'resend', user_id: b.user_id } }
  }
  if (b.action !== 'invite') return { ok: false, error: 'Unknown action.' }

  const email = str(b.email, 254).toLowerCase()
  if (!email || email.length > 254 || !EMAIL.test(email)) return { ok: false, error: 'Enter a valid email address.' }
  const first = str(b.first_name, 100)
  const last = str(b.last_name, 100)
  if (!first || first.length > 100) return { ok: false, error: 'First name is required (max 100 characters).' }
  if (!last || last.length > 100) return { ok: false, error: 'Last name is required (max 100 characters).' }
  if (typeof b.role_id !== 'string' || !UUID.test(b.role_id)) return { ok: false, error: 'Choose a role.' }
  let branch: string | null = null
  if (b.branch_id !== undefined && b.branch_id !== null && b.branch_id !== '') {
    if (typeof b.branch_id !== 'string' || !UUID.test(b.branch_id)) return { ok: false, error: 'Choose a valid branch.' }
    branch = b.branch_id
  }
  const job = str(b.job_title, 100)
  if (job.length > 100) return { ok: false, error: 'Job title is too long (max 100 characters).' }

  return { ok: true, value: { action: 'invite', email, first_name: first, last_name: last, role_id: b.role_id, branch_id: branch, job_title: job || null } }
}

function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
  if (origin && allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin
  return h
}

const json = (status: number, body: unknown, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } })

/** Maps a database error from the permission pre-check to an HTTP answer. */
function fromDbError(e: { code?: string; message?: string }): { status: number; message: string } {
  switch (e.code) {
    case '42501': return { status: 403, message: e.message || 'You do not have permission to do that.' }
    case 'P0002': return { status: 404, message: e.message || 'Not found.' }
    case '23505': return { status: 409, message: 'That person already exists in the system.' }
    case '23503':
    case '23514': return { status: 400, message: e.message || 'Some values are not valid.' }
    // 28000 / PGRST30x: PostgREST rejected the caller's JWT (missing, expired, or not signed by this project)
    case '28000':
    case 'PGRST301':
    case 'PGRST302':
    case 'PGRST303': return { status: 401, message: 'Please sign in again.' }
    default: return { status: 500, message: 'Something went wrong. Please try again.' }
  }
}

export async function handleInvite(req: Request, deps: InviteDeps): Promise<Response> {
  const origin = req.headers.get('Origin')
  const cors = corsHeaders(origin, deps.allowedOrigins)

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' }, cors)

  const authorization = req.headers.get('Authorization') ?? ''
  if (!/^Bearer\s+\S+$/i.test(authorization)) return json(401, { error: 'Sign in required.' }, cors)

  let body: unknown
  try { body = await req.json() } catch { return json(400, { error: 'Request body must be valid JSON.' }, cors) }
  const parsed = validateRequest(body)
  if (!parsed.ok) return json(400, { error: parsed.error }, cors)
  const request = parsed.value

  const siteUrl = origin && deps.allowedOrigins.includes(origin) ? origin : deps.defaultSiteUrl
  const redirectTo = `${siteUrl.replace(/\/+$/, '')}/accept-invite`
  const user = deps.userClient(authorization)

  // ---- resend a pending invitation ---------------------------------------------------------------
  if (request.action === 'resend') {
    const prep = await user.rpc('prepare_resend', { p_user_id: request.user_id })
    if (prep.error) { const m = fromDbError(prep.error); return json(m.status, { error: m.message }, cors) }
    const info = prep.data as { email: string }

    const existing = await deps.adminAuth.getUserById(request.user_id)
    if (existing.error || !existing.data.user) return json(404, { error: 'User not found.' }, cors)
    if (existing.data.user.email_confirmed_at || existing.data.user.last_sign_in_at) {
      return json(409, { error: 'This person has already accepted their invitation.' }, cors)
    }
    const sent = await deps.adminAuth.inviteUserByEmail(info.email, { redirectTo })
    if (sent.error) return json(502, { error: 'The invitation e-mail could not be sent. Please try again later.' }, cors)
    return json(200, { ok: true }, cors)
  }

  // ---- new invitation ------------------------------------------------------------------------------
  const prep = await user.rpc('prepare_invitation', { p_role_id: request.role_id, p_branch_id: request.branch_id })
  if (prep.error) { const m = fromDbError(prep.error); return json(m.status, { error: m.message }, cors) }
  const ctx = prep.data as { actor_id: string; organization_id: string }

  const invited = await deps.adminAuth.inviteUserByEmail(request.email, { redirectTo })
  if (invited.error || !invited.data.user) {
    const msg = invited.error?.message ?? ''
    if (invited.error?.code === 'email_exists' || /already (been )?registered|already exists/i.test(msg)) {
      return json(409, { error: 'Someone with that email address already has an account.' }, cors)
    }
    return json(502, { error: 'The invitation e-mail could not be sent. Please try again later.' }, cors)
  }
  const newUserId = invited.data.user.id

  const done = await deps.adminRpc.rpc('complete_invitation', {
    p_actor_id: ctx.actor_id,
    p_user_id: newUserId,
    p_organization_id: ctx.organization_id,
    p_first_name: request.first_name,
    p_last_name: request.last_name,
    p_role_id: request.role_id,
    p_branch_id: request.branch_id,
    p_job_title: request.job_title,
  })
  if (done.error) {
    // do not leave a half-created account behind
    await deps.adminAuth.deleteUser(newUserId)
    const m = fromDbError(done.error)
    return json(m.status, { error: m.message }, cors)
  }
  return json(200, { ok: true, user_id: newUserId }, cors)
}

// ---- Deno entry point (skipped when imported by tests) ---------------------------------------------------
const denoGlobal = (globalThis as { Deno?: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Response | Promise<Response>): void } }).Deno

if (denoGlobal) {
  const supabaseUrl = denoGlobal.env.get('SUPABASE_URL') ?? ''
  const anonKey = denoGlobal.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceKey = denoGlobal.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const siteUrl = denoGlobal.env.get('SITE_URL') ?? 'https://m-wholesale.vercel.app'
  const extraOrigins = (denoGlobal.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const allowedOrigins = [...new Set([siteUrl.replace(/\/+$/, ''), 'http://127.0.0.1:5273', 'http://localhost:5273', ...extraOrigins])]

  // Literal specifier so Deno's bundler packages the dependency. It is only executed inside Deno
  // (`denoGlobal` is undefined under vitest), and @vite-ignore stops Vite trying to resolve the `npm:` scheme.
  // (@ts-ignore rather than @ts-expect-error: Deno resolves the module, so an "unused directive" error would fire there)
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - the `npm:` scheme only exists in Deno; plain tsc cannot resolve it
  const { createClient } = (await import(/* @vite-ignore */ 'npm:@supabase/supabase-js@2')) as {
    createClient: (url: string, key: string, opts?: Record<string, unknown>) => {
      rpc: RpcClient['rpc']
      auth: { admin: AdminAuth }
    }
  }
  const noSession = { auth: { persistSession: false, autoRefreshToken: false } }
  const admin = createClient(supabaseUrl, serviceKey, noSession)

  denoGlobal.serve((req) =>
    handleInvite(req, {
      allowedOrigins,
      defaultSiteUrl: siteUrl,
      userClient: (authorization) =>
        createClient(supabaseUrl, anonKey, { ...noSession, global: { headers: { Authorization: authorization } } }),
      adminRpc: admin,
      adminAuth: admin.auth.admin,
    }))
}
