# Phase 12 — Deliveries and picking, stock insights, VAT summary, access review

Migrations: `20261021000100_phase12_permissions`, `…0200_deliveries_insights_vat`. Apply with `scripts/apply-phase12.sql` (one transaction).

## Permissions

| Permission | Meaning | Held by |
|---|---|---|
| `deliveries.view` | see delivery notes and pick lists | owners, managers, reps, cashiers, warehouse roles, dispatcher, accounts manager, auditor, read-only |
| `deliveries.create` | prepare / cancel a delivery note (creates the pick list) | owners, sales/branch/warehouse managers, pickers, packers |
| `deliveries.dispatch` | dispatch, confirm delivery, record a failed delivery | owners, branch/warehouse managers, dispatcher |
| `reports.stock` | stock insight reports | owners, sales/branch/warehouse/procurement managers, procurement officer, auditor, read-only |
| `reports.tax` | the VAT summary | owners, accounts manager and officer, auditor |

## Deliveries and picking (Sales → Deliveries)

Stock leaves the warehouse when an invoice is posted; the **delivery note** is the physical side. On a posted invoice choose **Prepare delivery** (address, who to ask for, phone, packages, notes for the driver). The note carries the **pick list**: for every batch the invoice actually picked — the **location**, batch, expiry date and quantity — in walking order (the locations' picking sequence, then earliest expiry). Print it, or download it as a PDF.

`PREPARED (to dispatch) → DISPATCHED (on the road, with driver and vehicle) → DELIVERED (with the name of the person who received it: proof of delivery)`, or `FAILED` (shop closed, refused …) or `CANCELLED` (before dispatch). One live note per invoice; after a failed or cancelled one a new one can be prepared. Reversing an invoice **cancels a prepared note** and is **refused once the goods have left**: take them back with a credit note instead. Delivered, failed and cancelled notes cannot be changed. The dashboard counts deliveries to dispatch and on the road.

## Stock insights (Reports → Stock insights)

All estimates from recent sales; each can be exported to CSV or PDF.
- **Reorder suggestions**: per product the average daily sales over the chosen history, stock free after reservations, what is already on order (approved and part-received purchase orders), the preferred supplier's lead time (7 days if none), and **how much to buy** so that stock covers the chosen number of days after it arrives. Products that have not sold are not listed.
- **Slow-moving stock**: sellable stock that has not sold for N days (or ever), with the value tied up where the viewer is allowed to see costs.
- **Likely to expire**: batches expiring within the horizon that will probably not sell in time, assuming the product keeps selling at its recent pace and earliest-expiry stock goes first, with the value at risk.

## VAT summary (Reports → VAT summary)

For a period and branch: **output VAT** per tax code from posted invoices net of posted credit notes, **input VAT** from approved or paid supplier invoices, and the net payable or refundable. It is a working summary for the VAT return. It is **not** an integration with the Ghana Revenue Authority: that needs the authority's specification and credentials (see below).

## Access review (`docs/ACCESS_REVIEW.md`)

Generated from the database by `node scripts/role-matrix.mjs` (run `node scripts/db-test.mjs --migrate-only` first): every built-in role with its permissions, a role × permission table, who holds each sensitive right, and a **separation-of-duties check** listing roles that hold both halves of a pairing that normally needs two people. Findings from the current matrix, for you to decide on (nothing was changed):

1. **Accounts manager can run the whole supplier-payment cycle alone** (record, approve and pay a supplier invoice) **and** take, void and refund customer money and override credit limits. Fine for a one-person finance function; if you employ an accounts officer, give the officer the recording (`payables.create`, which the role already has) and keep approving and paying with the manager only.
2. **Branch manager takes money and can pay it back** (`receipts.create` + `refunds.create`) and drafts and posts credit notes. A cashier-level person should take payments; consider removing `refunds.create` from branch managers who also handle cash.
3. **Procurement manager raises and approves purchase orders.** Acceptable for a small team; with two buyers, approve orders with someone else.
4. **Warehouse manager can adjust stock and read the controlled-drugs register.** Adjustments of controlled medicines have no second approval yet. A later phase could require a pharmacist's sign-off for them.
5. **Cashier holds `sales.post`** (needed for counter sales) but no discount or price-override right: as intended.
6. Only owner, general manager and super admin can invite users or assign roles.
7. Only the owner roles and the accounts manager can reverse invoices and credit notes.

## Not built, and why

- **GRA e-VAT / tax-authority integration**: needs the authority's API specification, credentials and approval; guessing could issue invalid tax invoices. Send the specification and test credentials when you have them.
- **Accounting ledger, trial balance and bank reconciliation**: they depend on your accountant's chart of accounts and posting rules, and wrong rules would put wrong numbers in your books. Agree the chart first.
- **Customer ordering portal**: outside users need their own sign-in and strict isolation to their own account; that deserves a deliberate design.
