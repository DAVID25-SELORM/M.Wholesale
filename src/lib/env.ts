// Only PUBLIC values are read here (project URL + anon/publishable key). Authorization
// never depends on anything in the browser: the database enforces it via RLS.

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const env = {
  supabaseUrl: url ?? '',
  supabaseAnonKey: anonKey ?? '',
}

/** Human readable description of what is misconfigured, or null when all is well. */
export const envProblem: string | null =
  !url || !anonKey
    ? 'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill them in.'
    : null
