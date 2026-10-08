import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useMemo, type ReactNode } from 'react'
import { RouterProvider } from 'react-router-dom'
import { ToastProvider } from '@/components/ui'
import { AuthProvider } from '@/modules/auth/AuthProvider'
import { createRouter } from './router'

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) => {
          // do not hammer the server for authorization / validation failures
          const kind = (error as { kind?: string } | null)?.kind
          return count < 2 && kind !== 'permission' && kind !== 'auth' && kind !== 'validation'
        },
        refetchOnWindowFocus: false,
        staleTime: 15_000,
      },
    },
  })
}

export function Providers({ children, client }: { children: ReactNode; client?: QueryClient }) {
  const qc = useMemo(() => client ?? makeQueryClient(), [client])
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider>{children}</AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  )
}

export function App() {
  const router = useMemo(() => createRouter(), [])
  return (
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  )
}
