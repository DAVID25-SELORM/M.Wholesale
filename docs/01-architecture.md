# 1. Software Architecture

## 1.1 Goals and quality attributes

| Attribute | Target |
|-----------|--------|
| Correctness of stock & money | Ledger-based, transactional, reconcilable; zero silent edits |
| Traceability | Any unit traceable supplier invoice → batch → warehouse → customer in < 10 s |
| Availability | 99.5% in phase 1, 99.9% later; RPO ≤ 5 min, RTO ≤ 1 h |
| Performance | POS line add < 200 ms p95; invoice post < 1 s p95; product search < 150 ms on 100k SKUs |
| Scale | 1,000 tenants, 50 branches/tenant, 5M stock movements/tenant/year |
| Resilience to poor connectivity | POS + warehouse PWAs queue writes offline, sync idempotently |
| Security | Tenant isolation at DB level, full audit trail, least privilege (see doc 4) |
| Extensibility | Adapter-based integrations; country packs for tax/regulatory rules |

## 1.2 Technology stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Frontend | React 18 + TypeScript, Vite, Tailwind CSS | TanStack Router/Query, React Hook Form + Zod, TanStack Table (virtualised), shadcn/ui (Radix) primitives |
| PWA | Workbox service worker, IndexedDB (Dexie) | Offline queue for POS/warehouse scan flows |
| Backend | Node.js 20 LTS + NestJS (TypeScript, strict) | REST + OpenAPI; BullMQ jobs; class-validator/Zod DTOs |
| ORM | Prisma | Hand-written SQL migrations for RLS, partial indexes, triggers, ledger constraints (Prisma `migrate` + raw SQL files). `$queryRaw` for heavy reports |
| DB | PostgreSQL 16 | RLS, `pgcrypto`, `pg_trgm`, partitioning for ledger/audit |
| Cache/queue | Redis | Sessions blacklist, rate limit, BullMQ |
| Search | PostgreSQL FTS + `pg_trgm` first; OpenSearch only if needed | Avoid early infra |
| Files | S3-compatible object storage | Invoices PDF, supplier invoice scans, import files, licence docs |
| PDF | Headless Chromium render of HTML templates (Puppeteer) in a worker | Invoices, delivery notes, statements, labels |
| Observability | OpenTelemetry, Pino JSON logs, Sentry, Prometheus/Grafana | Correlation ID per request |
| CI/CD | GitHub Actions *later* (not pushed now) — local scripts first | Docker, Prisma migrate deploy, blue/green |
| Monorepo | pnpm workspaces + Turborepo | `apps/web`, `apps/api`, `apps/worker`, `packages/shared` (types, Zod schemas, money/tax libs) |

Honest trade-offs: Prisma lacks first-class RLS, partitioning and some constraint types, so the schema is Prisma-managed for models but several objects live in reviewed raw-SQL migrations. This is a known, manageable pattern; the alternative (Drizzle/Kysely) fits Postgres features better but you specified Prisma.

## 1.3 Logical architecture

```
                 ┌──────────────── Clients ────────────────┐
                 │ Web app (React SPA/PWA)  Mobile browser │
                 │ Barcode scanners (HID)   Thermal printer│
                 └──────────────┬──────────────────────────┘
                                │ HTTPS (REST/JSON, SSE for live updates)
                      ┌─────────▼──────────┐
                      │ API Gateway layer  │ NestJS: auth, tenant context,
                      │ (NestJS app)       │ rate limit, validation, RBAC
                      └─────────┬──────────┘
        ┌──────────┬────────────┼─────────────┬───────────────┐
   Catalog   Inventory   Procurement   Sales/Invoicing   Finance ... (modules)
        └──────────┴────────────┼─────────────┴───────────────┘
                                │ domain events (in-process bus + transactional outbox)
                 ┌──────────────▼──────────────┐
                 │ Worker (BullMQ)             │ posting engine, PDF, imports,
                 │                             │ notifications, reminders, reports
                 └───────┬───────────┬─────────┘
                    PostgreSQL     Redis     Object storage
                         │
                 Adapters: DrugXOne, MoMo/payment gateway, SMS/WhatsApp,
                           email, GRA E-VAT, accounting export
```

### Module map (NestJS modules → your 20 areas)

