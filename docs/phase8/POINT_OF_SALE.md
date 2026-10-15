# Phase 8 — Point of sale

Migrations: `20261017000100_pos_permissions`, `…0200_pos`. Apply with `scripts/apply-phase8.sql` (one transaction).

A counter sale is an **ordinary sales invoice, posted and paid on the spot**, so every Phase 6 rule still holds: stock leaves earliest-expiry-first, the regulatory rules, credit control, and the price/discount rights of the person at the till. Returns and refunds of counter sales are credit notes (Phase 7).

## Permissions

| Permission | Meaning |
|---|---|
| `pos.sell` | ring up sales and open/close **your own** till shift (branch-scoped) — cashiers, managers |
| `pos.view` | see every shift and counter sale of the branch (not only your own) |
| `pos.manage` | close another cashier's forgotten shift |

Cashiers still need `receipts.create` and `sales.create/post` (the CASHIER role has them). Discounts need `sales.discount` and other prices `sales.price_override`, which cashiers do not have.

## The walk-in customer

Every organization has one built-in **Walk-in customer** (cash only, no credit, no licence, type retailer). It cannot be made a credit or licensed customer, deactivated or deleted. Because it holds no licence, prescription-only, pharmacy-only and controlled medicines are refused for it (no override). Its debt, if a counter payment is later voided, does not block further counter sales: for the walk-in only what the *current* sale leaves unpaid is checked.

## Till shifts

`open_pos_session(warehouse, opening float)` — one open shift per cashier; the stock sold comes from that warehouse. `close_pos_session(shift, cash counted, notes)` compares the drawer with the **expected cash = float + cash kept** (change is not kept; voided payments are excluded). A difference must be explained in the notes and is recorded as the shift's variance. A closed shift cannot be changed. Cashiers see their own shifts; `pos.view` sees all of the branch.

## Selling

`pos_checkout(shift, customer or walk-in, lines, payments)` is **one transaction**: it writes the invoice, posts it, takes the payments and links everything to the shift. Payments can be split over up to five: cash (the amount **handed over**; anything above what is due is change), mobile money, card, bank transfer, cheque (non-cash needs a reference and can never exceed the total). If anything fails — not enough stock, a regulatory refusal, a short payment from the walk-in — nothing is left behind (no draft, receipt or stock change). A customer with credit can be sold to on account, subject to the usual credit checks. `post_sales_invoice` now accepts a list of payments as well as a single one.

## Screens

**Sales → Point of sale**: start a shift (float), scan a barcode or type a name/SKU + Enter, a cart with quantity steppers, pack level, price (and discount for those allowed), customer (walk-in by default), **Charge** with change calculation and split payments, a printable 80 mm receipt, **Close shift** with the live difference. **Sales → Till shifts**: every shift with its cash difference, a detail view of the sales, and closing someone else's shift for managers.

## Not in this phase

Parking/holding a cart, a cash drawer / receipt printer integration, cash paid in/out during a shift, prescriptions for dispensing, and loyalty or promotions.
