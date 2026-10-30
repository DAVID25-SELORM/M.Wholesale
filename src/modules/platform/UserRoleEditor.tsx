import {useState} from 'react'
import {useQuery,useQueryClient} from '@tanstack/react-query'
import {Button,Field,Input,InlineError,Modal} from '@/components/ui'
import {supabase} from '@/lib/supabase'
import {unwrap} from '@/services/common'
import {textValue,type RecordData} from './api'
export function UserRoleEditor({user,onClose}:{user:string;onClose:()=>void}){
 const [role,setRole]=useState('');const [branch,setBranch]=useState('');const [reason,setReason]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false)
 const qc=useQueryClient()
 const q=useQuery({queryKey:['platform','user-roles',user],queryFn:async()=>unwrap(await supabase.rpc('platform_user_roles',{p_user:user}),'platform.roles') as {roles:RecordData[];branches:RecordData[];assigned:RecordData[]}})
 async function save(grant:boolean,roleId=role,branchId=branch){
  if(busy)return;setBusy(true);setError('')
  try{unwrap(await supabase.rpc('platform_change_user_role',{p_user:user,p_role:roleId,p_branch:branchId||null,p_grant:grant,p_reason:reason}),'platform.roles.change');await qc.invalidateQueries({queryKey:['platform']});setRole('');setReason('')}
  catch(e){setError(e instanceof Error?e.message:'Role change failed')}finally{setBusy(false)}
 }
 return <Modal open title="User roles and branch scope" onClose={()=>{if(!busy)onClose()}}><div className="space-y-4"><InlineError message={error||(q.isError?q.error.message:null)}/>{q.isPending&&<p>Loading roles…</p>}
 <Field label="Reason for change"><Input minLength={3} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></Field>
 {q.data?.assigned.map(a=><div key={textValue(a.id)} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2"><span>{textValue(a.name)} — {textValue(a.branch)||'All branches'}</span>{!['OWNER','SUPER_ADMIN'].includes(textValue(a.code))&&<Button variant="secondary" disabled={busy||reason.trim().length<3} onClick={()=>{if(window.confirm('Revoke this role?'))void save(false,textValue(a.role_id),textValue(a.branch_id))}}>Revoke</Button>}</div>)}
 <Field label="Role"><select className="w-full rounded border p-2" value={role} onChange={e=>setRole(e.target.value)}><option value="">Select role</option>{q.data?.roles.map(r=><option key={textValue(r.id)} value={textValue(r.id)}>{textValue(r.name)}</option>)}</select></Field>
 <Field label="Branch scope"><select className="w-full rounded border p-2" value={branch} onChange={e=>setBranch(e.target.value)}><option value="">All branches</option>{q.data?.branches.map(b=><option key={textValue(b.id)} value={textValue(b.id)}>{textValue(b.name)}</option>)}</select></Field>
 <Button disabled={busy||!role||reason.trim().length<3} onClick={()=>void save(true)}>Grant role</Button></div></Modal>
}
