// Navigation is data. Items marked `planned` are future ERP modules: they are shown
// disabled (clearly labelled) so users see the roadmap, and have NO routes or fake screens.
// `anyOf` only decides visibility - the database enforces access independently.

import {
  BarChart3, Boxes, Building2, ClipboardList, FileText, Gauge, Handshake, Landmark, LayoutDashboard,
  MapPinned, Settings, ShieldCheck, ShoppingCart, Truck, Users, Warehouse, type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  id: string
  label: string
  to?: string
  /** visible when the user holds ANY of these permissions (in any scope). Omit = always visible. */
  anyOf?: readonly string[]
  planned?: boolean
  icon?: LucideIcon
}

export interface NavGroup {
  id: string
  label: string
  icon: LucideIcon
  items: NavItem[]
  /** collapsed by default (used for planned modules) */
  collapsedByDefault?: boolean
}

const planned = (id: string, label: string): NavItem => ({ id, label, planned: true })

export const NAV_TOP: NavItem = { id: 'dashboard', label: 'Dashboard', to: '/', icon: LayoutDashboard }

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'administration', label: 'Administration', icon: Settings,
    items: [
      { id: 'organization', label: 'Organization', to: '/admin/organization', anyOf: ['organizations.view'] },
      { id: 'branches', label: 'Branches', to: '/admin/branches', anyOf: ['branches.view'] },
      { id: 'warehouses', label: 'Warehouses', to: '/admin/warehouses', anyOf: ['warehouses.view'] },
      { id: 'locations', label: 'Warehouse locations', to: '/admin/locations', anyOf: ['warehouse_locations.view'] },
      { id: 'users', label: 'Users', to: '/admin/users', anyOf: ['users.view'] },
      { id: 'roles', label: 'Roles & permissions', to: '/admin/roles', anyOf: ['roles.view'] },
      { id: 'audit', label: 'Audit log', to: '/admin/audit', anyOf: ['audit.view'] },
      planned('products', 'Products'),
      planned('approvals', 'Approvals'),
      planned('integrations', 'Integrations'),
      planned('settings', 'Settings'),
    ],
  },
  {
    id: 'sales', label: 'Sales', icon: ShoppingCart, collapsedByDefault: true,
    items: ['Orders', 'Quotations', 'Invoices', 'Customers', 'Returns'].map((l) => planned(`sales-${l}`, l)),
  },
  {
    id: 'warehouse', label: 'Warehouse', icon: Warehouse, collapsedByDefault: true,
    items: ['Picking', 'Packing', 'Dispatch', 'Inventory', 'Batches', 'Stock count', 'Transfers'].map((l) => planned(`wh-${l}`, l)),
  },
  {
    id: 'purchasing', label: 'Purchasing', icon: Boxes, collapsedByDefault: true,
    items: ['Purchase requests', 'Supplier quotations', 'Purchase orders', 'Goods received', 'Suppliers', 'Purchase returns']
      .map((l) => planned(`pur-${l}`, l)),
  },
  {
    id: 'finance', label: 'Finance', icon: Landmark, collapsedByDefault: true,
    items: ['Payments', 'Receivables', 'Payables', 'Credit control', 'Expenses'].map((l) => planned(`fin-${l}`, l)),
  },
  {
    id: 'crm', label: 'CRM', icon: Handshake, collapsedByDefault: true,
    items: ['Sales reps', 'Territories', 'Visits', 'Targets'].map((l) => planned(`crm-${l}`, l)),
  },
  {
    id: 'delivery', label: 'Delivery', icon: Truck, collapsedByDefault: true,
    items: ['Dispatch', 'Delivery runs', 'Drivers', 'Vehicles'].map((l) => planned(`del-${l}`, l)),
  },
  {
    id: 'intelligence', label: 'Intelligence', icon: Gauge, collapsedByDefault: true,
    items: ['Stock insights', 'Replenishment', 'Customer insights', 'Product performance', 'Procurement insights']
      .map((l) => planned(`int-${l}`, l)),
  },
  {
    id: 'reports', label: 'Reports', icon: BarChart3, collapsedByDefault: true,
    items: [planned('reports-all', 'Reports')],
  },
]

// Re-exported for pages that want the same icons.
export const ICONS = { Building2, ClipboardList, FileText, MapPinned, ShieldCheck, Users }
