import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {expect,it,vi} from 'vitest'
const mocks=vi.hoisted(()=>({rpc:vi.fn()}))
vi.mock('@/lib/supabase',()=>({supabase:{rpc:mocks.rpc}}))
import {TenantSupportPage} from '@/modules/platform/TenantSupportPage'
it('retains ticket reference on failure and submits without a browser tenant ID',async()=>{
 let calls=0
 mocks.rpc.mockImplementation(async(fn:string,args:Record<string,unknown>)=>{
  if(fn==='tenant_support_read')return {data:args.p_id?{ticket:{id:args.p_id,subject:'Test ticket',body:'Details',status:'OPEN'},replies:[]}:{rows:[],total:0},error:null}
  calls++
  return calls===1?{data:null,error:new Error('Temporary failure')}:{data:args.p_id,error:null}
 })
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><TenantSupportPage/></QueryClientProvider>)
 fireEvent.change(screen.getByLabelText('Subject'),{target:{value:'Test ticket'}})
 fireEvent.change(screen.getByLabelText('Describe the issue'),{target:{value:'Please investigate'}})
 fireEvent.click(screen.getByRole('button',{name:'Submit ticket'}))
 await waitFor(()=>expect(screen.getByRole('button',{name:'Submit ticket'})).toBeEnabled())
 await waitFor(()=>expect(calls).toBe(1))
 fireEvent.click(screen.getByRole('button',{name:'Submit ticket'}))
 await waitFor(()=>expect(screen.getByRole('button',{name:'Send reply'})).toBeInTheDocument())
 const writes=mocks.rpc.mock.calls.filter(c=>c[0]==='tenant_support_write')
 expect(writes[0]![1].p_id).toBe(writes[1]![1].p_id)
 expect(writes[0]![1]).not.toHaveProperty('organization_id')
})
