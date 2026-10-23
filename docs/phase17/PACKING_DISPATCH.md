# Packing and dispatch

Migration: `20261027000300_packing_dispatch.sql`, after the picking migration.

## Workflow

1. Finish picking and resolve short picks. Open the order from **Warehouse → Packing**.
2. Start packing. Add cartons, bags or cool boxes with cold-chain/fragile labels.
3. Confirm quantities into packages. The database refuses excess quantities, foreign orders and more than three decimal places.
4. Correct an unverified package by voiding it with a reason and repacking. Its original contents remain in the audit record.
5. A supervisor verifies controlled lines after packing. The verifier must be different from both the picker and everyone who packed the line. Verified contents are frozen.
6. Seal packing. Every picked quantity must reconcile exactly and every live package must contain goods.
7. **Warehouse → Dispatch** lists packed orders still awaiting dispatch. Prepare a delivery note with the actual package count, then open it to assign the driver and vehicle and dispatch. Existing delivery screens record delivered/failed outcomes and receiver details.

Existing delivery notes prepared before packing can still be used. Dispatch checks packing and replaces their package count with the sealed count. Invoices never released into fulfilment retain their existing direct delivery workflow. This is an explicit compatibility exception, not a tenant exception.

## Isolation and integrity

All three new tables have organization and branch RLS, immutable ownership, composite order/tenant/branch references and no direct application writes. RPCs resolve the tenant from the session and check branch permissions. Package contents and verification evidence are append-only. All changes are audited. No packing or dispatch command posts stock or financial entries.

Warehouse access follows the application's existing warehouse-to-branch model; this phase does not add individual warehouse assignments within a branch. Platform provisioning rights are unchanged. Global permission definitions and system role templates remain the existing shared-reference exception.

Tests in `tests/security/picking.test.ts` cover reconciliation, corrections, independent verification, legacy dispatch enforcement, stock neutrality, anonymous denial, cross-order references, foreign tenants and inaccessible branches. The automatic tenant sweep includes the new tables and dispatch report.

## Release

Apply the new migration once before deploying these screens. Refresh the signed-in session to load the new packing permissions. Do not rerun the already applied picking migration. Check packing and delivery using an isolated test organization before operational use.

This delivers packing and dispatch through the existing delivery-note workflow. Multi-stop delivery runs, fleet scheduling and loading scans remain phase 17d; batch substitutions and stock-count treatment remain phase 17e. Neither is implied by a successful deployment of this migration.

## Local verification

- Fresh migration application and tenant sweep: passed (8 sweep checks).
- Picking, packing, dispatch, concurrent packing and isolation tests: 20 passed.
- Existing phase 12 delivery/report regression tests: 8 passed.
- Packing/dispatch screen tests: 4 passed.
- TypeScript, production build and lint of changed application files: passed. Build retains the existing large-bundle warning.
- Hosted migration application and signed-in packing workflow: pending deployment; local results do not establish hosted production readiness.
