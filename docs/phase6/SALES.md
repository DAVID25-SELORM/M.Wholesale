# Phase 6 — Sales: customers, pricing, invoices, receipts and receivables

Migrations: `20261015000100_sales_permissions`, `…0200_customers_pricing`, `…0300_sales`. Apply with `scripts/apply-phase6.sql` (one transaction).

## Permissions

`customers.view/create/edit`, `pricing.view/manage`, `sales.view/create/post/discount/price_override/override_credit`, `receipts.view/create/void`. Owner, super admin and general manager hold all of them; sales manager/rep, cashier, branch manager and the accounts roles hold the ones their job needs; warehouse, auditor and read-only roles can look.

## Customers, price lists, tax

- **Customer**: code, name, type (pharmacy, hospital, clinic, wholesaler, retailer, other), premises **licence** number + expiry, registered pharmacist, whether **controlled drugs are authorised**, payment terms (days), **credit limit** (0 = cash only), price list, minimum shelf life (days), credit hold (with reason).
- **Price lists** hold one price per product *pack level*. A customer's own list wins; otherwise the default list; no price on either = the line cannot be sold unless someone with `sales.price_override` names a price.
- **Tax codes** (rate 0–100 %, one default). A new organisation gets an *Exempt 0 %* default. A product may name its own code. The rate and code are **copied onto each invoice line**, so later changes never alter an issued invoice.

## Invoice life cycle

`DRAFT → POSTED` (or `CANCELLED`, drafts only). A draft is saved with `save_sales_invoice` (no number, no stock effect). **Posting** (`post_sales_invoice`) does everything in one transaction:

1. checks the customer: active; for **prescription-only, pharmacy-only and controlled medicines** the customer must be a pharmacy, hospital, clinic or wholesaler with a recorded, unexpired licence, and controlled drugs additionally need the customer's authorisation. There is **no override** for these rules;
2. checks **credit**: hold and limit. Exposure = what they owe − unused credit + this invoice (less a payment taken at posting). Over the limit, or on hold, is refused unless the poster has `sales.override_credit` and gives a reason (audited). A customer with limit 0 must pay in full at posting;
3. **allocates stock first-expiry-first-out** from AVAILABLE, unexpired batches that also satisfy the customer's minimum shelf life, tracking what earlier lines of the same invoice already took, then posts one `SALE` stock document (`SAL-…`);
4. numbers the invoice (`INV-yyyy-nnnnnn`, gap-free because the number is assigned only at posting), stores the batches picked with their cost, and sets the due date from the customer's terms;
5. optionally records a payment taken at the counter.

A posted invoice is **locked**: only the amount paid can move (through receipts). There is no delete. (Credit notes and returns are the next phase.)

## Receipts

`record_receipt` records money from a customer at a branch (cash, mobile money, bank transfer, cheque, card; a reference is required for anything but cash). It is applied **oldest-due-first**, or to invoices the user chooses; a leftover stays as the customer's **credit**, counted against their exposure, and can be applied later (`allocate_receipt`). `void_receipt` (with a reason) reverses the allocations and reopens the invoices.

## Reports and screens

- **Receivables** (`receivables_summary`): per customer, owed now / not yet due / 1–30 / 31–60 / 61–90 / over 90 days late, credit held, limit, hold flag.
- **Customer statement** (`customer_statement`) and `customer_credit` (outstanding, overdue, available).
- UI under **Sales**: Invoices (list, draft editor, post dialog, printable posted invoice), Customers (+ customer page with statement and open invoices), Payments received, Receivables, Pricing & tax. Products have a *Tax* field. The dashboard shows sales today, receivables and drafts.

## Security notes

Transactional tables have **select-only** policies; every write goes through a definer function that checks the permission at the right branch (`sales.*` at the dispatching warehouse's branch, `receipts.*` at the receiving branch). Posted invoices, allocations and receipts are immutable by trigger; allocations are append-only. Every new public function is on the allow-list in `tests/security/hardening.test.ts`. `tests/security/sales.test.ts` (33 tests) covers isolation between organisations, FEFO, regulatory refusals, credit control, receipts and ageing.

## Not in this phase

Credit notes / sales returns, invoice reversal, payment reminders, PDF export, point-of-sale, quotations and orders with stock reservation.
