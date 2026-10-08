import { Select } from '@/components/ui'
import type { ActiveFilter } from '@/services/branches'

export function StatusFilter({ value, onChange, label = 'Status' }: { value: ActiveFilter; onChange: (v: ActiveFilter) => void; label?: string }) {
  return (
    <div className="w-full sm:w-40">
      <label className="sr-only" htmlFor={`status-${label}`}>{label}</label>
      <Select id={`status-${label}`} value={value} onChange={(e) => onChange(e.target.value as ActiveFilter)}>
        <option value="all">All statuses</option>
        <option value="active">Active</option>
        <option value="inactive">Inactive</option>
      </Select>
    </div>
  )
}
