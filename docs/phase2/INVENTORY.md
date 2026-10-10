# Phase 2 — Inventory core: batches, stock ledger, balances, expiry

Migrations: `20261011000100_inventory_permissions`, `20261011000200_inventory`.
Scope: where stock is, in which batch, in which status, and a trustworthy history of how it got there.
**Not in this phase:** purchasing (PO / GRN), sales, reservations, stock counts, valuation / costing, in-transit transfers.

## Model

```
batches          one per (product, batch number)   expiry date lives here
stock_documents  one numbered posting               OPN-/ADJ-/TRF-/STS-<year>-<n>
stock_movements  THE LEDGER: signed lines, append-only, never edited or deleted
stock_balances   current quantity per (warehouse, location, product, batch, status) - derived, written only by the posting function
```

* **Quantities are base units.** Users may type packs (2 boxes of 14); `post_stock_document` converts with
  `product_units.factor_to_base` and records what was typed (`entered_unit_id`, `entered_quantity`) for traceability.
* **Statuses:** `AVAILABLE` (sellable), `QUARANTINE`, `DAMAGED`, `EXPIRED`. Moving stock between statuses is a *status change*
  document, so every hold, release and write-off is on the ledger.
* **Batches** are per product, case-insensitive (`ab-1` = `AB-1 `), and an existing batch cannot be re-declared with another
  expiry date. Batch number, expiry and manufacture date are immutable. Products with `track_batches = false` hold stock with no batch.
* **Expired stock can never become sellable:** loading it, adjusting it in, or releasing it to `AVAILABLE` is rejected.
  Stock that *becomes* expired while AVAILABLE is shown in red on Stock/Expiry until someone moves it out.
* **No negative stock**, ever: a friendly pre-check (`insufficient stock: SKU batch X [AVAILABLE] has 8 available, 9 requested`)
  and a `CHECK (quantity >= 0)` as the backstop.

## One writer

Clients have **SELECT only** on the four tables. Everything is posted through `public.post_stock_document(type, warehouse, lines, to_warehouse, reason, notes)`:

| Type | Permission | What it does |
|---|---|---|
| `OPENING` | `inventory.opening_stock` | load starting balances; creates batches |
| `ADJUSTMENT` | `inventory.adjust` | IN (found / count up) or OUT (loss / damage / count down); **reason required** |
| `TRANSFER` | `inventory.transfer` | OUT of one warehouse, IN to another in the same document; batch and status travel; instant (no in-transit yet) |
| `STATUS_CHANGE` | `inventory.quarantine` | quarantine, release, damaged, expired; may also move location |

Each call is **all-or-nothing** (one transaction): document number, batches, ledger lines, balances and the audit entry commit together or not at all.
Balances are applied in a fixed key order and negative results are rejected, so concurrent postings cannot deadlock or oversell
(tested: 20 racing decrements against a stock of 10 succeed exactly 10 times).

**Invariant, tested:** for every balance, `sum(ledger lines) = stored quantity`.

## Permissions and scope

Inventory is **branch-scoped**: a warehouse belongs to a branch, and a permission only covers the warehouses of branches it was granted for
(organization-wide grants cover all). Reads (`inventory.view`) and every posting check the *source warehouse's* branch.
A branch-scoped manager can neither see nor move stock of another branch. Batches are organization-level (readable with `inventory.view` anywhere).

| Role | Gets |
|---|---|
| OWNER, SUPER_ADMIN, GENERAL_MANAGER, WAREHOUSE_MANAGER | all five |
| BRANCH_MANAGER | view, transfer |
| PHARMACIST | view, quarantine |
| every other operational / read-only role | view |

## Reads (SECURITY INVOKER, so RLS applies)

* `stock_summary(warehouse?, query?, near_days, limit, offset)` — per product: available / quarantine / damaged / expired, near-expiry, expired-but-unsold, earliest expiry. Search uses `search_products`.
* `expiring_stock(within_days, warehouse?)` — batches with stock that are expired or expire soon.
* `suggest_fefo_allocation(product, warehouse, quantity, min_shelf_life_days)` — which batches to pick, earliest expiry first, AVAILABLE and unexpired only, with an optional minimum shelf life. **It reserves nothing**: reservations arrive with sales orders. Rows sum to `least(requested, on hand)`; a shortfall is detected by comparing with the request.

## UI

* **Warehouse → Stock** (`/inventory/stock`): per-product totals, near-expiry and expired flags, warehouse filter and search; buttons for Opening stock, Adjustment, Transfer, Status change (shown only for permissions you hold).
* **Warehouse → Expiry** (`/inventory/expiry`): 30–365 day window; red alert when expired batches are still AVAILABLE.
* **Warehouse → Stock documents** (`/inventory/documents`): every posting; click for its ledger lines.
* **Product → Stock tab**: stock by warehouse/location/batch/status and the product's movement history.
* The posting dialog takes stock from an existing batch (earliest expiry first) instead of free-typing batch numbers for outgoing lines.

## Known limits / next

* Dates use the database server's day for "expired" (UTC; identical to Ghana). A per-organization time zone is already used for expiry checks while posting.
* Transfers are instant; an in-transit status arrives with dispatch.
* Costing/valuation, stock counts, reservations and purchase receiving (GRN) are the natural next steps; GRN will post into this same ledger.
