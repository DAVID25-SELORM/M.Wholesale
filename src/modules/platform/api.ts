import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import type { Json } from '@/types/database'

export type RecordData = Record<string, Json | undefined>
export type PlatformResult = { rows: RecordData[]; total: number } & RecordData
export async function readPlatform(section: string, search = '', page = 0, from?: string, to?: string, id?: string, filter = 'ALL') {
  if (['invoices', 'payments', 'options', 'revenue'].includes(section)) return unwrap(await supabase.rpc('platform_billing', { p_section: section, p_page: page }), 'platform.billing') as unknown as PlatformResult
  return unwrap(await supabase.rpc('platform_read', { p_section: section, p_search: search, p_page: page, p_from: from, p_to: to, p_id: id, p_filter: filter }), 'platform.read') as unknown as PlatformResult
}
export async function writePlatform(action: string, data: RecordData, reason: string) {
  if (action === 'invoice.create') return unwrap(await supabase.rpc('platform_issue_invoice', { p_organization: textValue(data.organization_id), p_reason: reason }), 'platform.invoice')
  return unwrap(await supabase.rpc('platform_write', { p_action: action, p_data: data as Json, p_reason: reason }), 'platform.write')
}
export const textValue = (value: Json | undefined): string => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
export function exportRecords(rows: RecordData[], name: string) {
  if (!rows.length) return
  const columns = Object.keys(rows[0]!)
  const escape = (v: Json | undefined) => '"' + textValue(v).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"'
  const content = [columns.map(escape).join(','), ...rows.map(row => columns.map(key => escape(row[key])).join(','))].join('\r\n')
  const url = URL.createObjectURL(new Blob(['\ufeff', content], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = `${name}.csv`; a.click(); URL.revokeObjectURL(url)
}
