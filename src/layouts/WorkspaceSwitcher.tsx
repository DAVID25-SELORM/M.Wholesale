import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useSession } from '@/modules/session/SessionProvider'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'

export function WorkspaceSwitcher({ platform = false }: { platform?: boolean }) {
  const { context } = useSession()
  const navigate = useNavigate()
  const access = useQuery({ queryKey: ['platform-access', context.user_id], queryFn: async () => unwrap(await supabase.rpc('platform_operator_access'), 'platform.access') })
  if (!platform && !access.data) return null
  return <label className="flex min-w-0 flex-col gap-1 text-xs text-slate-600">
    <span>Workspace</span>
    <select aria-label="Switch workspace" className="h-9 max-w-[16rem] rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-800" value={platform ? 'platform' : 'organization'} onChange={e => navigate(e.target.value === 'platform' ? '/platform/tenants' : '/')}>
      <option value="organization">{context.organization?.name ?? 'Organization'} — ERP</option>
      {access.data && <option value="platform">Platform Administration</option>}
    </select>
  </label>
}
