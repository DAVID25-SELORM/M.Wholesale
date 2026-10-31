import { supabase } from '@/lib/supabase'
import { unwrap } from '@/services/common'
import type { Json } from '@/types/database'

export type RecordData = Record<string, Json | undefined>
export type PlatformResult = { rows: RecordData[]; total: number } & RecordData
export async function readPlatform(section: string, search = '', page = 0, from?: string, to?: string, id?: string, filter = 'ALL') {
  if (section === 'assignees') {
    const rows = unwrap(await supabase.rpc('platform_support_assignees'), 'platform.support') as RecordData[]
    return { rows, total: rows.length } as PlatformResult
  }
  if (section === 'onboarding') return unwrap(await supabase.rpc('platform_onboarding_requests', { p_page: page, p_status: filter }), 'platform.onboarding') as unknown as PlatformResult
  if (['invoices', 'payments', 'options', 'revenue'].includes(section)) return unwrap(await supabase.rpc('platform_billing', { p_section: section, p_page: page }), 'platform.billing') as unknown as PlatformResult
  return unwrap(await supabase.rpc('platform_read', { p_section: section, p_search: search, p_page: page, p_from: from, p_to: to, p_id: id, p_filter: filter }), 'platform.read') as unknown as PlatformResult
}
export async function writePlatform(action: string, data: RecordData, reason: string) {
  if (action === 'subscription.renew') return unwrap(await supabase.rpc('platform_renew_subscription', { p_organization: textValue(data.organization_id), p_expected_end: textValue(data.ends_on), p_reason: reason }), 'platform.subscription.renew')
  if (action === 'invoice.void') return unwrap(await supabase.rpc('platform_void_invoice', { p_id: textValue(data.id), p_reason: reason }), 'platform.invoice.void')
  if (action === 'announcement.publish' || action === 'announcement.withdraw') return unwrap(await supabase.rpc('platform_publish_announcement', { p_id: textValue(data.id), p_publish: action === 'announcement.publish', p_reason: reason }), 'platform.announcement')
  if (action === 'ticket.tenant_reply') return unwrap(await supabase.rpc('platform_reply_to_tenant', { p_id: textValue(data.id), p_body: textValue(data.body) }), 'platform.support.reply')
  if (action.startsWith('onboarding.')) {
    const result = unwrap(await supabase.rpc('platform_decide_onboarding', { p_id: textValue(data.id), p_approve: action === 'onboarding.approve', p_reason: reason }), 'platform.onboarding') as RecordData
    if (result.status === 'FAILED') throw new Error(`Provisioning failed (${textValue(result.failure_code)}). The request was retained for review and retry.`)
    return textValue(result.organization_id)
  }
  if (action === 'invoice.create') return unwrap(await supabase.rpc('platform_issue_invoice', { p_organization: textValue(data.organization_id), p_reason: reason }), 'platform.invoice')
  return unwrap(await supabase.rpc('platform_write', { p_action: action, p_data: data as Json, p_reason: reason }), 'platform.write')
}
export const textValue = (value: Json | undefined): string => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
export async function collectPlatformExport(section: string, search: string, from: string, to: string, id: string | undefined, filter: string, signal: AbortSignal, progress: (count: number) => void) {
  const rows: RecordData[] = []
  const seen = new Set<string>()
  let expected: number | undefined
  for (let page = 0; ; page++) {
    signal.throwIfAborted()
    const result = await readPlatform(section, search, page, from, to, id, filter)
    signal.throwIfAborted()
    if (expected !== undefined && result.total !== expected) throw new Error('Records changed during export. Refresh and retry.')
    expected = result.total
    if (!Number.isSafeInteger(expected) || expected < 0 || expected > 100000) throw new Error('Export supports up to 100,000 records. Narrow the filters and retry.')
    for (const row of result.rows) {
      const key = textValue(row.id ?? row.organization_id)
      if (key && seen.has(key)) throw new Error('Records moved between pages during export. Refresh and retry.')
      if (key) seen.add(key)
      rows.push(row)
    }
    progress(rows.length)
    if (rows.length > expected) throw new Error('Export count changed. Refresh and retry.')
    if (rows.length === expected) return rows
    if (!result.rows.length) throw new Error('Export returned an incomplete page. Refresh and retry.')
  }
}
export function exportRecords(rows: RecordData[], name: string) {
  if (!rows.length) return
  const columns = Object.keys(rows[0]!)
  const escape = (v: Json | undefined) => '"' + textValue(v).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"'
  const content = [columns.map(escape).join(','), ...rows.map(row => columns.map(key => escape(row[key])).join(','))].join('\r\n')
  const url = URL.createObjectURL(new Blob(['\ufeff', content], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = `${name}.csv`; a.click(); URL.revokeObjectURL(url)
}
