# Hosted Chrome navigation review — 2026-10-26

Target: m-wholesale.vercel.app, existing owner session, Head Office.
Read-only navigation; no business records created, posted, imported or changed.
This is navigation evidence, not transaction acceptance or a final handover.

## Screens opened

- Dashboard; Organization; Branches; Warehouses; Warehouse locations; Users; Roles and permissions; Audit log; Application errors.
- Products; Catalogue setup (identities, manufacturers, categories).
- Import data (products, suppliers, customers, opening receivables, opening payables, opening stock).
- Settings (all eight sections, read-only).
- Every Sales navigation entry: quotations, orders, POS, shifts, invoices, credits, refunds, deliveries, reminders, customers, receipts, receivables, pricing (price lists and tax codes).
- Every available Warehouse entry: stock, expiry, documents, controlled adjustments, transfers, counts, valuation, picking, packing, dispatch.
- Every available Purchasing entry: suppliers, orders, receipts, returns, invoices, payables.
- Drivers and Vehicles.
- Every Accounting entry, including all three statement tabs.
- Sales and margins, Stock insights (all three tabs), VAT summary, Controlled drugs register.

These pages rendered without visible ERP crash messages. Most transaction screens
were empty. Filters, exports, forms and populated posting workflows were not fully
exercised by this review. Application errors reported no recorded errors.

## SOON entries tapped

All left the current route unchanged and were exposed as disabled groups:

- Administration: Approvals, Integrations.
- Sales: Price agreements.
- Purchasing: Purchase requests, Supplier quotations.
- Finance: Payments, Receivables, Payables, Credit control, Expenses.
- CRM: Sales reps, Territories, Visits, Targets.
- Delivery: Dispatch, Delivery runs.
- Intelligence: Stock insights, Replenishment, Customer insights, Product performance, Procurement insights.
- Reports: Customer insights.

Some are duplicate navigation gaps: receipts/receivables/payables, warehouse
dispatch and stock insights already have working screens elsewhere. Local delivery
runs, recalls and fulfilment exception screens are ahead of the hosted frontend.

## Readiness findings

- One branch; no warehouse/bin or stock. POS cannot open a shift without a warehouse.
- Eighteen catalogue products, one walk-in customer and three sample suppliers.
  One sample supplier has an expired licence. Real master-data acceptance remains.
- No price lists; only default EXEMPT 0% tax code. Business configuration is pending.
- Accounting has not been started. Opening balances require reconciliation before activation.
- Bank/wallet entries have no bank details; no statements imported.
- No drivers or vehicles.
- Hosted numbering displays raw DELIVERY_RUN, FULFILMENT_ORDER, PACKAGE and RECALL labels.
- Integrations explicitly report no implemented connections. No credentials supplied.
- Empty stock insight messages imply successful sales/risk assessment despite no
  trading data; use neutral empty-state language.
- Roles screen showed Credit Controller with only branches.view; role coverage
  needs review before assigning operational users.

## Local follow-up changes

- Linked the existing Finance receipts/receivables/payables screens and Intelligence
  stock insights instead of showing those duplicate items as future modules.
- Reworded empty stock insight results to avoid claiming that all goods sell or
  that there is no expiry risk when data is absent.
- Corrected package labels to use each packed batch's expiry and batch number.
- Added mixed-batch label and navigation regression tests. Packing/navigation unit run: 13 passed.
- TypeScript check passed. Database regression and lint are still pending for the
  latest changes; this is not a release signoff.

## Remaining work

See REMAINING_IMPLEMENTATION.md. The full software is not complete. This review
does not establish stock/accounting correctness, concurrency safety, full role
coverage, integration readiness, production deployment or business acceptance.
