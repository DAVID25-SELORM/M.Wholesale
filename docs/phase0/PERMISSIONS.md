# Phase 0 — Roles, permissions and branch access

```
auth user ──1:1── profile (organization) ──*── user_roles ──*── role ──*── permission
                                              │ branch_id NULL  → role applies to ALL branches
                                              └ branch_id = X   → role applies to branch X only
```

## Scope model (the chosen branch-access approach)
There is **no separate `user_branch_access` table**. A role assignment *is* the grant, and its optional
`branch_id` is the scope:

* A user with an organization-wide assignment (e.g. OWNER, branch NULL) can work in every branch — no per-branch
  rows to maintain, and new branches are covered automatically.
* A user with assignments scoped to branches A and B can see and act only in A and B, and may hold *different*
  roles in each (PHARMACIST at A, WAREHOUSE_PICKER at B).
* `can_access_branch(b)` = the caller has any active role assignment that is organization-wide or scoped to `b`.
* `has_permission(code, branch)` = holds the permission organization-wide, or for exactly that branch.
  `has_permission(code)` (no branch) requires **organization-wide** scope — used for organization-level resources
  (company profile, creating branches, users, roles, settings).
* `has_permission_anywhere(code)` = held in any scope — used for organization-wide *reads* such as
  organization-level settings that every scoped staff member may see.

**Warehouse access** currently follows branch access (`can_access_warehouse`). When restricting individual
warehouse users becomes necessary, add a `user_warehouse_access` table and change only that one function; no
policy changes.

## Where each rule is enforced
| Resource | Read | Create | Update |
|---|---|---|---|
| organization | member of the organization | — (server-side provisioning) | `organizations.manage`, org-wide |
| branches | `can_access_branch(id)` | `branches.create`, org-wide | `branches.edit` for that branch (`is_active` toggles deactivate) |
| warehouses | `can_access_branch(branch_id)` | `warehouses.create` for the branch | `warehouses.edit` for the branch |
| locations | via the warehouse's branch | `warehouse_locations.create` for the warehouse's branch | `warehouse_locations.edit` ditto |
| profiles | self, or `users.view` org-wide | — (provisioning) | self (personal fields) or `users.edit` org-wide; `is_active` only via `set_user_active` |
| user_roles | self, or `users.view` / `roles.view` org-wide | **`assign_user_role` RPC only** | immutable; `revoke_user_role` RPC |
| roles / permissions | members (names); `role_permissions` needs `roles.view` | migrations only | migrations only |
| audit_logs | `audit.view` org-wide, or `audit.view` for the row's branch | triggers only | never |
| system_settings / number_sequences | org-level rows: `settings.view` in any scope; branch rows: `settings.view` for that branch | `settings.manage` for the scope (settings) | same |

## Permission catalogue (Phase 0)
`organizations.view|manage` · `branches.view|create|edit` · `warehouses.view|create|edit` ·
`warehouse_locations.view|create|edit` · `users.view|invite|edit|deactivate` · `roles.view|assign|manage` ·
`audit.view` · `settings.view|manage`. Codes are stable `<module>.<action>` strings. Later phases only **add**
rows (`products.*`, `inventory.adjust`, `orders.approve`, `credit.override`, `payments.reverse` …) in their own
migrations; `users.invite` is reserved for the invitation flow (not built yet).

## System roles
SUPER_ADMIN, OWNER, GENERAL_MANAGER, BRANCH_MANAGER, PHARMACIST, PROCUREMENT_MANAGER, PROCUREMENT_OFFICER,
WAREHOUSE_MANAGER, WAREHOUSE_PICKER, WAREHOUSE_PACKER, SALES_MANAGER, SALES_REP, ACCOUNTS_MANAGER,
ACCOUNTS_OFFICER, CREDIT_CONTROLLER, CASHIER, DISPATCHER, DRIVER, AUDITOR, READ_ONLY. They are global templates
(not copied per organization); the matrix is defined in `20261008000900_reference_data.sql`. Highlights:
OWNER / SUPER_ADMIN hold everything; GENERAL_MANAGER holds everything except `roles.manage` and
`organizations.manage`; BRANCH_MANAGER and WAREHOUSE_MANAGER are meant to be assigned **with branch scope**;
AUDITOR holds every `*.view` (including `audit.view`) and nothing else; operational roles currently only see the
structure they work in until their modules exist.

## Anti-escalation and lock-out rules (database functions)
* `assign_user_role` / `revoke_user_role` / `set_user_active` require the caller to hold `roles.assign` /
  `users.deactivate` **and** every permission of the role involved, organization-wide
  (`actor_covers_role`). A GENERAL_MANAGER can therefore hand out CASHIER but not OWNER, and cannot demote or
  deactivate an OWNER.
* Cross-organization targets (users, roles, branches) are rejected.
* The last administrator (organization-wide holder of `roles.manage`) cannot be removed, demoted or deactivated;
  these checks run under a per-organization advisory lock so two admins cannot race each other. Nobody can
  deactivate themselves.
* Reasons are recorded in the audit log (`app.audit_reason`).

## SUPER_ADMIN
`SUPER_ADMIN` here is an **organization-level** technical administrator: it has every permission *inside its own
organization*. It is deliberately **not** a cross-tenant role. No RLS policy, helper function or RPC can grant
access outside `private.current_organization_id()`, so there is no flag a browser could flip. Platform-level
work (creating an organization, onboarding its first owner) uses `public.provision_organization` /
`provision_user`, which are executable **only by `service_role`** (and re-check `auth.role()` internally). The
service-role key never reaches the browser; it is held by trusted servers / CI only. If a true platform-admin
console is needed later, it must run server-side (Edge Function) with that key and write its own audit entries.
