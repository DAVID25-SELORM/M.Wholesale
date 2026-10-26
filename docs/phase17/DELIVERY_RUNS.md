# Phase 17d: delivery runs

Apply `20261027000400_delivery_runs.sql` after the packing migration, then deploy the frontend and refresh the signed-in session.

## Workflow

1. Maintain branch drivers and vehicles. A driver needs a licence number and expiry; a vehicle needs insurance and roadworthiness expiry, package capacity and kilogram capacity.
2. Open **Delivery → Delivery runs**, choose a branch, date, driver and vehicle. A driver or vehicle can have only one active run, including a planned run.
3. Add prepared delivery notes whose fulfilment orders have sealed packages. Enter the measured weight for each stop. Package counts and cold-chain requirements come from packing records. Move stops up/down into route order.
4. Start loading, physically check every stop's packages onto the vehicle, and enter the counted total. Dispatch rechecks expiry, capacity, refrigeration, invoice and delivery status in one transaction.
5. The dispatcher or assigned driver records delivery with a receiver name, or failure with a reason. All stop outcomes complete the run automatically.
6. Confirm failed goods returned before adding a replacement delivery to another run. This physical check-in does not restock the ledger; a credit note or redelivery follows the existing process.

The run sheet includes addresses, contacts, handling instructions, package counts, weights and current invoice amounts due. **Print run sheet / Save PDF** uses the browser print dialog. Reordering uses accessible up/down controls.

## Driver access

An administrator with both fleet management and role-assignment permission can edit an existing driver and save a sign-in link. Assign that user the **Driver** role for the appropriate branch through staff administration. A driver sees and updates only runs assigned to that driver record; an auditor has read-only branch access. Unlinking or deactivating the driver removes driver access, including historical runs. Dispatchers can record outcomes for drivers without sign-ins.

Driver sign-in links are no longer directly writable through the table API. Linking never grants roles automatically. Do not link a staff account without reviewing the resulting delivery-data access.

## Security and integrity

- Organization IDs come from authenticated sessions, never RPC arguments.
- Both run tables have RLS, composite organization/branch references, immutable ownership, no direct application writes, no deletes, and audit triggers.
- Fleet records must belong to the run branch. Unique indexes prevent competing active driver/vehicle assignments and duplicate delivery-note assignment.
- All workflow mutations lock the run; dispatch locks invoices first in a stable order before run and delivery locks.
- Driver reads use a server-side identity check; exported run sheets use the same scoped data.
- Legacy delivery actions cannot dispatch, cancel or complete an attached note outside its run workflow. Remove a planned stop or cancel its run before cancelling/reversing that delivery.
- These operations do not create stock movements, payments or accounting entries.
- Warehouse authorization continues to follow the existing branch-based model. Shared permission definitions and system role templates remain the existing global-reference exception.

## Scope

This phase uses counted loading confirmation per stop, manually measured weights, receiver-name proof and browser-print run sheets. It does not add GPS tracking, signatures/photos, barcode loading scans, automated routing or collection of payments. Full substitution/hold/stock-count handling remains phase 17e.

## Release status

Implementation and local validation are in progress. Do not treat this file as evidence that the hosted migration has been applied or that real delivery workflows have been tested.
