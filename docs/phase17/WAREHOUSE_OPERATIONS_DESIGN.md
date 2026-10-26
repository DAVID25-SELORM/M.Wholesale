# Advanced Warehouse Operations: design and staged implementation

Implementation update: fleet, picking, packing, delivery runs and fulfilment exceptions are deployed. Packing, delivery runs and exceptions are described in [PACKING_DISPATCH.md](PACKING_DISPATCH.md), [DELIVERY_RUNS.md](DELIVERY_RUNS.md) and [EXCEPTIONS.md](EXCEPTIONS.md). Follow-up migrations expose substitution options and display the actual substituted batch in pick lists.

Scope: separate **picking**, **packing**, **dispatch**, **delivery runs**, **drivers** and **vehicles**, on top of what already exists. This document is the plan to approve or change before any code is written.

## 1. What exists today (the starting point)

- A posted invoice has already chosen its batches (first-expiry-first) and locations: `sales_invoice_allocations` holds product, batch, **location** and base quantity. The stock ledger is reduced **when the invoice is posted**.
- `delivery_notes` (one live note per invoice) have the status path PREPARED → DISPATCHED → DELIVERED / FAILED / CANCELLED, with driver and vehicle as **free text**, a package count, proof of delivery as the receiver's **name**, and a **pick list** function that walks the allocations in picking-sequence order.
- Locations carry `picking_sequence` (aisle, rack, shelf, bin). Roles `WAREHOUSE_PICKER`, `WAREHOUSE_PACKER`, `DISPATCHER` and `DRIVER` exist, but picker and packer hold only the generic `deliveries.create`, and `DRIVER` holds nothing useful.
- The navigation already reserves *Picking, Packing, Dispatch, Delivery runs, Drivers, Vehicles* as "Soon".

What is missing: pick work as a tracked task with an owner and exceptions; packing as a step with packages and checking; planning several deliveries onto one vehicle and driver; driver and vehicle records with licence and roadworthiness control.

## 2. Principles (non-negotiable, as for every module)

1. **Multi-tenant from the first table.** Every new table has `organization_id`, composite foreign keys `(id, organization_id)`, row-level security scoped by organization and, through the warehouse, by branch. Every function takes the organization from the session, never from an argument. The cross-tenant sweep (`tests/security/tenant-sweep.test.ts`) picks the new tables and functions up automatically, and each stage adds its own cross-tenant tests.
2. **The database is the authority.** Stage changes happen only in checked functions; users have no direct write grants on the workflow tables; every transition is audited.
3. **Stock integrity.** Picking, packing and delivery do not create stock movements, because the ledger was already reduced at posting. The only ledger effect in this module is a **batch substitution** (section 6), done by a normal posted stock document.
4. **Append-only evidence.** Pick confirmations, package contents and delivery proofs are never edited; a correction is a new record.

## 3. The workflow

```
Posted invoice ──release──▶ FULFILMENT ORDER (RELEASED)
                               │ pick list(s): allocation lines in walking order
                               ▼
                        PICKING ──▶ PICKED ──▶ PACKING ──▶ PACKED ──▶ READY TO SHIP
                                                                           │ planned onto a
                                                                           ▼
                                    DELIVERY RUN (PLANNED → LOADING → ON ROAD → COMPLETED)
                                       stops = delivery notes: DELIVERED / FAILED
```

