# Phase 0 — Database

Migrations (`supabase/migrations`, applied in order; reviewed SQL, no dashboard edits):

| # | File | Contents |
|---|---|---|
| 01 | `foundation` | `private` schema, `entity_code` domain, `warehouse_type` enum, `set_updated_at()` and `prevent_column_change()` triggers |
| 02 | `tenancy_core` | `organizations`, `branches`, `warehouses`, `warehouse_locations` + constraints/indexes |
| 03 | `identity_rbac` | `profiles`, `permissions`, `roles`, `role_permissions`, `user_roles` |
| 04 | `security_helpers` | `current_organization_id`, `current_profile_id`, `has_permission`, `has_permission_anywhere`, `can_access_branch`, `warehouse_branch_id`, `can_access_warehouse`, `user_can_access_branch`, `actor_covers_role`, `org_has_other_admin`, profile write guard |
| 05 | `audit` | `audit_logs` (append-only), `write_audit`, `audit_row_change` + triggers on Phase 0 tables |
| 06 | `settings_numbering` | `system_settings`, `number_sequences`, `generate_document_number()` |
| 07 | `rls_and_grants` | RLS enabled everywhere, policies, explicit table/column grants |
| 08 | `rpc` | `get_session_context`, `assign_user_role`, `revoke_user_role`, `set_user_active`, `provision_organization`, `provision_user` |
| 09 | `reference_data` | 21 permissions, 20 system roles, role→permission matrix |
| 10 | `hardening` | revoke default EXECUTE on functions, re-grant the exact allow-list |
| 11 | `invitations` | `prepare_invitation`, `prepare_resend` (caller JWT), `complete_invitation` (service role only) for the `invite-user` Edge Function |
| P1-1…3 | `catalog_permissions`, `suppliers`, `catalog` | Phase 1 - see [../phase1/CATALOG_AND_SUPPLIERS.md](../phase1/CATALOG_AND_SUPPLIERS.md) |
| P2-1…2 | `inventory_permissions`, `inventory` | Phase 2 - see [../phase2/INVENTORY.md](../phase2/INVENTORY.md) |
| P3-1…2 | `purchasing_permissions`, `purchasing` | Phase 3 - see [../phase3/PURCHASING.md](../phase3/PURCHASING.md) |

Rules for future migrations: never edit an applied migration; add a new one. Every new tenant table needs
RLS + policies + explicit grants + `updated_at` trigger + audit trigger, and `tests/security/hardening.test.ts`
fails the build if a public table lacks RLS/policies or a function lacks a pinned `search_path`.

## Entities and relationships

```
organizations 1─┬─* branches 1─* warehouses 1─* warehouse_locations
                ├─* profiles (id = auth.users.id) ─* user_roles *─1 roles *─* permissions (role_permissions)
                │                       └ default_branch_id → branches
                ├─* audit_logs        ├─ user_roles.branch_id → branches (NULL = organization-wide)
                ├─* system_settings   (organization | branch scope)
                └─* number_sequences  (organization | branch scope, per document type)
```

**Cross-tenant references are impossible.** Every child stores `organization_id` and references its parent with a
composite foreign key `(parent_id, organization_id) → parent(id, organization_id)`:
`warehouses_branch_fk`, `warehouse_locations_warehouse_fk`, `profiles_default_branch_fk`, `user_roles_profile_fk`,
`user_roles_branch_fk`, `system_settings_branch_fk`, `number_sequences_branch_fk`. `organization_id` (and
`branch_id` on warehouses, `warehouse_id` on locations) are **immutable** — a trigger blocks changes even for the
service role.

| Table | Key constraints |
|---|---|
| `organizations` | name non-blank, `country ~ ^[A-Z]{2}$`, `currency_code ~ ^[A-Z]{3}$`, valid IANA `timezone` (trigger); defaults GHS / Africa/Accra / GH |
| `branches` | unique `(organization_id, code)`; one head office per organization (partial unique index); `code` matches `entity_code` |
| `warehouses` | unique `(organization_id, code)` (codes are organization-wide, which keeps future documents unambiguous); `warehouse_type` enum `MAIN/RETURNS/QUARANTINE/DAMAGED/TRANSIT/OTHER` |
| `warehouse_locations` | unique `(warehouse_id, code)`; aisle/rack/shelf/bin ≤ 32 chars; `picking_sequence ≥ 0` (index `(warehouse_id, picking_sequence, code)` for pick-list ordering) |
| `profiles` | PK = `auth.users.id` (FK RESTRICT); unique `(organization_id, employee_code)` when set; `email` is a denormalised display copy, Supabase Auth stays authoritative |
| `roles` | system roles are global templates (`organization_id IS NULL`, `is_system_role`); organization roles reserved for later (`CHECK is_system_role = (organization_id IS NULL)`) |
| `permissions` | `code = module || '.' || action` enforced by CHECK |
| `user_roles` | unique `(user_id, role_id, branch_id)` NULLS NOT DISTINCT; trigger rejects roles of another organization or inactive roles; rows are immutable (assign / revoke only) |
| `audit_logs` | append-only (see Security); indexes `(organization_id, created_at desc, id desc)`, per-branch, per-actor, per-entity, BRIN on `created_at` |
| `system_settings` | unique `(organization_id, branch_id, category, key)`; category in company/inventory/sales/purchasing/credit/invoice/notifications/security/integrations; value ≤ 16 KB; scope/key immutable; `updated_by` stamped by trigger (not client-supplied) |
| `number_sequences` | unique `(organization_id, branch_id, document_type)`; `reset_period` NEVER/YEARLY/MONTHLY; padding 1–12 |

`updated_at` is maintained by `private.set_updated_at()`; all timestamps are `timestamptz`. Audit uses
`clock_timestamp()` so events within one transaction keep their order.

## Document numbering
`private.generate_document_number(org, branch|null, type, default_prefix)` → e.g. `INV-2026-000042`
(YEARLY), `GRN-202610-000007` (MONTHLY), `PO-000015` (NEVER). The sequence row is created on first use and locked
with `SELECT … FOR UPDATE`; concurrent callers queue and each re-reads the updated row, so there are no
duplicates; because it runs inside the caller's transaction a rolled-back document releases its number (gap-free).
The period is evaluated in the **organization's time zone**; numbers never truncate when they outgrow the padding.
It is callable only by `service_role` / `postgres` (future business RPCs, which are SECURITY DEFINER, call it
internally); clients cannot call it. Tests: 60 concurrent callers → 60 distinct contiguous numbers.

## Indexes
Organization-first composites for tenant filters, FK-support indexes (`warehouses(branch_id)`,
`user_roles(user_id | role_id | organization_id, branch_id)`, `profiles(default_branch_id)`), pick-order index, name
index for user lists, and the audit indexes above. Redundant single-column indexes were intentionally avoided.

## Scale notes
`audit_logs` is a plain table with composite + BRIN indexes and keyset-friendly ordering. When it approaches
tens of millions of rows convert it to monthly range partitions (`created_at`) in a new migration — all access
already goes through `(organization_id, created_at desc)`, so no application change is needed.
