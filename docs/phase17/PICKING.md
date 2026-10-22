# Phase 17b: picking

Second stage of Advanced Warehouse Operations (see `WAREHOUSE_OPERATIONS_DESIGN.md`). A posted wholesale invoice is released to the warehouse as a **fulfilment order**; its batch allocations become **pick lines** in walking order; a picker claims the order and confirms each line; the order becomes **Picked**.

**Picking records physical work only.** The stock ledger was reduced when the invoice was posted, so release, claim and confirm never create a stock movement and never touch an invoice, price or amount (a test counts the stock movements before and after).

## Workflow

1. **Release.** On a posted invoice, *Release to warehouse* (priority, optional needed-by date, note). Refused for drafts, reversed invoices, invoices with nothing to pick, and an invoice that already has a live order. Counter and till sales are separate documents and never create orders.
2. **Pick list.** One line per allocation, numbered in walking order (picking sequence of the shelf, then earliest expiry). Product, batch, shelf and expected quantity are copied at release and can never change.
3. **Claim.** A picker with the right claims a waiting order (one picker at a time). A supervisor can assign a named picker (only people who can pick at that branch are offered), or work on behalf of the picker. A picker can give an order back.
4. **Confirm each line.** In full, or short (0 up to less than expected). A short line needs a reason (not found, damaged, expired, other with an explanation) and opens an **exception**. Optional scan checks: a typed or scanned batch that does not match the line is refused ("wrong batch"), and a barcode that does not belong to the product is refused.
5. **Done.** The order becomes **Picked** when every line is confirmed and no short pick is waiting. A supervisor either **accepts the short pick** (with a reason; the line stays short and the invoice is untouched, a credit note is raised in the usual way) or **resets the line** so it can be picked again.
6. **Cancel.** An order that has not been packed can be cancelled with a reason (the invoice and stock are unaffected; the invoice can be released again). Reversing an invoice cancels its live order automatically (a trigger, so the reversal function itself is untouched).

## Data and security

- Tables `fulfilment_orders`, `pick_lines`, `fulfilment_exceptions` (migration `20261027000200_picking.sql`, hosted apply script `scripts/apply-phase17b.sql`, one atomic transaction). All carry `organization_id`, composite foreign keys (branch, warehouse, customer, invoice, batch, picker), audit entries, an immutability guard on the identifying columns, and no delete.
- **No write grants at all**: every change is a function that takes the organization from the session and checks the permission for the order's branch: `release_to_warehouse`, `claim_fulfilment_order`, `release_fulfilment_claim`, `assign_picker`, `confirm_pick_line`, `reset_pick_line`, `resolve_short_pick`, `cancel_fulfilment_order`; reads through `fulfilment_queue`, `fulfilment_pick_list`, `picker_options`. Another organization's ids are "not found" everywhere.
- Row-level security by organization and branch on all three tables (`has_permission` / `permitted_branches`, evaluated once per query).
- A line can never claim more than was allocated, and a short line always has a reason (database checks, not only screens). One live order per invoice (partial unique index).

## Permissions

| Right | Roles |
|---|---|
| `fulfilment.view` | Super admin, Owner, General manager, Branch manager, Warehouse manager, Picker, Packer, Dispatcher, Auditor |
| `picking.work` | Super admin, Owner, General manager, Branch manager, Warehouse manager, Picker |
| `picking.assign` (assign, reset, accept short picks) | Super admin, Owner, General manager, Branch manager, Warehouse manager |
| `fulfilment.release` (release, cancel) | the managers above, Dispatcher, Sales manager, Sales rep |

Branch-limited assignments apply: a picker assigned to one branch sees and works only that branch's orders.

## Screens

Warehouse, Picking: the queue (status filter, My tasks, search, priority, progress, short-pick flag, refreshes itself every 30 seconds) and the task screen (location first, large quantity, batch and expiry, optional scan fields, short pick with reason, supervisor actions). The invoice page shows *Release to warehouse* or a link to the live order.

## Tests

`tests/security/picking.test.ts` (15): permissions per role, no direct write grants, release rules, walking order, stock untouched, claim and confirm, quantity/batch/barcode checks, short pick and supervisor resolution, reset, assignment rules, cancel and automatic cancel on reversal, immutability and database checks, audit entries, branch scope, cross-tenant reads and function calls, anonymous access. The tenant sweep, hardening allow-list and schema audit cover the new objects. `tests/e2e/picking.spec.ts` (release, claim, pick, short pick, supervisor accept, cancel, cashier and other-organization access); the queue joined the responsive check.

## Not in this stage

Packing, packages and labels, and second-person verification of controlled medicines (17c). Planning deliveries on a vehicle and driver (17d). Substituting another batch, holding an order, and linking a short pick to a credit note automatically (17e). The "release automatically on posting" setting is not offered yet: release is an explicit action. Order numbers (`FO-`) are generated but are not yet listed in Settings, Document numbering.
