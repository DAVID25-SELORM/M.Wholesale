import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { useRouteError } from 'react-router-dom'
import { reportClientError, type ErrorSource } from '@/lib/errorReport'

// A screen that crashes must not leave a white page. These show a calm message, offer a reload, and report the fault to the error log.
// They use plain markup only (no providers, no router context beyond useRouteError) so they still work when everything else is broken.

function Fallback({ onReload }: { onReload: () => void }) {
  return (
    <div role="alert" className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-600">
          This screen hit a problem and stopped. Nothing you had already saved is lost, and the problem has been reported. Reload to carry on; if it keeps happening, tell your administrator what you were doing.
        </p>
        <div className="mt-4 flex justify-center gap-3">
          <button type="button" onClick={onReload} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Reload</button>
          <a href="/" className="rounded-md px-4 py-2 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">Go to the dashboard</a>
        </div>
      </div>
    </div>
  )
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    reportClientError('render' satisfies ErrorSource, error)
  }

  render() {
    return this.state.failed ? <Fallback onReload={() => window.location.reload()} /> : this.props.children
  }
}

/** react-router's errorElement: replaces the library's raw developer error page. */
export function RouteError() {
  const error = useRouteError()
  useEffect(() => { reportClientError('route', error) }, [error])
  return <Fallback onReload={() => window.location.reload()} />
}
