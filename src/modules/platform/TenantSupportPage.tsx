import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Field, Input, Textarea, InlineError, PageHeader } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import { textValue, type RecordData } from './api'

export function TenantSupportPage() {
 const [selected, setSelected] = useState<string>()
 const [page, setPage] = useState(0)
 const [request, setRequest] = useState<string>(() => crypto.randomUUID())
 const [subject,setSubject] = useState(''); const [body,setBody] = useState(''); const [reply,setReply] = useState('')
 const [busy,setBusy] = useState(false); const [error,setError] = useState('')
 const qc = useQueryClient()
 function selectTicket(id?:string) {
  if(busy) return
  if(reply && !window.confirm('Discard your unsent reply?')) return
  setReply('');setError('');setSelected(id)
 }
 const query = useQuery({queryKey:['tenant-support',selected,page],queryFn:async () => unwrap(await supabase.rpc('tenant_support_read',{p_id:selected,p_page:page}),'support.read') as {rows?:RecordData[];total?:number;ticket?:RecordData;replies?:RecordData[]}})
 async function act(action:string) {
  if (busy) return
  setBusy(true);setError('')
  try {
   const id=unwrap(await supabase.rpc('tenant_support_write',{p_action:action,p_id:action==='CREATE'?request:selected!,p_subject:subject,p_body:action==='CREATE'?body:reply}),'support.write')
   if(action==='CREATE'){setSubject('');setBody('');setRequest(crypto.randomUUID());setSelected(id)}
   setReply('');await qc.invalidateQueries({queryKey:['tenant-support']})
  } catch(e){setError(e instanceof Error?e.message:'Unable to save ticket')}finally{setBusy(false)}
 }
 return <div className="space-y-5"><PageHeader title="Support" description="Contact platform support. Do not include passwords, API keys or patient information." />
 <InlineError message={error || (query.isError?query.error.message:null)} />
 <div className="flex gap-3"><Button variant="secondary" onClick={()=>void query.refetch()} disabled={query.isFetching}>Refresh</Button>{selected&&<Button variant="secondary" onClick={()=>selectTicket(undefined)}>Back to tickets</Button>}</div>
 {query.isPending&&<p>Loading support…</p>}
 {!selected&&<><form className="space-y-3 rounded-lg border bg-white p-4" onSubmit={e=>{e.preventDefault();void act('CREATE')}}><h2 className="font-semibold">Open a ticket</h2><Field label="Subject"><Input required minLength={3} maxLength={200} value={subject} onChange={e=>setSubject(e.target.value)} /></Field><Field label="Describe the issue"><Textarea required minLength={3} maxLength={4000} value={body} onChange={e=>setBody(e.target.value)} /></Field><Button type="submit" disabled={busy}>Submit ticket</Button></form>
 {query.data?.rows?.map(t=><article key={textValue(t.id)} className="rounded-lg border bg-white p-4"><h2 className="font-semibold">{textValue(t.subject)}</h2><p className="my-2 text-sm">{textValue(t.status)} · {textValue(t.updated_at)}</p><Button variant="secondary" onClick={()=>selectTicket(textValue(t.id))}>Open conversation</Button></article>)}
 {!query.isPending&&!query.data?.rows?.length&&<p>No tickets yet.</p>}<div className="flex items-center gap-3"><Button disabled={!page} onClick={()=>setPage(page-1)}>Previous</Button><span>Page {page+1}</span><Button disabled={(page+1)*25>=(query.data?.total??0)} onClick={()=>setPage(page+1)}>Next</Button></div></>}
 {selected&&query.data?.ticket&&<section className="space-y-4 rounded-lg border bg-white p-4"><h2 className="font-semibold">{textValue(query.data.ticket.subject)}</h2><p className="whitespace-pre-wrap break-words">{textValue(query.data.ticket.body)}</p><p>{textValue(query.data.ticket.status)}</p><Button variant="secondary" disabled={busy} onClick={()=>{const action=query.data?.ticket?.status==='CLOSED'?'REOPEN':'CLOSE';if(window.confirm(`${action==='CLOSE'?'Close':'Reopen'} this ticket?`))void act(action)}}>{query.data.ticket.status==='CLOSED'?'Reopen ticket':'Close ticket'}</Button>
 {query.data.replies?.map(r=><article key={textValue(r.id)} className="border-t pt-3"><p className="text-xs text-slate-500">{textValue(r.author)} · {textValue(r.created_at)}</p><p className="whitespace-pre-wrap break-words">{textValue(r.body)}</p></article>)}
 {query.data.ticket.status!=='CLOSED'&&<form className="space-y-3" onSubmit={e=>{e.preventDefault();void act('REPLY')}}><Field label="Reply"><Textarea required maxLength={4000} value={reply} onChange={e=>setReply(e.target.value)} /></Field><Button type="submit" disabled={busy}>Send reply</Button></form>}</section>}
 </div>
}
