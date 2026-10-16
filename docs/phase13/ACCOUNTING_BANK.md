# Phase 13: accounting ledger and bank reconciliation

Migrations: `20261022000200_phase13_permissions`, `…0300_accounting_ledger`, `…0400_accounting_functions`, `…0500_bank_reconciliation`. Apply with `scripts/apply-phase13.sql` (one transaction). Nothing changes for anyone until the owner presses **Start accounting**.

## What it is

A double-entry general ledger kept beside the operational records. **Every journal comes from a document, in the same transaction, so the books cannot miss an event**, and the database refuses an unbalanced journal. Journals are append-only: nobody (not even the database owner) edits or deletes one; a mistake is corrected with a reversing journal.

| Document | Journal |
|---|---|
| Sales invoice | Dr Receivables; Cr Sales, Cr VAT output |
| Credit note | Dr Sales returns, Dr VAT output; Cr Receivables |
| Customer receipt (cash, mobile money, card, bank transfer or cheque) | Dr Cash / Mobile money / Card settlements / Bank; Cr Receivables |
| Customer refund | Dr Receivables; Cr Cash / Mobile money / Card / Bank |
| Goods received | Dr Inventory; Cr Goods received not invoiced |
| Sale, sale return and their reversals (valued at batch cost) | Dr Cost of goods sold ↔ Cr Inventory, in the direction of the stock |
| Stock write-off or gain | Dr Stock adjustments ↔ Cr Inventory |
| Return to supplier | Dr Supplier returns awaiting credit; Cr Inventory |
| Supplier invoice approved | Dr Goods received not invoiced (at order cost), Dr/Cr Purchase price variance, Dr VAT input; Cr Payables |
| Supplier invoice paid | Dr Payables; Cr default bank account |
| Supplier credit recorded | Dr Payables; Cr Supplier returns awaiting credit (and price variance) |
| Reversed invoice or credit note, voided receipt, cancelled supplier invoice | the mirror journal, dated the day it happens |

Stock journals are built from the stock ledger itself, so the **Inventory account always equals stock on hand at batch cost**; the control checks prove it (see below). Transfers and status changes do not change value and post nothing (branch-level inventory is therefore approximate until transfers are journalled).

## Starting accounting

Overview → **Start accounting**: pick the go-live date and the opening balances. Receivables, inventory and payables are suggested from your records (check them); you type cash, bank, mobile money and VAT. The balancing figure goes to *Opening balance equity*, so the opening journal always balances. Documents dated before go-live are not journalled (the opening balances carry them): enter back-dated documents first. Done once.

## Chart of accounts

A standard wholesale-pharmacy chart is created for every organization (cash, bank, mobile money, card settlements, receivables, inventory, VAT, payables, goods received not invoiced, equity, sales, returns, cost of goods, adjustments, variance, rounding, common expenses). The accountant renames and adds accounts. **System accounts** (the ones documents post to) can be renamed but not retyped or deactivated. **Control accounts** (receivables, inventory, payables, goods received not invoiced, sales, sales returns, cost of goods, supplier returns) cannot be posted to by hand, so the ledger cannot drift from the customer, stock and supplier records.

## Manual journals, reversals, period close

*Journals → New journal* for what documents do not cover (salaries, rent, utilities, drawings). Date between go-live and today, balanced, at least two lines, not in a closed period; branch-limited users post for their own branch only. Only manual journals and bank entries can be reversed (once). **Close a period** (Overview): nothing can be journalled on or before the date; a document dated inside it is journalled on the first open day, so closed figures never change. Reopening needs a reason (kept in the audit log).

## Statements and checks

Trial balance, profit and loss, balance sheet (CSV and PDF), account ledger with running balance. Branch-limited accountants see only their branch (row-level security does the filtering). The **control checks** on the overview compare ledger and records: receivables vs customer balances, inventory vs stock at batch cost, payables vs approved unpaid supplier invoices, and total debits vs credits. A difference means something was posted outside the documents or an opening balance was wrong.

## Bank reconciliation

Accounting → Bank reconciliation. The main bank account and the mobile-money wallet exist already; add more (each gets its own ledger account). Bank transfers, cheques and supplier payments go to the **default** account.

1. **Import** the statement (Excel or CSV; Date, Amount or Debit/Credit, optional Description/Reference; day-first dates) with the printed opening and closing balances. It is refused unless opening + lines = closing, the opening equals the previous statement's closing, and the period overlaps no other.
2. **Match**: suggestions by amount, date (±10 days) and reference; *Match automatically* accepts only unambiguous pairs (same amount, within 3 days, nobody else could fit); or choose a line and tick the entries that add up to it.
3. **Book** what the books do not know (charges, interest, direct deposits) against an account in one step.
4. **Clear** ledger lines that will never reach a statement (with a reason).
5. **Finish** when the difference is nil, every line is matched and earlier statements are done. A finished statement is locked.

## Permissions

| Right | Meaning | Held by |
|---|---|---|
| `accounting.view` | ledger, journals, statements, checks | owners, general manager, accounts manager, accounts officer, auditor |
| `accounting.manage` | chart of accounts, start accounting, close periods | owners, general manager, accounts manager |
| `journals.create` | post and reverse manual journals | owners, accounts manager |
| `bank.view` | bank accounts, statements, reconciliations | same as `accounting.view` |
| `bank.reconcile` | import, match, book, clear, finish | owners, accounts manager, accounts officer |

The accounts officer prepares reconciliations but cannot post journals. The accounts manager (and owner roles) hold both, which `docs/ACCESS_REVIEW.md` flags: with two finance people, give the officer reconciling and keep journals with the manager.

## Found while building

`receivables_summary()` is a SECURITY INVOKER report that depends on row-level security; calling it from a SECURITY DEFINER function (which bypasses it) summed *every organization*. The opening-balance suggestion and control check therefore compute receivables with an explicit organization filter (`private.gl_operational_ar`), and `accounting.test.ts` runs in a database with other organizations present so a regression shows.

## Not built (needs your input)

GRA e-VAT, customer portal, year-end close to retained earnings (the balance sheet shows profit to date), foreign-currency books, inter-branch transfer journals, fixed assets and depreciation, budgets.
