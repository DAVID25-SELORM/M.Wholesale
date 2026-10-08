import type { Database } from './database'

export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row']
export type WarehouseType = Database['public']['Enums']['warehouse_type']

export const WAREHOUSE_TYPES: readonly WarehouseType[] = ['MAIN', 'RETURNS', 'QUARANTINE', 'DAMAGED', 'TRANSIT', 'OTHER']

// ---- Shape returned by the public.get_session_context() RPC -------------------------------

export interface SessionBranch {
  id: string
  code: string
  name: string
  is_head_office: boolean
  is_active: boolean
}

export interface SessionRole {
  id: string
  role_code: string
  role_name: string
  branch_id: string | null
}

export type SessionStatus = 'ok' | 'no_profile' | 'inactive_user' | 'inactive_organization'

export interface SessionContext {
  status: SessionStatus
  user_id: string
  profile?: {
    first_name: string
    last_name: string
    display_name?: string
    job_title?: string | null
    default_branch_id?: string | null
  }
  organization?: { id: string; name: string; currency_code?: string; timezone?: string; country?: string }
  roles?: SessionRole[]
  org_permissions?: string[]
  branch_permissions?: Record<string, string[]>
  branches?: SessionBranch[]
}

export interface Paged<T> {
  rows: T[]
  /** exact total when the query asked for a count */
  total?: number
  hasNext: boolean
}

export interface PageParams {
  page: number
  pageSize: number
}
