import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Button, Input, Select } from '@/components/ui'
import { useDebouncedValue } from '@/lib/utils'
import { getIdentity, searchIdentityOptions } from '@/services/catalog'
import { IdentityForm } from './IdentityForm'

const label = (i: { generic_name: string; strength_text: string; dosage_form: { name: string } | null }) =>
  `${i.generic_name} — ${i.strength_text}${i.dosage_form ? ` (${i.dosage_form.name})` : ''}`

/** Search-as-you-type selector for canonical identities, with "create new" for the case it does not exist yet. */
export function IdentityPicker({ id, value, onChange, canCreate, invalid }: {
  id?: string | undefined; value: string; onChange: (identityId: string) => void; canCreate: boolean; invalid?: boolean | undefined
}) {
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const debounced = useDebouncedValue(search, 250)
  const options = useQuery({ queryKey: ['identities', 'options', debounced], queryFn: () => searchIdentityOptions(debounced), staleTime: 30_000 })
  // the currently selected identity must stay selectable even if it is not in the filtered list
  const selected = useQuery({ queryKey: ['identities', 'one', value], queryFn: () => getIdentity(value), enabled: Boolean(value), staleTime: 60_000 })
  const list = options.data ?? []
  const merged = selected.data && !list.some((i) => i.id === selected.data!.id) ? [selected.data, ...list] : list

  return (
    <div className="space-y-2">
      <Input aria-label="Search identities" placeholder="Search generic name or strength…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="flex gap-2">
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined}>
          <option value="">{options.isFetching ? 'Searching…' : 'Select an identity…'}</option>
          {merged.map((i) => <option key={i.id} value={i.id}>{label(i)}</option>)}
        </Select>
        {canCreate && (
          <Button type="button" variant="secondary" onClick={() => setCreating(true)} aria-label="Create a new identity">
            <Plus className="h-4 w-4" aria-hidden /> New
          </Button>
        )}
      </div>
      <IdentityForm open={creating} identity={null} canEdit onClose={() => setCreating(false)} onSaved={(newId) => onChange(newId)} />
    </div>
  )
}
