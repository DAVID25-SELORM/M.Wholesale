import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { ErrorState, LoadingState } from '@/components/ui'
import { envProblem } from '@/lib/env'
import { SessionProvider, useSessionContextQuery } from '@/modules/session/SessionProvider'
import { useSession } from '@/modules/session/SessionProvider'
import { useAuth } from './AuthProvider'

/**
 * Gate for everything behind login:
 *   signed out            -> /login
 *   no profile / inactive -> dedicated explanation pages
 *   ok                    -> app (with the server-provided session context)
 * Route guards are UX. The database independently refuses every unauthorized read/write.
 */
export function RequireAuth() {
  const { auth } = useAuth()
  const location = useLocation()
  const query = useSessionContextQuery()

  if (envProblem) return <ErrorState title="Application is not configured" message={envProblem} />
  if (auth.status === 'loading') return <LoadingState label="Checking your session…" className="min-h-screen" />
  if (auth.status === 'signedOut') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />

  if (query.isPending) return <LoadingState label="Loading your workspace…" className="min-h-screen" />
  if (query.isError || !query.data) {
    return (
      <div className="min-h-screen">
        <ErrorState
          title="Could not load your workspace"
          message={query.error instanceof Error ? query.error.message : undefined}
          onRetry={() => void query.refetch()}
        />
      </div>
    )
  }

  const ctx = query.data
  if (ctx.status === 'inactive_user' || ctx.status === 'inactive_organization') {
    return <Navigate to="/access-disabled" replace state={{ reason: ctx.status }} />
  }
  if (ctx.status === 'no_profile') return <Navigate to="/no-access" replace />

  return (
    <SessionProvider context={ctx}>
      <Outlet />
    </SessionProvider>
  )
}

/** Renders children only when the user holds at least one of the permissions in some scope. */
export function RequirePermission({ anyOf }: { anyOf: readonly string[] }) {
  const { ability } = useSession()
  if (!ability.canAnyOf(anyOf)) return <Navigate to="/unauthorized" replace />
  return <Outlet />
}
