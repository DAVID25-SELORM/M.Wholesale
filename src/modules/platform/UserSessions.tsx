import { useQuery } from '@tanstack/react-query'
import { InlineError, Modal } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import { textValue, type RecordData } from './api'

export function UserSessions({ user, onClose }: { user: string; onClose: () => void }) {
  const query = useQuery({ queryKey: ['platform', 'user-sessions', user], queryFn: async () => unwrap(await supabase.rpc('platform_user_sessions', { p_user: user }), 'platform.user.sessions') as RecordData })
  return <Modal open title="Sessions and authentication history" onClose={onClose}>
    <InlineError message={query.isError ? query.error.message : null} />
    {query.isPending && <p role="status">Loading sessions…</p>}
    {query.data && <div className="space-y-4">
      <p className="text-sm">Up to 100 most recent records in each section. Authentication history reflects events retained by the authentication service.</p>
      <h3 className="font-semibold">Sessions</h3>
      {!query.data.sessions_available && <p>Session records are unavailable.</p>}
      {(query.data.sessions as RecordData[]).map(row => <div key={textValue(row.id)} className="rounded border p-3 text-sm"><p>{textValue(row.created_at)}</p><p>{row.revoked ? 'ERP access revoked' : 'Not revoked by ERP'}</p></div>)}
      {query.data.sessions_available && !(query.data.sessions as RecordData[]).length && <p>No sessions recorded.</p>}
      <h3 className="font-semibold">Authentication events</h3>
      {!query.data.history_available && <p>Authentication history is unavailable.</p>}
      {(query.data.events as RecordData[]).map(row => <div key={textValue(row.id)} className="rounded border p-3 text-sm"><p>{textValue(row.action)}</p><p>{textValue(row.created_at)}</p></div>)}
      {query.data.history_available && !(query.data.events as RecordData[]).length && <p>No retained authentication events.</p>}
    </div>}
  </Modal>
}