| NestJS module | Covers |
|---------------|--------|
| `identity` | Users, auth, roles, permissions, sessions, MFA (16) |
| `tenancy` | Businesses, branches, settings, subscription & licensing (19) |
| `catalog` | Products, forms/strengths, units of measure, barcodes, price lists (1) |
| `inventory` | Warehouses, locations, batches, stock ledger, transfers, adjustments, stock counts (2, 3, 12) |
| `procurement` | Suppliers, POs, GRN, supplier invoices, 3-way match (4, 5) |
| `sales` | Quotes, orders, invoices, credit notes, price rules (6) |
| `pos` | Counter sales, shifts, cash-up, scanning (7) |
| `parties` | Customers/pharmacies, contacts, licences, credit terms (8) |
| `receivables` | Credit limits, ageing, statements, collections (9) |
| `payments` | Receipts, allocation, cheques, MoMo, bank reconciliation (10) |
| `finance` | Chart of accounts, journals, expenses, VAT returns, period close (11) |
| `quality` | Returns, recalls, quarantine, controlled-drug register (13) |
| `fulfilment` | Pick/pack/dispatch, delivery routes, proof of delivery (14, 15) |
| `reporting` | Dashboards, scheduled reports, Excel export (17) |
| `data-exchange` | Excel import/export, validation, mapping templates (18) |
| `integrations` | DrugXOne, payments, messaging, E-VAT adapters (20) |
| `audit` | Immutable audit log, change history |
| `platform` | Numbering sequences, tax engine, money lib, notifications, file store |

**Rules of modularity**: modules talk through exported service interfaces or domain events only; no cross-module table writes; an ESLint boundary rule (`eslint-plugin-boundaries`) enforces it in CI. This is what allows extracting `fulfilment`, `reporting` or `integrations` into services later without a rewrite.

## 1.4 Multi-tenancy and branches

- **Tenant** = a wholesale business (the licensee). **Branch** = a physical site of that tenant with its own warehouses/POS. A tenant has ≥ 1 branches; a branch has ≥ 1 warehouses.
- **Pooled model**: one schema, `tenant_id uuid NOT NULL` on every business table, composite unique keys include `tenant_id`.
- **RLS**: each request runs inside a transaction that executes `SET LOCAL app.tenant_id = '<uuid>'` (and `app.user_id`); policies `USING (tenant_id = current_setting('app.tenant_id')::uuid)` on every table. The application DB role is **not** the table owner and has no `BYPASSRLS`. A separate migration/admin role is used only for migrations and platform-admin tooling.
- Prisma integration: a `PrismaTenantClient` wraps each request in `$transaction` with the `SET LOCAL`; interceptors guarantee it. Tests assert that a query without context returns zero rows.
- **Branch scoping** is authorization, not isolation: a user's role grants are scoped to `tenant` or to a set of branches/warehouses.
- **Upgrade path**: large tenants can be moved to a dedicated database (tenant → connection map in the control-plane DB) with no schema change.
- **Control plane vs tenant plane**: platform tables (plans, licences, tenant registry, platform admins) live in a separate schema `platform` not reachable via tenant RLS contexts.

## 1.5 Cross-cutting design patterns

1. **Stock ledger (event-sourced inventory)** — `stock_movements` append-only; every receipt, sale, transfer leg, adjustment, return, recall hold writes rows with `qty_delta` (in base unit), batch, warehouse, location, source document reference. `stock_balances` (per tenant/warehouse/location/batch) is maintained in the same transaction with `CHECK (qty_on_hand >= 0)` unless the tenant permits negative stock (default: disallowed). Reservations are a separate `qty_reserved` column.
2. **Document pattern** — every business document (PO, GRN, invoice, credit note, transfer, adjustment…) has `status` (draft → submitted/approved → posted → cancelled/void), gap-free numbering per tenant/branch/year from a `number_sequences` table (locked `SELECT … FOR UPDATE`), and is **immutable once posted**. Corrections are via reversing documents (credit note, return, reversal journal).
3. **Posting engine** — on `posted`, a domain event is written to the outbox in the same transaction; a posting service produces balanced journal entries from configurable account mappings (e.g. Sales → Dr AR, Cr Revenue, Cr VAT payable; COGS from batch cost). Journal lines must sum to zero (DB constraint trigger). Failed postings go to a retry/dead-letter queue and raise an alert; period-locked dates reject posting.
4. **Idempotency** — every mutating endpoint accepts `Idempotency-Key`; offline clients generate client UUIDs for documents; unique `(tenant_id, client_uuid)` prevents duplicates on sync retry.
5. **Optimistic concurrency** — `row_version` on documents and balances; stock allocation uses `SELECT … FOR UPDATE SKIP LOCKED` on candidate batch rows to avoid oversell during concurrent picks.
6. **Costing** — per-batch actual cost (default); weighted average per product per warehouse available as a tenant setting. Landed cost (freight, duty, clearing) apportioned to GRN lines.
7. **Units of measure** — each product has a base unit (e.g. tablet) and packaging hierarchy (strip → box → carton). All quantities stored in base unit; documents display in the chosen pack. Prices per pack stored with conversion factor.
8. **Time & locale** — timestamps `timestamptz` in UTC, business dates in tenant timezone (`Africa/Accra`); i18n framework from day one (English first; Twi/Ga/French packs later).
9. **Soft delete only** for master data (`archived_at`); transactional documents are never deleted.
10. **Validation** — Zod schemas shared between web and api in `packages/shared`.

