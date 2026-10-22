import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from '@/layouts/AppShell'
import { AuditLogPage } from '@/modules/audit/AuditLogPage'
import { ClientErrorsPage } from '@/modules/audit/ClientErrorsPage'
import { SettingsPage } from '@/modules/settings/SettingsPage'
import { RouteError } from '@/components/ErrorBoundary'
import { RequireAuth, RequirePermission } from '@/modules/auth/guards'
import { AccessDisabledPage, LoginPage, NoAccessPage, NotFoundPage, UnauthorizedPage } from '@/modules/auth/pages'
import { ForgotPasswordPage, SetPasswordPage } from '@/modules/auth/PasswordPages'
import { BranchesPage } from '@/modules/branches/BranchesPage'
import { PickTaskPage } from '@/modules/fulfilment/PickTaskPage'
import { PickingQueuePage } from '@/modules/fulfilment/PickingQueuePage'
import { DriversPage } from '@/modules/fleet/DriversPage'
import { VehiclesPage } from '@/modules/fleet/VehiclesPage'
import { DashboardPage } from '@/modules/dashboard/DashboardPage'
import { CatalogSetupPage } from '@/modules/catalog/CatalogSetupPage'
import { ProductDetailPage } from '@/modules/catalog/ProductDetailPage'
import { ProductsPage } from '@/modules/catalog/ProductsPage'
import { ExpiryPage } from '@/modules/inventory/ExpiryPage'
import { ControlledAdjustmentsPage } from '@/modules/inventory/ControlledAdjustmentsPage'
import { StockDocumentsPage } from '@/modules/inventory/StockDocumentsPage'
import { StockPage } from '@/modules/inventory/StockPage'
import { ImportPage } from '@/modules/imports/ImportPage'
import { StockCountDetailPage } from '@/modules/inventory/StockCountDetailPage'
import { StockCountsPage } from '@/modules/inventory/StockCountsPage'
import { TransfersPage } from '@/modules/inventory/TransfersPage'
import { ValuationPage } from '@/modules/inventory/ValuationPage'
import { OrganizationPage } from '@/modules/organization/OrganizationPage'
import { QuotationPage } from '@/modules/sales/QuotationPage'
import { QuotationsPage } from '@/modules/sales/QuotationsPage'
import { SalesOrderPage } from '@/modules/sales/SalesOrderPage'
import { SalesOrdersPage } from '@/modules/sales/SalesOrdersPage'
import { AccountingOverviewPage } from '@/modules/accounting/AccountingOverviewPage'
import { BankPage } from '@/modules/accounting/BankPage'
import { ChartPage } from '@/modules/accounting/ChartPage'
import { JournalsPage } from '@/modules/accounting/JournalsPage'
import { LedgerPage } from '@/modules/accounting/LedgerPage'
import { ReconcilePage } from '@/modules/accounting/ReconcilePage'
import { StatementsPage } from '@/modules/accounting/StatementsPage'
import { ControlledRegisterPage } from '@/modules/reports/ControlledRegisterPage'
import { SalesReportPage } from '@/modules/reports/SalesReportPage'
import { RemindersPage } from '@/modules/sales/RemindersPage'
import { StockInsightsPage } from '@/modules/reports/StockInsightsPage'
import { VatReportPage } from '@/modules/reports/VatReportPage'
import { DeliveriesPage } from '@/modules/sales/DeliveriesPage'
import { DeliveryNotePage } from '@/modules/sales/DeliveryNotePage'
import { PosPage } from '@/modules/pos/PosPage'
import { PosSessionsPage } from '@/modules/pos/PosSessionsPage'
import { CreditNotePage } from '@/modules/sales/CreditNotePage'
import { CreditNotesPage } from '@/modules/sales/CreditNotesPage'
import { CustomerPage } from '@/modules/sales/CustomerPage'
import { CustomersPage } from '@/modules/sales/CustomersPage'
import { RefundsPage } from '@/modules/sales/RefundsPage'
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
    errorElement: <RouteError />,
    children: [
      { path: '/unauthorized', element: <UnauthorizedPage /> },
      {
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          { element: <RequirePermission anyOf={['organizations.view']} />, children: [{ path: 'admin/organization', element: <OrganizationPage /> }] },
          { element: <RequirePermission anyOf={['branches.view']} />, children: [{ path: 'admin/branches', element: <BranchesPage /> }] },
          { element: <RequirePermission anyOf={['fulfilment.view']} />, children: [{ path: 'warehouse/picking', element: <PickingQueuePage /> }, { path: 'warehouse/picking/:id', element: <PickTaskPage /> }] },
          { element: <RequirePermission anyOf={['fleet.view']} />, children: [{ path: 'delivery/drivers', element: <DriversPage /> }, { path: 'delivery/vehicles', element: <VehiclesPage /> }] },
          { element: <RequirePermission anyOf={['warehouses.view']} />, children: [{ path: 'admin/warehouses', element: <WarehousesPage /> }] },
          { element: <RequirePermission anyOf={['warehouse_locations.view']} />, children: [{ path: 'admin/locations', element: <LocationsPage /> }] },
          { element: <RequirePermission anyOf={['users.view']} />, children: [{ path: 'admin/users', element: <UsersPage /> }] },
          { element: <RequirePermission anyOf={['roles.view']} />, children: [{ path: 'admin/roles', element: <RolesPage /> }] },
          { element: <RequirePermission anyOf={['audit.view']} />, children: [{ path: 'admin/audit', element: <AuditLogPage /> }, { path: 'admin/errors', element: <ClientErrorsPage /> }] },
          { element: <RequirePermission anyOf={['settings.view']} />, children: [{ path: 'admin/settings', element: <SettingsPage /> }] },
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
            element: <RequirePermission anyOf={['quotations.view']} />,
            children: [
              { path: 'sales/quotations', element: <QuotationsPage /> },
              { path: 'sales/quotations/new', element: <QuotationPage /> },
              { path: 'sales/quotations/:id', element: <QuotationPage /> },
            ],
          },
          {
            element: <RequirePermission anyOf={['orders.view']} />,
            children: [
              { path: 'sales/orders', element: <SalesOrdersPage /> },
              { path: 'sales/orders/new', element: <SalesOrderPage /> },
              { path: 'sales/orders/:id', element: <SalesOrderPage /> },
            ],
          },
          { element: <RequirePermission anyOf={['reports.sales']} />, children: [{ path: 'reports/sales', element: <SalesReportPage /> }] },
          { element: <RequirePermission anyOf={['registers.controlled']} />, children: [{ path: 'registers/controlled', element: <ControlledRegisterPage /> }] },
          { element: <RequirePermission anyOf={['reminders.view']} />, children: [{ path: 'sales/reminders', element: <RemindersPage /> }] },
          { element: <RequirePermission anyOf={['reports.stock']} />, children: [{ path: 'reports/stock', element: <StockInsightsPage /> }] },
          { element: <RequirePermission anyOf={['reports.tax']} />, children: [{ path: 'reports/vat', element: <VatReportPage /> }] },
          {
            element: <RequirePermission anyOf={['accounting.view']} />,
            children: [
              { path: 'accounting', element: <AccountingOverviewPage /> },
              { path: 'accounting/accounts', element: <ChartPage /> },
              { path: 'accounting/journals', element: <JournalsPage /> },
              { path: 'accounting/statements', element: <StatementsPage /> },
              { path: 'accounting/ledger', element: <LedgerPage /> },
            ],
          },
          {
            element: <RequirePermission anyOf={['bank.view']} />,
            children: [
              { path: 'accounting/bank', element: <BankPage /> },
              { path: 'accounting/bank/statements/:id', element: <ReconcilePage /> },
            ],
          },
          {
            element: <RequirePermission anyOf={['deliveries.view']} />,
            children: [
              { path: 'sales/deliveries', element: <DeliveriesPage /> },
              { path: 'sales/deliveries/:id', element: <DeliveryNotePage /> },
            ],
          },
          { element: <RequirePermission anyOf={['pos.sell']} />, children: [{ path: 'pos', element: <PosPage /> }] },
          { element: <RequirePermission anyOf={['pos.sell', 'pos.view']} />, children: [{ path: 'pos/sessions', element: <PosSessionsPage /> }] },
          {
            element: <RequirePermission anyOf={['credit_notes.view']} />,
            children: [
              { path: 'sales/credit-notes', element: <CreditNotesPage /> },
              { path: 'sales/credit-notes/new', element: <CreditNotePage /> },
              { path: 'sales/credit-notes/:id', element: <CreditNotePage /> },
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
          { element: <RequirePermission anyOf={['refunds.view']} />, children: [{ path: 'sales/refunds', element: <RefundsPage /> }] },
          { element: <RequirePermission anyOf={['pricing.view']} />, children: [{ path: 'sales/pricing', element: <PricingPage /> }] },
          { element: <RequirePermission anyOf={['products.create', 'suppliers.create', 'inventory.opening_stock']} />, children: [{ path: 'admin/import', element: <ImportPage /> }] },
          { element: <RequirePermission anyOf={['inventory.valuation']} />, children: [{ path: 'inventory/valuation', element: <ValuationPage /> }] },
          {
            element: <RequirePermission anyOf={['inventory.view']} />,
            children: [
              { path: 'inventory/stock', element: <StockPage /> },
              { path: 'inventory/expiry', element: <ExpiryPage /> },
              { path: 'inventory/documents', element: <StockDocumentsPage /> },
              { path: 'inventory/controlled-adjustments', element: <ControlledAdjustmentsPage /> },
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
