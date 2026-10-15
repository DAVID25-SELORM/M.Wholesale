# Phase 10 — Quotations and sales orders (with stock reservation)

Migrations: `20261019000100_orders_permissions`, `…0200_orders`. Apply with `scripts/apply-phase10.sql` (one transaction).

## Permissions

| Permission | Meaning | Held by |
|---|---|---|
| `quotations.view` / `quotations.create` | see; draft, send, reject, cancel, accept (convert) | reps and managers; viewers read |
| `orders.view` / `orders.create` | see; draft and cancel draft orders | reps and managers; warehouse roles and accounts read |
| `orders.confirm` | confirm an order, which **reserves the stock** | sales / branch managers, general manager, owners |
| `orders.manage` | cancel a confirmed order, close it short | the same managers |

Invoicing an order needs `sales.create` (draft) and `sales.post` (post) as for any invoice. Prices, discounts and credit rules are the invoice rules.

## Quotation

`DRAFT → SENT (QUO-yyyy-nnnnnn) → ACCEPTED | REJECTED | CANCELLED`. Priced from the customer's price list like an invoice (tax at the product's rate; a price other than the list price needs `sales.price_override`, a discount needs `sales.discount`), with a **valid-until** date. Once sent its content is frozen (cancel it and make a new one to change anything). After the valid-until date it shows as *Expired* and can no longer be accepted. **Accepting** creates a DRAFT sales order with the quoted lines at the quoted prices. No stock is held for a quotation. A printable quotation is provided.

## Sales order

`DRAFT → CONFIRMED (SO-yyyy-nnnnnn) → COMPLETED`, or `CANCELLED`, or `CLOSED` (short). Orders are for named customers (not the walk-in customer). Fields: warehouse the stock comes from, the customer's own PO number, needed-by date and an optional **hold-the-stock-until** date.

### Reservation

**Confirming** an order reserves what it orders, per product at its warehouse. Confirmation is refused when the *free* stock (sellable and unexpired for that customer's minimum shelf life, minus what other orders already hold) does not cover it, naming the product and the figures; confirmations at one warehouse are serialised so two orders cannot both claim the last units.

A reservation is a **claim, not a hold on batches**. It equals *ordered − invoiced (posted)* for confirmed orders whose reserved-until date has not passed, so it shrinks as invoices are posted and returns when an invoice is reversed. When **any** invoice is posted — including a counter sale — the stock reserved for *other* customers' orders is not available to it (the error says how many can be sold now). Which batches ship is still decided at posting, earliest expiry first. Stock adjustments, transfers and write-offs are not blocked by reservations. The reservation ends when the order is completed, closed, cancelled or its date passes.

### Invoicing an order

**Create invoice** makes a DRAFT invoice from the order for all or part of what is left (never more than ordered, counting other draft invoices) **at the order's agreed prices** — the clerk needs no price-override right. Such a draft follows the order (post or cancel only; it cannot be edited). Posting runs the usual checks (credit control, regulatory rules, FEFO) and moves the order forward; when everything ordered is invoiced the order becomes **COMPLETED**; reversing an invoice puts the quantity back on the order (and its reservation). **Close short** releases whatever will never be delivered; an order with posted invoices cannot be cancelled, only closed. Neither is possible while draft invoices exist.

## Screens

**Sales → Quotations** and **Sales → Orders** (lists with filters; editors for drafts with *Save and send* / *Save and confirm*; a quotation page with Accept / Rejected / Cancel / Print; an order page with per-line progress — ordered, invoiced, on draft invoices, still to invoice — the invoices raised, Create invoice, Close short, Cancel). The dashboard lists orders waiting to be confirmed and confirmed orders still to deliver.

## Not in this phase

Delivery notes / picking by order, amending a confirmed order (cancel and re-enter), batch-specific reservations, and customer-facing order portals.
