import { useQuery } from '@tanstack/react-query'
import { InlineError } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import type { RecordData } from './api'

export function RenewalScheduler() {
  const query = useQuery({ queryKey: ['platform', 'renewal-scheduler'], queryFn: async () => unwrap(await supabase.rpc('platform_renewal_scheduler'), 'platform.renewal.scheduler') as RecordData })
  return <section className="rounded-lg border bg-white p-4 text-sm" aria-label="Automatic renewal scheduler">
    <InlineError message={query.isError ? query.error.message : null} />
    {query.isPending && <p role="status">Checking renewal scheduler…</p>}
    {query.data && <><p>{query.data.scheduled ? 'Daily automatic renewal is scheduled.' : 'Automatic renewal scheduler is not installed. Enabled subscriptions will not renew automatically until scheduling is configured.'}</p><p className="mt-2">{String(query.data.enabled_subscriptions)} enabled subscriptions · {String(query.data.failed_subscriptions)} needing review</p><p className="mt-2 text-slate-500">Renewal creates an unpaid invoice at the agreed price. No payment is collected.</p></>}
  </section>
}
