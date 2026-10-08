# ADR-0001: Supabase (PostgreSQL + RLS + Auth) with a React SPA

Status: accepted (2026-10-08) — supersedes the stack in `docs/01-architecture.md`.

## Context
The first planning pack (`docs/01…07`) proposed NestJS + Prisma. The Phase 0 brief instead makes the
**database the authoritative security boundary** and targets Supabase (PostgreSQL, Supabase Auth, RLS,
migrations in `supabase/migrations`). The repository was empty, so there was nothing to preserve or migrate.

## Decision
- **Frontend:** React 18 + TypeScript + Vite + Tailwind, React Router 7, TanStack Query, Zod.
- **Backend:** Supabase — PostgreSQL 17, Supabase Auth (GoTrue), PostgREST data API, RLS.
  Business rules that must be tamper-proof live in the database (constraints, triggers, RLS, guarded RPCs).
  Server-only operations (provisioning organizations/users) use the service-role key from a trusted server,
  never from the browser.
- **No NestJS/Prisma** for now. An application server (Edge Functions or a Node service) can be added later
  for integrations (DrugXOne, payment gateways, messaging) without changing the security model.

## Consequences
- Everything in `docs/02-database-design.md` (ledger-based stock, batches, double-entry journals, composite
  tenant FKs, immutable posted documents) still applies and is implemented as SQL migrations phase by phase.
- Planning documents that mention NestJS/Prisma/`tenant_id`/`SET LOCAL app.tenant_id` are superseded by
  `docs/phase0/*`: the tenant column is `organization_id` and the tenant is resolved from the JWT
  (`auth.uid()` → `profiles.organization_id`) inside `private.current_organization_id()`.
- Reporting/AI workloads later run on a read replica or an analytics schema; heavy business logic that needs
  transactions across tables is written as SECURITY DEFINER functions (same guard rails as Phase 0 RPCs).