- **Release.** A posted invoice becomes a fulfilment order automatically when the branch uses fulfilment (a setting), or by an explicit *Release to warehouse* action. **Counter and till sales never create one** (the goods leave in the customer's hand).
- **Picking.** The pick list is the invoice's allocations ordered by `picking_sequence`. A picker (or a supervisor on their behalf) claims a task, confirms each line by quantity, and may scan the product barcode and read the batch to confirm (a wrong batch is refused). A line can be picked in full, short (with a reason: not found, damaged, expired), or flagged for a **batch substitution** (section 6). Pick lines are append-only confirmations.
- **Packing.** Picked goods are put into **packages** (carton, bag, cool box). Each package has a number and label, lists its contents, and carries flags (cold chain, fragile). The packer checks every picked quantity into exactly one package; the order cannot become PACKED with anything left over or over-packed. The package count flows into the delivery note. Packing can be switched off per branch for small orders (`require packing` setting): PICKED then goes straight to READY.
- **Controlled medicines.** A pick or pack that contains a controlled medicine needs a **second person** to verify (the picker cannot verify their own lines), mirroring the second-person rule for controlled adjustments. The verification is recorded and appears in the controlled-drugs register's reference.
- **Delivery runs.** A dispatcher plans a run for a date: chooses a **vehicle** and a **driver**, adds ready delivery notes as **stops** in route order (manually ordered, a drag-to-reorder list), sees the load against the vehicle's capacity, and prints the **run sheet** (stops, addresses, contacts, packages, amounts due). *Loading*: packages are checked onto the vehicle (scan or tick). *On road*: the run is dispatched (this dispatches every delivery note on it in one step, using the existing dispatch rules). Each stop is then marked **delivered** (receiver's name, time, notes) or **failed** (reason). A run completes when every stop is delivered or failed; failed goods come back to the warehouse (*returned* check-in) and the invoice can be redelivered on a later run or settled with a credit note (existing flows).
- **Drivers and vehicles.** See section 4. A run cannot be created or dispatched with an inactive driver or vehicle, an expired driving licence, or an expired insurance or roadworthiness date.

## 4. Data model (new tables; all tenant-scoped, none editable directly by users)

| Table | Purpose | Key rules |
|---|---|---|
| `drivers` | name, phone, licence number and expiry, branch, active, optional link to a sign-in (`profile_id`) | licence expiry checked at assignment; one driver per sign-in |
| `vehicles` | registration number (unique per organization), type, capacity (packages, kilograms), refrigerated, insurance and roadworthy expiry, branch, active | expiry checked at assignment |
| `fulfilment_orders` | one per released invoice: status, priority, required-by, picker, packer, released/picked/packed times | one live order per invoice; cancelled automatically if the invoice is reversed before dispatch |
| `pick_lines` | one per allocation: expected and picked quantity, picked batch and location, short reason, picked by and when, verified by | append-only confirmations; quantity never exceeds the allocation |
| `fulfilment_exceptions` | short picks and substitution requests awaiting a supervisor | resolved once, with a reason |
| `packages` and `package_lines` | package number, label text, flags; contents per product and batch | contents must reconcile to the pick lines |
| `delivery_runs` | run number, date, branch, vehicle, driver, status, loading and dispatch times | one active run per vehicle and per driver at a time |
| `delivery_run_stops` | run, delivery note, route order, stop outcome | a delivery note is on at most one active run |
| `delivery_notes` (existing) | gains `fulfilment_order_id`, `driver_id`, `vehicle_id`; the old text columns stay for history | existing flows keep working |

Numbering uses the existing document-number mechanism (new types for fulfilment orders, packages and runs, configurable in Settings).

## 5. Permissions and roles

New rights (stable codes): `fulfilment.view`, `picking.work`, `picking.assign` (assign, prioritise, resolve exceptions), `packing.work`, `runs.view`, `runs.manage` (plan, load, dispatch, complete), `fleet.view`, `fleet.manage` (drivers and vehicles).

