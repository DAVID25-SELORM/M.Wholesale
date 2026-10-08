// One error vocabulary for the whole UI. Services convert whatever Supabase throws into
// an AppError with a stable `kind` and a message that is safe to show to users.

export type AppErrorKind =
  | 'permission' | 'duplicate' | 'reference' | 'validation' | 'not_found'
  | 'auth' | 'network' | 'unknown'

export class AppError extends Error {
  readonly kind: AppErrorKind
  readonly code: string | undefined
  readonly details: string | undefined

  constructor(kind: AppErrorKind, message: string, opts: { code?: string; details?: string; cause?: unknown } = {}) {
    super(message, { cause: opts.cause })
    this.name = 'AppError'
    this.kind = kind
    this.code = opts.code
    this.details = opts.details
  }
}

interface PgLikeError {
  code?: string
  message?: string
  details?: string | null
  hint?: string | null
  status?: number
}

/** Pulls the user-facing sentence out of our own RAISE EXCEPTION messages. */
function dbMessage(e: PgLikeError, fallback: string): string {
  const m = e.message ?? ''
  // Constraint / trigger messages we wrote ourselves are English sentences without SQL jargon.
  return m && !/violates|constraint|relation|column|"public\./i.test(m) ? m : fallback
}

export function toAppError(err: unknown, fallback = 'Something went wrong. Please try again.'): AppError {
  if (err instanceof AppError) return err
  const e = (err ?? {}) as PgLikeError
  const code = e.code
  const opts = { code, details: e.details ?? undefined, cause: err }

  if (e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(e.message ?? '')) {
    return new AppError('network', 'Cannot reach the server. Check your connection and try again.', opts)
  }
  switch (code) {
    case '23505':
      return new AppError('duplicate', 'That code or value is already in use. Choose a different one.', opts)
    case '23503':
      return new AppError('reference', 'This change refers to a record that does not exist or is not allowed.', opts)
    case '23514':
      return new AppError('validation', dbMessage(e, 'Some values are not valid. Please review the form.'), opts)
    case '22023':
    case '22P02':
      return new AppError('validation', 'Some values are not valid. Please review the form.', opts)
    case '42501':
      return new AppError('permission', dbMessage(e, 'You do not have permission to do that.'), opts)
    case 'P0002':
    case 'PGRST116':
      return new AppError('not_found', dbMessage(e, 'The record could not be found.'), opts)
    case '28000':
    case 'PGRST301':
    case 'PGRST303':
      return new AppError('auth', 'Your session has expired. Please sign in again.', opts)
    default:
      return new AppError('unknown', dbMessage(e, fallback), opts)
  }
}

/** Developer diagnostics: never log secrets, tokens or request bodies. */
export function logError(context: string, err: unknown): void {
  const e = err as PgLikeError
  console.error(`[${context}]`, { code: e?.code, message: e?.message, details: e?.details, hint: e?.hint })
}
