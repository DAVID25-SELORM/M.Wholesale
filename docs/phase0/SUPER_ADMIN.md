# SUPER_ADMIN: scope, assignment, and the controls around it

This page answers, for the most powerful built-in role, exactly what it is, how it is given and taken away, what stops it being abused or forged, and how its use is recorded. Every statement below is enforced in the database and covered by a test (named in brackets) unless it says otherwise.

## 1. What SUPER_ADMIN is

`SUPER_ADMIN` is an **organization-scoped technical administrator**. It holds every permission (91 of 91 today, the same as `OWNER`) **inside its own organization**, and nothing outside it. It is *not* a platform role: there is no role, flag, claim or function in this system that lets a signed-in user see or change another organization's data.

Its place among the roles: `OWNER` and `SUPER_ADMIN` hold everything; `GENERAL_MANAGER` holds everything except `organizations.manage`, `roles.manage`, `journals.create` and `bank.reconcile`; every other role holds a subset (see `docs/ACCESS_REVIEW.md`, regenerated from the database by `scripts/role-matrix.mjs`).

## 2. Why it is organization-scoped, and why it cannot be forged

1. **The organization is never taken from the request.** Every policy and function derives it from the signed-in user's own profile: `private.current_organization_id()` looks up `profiles.organization_id` for `auth.uid()`, where `auth.uid()` comes from the **verified JWT**. A browser can change what it sends; it cannot change who the verified token says it is, or what row the profile table holds for that person. [`tenant-isolation.test.ts`: *cannot insert into B by supplying B ids or organization_id*; *a tampered JWT subject without a profile gets no data*]
2. **Roles are rows, not claims.** Permissions come from `user_roles` and `role_permissions` in the database, evaluated per query by `private.has_permission`. There is no "is admin" value in the JWT, in local storage or in a request that the database trusts. Claiming `service_role` inside the JWT claims does not unlock anything. [`tenant-isolation.test.ts`: *claiming service_role inside the JWT claims does not unlock provisioning RPCs*; *cannot escalate the database role*]
3. **The tables that hold roles cannot be written by clients at all.** `roles`, `permissions`, `role_permissions` and `user_roles` have no insert, update or delete grants for the `authenticated` role; the only way to change them is the checked functions in section 4. [`rbac.test.ts`: *direct writes to RBAC tables are impossible for clients*]
4. **Rows carry their organization, and parents must match.** Every child row has `organization_id` and a composite foreign key `(parent_id, organization_id)`, so a row can never point at another organization's parent, and a user cannot move a row to another organization. [`invariants.test.ts` 10–12; `tenant-isolation.test.ts`: *cannot move own rows to another organization or parent*]
5. **No cross-organization function exists.** There is no `SECURITY DEFINER` function callable by users that takes an organization id as an argument and acts on it. `schema-audit.test.ts` checks that every function callable by users either checks a permission or reads the organization from the session, and that nothing in `public` is executable by `anon`.

If a true platform-operator console is ever needed, it must run **server-side only** (an Edge Function holding the service-role key) and write its own audit entries. That does not exist today by design.

## 3. How SUPER_ADMIN is assigned

- **Nobody assigns it to themselves.** `assign_user_role` refuses the caller's own escalation: the caller needs the `roles.assign` right **and every permission the target role carries** (`private.actor_covers_role`). Only a holder of all 91 permissions covers `SUPER_ADMIN`, so in practice **only an `OWNER` or an existing `SUPER_ADMIN` can grant it**. A `GENERAL_MANAGER` can hand out `CASHIER` but not `OWNER` or `SUPER_ADMIN`. [`rbac.test.ts`: *privilege escalation is blocked: a manager cannot hand out a role stronger than their own*]
- **The first owner of an organization** is created outside the application: `provision_organization` (service role only) creates the organization, its head-office branch, the owner's profile and the `OWNER` role assignment in one transaction. This is run by a trusted operator or CI, not from a browser.
- **People invited later** go through the `invite-user` Edge Function: the caller's own session is checked first (needs `users.invite` and role coverage as above); only then does the function, using the service-role key, create the sign-in and call `complete_invitation` (service role only), which records the **inviter as the actor**. `organization_id` is never read from the request. [`invitations.test.ts`, `invite-function.test.ts`]
- A role can only be assigned inside the caller's own organization, to an active member of that organization, at a branch of that organization; cross-organization targets are rejected. [`rbac.test.ts`: *cross-organization assignment is rejected*]

## 4. Who can provision or revoke it

