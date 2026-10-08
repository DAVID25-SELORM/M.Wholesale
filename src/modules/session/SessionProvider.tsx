import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { logError, toAppError } from '@/lib/errors'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/modules/auth/AuthProvider'
import type { SessionBranch, SessionContext } from '@/types/domain'
import { createAbility, type Ability } from './ability'

export const ALL_BRANCHES = 'ALL' as const
export type BranchSelection = string | typeof ALL_BRANCHES

interface SessionApi {
  context: SessionContext
  ability: Ability
  branches: SessionBranch[]
  /** 'ALL' only when the user holds organization-wide access; otherwise always a concrete accessible branch id */
  selectedBranch: BranchSelection
  selectedBranchRecord: SessionBranch | null
  selectBranch: (id: BranchSelection) => void
  refresh: () => Promise<void>
}

const SessionContextReact = createContext<SessionApi | null>(null)
const STORAGE_KEY = 'wps.selectedBranch'
export const SESSION_QUERY_KEY = ['session-context'] as const

/** Fetches who the signed-in user is, ONCE, via a single RPC (no per-component permission fetching). */
export function useSessionContextQuery() {
  const { auth } = useAuth()
  const userId = auth.status === 'signedIn' ? auth.session.user.id : null
  return useQuery({
    queryKey: [...SESSION_QUERY_KEY, userId],
    enabled: userId !== null,
    staleTime: 60_000,
    queryFn: async (): Promise<SessionContext> => {
      const { data, error } = await supabase.rpc('get_session_context')
      if (error) { logError('get_session_context', error); throw toAppError(error) }
      return data as unknown as SessionContext
    },
  })
}

function readStoredBranch(): string | null {
  try { return localStorage.getItem(STORAGE_KEY) } catch { return null }
}

export function SessionProvider({ context, children }: { context: SessionContext; children: ReactNode }) {
  const queryClient = useQueryClient()
  const ability = useMemo(() => createAbility(context), [context])
  const branches = useMemo(() => context.branches ?? [], [context.branches])
  // The user's raw preference (UI only - localStorage is never an authorization source).
  const [preference, setPreference] = useState<string | null>(readStoredBranch)

  // The effective selection is DERIVED: a preference is honoured only if the server-provided
  // branch list (or organization-wide access) allows it, so a revoked branch silently falls back.
  const selectedBranch = useMemo<BranchSelection>(() => {
    if (preference === ALL_BRANCHES && ability.hasOrgWideAccess) return ALL_BRANCHES
    if (preference && branches.some((b) => b.id === preference)) return preference
    const fallback = context.profile?.default_branch_id
    if (fallback && branches.some((b) => b.id === fallback)) return fallback
    if (ability.hasOrgWideAccess) return ALL_BRANCHES
    return branches[0]?.id ?? ALL_BRANCHES
  }, [preference, ability.hasOrgWideAccess, branches, context.profile?.default_branch_id])

  const selectBranch = useCallback((id: BranchSelection) => {
    setPreference(id)
    try { localStorage.setItem(STORAGE_KEY, id) } catch { /* storage unavailable */ }
  }, [])

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
  }, [queryClient])

  const selectedBranchRecord = selectedBranch === ALL_BRANCHES ? null : (branches.find((b) => b.id === selectedBranch) ?? null)

  const value = useMemo<SessionApi>(
    () => ({ context, ability, branches, selectedBranch, selectedBranchRecord, selectBranch, refresh }),
    [context, ability, branches, selectedBranch, selectedBranchRecord, selectBranch, refresh],
  )
  return <SessionContextReact.Provider value={value}>{children}</SessionContextReact.Provider>
}

export function useSession(): SessionApi {
  const ctx = useContext(SessionContextReact)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}
