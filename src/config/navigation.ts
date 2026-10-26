// Navigation is data. Items marked `planned` are future ERP modules: they are shown
// disabled (clearly labelled) so users see the roadmap, and have NO routes or fake screens.
// `anyOf` only decides visibility - the database enforces access independently.

import {
  BarChart3, BookOpen, Boxes, Building2, ClipboardList, FileText, Gauge, Handshake, Landmark, LayoutDashboard,
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
      { id: 'client-errors', label: 'Application errors', to: '/admin/errors', anyOf: ['audit.view'] },
      { id: 'products', label: 'Products', to: '/catalog/products', anyOf: ['products.view'] },
      { id: 'catalog-setup', label: 'Catalogue setup', to: '/catalog/setup', anyOf: ['products.view'] },
      { id: 'import', label: 'Import data', to: '/admin/import', anyOf: ['products.create', 'suppliers.create', 'inventory.opening_stock'] },
      planned('approvals', 'Approvals'),
      planned('integrations', 'Integrations'),
      { id: 'settings', label: 'Settings', to: '/admin/settings', anyOf: ['settings.view'] },
    ],
  },
  {
    id: 'sales', label: 'Sales', icon: ShoppingCart,
    items: [
      { id: 'sales-quotations', label: 'Quotations', to: '/sales/quotations', anyOf: ['quotations.view'] },
      { id: 'sales-orders', label: 'Orders', to: '/sales/orders', anyOf: ['orders.view'] },
      { id: 'sales-pos', label: 'Point of sale', to: '/pos', anyOf: ['pos.sell'] },
      { id: 'sales-shifts', label: 'Till shifts', to: '/pos/sessions', anyOf: ['pos.sell', 'pos.view'] },
      { id: 'sales-invoices', label: 'Invoices', to: '/sales/invoices', anyOf: ['sales.view'] },
      { id: 'sales-credit-notes', label: 'Credit notes', to: '/sales/credit-notes', anyOf: ['credit_notes.view'] },
      { id: 'sales-refunds', label: 'Refunds', to: '/sales/refunds', anyOf: ['refunds.view'] },
      { id: 'sales-deliveries', label: 'Deliveries', to: '/sales/deliveries', anyOf: ['deliveries.view'] },
      { id: 'sales-reminders', label: 'Payment reminders', to: '/sales/reminders', anyOf: ['reminders.view'] },
      { id: 'sales-customers', label: 'Customers', to: '/sales/customers', anyOf: ['customers.view'] },
      { id: 'sales-receipts', label: 'Payments received', to: '/sales/receipts', anyOf: ['receipts.view'] },
      { id: 'sales-receivables', label: 'Receivables', to: '/sales/receivables', anyOf: ['receipts.view'] },
      { id: 'sales-pricing', label: 'Pricing & tax', to: '/sales/pricing', anyOf: ['pricing.view'] },
      ...['Price agreements'].map((l) => planned(`sales-${l}`, l)),
    ],
  },
  {
    id: 'warehouse', label: 'Warehouse', icon: Warehouse,
    items: [
      { id: 'stock', label: 'Stock', to: '/inventory/stock', anyOf: ['inventory.view'] },
      { id: 'expiry', label: 'Expiry', to: '/inventory/expiry', anyOf: ['inventory.view'] },
      { id: 'recalls', label: 'Recalls', to: '/inventory/recalls', anyOf: ['recalls.view', 'recalls.manage'] },
      { id: 'stock-documents', label: 'Stock documents', to: '/inventory/documents', anyOf: ['inventory.view'] },
      { id: 'stock-controlled', label: 'Controlled adjustments', to: '/inventory/controlled-adjustments', anyOf: ['inventory.adjust', 'inventory.controlled_approve'] },
      { id: 'stock-transfers', label: 'Transfers', to: '/inventory/transfers', anyOf: ['inventory.view'] },
      { id: 'stock-counts', label: 'Stock counts', to: '/inventory/counts', anyOf: ['inventory.view'] },
      { id: 'stock-valuation', label: 'Stock valuation', to: '/inventory/valuation', anyOf: ['inventory.valuation'] },
      { id: 'wh-picking', label: 'Picking', to: '/warehouse/picking', anyOf: ['fulfilment.view'] },
      { id: 'wh-exceptions', label: 'Fulfilment exceptions', to: '/warehouse/exceptions', anyOf: ['fulfilment.view', 'fulfilment.exception'] },
      { id: 'wh-packing', label: 'Packing', to: '/warehouse/packing', anyOf: ['fulfilment.view'] },
      { id: 'wh-dispatch', label: 'Dispatch', to: '/warehouse/dispatch', anyOf: ['fulfilment.view'] },
    ],
  },
  {
    id: 'purchasing', label: 'Purchasing', icon: Boxes,
    items: [
      { id: 'suppliers', label: 'Suppliers', to: '/purchasing/suppliers', anyOf: ['suppliers.view'] },
      { id: 'purchase-orders', label: 'Purchase orders', to: '/purchasing/orders', anyOf: ['purchasing.view'] },
      { id: 'goods-received', label: 'Goods received', to: '/purchasing/receipts', anyOf: ['purchasing.view'] },
      { id: 'purchase-returns', label: 'Purchase returns', to: '/purchasing/returns', anyOf: ['purchasing.view'] },
      { id: 'supplier-invoices', label: 'Supplier invoices', to: '/purchasing/invoices', anyOf: ['payables.view'] },
      { id: 'payables', label: 'Payables', to: '/purchasing/payables', anyOf: ['payables.view'] },
      ...['Purchase requests', 'Supplier quotations']
        .map((l) => planned(`pur-${l}`, l)),
    ],
  },
  {
    id: 'finance', label: 'Finance', icon: Landmark, collapsedByDefault: true,
    items: [
      { id: 'fin-Payments', label: 'Payments received', to: '/sales/receipts', anyOf: ['receipts.view'] },
      { id: 'fin-Receivables', label: 'Receivables', to: '/sales/receivables', anyOf: ['receipts.view'] },
      { id: 'fin-Payables', label: 'Payables', to: '/purchasing/payables', anyOf: ['payables.view'] },
      planned('fin-Credit control', 'Credit control'),
      planned('fin-Expenses', 'Expenses'),
    ],
  },
  {
    id: 'crm', label: 'CRM', icon: Handshake, collapsedByDefault: true,
    items: ['Sales reps', 'Territories', 'Visits', 'Targets'].map((l) => planned(`crm-${l}`, l)),
  },
  {
    id: 'delivery', label: 'Delivery', icon: Truck, collapsedByDefault: true,
    items: [
      { id: 'del-dispatch', label: 'Dispatch', to: '/warehouse/dispatch', anyOf: ['fulfilment.view'] },
      { id: 'del-runs', label: 'Delivery runs', to: '/delivery/runs', anyOf: ['runs.view', 'runs.drive'] },
      { id: 'del-drivers', label: 'Drivers', to: '/delivery/drivers', anyOf: ['fleet.view'] },
      { id: 'del-vehicles', label: 'Vehicles', to: '/delivery/vehicles', anyOf: ['fleet.view'] },
    ],
  },
  {
    id: 'intelligence', label: 'Intelligence', icon: Gauge, collapsedByDefault: true,
    items: [
      { id: 'int-Stock insights', label: 'Stock insights', to: '/reports/stock', anyOf: ['reports.stock'] },
      ...['Replenishment', 'Customer insights', 'Product performance', 'Procurement insights'].map((l) => planned(`int-${l}`, l)),
    ],
  },
  {
    id: 'accounting', label: 'Accounting', icon: BookOpen,
    items: [
      { id: 'accounting-overview', label: 'Overview', to: '/accounting', anyOf: ['accounting.view'] },
      { id: 'accounting-journals', label: 'Journals', to: '/accounting/journals', anyOf: ['accounting.view'] },
      { id: 'accounting-statements', label: 'Financial statements', to: '/accounting/statements', anyOf: ['accounting.view'] },
      { id: 'accounting-ledger', label: 'Account ledger', to: '/accounting/ledger', anyOf: ['accounting.view'] },
      { id: 'accounting-accounts', label: 'Chart of accounts', to: '/accounting/accounts', anyOf: ['accounting.view'] },
      { id: 'accounting-bank', label: 'Bank reconciliation', to: '/accounting/bank', anyOf: ['bank.view'] },
    ],
  },
  {
    id: 'reports', label: 'Reports', icon: BarChart3,
    items: [
      { id: 'reports-sales', label: 'Sales and margins', to: '/reports/sales', anyOf: ['reports.sales'] },
      { id: 'reports-stock', label: 'Stock insights', to: '/reports/stock', anyOf: ['reports.stock'] },
      { id: 'reports-vat', label: 'VAT summary', to: '/reports/vat', anyOf: ['reports.tax'] },
      { id: 'reports-controlled', label: 'Controlled drugs register', to: '/registers/controlled', anyOf: ['registers.controlled'] },
      ...['Customer insights'].map((l) => planned(`rep-${l}`, l)),
    ],
  },
]

// Re-exported for pages that want the same icons.
export const ICONS = { Building2, ClipboardList, FileText, MapPinned, ShieldCheck, Users }
