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
import { OrganizationPage } from '@/modules/organization/OrganizationPage'
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
            element: <RequirePermission anyOf={['inventory.view']} />,
            children: [
              { path: 'inventory/stock', element: <StockPage /> },
              { path: 'inventory/expiry', element: <ExpiryPage /> },
              { path: 'inventory/documents', element: <StockDocumentsPage /> },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]

export const createRouter = () => createBrowserRouter(routes)
