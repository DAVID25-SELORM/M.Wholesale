# Phase 4 — Costing, purchase returns, stock counts, supplier invoices and payables

Migrations: `20261013000100_phase4_permissions`, `…0200_costing`, `…0300_purchase_returns`, `…0400_supplier_invoices`, `…0500_stock_counts`.
**Not in this phase (next):** in-transit transfers, Excel import, reservations (arrive with sales), a payments ledger / general ledger (finance phase).

## Costing and valuation

* `batch_costs` holds what a batch cost **per base unit**. It is written once, when a batch is created — by a goods receipt (the order's price),
  by opening stock, or by an adjustment that carries a cost. Topping up an existing batch never changes its cost. The table is append-only.
* Cost is kept apart from `batches` so it is visible only with **`inventory.valuation`** (owner, general manager, accounts, auditor, procurement manager),
  while everyone who can see stock still sees batches.
* **Stock valuation** (`/inventory/valuation`, CSV export): good stock (AVAILABLE + QUARANTINE) × batch cost. Damaged and expired stock carries no value.
  Stock whose batch has no cost is reported as **uncosted** rather than silently valued at zero, with a banner.

## Purchase returns

`post_purchase_return()` takes goods out of stock (ledger document `RETURN`, movement `RETURN_OUT`) and records the return in one transaction:
the supplier, the exact batch / location / status, the reason, a **cost snapshot** and the **expected credit**. Needs `purchasing.receive` for the warehouse.
When the supplier's credit note arrives, `record_return_credit()` (needs `payables.create`) stores its number and amount — once. Returns and lines are immutable.

## Supplier invoices and the 3-way match

Order (what was agreed) ↔ goods received (what arrived) ↔ invoice (what is billed). For every line, when the invoice is recorded **and again at approval**:

| Check | Rule |
|---|---|
| Quantity | invoiced ≤ received − what other live invoices already bill for that line |
| Price | invoiced price within **1 %** of the order price |

Result per line: `MATCHED`, `QTY_OVER`, `PRICE_DIFF` or `QTY_AND_PRICE`. A fully matching invoice is **MATCHED**; otherwise **EXCEPTION**.
`MATCHED | EXCEPTION → APPROVED → PAID`, and `CANCELLED` (frees the quantities). An exception can still be approved, but **only with a stated reason**, kept on the invoice and in the audit log.

* Recording locks the purchase order, so racing invoices for the same goods are processed one at a time (tested: three invoices of 6 against 10 received → exactly one matches).
* A supplier invoice number cannot be booked twice for the same supplier (a cancelled one may be re-entered).
* **Separation of duties:** the person who recorded an invoice cannot approve it unless nobody else holds `payables.approve` for that branch.
* `PAID` records the date and the payment reference; **actual payments are not modelled yet** (no bank/cash ledger — that belongs to finance).
* **Payables** (`/purchasing/payables`): per supplier, approved-and-unpaid by age (not due, 1–30, 31–60, 61–90, over 90), invoices awaiting approval, and credit still expected from returns.
* Amounts are in the order currency; tax is a single amount per invoice (no tax engine yet).

## Stock counts (cycle counts)

`start_stock_count` snapshots the system quantities for a warehouse (optionally one location, up to 5,000 lines). People enter counted quantities, **submit**, and a
second person **approves**; approval posts **one** `ADJUSTMENT` (reason `COUNT_VARIANCE`) for the differences. Variance = counted − the snapshot, applied to the stock *as it is at approval*, so movements
during the count are not lost; if the stock can no longer absorb a negative variance, approval fails and nothing changes. Lines nobody counted are left alone. A submitted count can be sent back; open or submitted counts can be cancelled — both with a reason.
Approval does not need `inventory.adjust`: the count's own approval permission is the authority. Counters can see the system quantity in the database; a *blind* count is a UI concern for later.

## Permissions

| Permission | Granted to |
|---|---|
| `inventory.valuation` | OWNER, SUPER_ADMIN, GENERAL_MANAGER, PROCUREMENT_MANAGER, ACCOUNTS_*, AUDITOR |
| `inventory.count` | OWNER, SUPER_ADMIN, GENERAL_MANAGER, WAREHOUSE_MANAGER, WAREHOUSE_PICKER, PHARMACIST |
| `inventory.count_approve` | OWNER, SUPER_ADMIN, GENERAL_MANAGER, BRANCH_MANAGER |
| `payables.view` | owner/management, accounts, procurement, auditor, read-only |
| `payables.create` | owner/management, ACCOUNTS_*, PROCUREMENT_* |
| `payables.approve` / `payables.pay` | OWNER, SUPER_ADMIN, GENERAL_MANAGER, ACCOUNTS_MANAGER |

All are branch-scoped by the warehouse / order they concern (organization-wide grants cover everything), except cost visibility, which is organization-wide.

## UI

Warehouse → **Stock counts**, **Stock valuation**; Purchasing → **Purchase returns**, **Supplier invoices**, **Payables**.
The **dashboard** now shows real work: orders, invoices and counts waiting for *you*, returns awaiting a credit note, products in stock and how many batches are expired-but-sellable or expiring within 30 / 90 days.
The opening-stock and adjustment dialogs take an optional **cost per pack** for new batches. Stock documents now list receipts and returns too.
