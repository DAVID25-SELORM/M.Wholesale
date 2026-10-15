# Pharmacy Wholesale ERP

Multi-tenant ERP for pharmaceutical wholesalers (Ghana first, built to be international).
**Status: Phase 0 (secure foundation), Phase 1 (product master, pharmaceutical identity, units, suppliers), Phase 2 (inventory core: batches, stock ledger, expiry) and Phase 3 (purchase orders with approval, goods received), Phase 4 (costing and valuation, purchase returns, stock counts, supplier invoices with 3-way match, payables) and Phase 5 (in-transit transfers, bulk import from Excel/CSV) built.**
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
| [docs/README.md](docs/README.md) | original planning pack (architecture/roadmap/requirements) |

Quick start: `npm install && npm run stack:up && DEV_SEED_PASSWORD='…' npm run seed:dev && npm run dev`.
The local stack uses ports 58330/58331 (override with `WPS_AUTH_PORT` / `WPS_REST_PORT` if Windows has reserved them).
