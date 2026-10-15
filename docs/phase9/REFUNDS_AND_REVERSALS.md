# Phase 9 — Refunds and reversals

Migrations: `20261018000100_refund_permissions`, `…0200_refunds_reversals`. Apply with `scripts/apply-phase9.sql` (one transaction).

## Permissions

| Permission | Meaning | Held by |
|---|---|---|
| `refunds.view` | see refunds | owners, accounts, sales/branch managers, cashiers, auditors, read-only |
| `refunds.create` | pay unused credit back (branch-scoped) | owners, general manager, accounts manager, sales manager, branch manager |
| `sales.reverse` | reverse a posted invoice | owners, general manager, accounts manager |
| `credit_notes.reverse` | reverse a posted credit note | owners, general manager, accounts manager |

## Refunds

Unused customer credit is either an **unapplied credit note** or a **payment not allocated to any invoice**. `refund_customer(source, amount, method, reference, notes, till shift)` pays some or all of it back by cash, mobile money, bank transfer, cheque or card (non-cash needs a reference). The refund is recorded once (`RFD-yyyy-nnnnnn`, append-only), reduces the credit it came from and the customer's credit position, and appears on the customer statement.

A **cash refund can be paid out of your own open till shift** (same branch): the shift then expects that much less cash in the drawer. A payment that has been (even partly) refunded can no longer be voided, and a credit note that has been partly refunded can no longer be reversed. A refund itself cannot be undone.

## Reversing a sales invoice

For a sale that should never have happened (wrong customer, rung up twice). `reverse_sales_invoice(invoice, reason)`:

1. puts the goods back into the batches and locations they came from — as sellable stock, or as **expired** stock if the batch has expired meanwhile (stock document `SALE_REVERSAL`, `SRV-…`);
2. turns every payment applied to the invoice back into the customer's **credit** (apply it to another invoice, or pay it back);
3. marks the invoice **REVERSED**: it stays on file and on the statement together with its reversal, and no longer counts as owed.

Refused while credit notes exist on the invoice (reverse those first), and for anything but a posted invoice. Two simultaneous reversals cannot both succeed (tested). A reversed invoice cannot be credited, paid, edited or reversed again.

## Reversing a credit note

`reverse_credit_note(note, reason)` withdraws a posted credit note: what it had cleared on invoices (the original one, or any it was applied to) is owed again, and the goods it brought back are taken out of stock again from the condition they were put in (`SALE_RETURN_REVERSAL`, `CRV-…`). If those goods were meanwhile released, sold or moved, the reversal is refused naming the short batch and **nothing changes**. The invoice can be credited again afterwards.

## Statement and screens

The customer statement shows reversals (as the opposite entry of what they undo) and refunds. **Sales → Refunds** lists refunds. On a posted invoice: **Reverse**. On a posted credit note: **Pay back** and **Reverse**. On the customer page and the payments list: **Pay back** for unused credit. Reasons are required for reversals and recorded in the audit log.

## Not in this phase

Reversing a refund, partial reversal of an invoice, and reversing counter sales in bulk.
