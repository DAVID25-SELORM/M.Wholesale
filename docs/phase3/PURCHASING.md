# Phase 3 — Purchasing: purchase orders, approval and goods received

Migrations: `20261012000100_purchasing_permissions`, `20261012000200_purchasing`.
Scope: ordering from suppliers with an approval step, and receiving the goods into the stock ledger.
**Not in this phase:** purchase requisitions and supplier quotations, supplier invoices and 3-way match, purchase returns,
supplier ledger / payments, tax (VAT, levies), receiving without an order, over-delivery tolerance.

## Lifecycle

```
DRAFT ──submit──▶ SUBMITTED ──approve──▶ APPROVED ──receive──▶ PARTIALLY_RECEIVED ──receive──▶ RECEIVED
  ▲                  │ send back (reason)      │                      │ close short (reason)
  └──────────────────┘                         └─ cancel (reason)      └──▶ CLOSED          (CANCELLED from DRAFT / SUBMITTED / APPROVED)
```

* Orders and lines are written **only** by database functions (`save_purchase_order`, `submit_…`, `approve_…`, `reject_…`,
  `cancel_…`, `close_…`, `receive_goods`); clients have SELECT only. Every status change is audited with the actor and the reason.
* Only a **DRAFT** can be edited; saving replaces its lines. Costs are **per pack, before tax**, in the supplier's currency
  (or the organization's), with the supplier's payment terms as default.
* **Separation of duties:** whoever prepared an order cannot approve it, unless nobody else holds `purchasing.approve`
  for that branch (so a one-person company is not stuck).
* **Supplier checks at approval:** an inactive supplier, or one whose regulatory **licence has expired**, cannot be ordered from.
* Cancelling is refused once goods have arrived; use **Close short** for a part-delivered order the supplier will not complete.

## Receiving goods

`receive_goods(order, lines, delivery_note, notes)` runs in one transaction:

1. checks `purchasing.receive` for the order's branch and that the order is APPROVED / PARTIALLY_RECEIVED;
2. validates each line against what is still expected (**over-receipt is refused**; amend the order instead) and locks lines in a fixed order;
3. posts a `RECEIPT` document to the **stock ledger** through the same engine as every other stock posting
   (batch + expiry required for batch-tracked products; pack quantities converted to base units);
4. records an immutable **goods receipt** (`GRN-<year>-<n>`) with one line per batch, including cost per base unit;
5. moves the order to PARTIALLY_RECEIVED or RECEIVED.

Doubtful goods can be received straight into **QUARANTINE** or **DAMAGED**; expired goods can never be received as AVAILABLE.
One order line can be split over several batches, and goods can be received in a different pack level from the one ordered.
A rejected line rolls back the whole receipt (tested). Two simultaneous full receipts: exactly one succeeds (tested).

The ledger engine was moved to `private.post_stock()`; `public.post_stock_document()` is a thin wrapper that refuses
`RECEIPT`, so nobody can fake a goods receipt through the inventory API.

## Permissions (branch-scoped by the delivery warehouse's branch)

| Permission | Granted to |
|---|---|
| `purchasing.view` | all purchasing, warehouse, accounts, audit and read-only roles; PHARMACIST; BRANCH_MANAGER |
| `purchasing.create` | OWNER, SUPER_ADMIN, GENERAL_MANAGER, PROCUREMENT_MANAGER / OFFICER, BRANCH_MANAGER |
| `purchasing.approve` | OWNER, SUPER_ADMIN, GENERAL_MANAGER, PROCUREMENT_MANAGER |
| `purchasing.receive` | OWNER, SUPER_ADMIN, GENERAL_MANAGER, WAREHOUSE_MANAGER |

## UI

* **Purchasing → Purchase orders:** list with status / supplier filters; new order form pre-fills pack level and cost from the supplier's price list.
* **Order page:** header, lines (ordered / received / expected), goods received, and only the actions your role and the order's status allow.
* **Receive goods dialog:** per line quantity, pack level, condition, batch, expiry, location; "another batch of this product".
* **Purchasing → Goods received:** every receipt; click for its lines. Receipts also appear as "Goods received" in Stock documents.

## Next

Supplier invoices with 3-way match (order ↔ receipt ↔ invoice), purchase returns for damaged / wrong goods (a receipt in DAMAGED status is the evidence),
and the supplier ledger belong to the finance phase and will read these tables.
