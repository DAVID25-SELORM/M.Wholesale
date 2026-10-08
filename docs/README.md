# Wholesale Pharmacy Management Software — Planning Pack

Status: original planning pack (2026-10-08). **Phase 0 has since been built on a different stack** — see
[ADR-0001](adr/0001-supabase-stack.md) and [phase0/](phase0/ARCHITECTURE.md). The functional requirements,
database ideas (ledger inventory, batches, journals), UX specification, security thinking and roadmap below
remain the reference for later phases; anywhere they mention NestJS/Prisma/`tenant_id`/`SET LOCAL
app.tenant_id`, read Supabase/PostgREST/`organization_id`/JWT-derived tenant instead.
Target market: Ghana first (GHS), designed to expand internationally.

## Contents

| # | Document | Purpose |
|---|----------|---------|
| 1 | [01-architecture.md](01-architecture.md) | System architecture, tech stack, multi-tenancy, module boundaries, integrations, deployment |
| 2 | [02-database-design.md](02-database-design.md) | Data model, entities, key constraints, inventory ledger, accounting design |
| 3 | [03-functional-requirements.md](03-functional-requirements.md) | Detailed requirements for all 20 modules, with priorities |
| 4 | [04-security-plan.md](04-security-plan.md) | AuthN/Z, tenant isolation, audit, data protection, backups, threat model |
| 5 | [05-ui-ux-spec.md](05-ui-ux-spec.md) | Personas, navigation, key screens, POS and warehouse UX, design system |
| 6 | [06-roadmap.md](06-roadmap.md) | Phased delivery plan, milestones, team, testing, risks |
| 7 | [07-ghana-compliance.md](07-ghana-compliance.md) | Ghana regulatory/tax mapping and **open questions that need your decision** |

## Starting point

The project directory was empty (no code, no assets, no git repo). This is a greenfield build.

## Headline design decisions

1. **Modular monolith** (NestJS) rather than microservices — one deployable, strict module boundaries, extractable later.
2. **Shared database, shared schema, `tenant_id` on every row, enforced by PostgreSQL Row-Level Security** — not just application filters.
3. **Append-only stock ledger** is the source of truth for inventory; on-hand balances are derived/cached per batch + warehouse + location. Nothing edits stock directly.
4. **Batch is the unit of stock.** No stock line exists without a batch and expiry (FEFO picking by default).
5. **Double-entry accounting** underneath sales, purchases, payments and stock, posted through an event-driven posting engine, so finance reports always reconcile to operations.
6. **Tax is data, not code**: tax codes, rates, effective dates and per-product tax category are configuration (Ghana's VAT/levy regime has changed repeatedly).
7. **Money is `numeric(18,4)` in the database and decimal strings in the API** — never floats. Multi-currency ready, GHS default.
8. **Offline-tolerant POS/warehouse** (PWA with queued writes) because connectivity in Ghana is inconsistent.
9. **Integration-ready** (DrugXOne, mobile money, GRA E-VAT, SMS/WhatsApp) behind adapter interfaces with an outbox pattern.

## What I need from you before development starts

See §3 of [07-ghana-compliance.md](07-ghana-compliance.md) and §8 of [06-roadmap.md](06-roadmap.md). The top items: VAT/levy treatment sign-off by an accountant, E-VAT obligation, controlled-drug handling scope, hosting region/provider, pilot customer, and DrugXOne API availability.