| Action | Who | Mechanism |
|---|---|---|
| Create an organization and its first owner | Trusted operator / CI only | `provision_organization`, executable only by `service_role` (and it re-checks the caller internally) |
| Create a user directly (bootstrap) | Trusted operator / CI only | `provision_user`, same restriction |
| Invite a person | A user with `users.invite` who covers the role | Edge Function, then `complete_invitation` (service role) |
| Grant any role, including `SUPER_ADMIN` | A user with `roles.assign` who holds every permission of that role | `assign_user_role` |
| Revoke a role | The same rule: `roles.assign` plus coverage of that role | `revoke_user_role` |
| Deactivate or reactivate a user | `users.deactivate` plus coverage of the user's roles; **not themselves** | `set_user_active` |

Protections that apply to revoking and deactivating: a manager cannot strip an owner of their role or deactivate them; **the last administrator of an organization** (the last holder of `roles.manage` organization-wide) cannot be removed, demoted or deactivated, and nobody can deactivate themselves; the checks run under a per-organization advisory lock so two administrators cannot defeat the rule by acting at the same moment. [`rbac.test.ts`: *a manager cannot strip an owner of their role or deactivate them*; *the last administrator cannot be removed, deactivated, or deactivate themselves*]

## 5. How privilege escalation is prevented (summary)

1. Clients cannot write role tables (section 2.3).
2. Granting needs `roles.assign` **and** coverage of every permission in the role (section 3).
3. Revoking and deactivating follow the same coverage rule and the last-administrator rule (section 4).
4. Definer functions pin `search_path`, check permission or organization first, and are not executable by `anon` or `PUBLIC` (`schema-audit.test.ts`); the helper functions `private.*` that policies need are the only ones in `private` executable by users, and a test lists them exactly.
5. Sensitive settings (the idle time-out) cannot be changed without a recorded reason; document numbering cannot be configured so as to issue a duplicate.
6. Column-level grants stop users writing their own `organization_id`, `created_by`, status or approval columns; money and stock tables are read-only to users and written only by checked functions. (`schema-audit.test.ts`)

## 6. Which operations need the service role

Only these. Everything else a signed-in user does runs as `authenticated` under row-level security and the checks above.

- `provision_organization`, `provision_user`, `complete_invitation` (database functions executable only by `service_role`).
- The `invite-user` Edge Function's calls to the authentication admin API (creating the sign-in, sending the invitation, removing it again if the database step fails).
- Applying migrations and the `scripts/apply-*.sql` files (run in the Supabase SQL editor by the project owner).

The service-role key is **never** present in the browser build, the repository or the `.env.example`; it exists in the hosting platform's secret store (and, for the Edge Function, in its secrets). A leaked key would defeat tenant isolation for provisioning, which is why the production checklist keeps it out of Vercel's browser variables.

## 7. How sensitive administrative actions are audited

`audit_logs` is append-only, even for the database owner (a trigger refuses update, delete and truncate); users read it only with `audit.view` and only within their organization (and branch scope). [`audit.test.ts`: *ordinary users (even owners) cannot update, delete or insert audit rows*; *even the table owner / server context cannot rewrite history*]

Recorded, with the actor, the time, the branch where relevant, **only the columns that changed (before and after)** and an optional reason:

| Event | Audit action |
|---|---|
| A person is created or invited | `user.created` |
| A role is granted or revoked | `user_role.created`, `user_role.deleted` (reason supplied by the caller) |
| A user is deactivated or reactivated | `user.deactivated`, `user.activated` |
| Organization profile, branch, warehouse, location changes | `organization.updated`, `branch.*`, `warehouse.*`, `warehouse_location.*` |
| A setting is created, changed or reset to default | `system_setting.created`, `.updated`, `.deleted` (a reason is **required** for sensitive ones) |
| Document numbering is configured | `numbering.configured`, with the previous and new format |
| Accounting started, period closed, manual journals, bank entries | `accounting_settings.*`, `gl_journal.created`, `bank_*` |
| Controlled-drug adjustments requested and decided | `controlled_adjustment.*` |
| Opening balances imported | `opening_receivables.imported`, `opening_payables.imported` |

Rolled-back changes leave no trace and no-op updates are not logged. [`audit.test.ts`: *rolled-back changes leave no audit trace and no-op updates are not logged*]

## 8. Residual risks and how to keep them small

- An `OWNER` can create more `OWNER`s and `SUPER_ADMIN`s: that is by design for a business owner. **Keep the number of holders to two or three** and review them quarterly with `docs/ACCESS_REVIEW.md`.
- A database superuser (the hosting provider's `supabase_admin`) can still disable triggers. This is outside the application's trust boundary; mitigate with the provider's access controls and point-in-time recovery.
- Two-factor sign-in for `OWNER`, `SUPER_ADMIN` and accounts roles is set in the Supabase dashboard (see the production checklist); the application cannot enforce it by itself.
- The idle time-out is a browser-side convenience, not a server-side session rule.
