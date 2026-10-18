# Phase 16: cutover tools

Migration: `20261025000100_cutover_opening_balances`. Apply with `scripts/apply-phase16.sql` (one transaction). The plan that uses these tools is `docs/CUTOVER.md`.

## What was missing

Import existed for products, suppliers and opening stock. A real switch-over also has to carry over **customers** (with licences, terms and credit limits) and the money in flight: **who owes you** and **whom you owe**. Without it, collections and supplier payments cannot start on day one and the ledger's opening receivables and payables have nothing behind them.

## What it adds

- **Import customers** (Administration → Import data): same checked, row-by-row, dry-run-first pattern as suppliers. Needs `customers.create`.
- **Import opening receivables** and **opening payables** (needs the new right `opening.balances`: owner roles, general manager, accounts manager). One row per unpaid invoice: customer or supplier code, the old invoice number, invoice date, optional due date, and what is still owed (tax included).
- **Opening invoices are real documents without stock.** A receivable is a posted sales invoice flagged as an opening balance (number `OB-<old number>`, no lines, no stock document); a payable is an approved supplier invoice flagged as opening (no purchase order). They show in receivables, customer statements, reminders, credit control, payments and the payables list, and customers pay them (and you pay them) like any invoice. They are **not** sales: sales, margin and VAT reports ignore them.
- **Safe by construction:** a reference already imported is refused (never doubled); amounts must be above 0 with two decimals; dates must be sensible; unknown customers, suppliers and branches are explained per row. Opening invoices cannot be reversed, credited or delivered (they have no stock), and everything that needs stock refuses them with a clear message.
- **Fixing a mistake:** `remove_opening_balance` (reason required) removes a wrong opening invoice, **only before accounting starts** and, for receivables, only if nothing was paid against it. Afterwards the ledger already carries the balance, and the accountant corrects the opening balance instead; importing is also refused once accounting has started.
- **The ledger:** opening invoices are never journalled themselves; the opening balances (Start accounting, prefilled from these invoices) carry them. Paying one later, in either direction, is an ordinary journalled payment, and the control checks still agree.

## Order of work

Products → suppliers → customers → opening stock → opening receivables → opening payables → **start accounting**. See `docs/CUTOVER.md` for the switch-over day, go/no-go criteria and rollback.
