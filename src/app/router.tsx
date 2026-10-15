import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from '@/layouts/AppShell'
import { AuditLogPage } from '@/modules/audit/AuditLogPage'
import { RequireAuth, RequirePermission } from '@/modules/auth/guards'
import { AccessDisabledPage, LoginPage, NoAccessPage, NotFoundPage, UnauthorizedPage } from '@/modules/auth/pages'
import { ForgotPasswordPage, SetPasswordPage } from '@/modules/auth/PasswordPages'
import { BranchesPage } from '@/modules/branches/BranchesPage'
import { DashboardPage } from '@/modules/dashboard/DashboardPage'
import { CatalogSetupPage } from '@/modules/catalog/CatalogSetupPage'
import { ProductDetailPage } from '@/modules/catalog/ProductDetailPage'
import { ProductsPage } from '@/modules/catalog/ProductsPage'
import { ExpiryPage } from '@/modules/inventory/ExpiryPage'
import { StockDocumentsPage } from '@/modules/inventory/StockDocumentsPage'
import { StockPage } from '@/modules/inventory/StockPage'
import { ImportPage } from '@/modules/imports/ImportPage'
import { StockCountDetailPage } from '@/modules/inventory/StockCountDetailPage'
import { StockCountsPage } from '@/modules/inventory/StockCountsPage'
import { TransfersPage } from '@/modules/inventory/TransfersPage'
import { ValuationPage } from '@/modules/inventory/ValuationPage'
import { OrganizationPage } from '@/modules/organization/OrganizationPage'
import { CustomerPage } from '@/modules/sales/CustomerPage'
import { CustomersPage } from '@/modules/sales/CustomersPage'
import { PricingPage } from '@/modules/sales/PricingPage'
import { ReceiptsPage } from '@/modules/sales/ReceiptsPage'
import { ReceivablesPage } from '@/modules/sales/ReceivablesPage'
import { SalesInvoicePage } from '@/modules/sales/SalesInvoicePage'
import { SalesInvoicesPage } from '@/modules/sales/SalesInvoicesPage'
import { PayablesPage } from '@/modules/purchasing/PayablesPage'
import { PurchaseReturnsPage } from '@/modules/purchasing/PurchaseReturnsPage'
import { SupplierInvoicesPage } from '@/modules/purchasing/SupplierInvoicesPage'
import { GoodsReceiptsPage } from '@/modules/purchasing/GoodsReceiptsPage'
import { PurchaseOrderDetailPage } from '@/modules/purchasing/PurchaseOrderDetailPage'
import { PurchaseOrdersPage } from '@/modules/purchasing/PurchaseOrdersPage'
import { RolesPage } from '@/modules/roles/RolesPage'
import { SuppliersPage } from '@/modules/suppliers/SuppliersPage'
import { UsersPage } from '@/modules/users/UsersPage'
import { LocationsPage } from '@/modules/warehouses/LocationsPage'
import { WarehousesPage } from '@/modules/warehouses/WarehousesPage'

// Route guards are UX. The database is the security boundary (RLS + guarded RPCs).
export const routes = [
  { path: '/login', element: <LoginPage /> },
  // Public pages reached from e-mail links (invitation / password reset) or the login form.
  { path: '/accept-invite', element: <SetPasswordPage mode="invite" /> },
  { path: '/reset-password', element: <SetPasswordPage mode="reset" /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/access-disabled', element: <AccessDisabledPage /> },
  { path: '/no-access', element: <NoAccessPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/unauthorized', element: <UnauthorizedPage /> },
      {
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          { element: <RequirePermission anyOf={['organizations.view']} />, children: [{ path: 'admin/organization', element: <OrganizationPage /> }] },
          { element: <RequirePermission anyOf={['branches.view']} />, children: [{ path: 'admin/branches', element: <BranchesPage /> }] },
          { element: <RequirePermission anyOf={['warehouses.view']} />, children: [{ path: 'admin/warehouses', element: <WarehousesPage /> }] },
          { element: <RequirePermission anyOf={['warehouse_locations.view']} />, children: [{ path: 'admin/locations', element: <LocationsPage /> }] },
          { element: <RequirePermission anyOf={['users.view']} />, children: [{ path: 'admin/users', element: <UsersPage /> }] },
          { element: <RequirePermission anyOf={['roles.view']} />, children: [{ path: 'admin/roles', element: <RolesPage /> }] },
          { element: <RequirePermission anyOf={['audit.view']} />, children: [{ path: 'admin/audit', element: <AuditLogPage /> }] },
          {
            element: <RequirePermission anyOf={['products.view']} />,
            children: [
              { path: 'catalog/products', element: <ProductsPage /> },
              { path: 'catalog/products/:id', element: <ProductDetailPage /> },
              { path: 'catalog/setup', element: <CatalogSetupPage /> },
            ],
          },
          { element: <RequirePermission anyOf={['suppliers.view']} />, children: [{ path: 'purchasing/suppliers', element: <SuppliersPage /> }] },
          {
            element: <RequirePermission anyOf={['purchasing.view']} />,
            children: [
              { path: 'purchasing/orders', element: <PurchaseOrdersPage /> },
              { path: 'purchasing/orders/:id', element: <PurchaseOrderDetailPage /> },
              { path: 'purchasing/receipts', element: <GoodsReceiptsPage /> },
              { path: 'purchasing/returns', element: <PurchaseReturnsPage /> },
            ],
          },
          {
            element: <RequirePermission anyOf={['payables.view']} />,
            children: [
              { path: 'purchasing/invoices', element: <SupplierInvoicesPage /> },
              { path: 'purchasing/payables', element: <PayablesPage /> },
            ],
          },
          {
            element: <RequirePermission anyOf={['sales.view']} />,
            children: [
              { path: 'sales/invoices', element: <SalesInvoicesPage /> },
              { path: 'sales/invoices/new', element: <SalesInvoicePage /> },
              { path: 'sales/invoices/:id', element: <SalesInvoicePage /> },
            ],
          },
          {
            element: <RequirePermission anyOf={['customers.view']} />,
            children: [
              { path: 'sales/customers', element: <CustomersPage /> },
              { path: 'sales/customers/:id', element: <CustomerPage /> },
            ],
          },
          {
            element: <RequirePermission anyOf={['receipts.view']} />,
            children: [
              { path: 'sales/receipts', element: <ReceiptsPage /> },
              { path: 'sales/receivables', element: <ReceivablesPage /> },
            ],
          },
          { element: <RequirePermission anyOf={['pricing.view']} />, children: [{ path: 'sales/pricing', element: <PricingPage /> }] },
          { element: <RequirePermission anyOf={['products.create', 'suppliers.create', 'inventory.opening_stock']} />, children: [{ path: 'admin/import', element: <ImportPage /> }] },
          { element: <RequirePermission anyOf={['inventory.valuation']} />, children: [{ path: 'inventory/valuation', element: <ValuationPage /> }] },
          {
            element: <RequirePermission anyOf={['inventory.view']} />,
            children: [
              { path: 'inventory/stock', element: <StockPage /> },
              { path: 'inventory/expiry', element: <ExpiryPage /> },
              { path: 'inventory/documents', element: <StockDocumentsPage /> },
              { path: 'inventory/counts', element: <StockCountsPage /> },
              { path: 'inventory/transfers', element: <TransfersPage /> },
              { path: 'inventory/counts/:id', element: <StockCountDetailPage /> },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]

export const createRouter = () => createBrowserRouter(routes)
