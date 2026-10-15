# Phase 11 — Sales reports and margins, controlled-drugs register, payment reminders, PDF export

Migrations: `20261020000100_reporting_permissions`, `…0200_reports_registers_reminders`. Apply with `scripts/apply-phase11.sql` (one transaction). New dependencies: `jspdf` (4.2.1) and `jspdf-autotable`, loaded only when someone clicks a PDF button.

## Permissions

| Permission | Meaning | Held by |
|---|---|---|
| `reports.sales` | sales reports (revenue, tax, credits) for the person's branches | owners, general manager, sales/branch/accounts managers, accounts officer, auditor, read-only |
| `reports.margins` | …and **cost and margin** (cost prices are sensitive, so this is separate) | owners, general manager, sales/branch/accounts managers, auditor |
| `registers.controlled` | the controlled-drugs register | owners, general manager, branch manager, pharmacist, warehouse manager, auditor |
| `reminders.view` / `reminders.send` | see overdue customers and reminders; record a reminder | sales/branch/accounts managers (send), accounts officer (send), reps and read-only (view) |

## Sales and margins (`sales_report`, Reports → Sales and margins)

Revenue by **day, month, product, category, customer or branch** for a date range, from posted invoices (reversed ones excluded) **net of posted credit notes**, with tax and units. **Cost** is what each sale was actually picked from (the batch cost recorded when the invoice was posted); goods returned on a credit note give their cost back unless they came back damaged. Cost, margin and margin % are shown only to people holding `reports.margins` for every branch in the rows; lines sold from batches with no cost on record are **counted and flagged** so a margin is never silently overstated. Rows are limited to the branches the person holds `reports.sales` for. Export to CSV or PDF.

## Controlled-drugs register (`controlled_drug_summary`, `controlled_drug_register`, Reports → Controlled drugs register)

For every product of class *Controlled*: a period summary (opening, received, issued, adjusted, closing) and, per product, the **register**: a brought-forward line, then every movement in date order — opening stock, receipts from suppliers, sales, customer returns, returns to suppliers, transfers, adjustments and reversals — with the **running balance**, batch and expiry, the **customer (with premises licence number) or supplier**, the document and invoice/credit-note/order reference, who posted it, and notes. Quality-status changes are left out (they move no quantity). Visible per warehouse to people holding `registers.controlled` there; print, CSV or PDF.

## Payment reminders (`overdue_customers`, `record_payment_reminder`, Sales → Payment reminders)

Lists customers with unpaid invoices past their due date (never the walk-in customer): amount, number of invoices, how late, the last reminder and its level, and a suggested next level (friendly → firm → final, not before a week has passed). **Remind** opens a message written for the chosen tone and the chosen invoices; edit it, then copy it or open your own **e-mail, SMS or WhatsApp** app with the text filled in, or **print a letter**. Nothing is sent from the system itself. **Record as sent** stores the reminder (level, channel, the exact text, the invoices and the amount) append-only, so colleagues see the history.

## PDF export

**Download PDF** on a posted invoice, credit note and quotation (with a REVERSED / CANCELLED stamp where it applies), on the customer statement, the receivables ageing, the sales report and the controlled-drugs register. PDFs are built in the browser from data already on screen. Spreadsheet (CSV) exports neutralise text that a spreadsheet would run as a formula.

## Not in this phase

Sending e-mail/SMS from the system, scheduled or recurring reports, charts, and stock-insight reports.