| Role | Gets |
|---|---|
| Warehouse picker | `fulfilment.view`, `picking.work` |
| Warehouse packer | `fulfilment.view`, `packing.work` |
| Warehouse manager | everything above plus `picking.assign`, `fleet.view` |
| Dispatcher | `fulfilment.view`, `runs.view`, `runs.manage`, `fleet.view`, `fleet.manage` |
| Driver | `runs.view` for **their own runs only** (enforced in the database through the driver's sign-in link), and marking their own stops |
| Owners, general manager | all |

Separation of duties added to the access review: the person who picks a controlled line cannot verify it; `fleet.manage` is separate from `runs.manage` so the person who plans runs cannot silently change a driver's licence date. Branch-limited staff see only their branch's work (through the warehouse's branch).

## 6. The hard problem: short picks and batch substitution

The invoice already chose batch X, and the ledger already deducted X. If the picker cannot find X, there are three outcomes, each recorded as a **fulfilment exception** that only someone with `picking.assign` resolves:

1. **Substitute another batch of the same product.** The ledger is corrected by a normal posted stock document (put X back, take Y out), pick line records Y, and the invoice's allocation evidence is not rewritten: the substitution is its own record linked to both. Expiry rules still apply (the substitute must satisfy the customer's minimum shelf life and not be quarantined or expired), and a controlled product needs the second-person approval already built for controlled adjustments.
2. **Ship short and credit.** The line is closed short; the supervisor raises a credit note for the difference through the existing credit-note flow, and the unpicked stock stays on the shelf (the credit note's restock puts it back in the ledger).
3. **Hold the order.** The fulfilment order waits for stock (for example a late receipt).

This is the riskiest part of the module, so it is its own stage with its own tests.

## 7. Interaction with stock counts

Between posting and picking, the shelf holds more than the ledger says (the goods are allocated but not yet taken). A stock count in that window would show a false surplus. Plan: the count screen shows an **awaiting pick** column per batch, and the expected quantity used for variances includes it, so counts stay honest while orders are in flight.

## 8. Screens (Warehouse and Delivery menus)

- **Picking:** the queue (priority, required-by, customer, lines), *My tasks*, and a task screen built for a phone or handheld: big quantity steppers, scan field, location shown first, "short" with reason. Pick list and packing list as print or PDF.
- **Packing:** orders waiting to pack, add packages, scan or tick contents, print package labels (with a barcode of the package number), seal.
- **Dispatch / ready to ship:** the board of packed deliveries by area or customer.
- **Delivery runs:** planner (vehicle, driver, stops in order, capacity bar), loading checklist, run sheet PDF, live status of stops.
- **Drivers** and **Vehicles:** the records, with expiry badges (valid, expiring in 30 days, expired).
- **My deliveries** (drivers with a sign-in): their runs and stops on a phone, marking delivered or failed.
- Dashboard counts: waiting to pick, waiting to pack, ready to ship, on the road. Reports: pick and pack times per person, short-pick rate by product, on-time delivery by driver.

## 9. Settings added (through the validated settings registry)

`fulfilment.auto_release` (per branch, default off until you choose), `fulfilment.require_packing` (default on), `fulfilment.require_controlled_verification` (default on, cannot be turned off for controlled medicines), `runs.licence_warning_days` (default 30).

## 10. Build plan: five stages, each complete and tested before the next

| Stage | Delivers | Tests added |
|---|---|---|
| 17a Fleet | drivers and vehicles, expiry control, permissions, roles, settings, the two screens | database (rules, expiry, permissions), tenant sweep, cross-tenant, unit, e2e |
| 17b Picking | fulfilment orders, release, pick lists, task screen, short flag, queue and My tasks | stock never changes on pick, one live order per invoice, reversal cancels, branch scope, cross-tenant, e2e |
| 17c Packing | packages, labels, reconciliation, controlled-medicine verification, packing list | reconciliation, second-person rule, cross-tenant, e2e |
| 17d Runs | delivery runs and stops, loading, dispatch, stop outcomes, run sheet, driver view | one active run per vehicle/driver, capacity, expiry blocks, driver sees only own runs, cross-tenant, e2e |
| 17e Exceptions | substitution with ledger correction, ship-short, hold, count interplay | ledger balances after substitution, expiry and shelf-life rules, controlled approval, cross-tenant |

Every stage ends with the full regression (database, frontend, end-to-end, typecheck, lint, build), a probe of the hosted database after you apply its migration, and nothing is committed until you say so. Each stage ships separately, so you can use fleet records and picking before packing and runs exist.

## 11. Decisions (settled)

1. **Where picking starts: the posted invoice.** Batches are already chosen and the ledger already reduced at posting; picking tracks the physical work. Picking from a confirmed order stays a possible later phase.
2. **Drivers: sign-in is optional.** A driver with a sign-in sees only their own runs on a phone and marks their own stops; other drivers are records, and the dispatcher marks their stops.
3. **Proof of delivery: receiver's name, time and notes** now, tied to runs. Signature or photo comes later with tenant-scoped file storage.
4. **Batch substitution and short-pick handling are in the first release,** as stage 17e (substitute with ledger correction, ship short with a credit note, or hold the order).

Status: fleet, picking, packing and delivery runs are deployed. Advanced exceptions (17e) are implemented locally pending release. The phase-specific documents record implementation scope and verification evidence.
