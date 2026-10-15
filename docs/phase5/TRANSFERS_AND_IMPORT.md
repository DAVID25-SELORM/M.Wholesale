# Phase 5 — In-transit transfers and bulk import (Excel / CSV)

Migrations: `20261014000100_transfers`, `…0200_imports`. No new permissions: transfers use `inventory.transfer` / `inventory.adjust`; imports use `products.create`, `suppliers.create`, `inventory.opening_stock`.

## In-transit transfers

The instant **Transfer** (Stock page, Phase 2) stays for moves where the goods arrive at once. A **two-step transfer** is for goods that travel:

| Step | Who | What happens |
|---|---|---|
| **Dispatch** (`dispatch_transfer`) | `inventory.transfer` at the *sending* branch | Takes the stock out of the sender (ledger document `TRANSFER_DISPATCH`, number `DSP-…`) and creates the transfer `TRN-…` with one line per batch / location / condition. The goods are now on the road: in **no** warehouse's stock. |
| **Receive** (`receive_transfer`) | `inventory.transfer` at the *receiving* branch | Books what arrived (`TRANSFER_RECEIPT`, `TRC-…`) per line, in the condition found (available / quarantine / damaged / expired) and into a location. Can be done in several deliveries; a line can be split by condition. Quantities are in the **base unit** unless a pack level is named. |
| **Close short** (`close_transfer`) | `inventory.adjust` at the sending branch | Whatever never arrived is written off (a loss in transit) with a stated reason. Goods already received stay where they are. |
| **Cancel** (`cancel_transfer`) | `inventory.transfer` at the sending branch | Only while nothing has been received: the goods return to the same batch, location and condition they were taken from. |

Rules enforced by the database: receipts cannot exceed what is still on the way; goods that expired in transit can never be received as AVAILABLE; a bad line rolls back the whole receipt; simultaneous receipts cannot over-receive (one wins, tested). Both the sending and the receiving branch can see the transfer; nobody else can. The ledger invariant (balance = sum of movements) holds at every step.

UI: **Warehouse → Transfers** (default view "still on the way"), a *Send stock* dialog that takes outgoing stock from existing batches, a transfer page with receive / close short / cancel, and "transfers on the way" in the dashboard's *Waiting for you*.

## Bulk import

**Administration → Import data.** Three kinds, each with a downloadable template and a column guide:

| Import | How it is checked and saved |
|---|---|
| **Products** | The database function `import_products` creates identities (generic + form + strength, found by their normalised key, never duplicated), manufacturers and categories (found by name, created if new), the product, up to two pack levels, a barcode (GTIN check digits verified) and aliases. |
| **Suppliers** | `import_suppliers`: code, name, type, licence and expiry, payment terms, currency, contact details. |
| **Opening stock** | Checked in the browser against your catalogue and warehouses (SKU, warehouse code, location, batch, expiry, quantity in any pack level, cost), then posted as `OPENING` documents (one per warehouse, 200 lines at a time). If a whole document is refused its rows are retried one by one, so each bad row gets its own message. |

How a file is handled:

1. **Read in the browser** (`.xlsx` via a small, maintained reader loaded only when needed; `.csv` with a built-in reader that copes with BOM, quotes and `;` or tab delimiters, as Excel writes in some regions). Up to 5 MB / 5,000 rows. Headings are matched ignoring case and punctuation, with common alternatives recognised ("Product Name", "GTIN", "Lot", "Qty" …).
2. **Check** — nothing is saved. The database runs the *real* code on every row inside a sub-transaction and undoes it, so the result is exactly what *Import* will do. Each row is **Ready**, **Already there** or has a **Problem** with a plain-language reason; the problems can be downloaded as CSV.
3. **Import** — only the ready rows are saved. One bad row never spoils the others.

Rules: imports are **create-only** (an existing SKU or supplier code is reported and left unchanged, so re-importing a corrected file is safe); the same SKU twice in one file is an error; imports need the permission for the **whole organization** (catalogue and suppliers are shared master data); at most 500 rows per database call (the page chunks automatically); a summary entry (`product.imported`, `supplier.imported`) is added to the audit log when rows are really imported. **An opening-stock file adds to stock**, so import it once.

## Not here

Update-in-place import (changing existing products), stock-count and price-list import, multi-sheet files, and import of customers (they arrive with sales).
