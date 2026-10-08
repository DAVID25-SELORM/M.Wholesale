# Phase 0 — Architecture

## Layers

```
Browser (React SPA)                     Supabase
┌──────────────────────────┐   HTTPS   ┌────────────────────────────────────────────┐
│ modules/* pages & forms  │──────────▶│ GoTrue (auth, JWT)                          │
│ services/* (typed calls) │           │ PostgREST (data API, role from JWT)         │
│ session ability (UX only)│           │ PostgreSQL: RLS · constraints · triggers ·  │
└──────────────────────────┘           │            guarded RPCs · audit             │
                                       └────────────────────────────────────────────┘
        anon key only                  service-role key lives ONLY on trusted servers
```

* **Authentication** — Supabase Auth owns identities and passwords. The SPA signs in with email/password and
  receives a JWT; self-registration is disabled (`enable_signup = false`). Accounts are created by an
  administrator or a trusted server (see Security → provisioning).
* **Session context** — one RPC, `public.get_session_context()`, returns status (`ok`, `inactive_user`,
  `inactive_organization`, `no_profile`), organization, roles, organization-wide permissions, per-branch
  permissions and the branches the user may access. The SPA caches it (TanStack Query, 60 s) and derives
  navigation, button visibility and the branch selector from it. **It never authorizes anything.**
* **Authorization** — enforced in PostgreSQL on every request (RLS policies + column grants + triggers +
  security-definer RPCs). Hiding a menu item or guarding a route is purely UX.
* **Multi-tenancy** — pooled schema; every tenant row carries `organization_id`. Policies compare it with
  `private.current_organization_id()`, which is derived from the verified JWT subject and is `NULL` for inactive
  users/organizations, so every policy fails closed.
* **Branch access** — see [PERMISSIONS.md](PERMISSIONS.md). One source of truth: `user_roles.branch_id`.

## Frontend structure (`src/`)

| Folder | Purpose |
|---|---|
| `app/` | Providers, router (route table with `RequireAuth` / `RequirePermission` guards) |
| `layouts/` | `AppShell`, `Sidebar` (permission-aware), `Topbar` (branch selector, user menu) |
| `components/ui/` | The single component kit: Button, Card, Badge, Field/Input/Select, Modal/Drawer/ConfirmDialog, DataTable, Pagination, SearchInput, Tabs, Dropdown, Toast, Empty/Loading/Error states |
| `modules/<area>/` | Feature pages: `auth`, `session`, `dashboard`, `organization`, `branches`, `warehouses` (+locations), `users`, `roles`, `audit` |
| `services/` | Thin typed data-access functions (the only place that talks to Supabase tables/RPCs); all errors normalised through `lib/errors.ts` |
| `lib/` | `supabase` client, `errors`, `validation` (Zod helpers mirroring DB constraints), `env`, `utils` |
| `config/navigation.ts` | Navigation as data; future modules are shown as disabled “Soon” items, with no routes and no fake screens |
| `types/` | `database.ts` generated from the migrated schema (`npm run db:types`), `domain.ts` hand-written domain types |

Server-side data patterns: lists use database pagination (`range`), search/sort/filter run in SQL, the audit
log never counts rows (fetches `pageSize + 1` to know whether another page exists) and resolves actor names
with one extra query per page. Permissions are fetched once per session, not per component.

## Error handling
`services/common.ts#unwrap` converts every PostgREST error into an `AppError { kind, message }`
(`permission`, `duplicate`, `reference`, `validation`, `not_found`, `auth`, `network`). Forms show the message
inline, row actions show a toast, whole-page failures render an `ErrorState` with retry. Diagnostics go to
`console.error` with code/message/details only — never tokens or request bodies.

## Deletion strategy
Foundational entities (organizations, branches, warehouses, locations, users, roles) are **never hard-deleted**:
lifecycle is `is_active`, all foreign keys are `ON DELETE RESTRICT` (only `role_permissions → roles` cascades, as
it is pure reference data), and no DELETE privilege is granted to client roles. Future financial and inventory
records follow the same rule: corrections are made by reversing documents/ledger entries, never by deleting or
editing posted rows. `deleted_at` is deliberately not used.

## Preparing for later phases
* **Product identity (Phase 1):** new tables `products` (canonical identity), `product_aliases`, `product_skus`
  / package variants, `manufacturers`, `units_of_measure`, `barcodes` — all tenant-scoped with the same
  composite-FK pattern (`(parent_id, organization_id)`), RLS template and audit trigger.
* **Ledger inventory:** stock will be an append-only movement table with batch + warehouse + location
  references (composite FKs to `warehouses`/`warehouse_locations` already guarantee tenant consistency) and a
  derived balance table; there is deliberately no `quantity` column anywhere in Phase 0.
* **Numbering:** `private.generate_document_number()` is ready for PO/GRN/SO/INV/PAY/RET/TRF.
* **DrugXOne:** nothing in Phase 0 is coupled to it; integrations will enter through server-side adapters (Edge
  Functions) that call the same guarded RPCs, with `system_settings` (category `integrations`) holding
  non-secret configuration only.
