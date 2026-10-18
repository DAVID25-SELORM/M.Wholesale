# Pharmacy Wholesale ERP

Multi-tenant ERP for pharmaceutical wholesalers (Ghana first, built to be international).
**Status: Phase 0 (secure foundation), Phase 1 (product master, pharmaceutical identity, units, suppliers), Phase 2 (inventory core: batches, stock ledger, expiry) and Phase 3 (purchase orders with approval, goods received), Phase 4 (costing and valuation, purchase returns, stock counts, supplier invoices with 3-way match, payables), Phase 5 (in-transit transfers, bulk import from Excel/CSV), Phase 6 (customers, price lists, tax, sales invoices with FEFO picking, receipts, receivables) Phase 7 (credit notes: sales returns and price corrections) Phase 8 (point of sale: till shifts, counter sales, receipts) Phase 9 (refunds, reversal of invoices and credit notes) Phase 10 (quotations, sales orders with stock reservation) Phase 11 (sales and margin reports, controlled-drugs register, payment reminders, PDF export) Phase 12 (deliveries and picking, stock insights, VAT summary, access review) Phase 13 (accounting ledger, financial statements, bank reconciliation) Phase 14 (second-person approval for controlled-drug adjustments) Phase 15 (application error log, crash screen) and Phase 16 (cutover tools: customer import, opening receivables and payables) built.**
Sales, finance and delivery arrive in later phases.

* Stack: React + TypeScript + Vite + Tailwind · Supabase (PostgreSQL 17, Auth, RLS) — see
  [ADR-0001](docs/adr/0001-supabase-stack.md).
* Principle: **the database is the authority** for authorization, tenant isolation and integrity; the UI only improves UX.

| Read | |
|---|---|
| [docs/phase0/ARCHITECTURE.md](docs/phase0/ARCHITECTURE.md) | layers, frontend structure, deletion strategy, next-phase prep |
| [docs/phase0/DATABASE.md](docs/phase0/DATABASE.md) | migrations, entities, constraints, numbering |
| [docs/phase0/PERMISSIONS.md](docs/phase0/PERMISSIONS.md) | user → role → permission, branch scope, SUPER_ADMIN |
| [docs/phase0/SECURITY.md](docs/phase0/SECURITY.md) | trust boundaries, tenant isolation, audit, production checklist |
| [docs/phase0/DEVELOPMENT.md](docs/phase0/DEVELOPMENT.md) | setup, env vars, migrations, tests |
| [docs/phase1/CATALOG_AND_SUPPLIERS.md](docs/phase1/CATALOG_AND_SUPPLIERS.md) | Phase 1: product identity model, units, barcodes, aliases, search, suppliers |
| [docs/phase2/INVENTORY.md](docs/phase2/INVENTORY.md) | Phase 2: batches, stock ledger and balances, posting rules, statuses, FEFO, expiry |
| [docs/phase3/PURCHASING.md](docs/phase3/PURCHASING.md) | Phase 3: purchase orders, approval workflow, receiving goods into stock |
| [docs/phase4/STOCK_AND_PAYABLES.md](docs/phase4/STOCK_AND_PAYABLES.md) | Phase 4: batch costs and valuation, purchase returns, stock counts, supplier invoices, payables |
| [docs/phase5/TRANSFERS_AND_IMPORT.md](docs/phase5/TRANSFERS_AND_IMPORT.md) | Phase 5: two-step transfers between warehouses, importing products, suppliers and opening stock |
| [docs/phase6/SALES.md](docs/phase6/SALES.md) | Phase 6: customers and credit, price lists and tax, sales invoices (FEFO, regulatory rules), receipts, receivables |
| [docs/phase7/CREDIT_NOTES.md](docs/phase7/CREDIT_NOTES.md) | Phase 7: credit notes - returned goods back into the sold batches, price corrections, customer credit |
| [docs/phase8/POINT_OF_SALE.md](docs/phase8/POINT_OF_SALE.md) | Phase 8: point of sale - walk-in customer, till shifts, split-tender counter sales, receipts |
| [docs/phase9/REFUNDS_AND_REVERSALS.md](docs/phase9/REFUNDS_AND_REVERSALS.md) | Phase 9: refunding unused credit, reversing invoices and credit notes |
| [docs/phase10/QUOTATIONS_AND_ORDERS.md](docs/phase10/QUOTATIONS_AND_ORDERS.md) | Phase 10: quotations, sales orders, stock reservation, invoicing orders |
| [docs/phase11/REPORTS_REGISTERS_REMINDERS.md](docs/phase11/REPORTS_REGISTERS_REMINDERS.md) | Phase 11: sales and margin reports, controlled-drugs register, payment reminders, PDF export |
| [docs/phase12/DELIVERIES_INSIGHTS_VAT_ACCESS.md](docs/phase12/DELIVERIES_INSIGHTS_VAT_ACCESS.md) | Phase 12: delivery notes and pick lists, stock insights, VAT summary, access review (and what was deliberately not built) |
| [docs/phase13/ACCOUNTING_BANK.md](docs/phase13/ACCOUNTING_BANK.md) | Phase 13: accounting ledger (automatic journals), chart of accounts, manual journals, period close, financial statements, bank reconciliation |
| [docs/phase14/CONTROLLED_ADJUSTMENT_APPROVAL.md](docs/phase14/CONTROLLED_ADJUSTMENT_APPROVAL.md) | Phase 14: controlled-drug adjustments need a second person's approval |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | End-user guide by task: cashier, sales, warehouse, purchasing, accounts and bank, controlled medicines, what to do when something goes wrong |
| [docs/CUTOVER.md](docs/CUTOVER.md) | Cutover plan: loading data, opening balances, the switch-over day, go/no-go, rollback |
| [docs/ACCESS_REVIEW.md](docs/ACCESS_REVIEW.md) | who can do what, per role, with separation-of-duties checks (generated) |
| [docs/README.md](docs/README.md) | original planning pack (architecture/roadmap/requirements) |

Quick start: `npm install && npm run stack:up && DEV_SEED_PASSWORD='…' npm run seed:dev && npm run dev`.
The local stack uses ports 58330/58331 (override with `WPS_AUTH_PORT` / `WPS_REST_PORT` if Windows has reserved them).
