import { TenantsPage } from '@/modules/organization/TenantsPage'
import { SupplierQuotationsPage } from '@/modules/purchasing/SupplierQuotationsPage'
import { PriceAgreementsPage } from '@/modules/sales/PriceAgreementsPage'
import { ExpensesPage } from '@/modules/accounting/ExpensesPage'
import { CrmPage } from '@/modules/crm/CrmPage'
import { ProcurementInsightsPage } from '@/modules/reports/ProcurementInsightsPage'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { PlatformShell } from '@/layouts/PlatformShell'
import { PlatformPage } from '@/modules/platform/PlatformPage'
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
import { PackingPage, PackingQueuePage } from '@/modules/fulfilment/PackingPage'
import { ExceptionsPage } from '@/modules/fulfilment/ExceptionsPage'
import { RecallsPage } from '@/modules/inventory/RecallsPage'
import { DriversPage } from '@/modules/fleet/DriversPage'
import { VehiclesPage } from '@/modules/fleet/VehiclesPage'
import { DeliveryRunPage, DeliveryRunsPage } from '@/modules/fleet/DeliveryRunsPage'
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
import { StockInsightsPage, ReplenishmentPage } from '@/modules/reports/StockInsightsPage'
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
import { WorkspaceModulePage } from '@/modules/shared/WorkspaceModulePage'
import { ApprovalsPage } from '@/modules/shared/ApprovalsPage'
import { CreditControlPage } from '@/modules/sales/CreditControlPage'
import { PurchaseRequestsPage } from '@/modules/purchasing/PurchaseRequestsPage'

// Route guards are UX. The database is the security boundary (RLS + guarded RPCs).
export const routes = [
  { path: '/login', element: <LoginPage /> },
  // Public pages reached from e-mail links (invitation / password reset) or the login form.
  { path: '/accept-invite', element: <SetPasswordPage mode="invite" /> },
  { path: '/reset-password', element: <SetPasswordPage mode="reset" /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/access-disabled', element: <AccessDisabledPage /> },
  { path: '/no-access', element: <NoAccessPage /> },
  { path: '/platform', element: <PlatformShell />, errorElement: <RouteError />, children: [
    { index: true, element: <Navigate to="overview" replace /> },
    { path: 'tenants', element: <Navigate to="/platform/organizations" replace /> },
    { path: 'create', element: <TenantsPage /> },
    ...['overview', 'organizations', 'users', 'operators', 'plans', 'subscriptions', 'invoices', 'payments', 'audit', 'notifications', 'tickets', 'announcements', 'settings'].map(section => ({ path: section, element: <PlatformPage key={section} section={section} /> })),
    { path: 'organizations/:id', element: <PlatformPage section="organization" /> },
    { path: 'tickets/:id', element: <PlatformPage section="ticket" /> },
  ] },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      { path: '/unauthorized', element: <UnauthorizedPage /> },
      { path: '/admin/tenants', element: <Navigate to="/platform/tenants" replace /> },
      {
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'workspace/:module', element: <WorkspaceModulePage /> },
          { path: 'workspace/approvals', element: <ApprovalsPage /> },
          { element: <RequirePermission anyOf={['accounting.view']} />, children: [{ path: 'workspace/expenses', element: <ExpensesPage /> }] },
          { element: <RequirePermission anyOf={['pricing.view']} />, children: [{ path: 'workspace/price-agreements', element: <PriceAgreementsPage /> }] },
          { element: <RequirePermission anyOf={['purchasing.view']} />, children: [{ path: 'workspace/supplier-quotations', element: <SupplierQuotationsPage /> }] },
          { element: <RequirePermission anyOf={['purchasing.view']} />, children: [{ path: 'workspace/procurement-insights', element: <ProcurementInsightsPage /> }] },
          { element: <RequirePermission anyOf={['crm.view', 'crm.manage']} />, children: [{ path: 'workspace/sales-reps', element: <CrmPage kind='representatives' /> }, { path: 'workspace/territories', element: <CrmPage kind='territories' /> }, { path: 'workspace/visits', element: <CrmPage kind='visits' /> }, { path: 'workspace/targets', element: <CrmPage kind='targets' /> }] },
          { element: <RequirePermission anyOf={['customers.view']} />, children: [{ path: 'workspace/credit-control', element: <CreditControlPage /> }] },
          { element: <RequirePermission anyOf={['purchasing.request', 'purchasing.request_approve']} />, children: [{ path: 'workspace/purchase-requests', element: <PurchaseRequestsPage /> }] },
          { element: <RequirePermission anyOf={['organizations.view']} />, children: [{ path: 'admin/organization', element: <OrganizationPage /> }] },
          { element: <RequirePermission anyOf={['branches.view']} />, children: [{ path: 'admin/branches', element: <BranchesPage /> }] },
          { element: <RequirePermission anyOf={['fulfilment.view']} />, children: [{ path: 'warehouse/picking', element: <PickingQueuePage /> }, { path: 'warehouse/picking/:id', element: <PickTaskPage /> }] },
          { element: <RequirePermission anyOf={['recalls.view', 'recalls.manage']} />, children: [{ path: 'inventory/recalls', element: <RecallsPage /> }] },
          { element: <RequirePermission anyOf={['fulfilment.view', 'fulfilment.exception']} />, children: [{ path: 'warehouse/exceptions', element: <ExceptionsPage /> }] },
          { element: <RequirePermission anyOf={['fulfilment.view']} />, children: [{ path: 'warehouse/packing', element: <PackingQueuePage /> }, { path: 'warehouse/packing/:id', element: <PackingPage /> }, { path: 'warehouse/dispatch', element: <PackingQueuePage dispatch /> }] },
          { element: <RequirePermission anyOf={['fleet.view']} />, children: [{ path: 'delivery/drivers', element: <DriversPage /> }, { path: 'delivery/vehicles', element: <VehiclesPage /> }] },
          { element: <RequirePermission anyOf={['runs.view', 'runs.drive']} />, children: [{ path: 'delivery/runs', element: <DeliveryRunsPage /> }, { path: 'delivery/runs/:id', element: <DeliveryRunPage /> }] },
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
          { element: <RequirePermission anyOf={['reports.sales']} />, children: [
            { path: 'workspace/customer-insights', element: <SalesReportPage key="customer-insights" initialGroup="CUSTOMER" title="Customer insights" /> },
            { path: 'workspace/product-performance', element: <SalesReportPage key="product-performance" initialGroup="PRODUCT" title="Product performance" /> },
          ] },
          { element: <RequirePermission anyOf={['registers.controlled']} />, children: [{ path: 'registers/controlled', element: <ControlledRegisterPage /> }] },
          { element: <RequirePermission anyOf={['reminders.view']} />, children: [{ path: 'sales/reminders', element: <RemindersPage /> }] },
          { element: <RequirePermission anyOf={['reports.stock']} />, children: [{ path: 'reports/stock', element: <StockInsightsPage /> }, { path: 'workspace/replenishment', element: <ReplenishmentPage /> }] },
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
