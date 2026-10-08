# Pharmacy Wholesale ERP

Multi-tenant ERP for pharmaceutical wholesalers (Ghana first, built to be international).
**Status: Phase 0 — secure foundation** (organizations, branches, warehouses, locations, users, RBAC with branch
scope, audit log, document numbering, application shell). Business modules arrive in later phases.

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
| [docs/README.md](docs/README.md) | original planning pack (architecture/roadmap/requirements) |

Quick start: `npm install && npm run stack:up && DEV_SEED_PASSWORD='…' npm run seed:dev && npm run dev`.
