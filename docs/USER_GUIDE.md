# User guide

For the people who use the system every day. Menus you cannot see are rights your role does not have: ask the owner. Everything you do is recorded with your name; documents are never edited or deleted, a mistake is corrected with a new document that reverses it.

## Before you start

- **Sign in** with your work email. If you forget the password, use *Forgot your password* on the sign-in page. Never share your sign-in: the audit log shows your name against everything you do.
- **Branch selector** (top left): choose the branch you are working in. Owners can choose *All branches*.
- **Dates and money** are in Ghana cedis (GHS). Where you see a grey *SOON* label, that part is planned and not available yet.

## Cashier (Point of sale)

1. **Open your till** (*POS*): count the cash float and enter it.
2. **Sell**: search or scan the product, set the quantity, choose how the customer pays (cash, mobile money, card, or a split between methods). The system shows the change due. Stock is taken from the earliest-expiring batch automatically.
3. **Customer wants a refund or return?** Do not edit the sale. A manager or accounts person raises a credit note (*Sales → Credit notes*) and, if money goes back, a refund. Cash refunds paid from your till are recorded against your shift.
4. **Close your till** at the end: count the cash. The system shows the expected cash (float + cash taken − cash refunds) and the difference. A difference is recorded, not hidden.

## Sales and customers

- **Quotation → Order → Invoice.** A quotation is an offer. When accepted it becomes an order, which can reserve the stock so nobody else sells it. Invoicing an order uses the order's prices.
- **Invoice**: choose the customer and warehouse, add products. The system checks the customer's licence (for controlled medicines), credit limit and overdue balance, and picks batches earliest-expiry first. **Post** to finalise: stock leaves and the customer owes the money. A posted invoice cannot be edited.
- **Wrong invoice?** *Reverse* it (needs the right): stock comes back and the invoice is voided. If goods have already left on a delivery, use a **credit note** instead.
- **Payments received** (*Sales → Payments received*): record cash, mobile money, bank transfer, cheque or card against a customer. It is applied to their oldest invoices unless you choose otherwise. A bounced cheque is *voided*.
- **Receivables and reminders**: *Receivables* shows who owes what by age; *Payment reminders* lists overdue customers and gives you the message to send.
- **Deliveries**: on a posted invoice choose *Prepare delivery*. Print the pick list (where in the warehouse each batch is), dispatch with driver and vehicle, then record who received the goods.

## Warehouse and stock

- **Stock** shows what you hold by batch and expiry. **Expiry** lists what is near or past expiry.
- **Goods received**: receive against an approved purchase order (quantity, batch number, expiry date). You cannot receive more than ordered without raising a new order.
- **Adjust stock** (damage, loss, found stock): always give a reason. **Controlled medicines are different**: the screen sends a *request*; a pharmacist (a second person) approves it under *Warehouse → Controlled adjustments* before the stock changes.
- **Transfers** between warehouses are sent, travel "in transit", and are confirmed on receipt.
- **Stock counts**: start a count, enter what you counted, submit. A different person with the right approves it; variances then become adjustments.
- **Quarantine / status change**: put stock on hold (quality, recall) so it cannot be sold, and release it later.

## Purchasing and suppliers

1. **Purchase order**: one person drafts, a *different* person approves.
2. **Goods received** against the order.
3. **Supplier invoice**: enter it against the order. The system matches it to what was ordered and received (the "3-way match"); differences go to an exception for approval with a reason.
4. **Approve** and **pay** the invoice (each needs its own right). **Payables** shows what you owe by age.
5. **Returns to suppliers** are recorded as a purchase return; record the supplier's credit note when it arrives.

## Accounts and bank

- **Accounting → Overview**: starts accounting (once, by the owner or accounts manager) and shows the **control checks**. If a check shows a difference, tell your accountant before posting anything else.
- **Journals**: everything in the books. Sales, receipts, purchases and stock post themselves. Use *New journal* only for things the documents do not cover (salaries, rent, utilities); a mistake is reversed, never edited.
- **Financial statements**: trial balance, profit and loss, balance sheet; download CSV or PDF. **Account ledger** shows every posting to one account.
- **Closing a month**: *Overview → Close a period*. After that, nothing can be posted into that month.
- **Bank reconciliation**: import the bank (or mobile-money) statement, accept the suggested matches, book bank charges from the statement lines, and finish when the difference is nil. A finished statement is locked.
- **Reports**: sales and margins, stock insights (what to reorder, slow stock, stock likely to expire), VAT summary, controlled-drugs register.

## Controlled medicines

- Sales need a customer with a valid licence authorised for controlled drugs; the system refuses otherwise, with no override.
- Every movement appears in the **controlled-drugs register** with a running balance, the customer and licence, and who posted it.
- Adjustments need two people (see above). Reasons and explanations are mandatory.

## Settings (owner)

*Administration → Settings* holds the choices the system really uses: the footer and payment instructions printed on invoices and receipts, default payment terms and credit limit for new customers and suppliers, how long quotations stay valid, the near-expiry window, each branch's default sales warehouse, how invoice and other document numbers look, and the sign-out-after-inactivity time. Every change is checked, recorded in the audit log, and security settings ask for a reason. Company details and branches are edited on their own pages (the Settings screen links to them). Anyone with only the view right sees the settings but cannot change them.

## Switching over from the old system (owner and accounts manager)

*Administration → Import data* brings your lists in from Excel or CSV; every file is checked row by row before anything is saved. Suggested order: products, suppliers, customers, **opening stock**, then **opening receivables** (customer invoices still unpaid) and **opening payables** (supplier invoices still unpaid), and only then **start accounting**. Opening invoices carry the old invoice number and what is still owed; customers pay them like any invoice, and they are not counted as sales. A wrong one can be removed until accounting starts. The full plan, with go/no-go checks and rollback, is in `docs/CUTOVER.md`.

## Something went wrong

- **A message in red**: read it, it says what to fix (for example "credit limit exceeded" or "batch expired"). It is the system protecting you or the customer, not a fault.
- **The screen says "Something went wrong"**: press *Reload*. Nothing already saved is lost. The problem is reported automatically; tell your administrator what you were doing.
- **"Your session has expired"**: sign in again.
- **Owners and administrators**: *Administration → Application errors* lists crashes with page and version; *Audit log* lists who did what.

## Day-to-day checks for the owner

- Daily: till differences, control checks (Accounting → Overview), anything waiting for approval (purchase orders, supplier invoices, controlled adjustments, stock counts).
- Weekly: audit log for reversals, refunds and stock adjustments; Application errors; overdue customers; stock likely to expire.
- Monthly: bank reconciliations, close the period, VAT summary, review who has which role (`docs/ACCESS_REVIEW.md`).
