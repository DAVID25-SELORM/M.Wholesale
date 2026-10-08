import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from '@/layouts/AppShell'
import { AuditLogPage } from '@/modules/audit/AuditLogPage'
import { RequireAuth, RequirePermission } from '@/modules/auth/guards'
import { AccessDisabledPage, LoginPage, NoAccessPage, NotFoundPage, UnauthorizedPage } from '@/modules/auth/pages'
import { BranchesPage } from '@/modules/branches/BranchesPage'
import { DashboardPage } from '@/modules/dashboard/DashboardPage'
import { OrganizationPage } from '@/modules/organization/OrganizationPage'
import { RolesPage } from '@/modules/roles/RolesPage'
import { UsersPage } from '@/modules/users/UsersPage'
import { LocationsPage } from '@/modules/warehouses/LocationsPage'
import { WarehousesPage } from '@/modules/warehouses/WarehousesPage'

// Route guards are UX. The database is the security boundary (RLS + guarded RPCs).
export const routes = [
  { path: '/login', element: <LoginPage /> },
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
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]

export const createRouter = () => createBrowserRouter(routes)
