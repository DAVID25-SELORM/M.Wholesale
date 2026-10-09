import { createClient } from '@supabase/supabase-js'
import { env } from './env'
import type { Database } from '@/types/database'

// Browser client: anon/publishable key only. The signed-in user's JWT is attached to
// every request, and Postgres RLS decides what that user may read or write.
export const supabase = createClient<Database>(
  env.supabaseUrl || 'http://localhost:0',
  env.supabaseAnonKey || 'missing-anon-key',
  {
    // detectSessionInUrl: invitation and password-reset e-mails return the user here with a one-time
    // token in the URL; supabase-js exchanges it for a session and removes it from the address bar.
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  },
)
