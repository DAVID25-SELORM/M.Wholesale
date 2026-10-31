import { useState } from 'react'
import { Button, Tabs } from '@/components/ui'
import { textValue, type RecordData } from './api'
import { OwnershipTransfer } from './OwnershipTransfer'
import { OrganizationActivity } from './OrganizationActivity'

const tabs = [
  { id: 'profile', label: 'Profile' }, { id: 'users', label: 'Users' },
  { id: 'branches', label: 'Branches' }, { id: 'warehouses', label: 'Warehouses' },
  { id: 'subscription', label: 'Subscription' }, { id: 'usage', label: 'Usage' },
  { id: 'ownership', label: 'Ownership' },
  { id: 'activity', label: 'Activity' },
]

export function OrganizationDetail({ data, onEdit }: { data: RecordData; onEdit: (profile: RecordData) => void }) {
  const [tab, setTab] = useState('profile')
  const profile = data.profile as RecordData | null
  if (!profile) return <p>Organization not found.</p>
  const records = (key: string) => (data[key] ?? []) as RecordData[]
  return <section className="min-w-0 space-y-5 rounded-xl border bg-white p-4 sm:p-6">
    <h2 className="break-words text-lg font-semibold">{textValue(profile.name)}</h2>
    <Tabs items={tabs} value={tab} onChange={setTab} label="Organization details" />
    <div role="tabpanel" aria-label={tabs.find(item => item.id === tab)?.label}>
      {tab === 'activity' && <OrganizationActivity key={textValue(profile.id)} organization={textValue(profile.id)} />}
      {tab === 'ownership' && <OwnershipTransfer organization={textValue(profile.id)} />}
      {tab === 'profile' && <><Properties data={profile} /><Button onClick={() => onEdit(profile)}>Edit profile</Button></>}
      {['users', 'branches', 'warehouses'].includes(tab) && <div className="space-y-3">
        {records(tab).length === 0 && <p className="text-sm text-slate-500">No {tab} recorded.</p>}
        {records(tab).map(row => <article key={textValue(row.id)} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
          <div className="min-w-0"><h3 className="break-words font-medium">{textValue(row.name)}</h3>{row.email && <p className="break-all text-sm text-slate-500">{textValue(row.email)}</p>}</div>
          <span className="text-sm">{row.active ? 'Active' : 'Inactive'}</span>
        </article>)}
      </div>}
      {tab === 'subscription' && (data.subscription ? <Properties data={data.subscription as RecordData} /> : <p>No subscription assigned.</p>)}
      {tab === 'usage' && <div className="grid gap-4 sm:grid-cols-3">{['users', 'branches', 'warehouses'].map(key => <div key={key} className="rounded-lg border p-4"><h3 className="capitalize">Active {key}</h3><p className="mt-2 text-3xl font-semibold">{records(key).filter(row => row.active === true).length}</p><p className="mt-1 text-sm text-slate-500">{records(key).length} total</p></div>)}</div>}
    </div>
  </section>
}

function Properties({ data }: { data: RecordData }) {
  return <dl className="mb-5 grid gap-4 sm:grid-cols-2">{Object.entries(data).map(([key, value]) => <div key={key} className="min-w-0"><dt className="text-xs capitalize text-slate-500">{key.replaceAll('_', ' ')}</dt><dd className="break-words text-sm">{textValue(value) || '—'}</dd></div>)}</dl>
}
