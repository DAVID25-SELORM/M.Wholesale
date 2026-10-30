import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, InlineError, PageHeader } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import { textValue, type RecordData } from './api'

export function TenantAnnouncementsPage() {
 const [page,setPage]=useState(0);const [busy,setBusy]=useState<string|null>(null);const [error,setError]=useState('')
 const qc=useQueryClient()
 const query=useQuery({queryKey:['tenant-announcements',page],queryFn:async()=>unwrap(await supabase.rpc('tenant_announcements',{p_page:page}),'announcements.read') as {rows:RecordData[];total:number}})
 return <div className="space-y-4"><PageHeader title="Announcements" description="Published updates from platform administration." />
 <InlineError message={error||(query.isError?query.error.message:null)} /><Button variant="secondary" disabled={query.isFetching} onClick={()=>void query.refetch()}>Refresh</Button>
 {query.isPending&&<p>Loading announcements…</p>}{query.data?.rows.map(a=><article key={textValue(a.id)} className="space-y-3 rounded-lg border bg-white p-5"><h2 className="font-semibold">{textValue(a.title)}</h2><p className="whitespace-pre-wrap break-words">{textValue(a.body)}</p><p className="text-xs text-slate-500">Published {textValue(a.published_at)} · Expires {textValue(a.expires_at)}</p>{a.is_read?<span className="text-sm text-emerald-700">Read</span>:<Button disabled={busy!==null} onClick={async()=>{setBusy(textValue(a.id));setError('');try{unwrap(await supabase.rpc('tenant_read_announcement',{p_id:textValue(a.id)}),'announcements.markRead');await qc.invalidateQueries({queryKey:['tenant-announcements']})}catch(e){setError(e instanceof Error?e.message:'Unable to mark read')}finally{setBusy(null)}}}>Mark as read</Button>}</article>)}
 {query.data?.total===0&&<p>No current announcements.</p>}<div className="flex items-center gap-3"><Button disabled={!page} onClick={()=>setPage(page-1)}>Previous</Button><span>Page {page+1}</span><Button disabled={(page+1)*25>=(query.data?.total??0)} onClick={()=>setPage(page+1)}>Next</Button></div></div>
}
