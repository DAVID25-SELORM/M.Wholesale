# Phase 7 — Credit notes: sales returns and price corrections

Migrations: `20261016000100_credit_note_permissions`, `…0200_credit_notes`. Apply with `scripts/apply-phase7.sql` (one transaction).

A posted invoice is never edited. A **credit note** corrects it. Each credit note refers to one posted invoice and is a DRAFT until it is POSTED (or CANCELLED, drafts only).

## Permissions

| Permission | Meaning |
|---|---|
| `credit_notes.view` | see credit notes |
| `credit_notes.create` | draft and cancel (checked at the branch of the warehouse the goods come back to) |
| `credit_notes.post` | post a credit note and apply unused credit to invoices — a financial act, so separate from drafting |
| `credit_notes.restock` | return goods straight into **sellable** stock (warehouse managers, pharmacists, owner/general manager) |

## Two kinds of line

- **RETURN** — goods come back. The quantity (in the pack level sold) is credited at the price actually charged (including the discount that was given) plus tax at the invoice line's rate. The goods re-enter stock **in the batches they were sold from** (the last-picked, latest-expiry batch first, or a batch you choose), as **quarantine** (default) or **damaged**. Only someone with `credit_notes.restock` can return them as **available**, and an expired batch can never come back available.
- **PRICE** — a value-only correction (a pricing mistake, an agreed rebate): no stock moves.

## Nothing is credited twice

Per invoice line, returned quantity and credited value are capped at what was invoiced; the last unit of a line credits exactly what remains, so cents never go missing or double. The caps are re-checked when posting, and posting locks the invoice, so two credit notes racing for the same goods cannot both succeed (tested).

## Posting (one transaction)

1. re-prices the lines against what has been credited meanwhile;
2. books the returned goods (stock document `SALE_RETURN`, number `SRT-…`, movement `SALE_RETURN_IN`, reason *return from customer*) and records which sold batch each unit went back to;
3. numbers the credit note (`CRN-yyyy-nnnnnn`, gap-free);
4. **applies it to the invoice it corrects**, as far as that invoice still owes (`invoices.amount_credited`; the invoice's balance is now total − paid − credited).

If the invoice was already paid, the credit stays as the customer's **credit**: it counts against what they owe (credit limit checks, receivables, customer page) and can be applied later to other invoices — oldest due first, or as chosen (`apply_credit_note`). Credit notes also appear on the customer statement as credits.

A posted credit note, its lines, the batches returned and its applications cannot be changed or deleted by anyone.

## Screens

**Sales → Credit notes** (list; filter by status, customer, unused credit). On a posted invoice, **Credit note** opens the form: per line, how many were sold and are still returnable, quantity to return, condition, batch, and/or a price correction, with live totals. The posted credit note is printable and shows the batches the goods went back to and the invoices it was applied to. The customer page lists unused credit with an **Apply to invoices** button. The dashboard lists credit notes waiting to be posted.

## Not in this phase

Refunding credit as cash, reversing a posted credit note, credit notes without an invoice, exchanges, and a quarantine-release workflow (use *Stock → Status change* to release inspected goods).