## 1.6 API design

- REST, resource-oriented, versioned `/api/v1`; OpenAPI generated from Nest decorators; typed client generated for the web app.
- Cursor pagination, server-side filter/sort, `ETag`/`If-Match` on documents.
- Errors: RFC 7807 problem+json with stable `code` values (e.g. `STOCK_INSUFFICIENT`, `CREDIT_LIMIT_EXCEEDED`, `BATCH_EXPIRED`).
- Real-time: Server-Sent Events for low-stock/expiry alerts, pick-task assignment, order status.
- Webhooks (outbound) per tenant for integration partners, HMAC-signed, with retry.
- Public/partner API (later phases): API keys scoped per tenant, rate-limited.

## 1.7 Offline-capable POS and warehouse

- PWA caches catalogue slice (products, barcodes, prices, customers) and a *bounded* batch/stock snapshot for the branch warehouse.
- Offline sales are queued with client UUIDs; on sync the server re-validates stock/price/credit. Conflicts (batch already sold, credit exceeded) surface in a **Sync Exceptions** queue for a supervisor — they never silently fail.
- Offline policy is configurable: cash sales allowed offline; **credit sales blocked offline by default** (credit limit cannot be verified).
- Thermal receipt printing via browser print (80 mm CSS) first; ESC/POS via WebUSB/WebSerial or a small local print agent as a later option.

## 1.8 Integration architecture

| Integration | Approach |
|-------------|----------|
| **DrugXOne** (future) | Anti-corruption layer in `integrations/drugxone`; internal canonical models for product, price, order, stock; mapping table `external_refs(system, entity, internal_id, external_id)`; outbox for outbound events; scheduled/pull sync for inbound. Contract unknown today — we reserve fields (`external_refs`, GTIN/product master mapping, order channel = `DRUGXONE`) and a channel-agnostic order intake endpoint. |
| Mobile money / card | Payment gateway adapter (e.g. Hubtel, Paystack, Flutterwave, direct MTN MoMo/Telecel/AT APIs) — selection is an open question; webhook-confirmed payments auto-allocate to invoices |
| SMS / WhatsApp / email | Notification adapter (e.g. Hubtel SMS, Twilio/WhatsApp Business) for due-date reminders, statements, dispatch notices |
| GRA E-VAT | Adapter for e-invoicing submission if the tenant is obliged (see doc 7); invoice stores `evat_reference`, `evat_qr` |
| Accounting export | CSV/Excel journal export; optional connectors (Xero/QuickBooks/Sage) later |
| Barcode / GS1 | GTIN-13/14 support, GS1-128 / DataMatrix parsing (GTIN, batch, expiry, serial) for receiving; Ghana FDA/track-and-trace readiness |
| Hardware | USB HID scanners, label printers (ZPL/ESC-POS), receipt printers, optional weighing scales |

## 1.9 Deployment

- **Environments**: local (Docker Compose: Postgres, Redis, MinIO, Mailpit), staging, production.
- **Production**: containers on a managed platform. Provider is an open decision: AWS (af-south-1 Cape Town, lowest-latency hyperscaler region to Ghana) vs. a managed PaaS/European region. Data-residency check against Ghana Data Protection Act is required (doc 7).
- Managed PostgreSQL with PITR, multi-AZ, read replica for reporting; Redis managed; object storage with versioning + lifecycle.
- Stateless API containers (≥ 2) behind a load balancer; separate worker deployment; zero-downtime migrations (expand → migrate → contract).
- Backups: continuous WAL (PITR), daily snapshot retained 35 days, monthly retained 7 years for financial data; quarterly restore drill.
- Secrets in a secret manager; no secrets in repo; per-environment keys.

## 1.10 Internationalisation / country packs

A `CountryPack` abstraction supplies: tax regime (codes, rates, rounding, invoice rules), regulator identifiers (e.g. FDA licence, Pharmacy Council registration), document templates, currency, address format, public holidays, statutory report formats. Ghana is pack #1; nothing Ghana-specific is hard-coded outside it. Multi-currency: `currency` on documents, `exchange_rates` table, base currency per tenant, realised/unrealised FX journals (phase 4).

## 1.11 Testing strategy (architecture-level)

- Unit tests on pure domain logic (tax, pricing, FEFO allocation, allocation of payments, costing).
- Integration tests against real Postgres (Testcontainers) including RLS leak tests and ledger invariants.
- Property-based tests: stock never negative, journals always balance, allocated ≤ invoice total.
- E2E (Playwright) for POS, invoice, receiving, dispatch flows.
- Load tests (k6) for POS and invoice posting; migration rehearsal on production-size data.
