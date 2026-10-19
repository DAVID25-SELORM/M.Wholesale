# Phase 17a: delivery fleet (drivers and vehicles)

First stage of Advanced Warehouse Operations (see `WAREHOUSE_OPERATIONS_DESIGN.md`). It adds the records that delivery runs (stage 17d) will be planned on. Nothing here moves stock or touches an invoice.

## What was added

- **Tables** `drivers` and `vehicles` (migration `20261027000100_fleet.sql`, hosted apply script `scripts/apply-phase17a.sql`, one atomic transaction).
  - Both carry `organization_id` (filled from the session, never writable), a required `branch_id` through a composite foreign key to `branches (id, organization_id)`, audit entries (`driver.*`, `vehicle.*`), automatic `updated_at`, and a guard that refuses deletion. A driver or vehicle that is no longer used is deactivated.
  - Drivers: code (unique per organization), name, phone, licence number, class and expiry, optional `profile_id` (the driver's own sign-in; composite foreign key so it can only be someone in the same organization, and one driver record per sign-in), notes, active.
  - Vehicles: registration number normalised by a trigger to capitals without spaces and unique per organization (the same plate may exist in another organization), type, capacity in packages and kilograms, refrigerated, insurance and roadworthy expiry, notes, active.
- **Permissions** `fleet.view` and `fleet.manage`. View: Super admin, Owner, General manager, Branch manager, Dispatcher, Warehouse manager, Auditor. Manage: Super admin, Owner, General manager, Branch manager, Dispatcher. Branch-limited assignments apply, so a branch manager manages only their own branch.
- **Security**: row-level security by organization and by branch (`has_permission` / `permitted_branches`, evaluated once per query), column-limited grants, no delete privilege.
- **Setting** `fleet.expiry_warning_days` (default 30, 1 to 365) in the validated settings registry; the `fleet` category was added to the settings category check. Shown under Settings, Delivery.
- **Screens**: Delivery, Drivers and Delivery, Vehicles with search, status filter, sorting, paging, expiry badges (Valid, Expiring soon, Expired, Not recorded) and a side form. Read-only roles see the details but no buttons.

## Tests

- `tests/security/fleet.test.ts`: permissions per role, validation, registration normalisation, duplicates within and across organizations, branch scope, cross-organization branch and sign-in links refused, one driver per sign-in, organization spoofing refused, no delete, audit entries, cross-tenant read and write, anonymous access, the setting.
- The tenant sweep and schema audit pick the new tables up automatically (the audit's allow-list of directly editable tables gained `drivers` and `vehicles`).
- `tests/unit/fleet.test.ts` (expiry states, form rules) and `tests/e2e/fleet.spec.ts` (create, badges, validation, deactivate, setting, unauthorized access); both pages joined the responsive check at five screen widths.

## Not in this stage

Nothing yet refuses an expired licence or insurance date: that rule is enforced where a driver or vehicle is assigned to a run (17d). Linking a driver to a sign-in is supported by the database; the screen for it arrives with the driver's own view of their runs (17d). The separation-of-duties pairing `fleet.manage` / `runs.manage` is added to the access review when `runs.manage` exists.
