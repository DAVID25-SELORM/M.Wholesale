# Cutover plan: from the old system to this one

A step-by-step plan for the day you switch over, with a parallel week first. Tick each box; a step that fails is a stop, not a detour.

**Roles you need in the room:** the owner (or general manager), the accounts manager, the warehouse manager, one pharmacist, and whoever knows the old system's reports. **Rollback owner:** the person who can say "we go back", decided in advance.

## 0. Two to three weeks before

- [ ] Apply every migration (`scripts/apply-phase*.sql`, in order) and confirm the latest app is live. Run through *Accounting → Overview* and *Administration → Application errors* once as the owner.
- [ ] Supabase and Vercel settings from `docs/PRODUCTION_READINESS.md` (MFA, sign-ups off, email sender, backups). **Do not skip backups.**
- [ ] Decide **branches, warehouses and locations** (Administration). One warehouse per physical store; locations if you pick by shelf.
- [ ] Create **one user per person** with the right role (`docs/ACCESS_REVIEW.md`); remove demo users. Hand out sign-ins in person.
- [ ] Export from the old system: products, suppliers, customers with licences and credit terms, stock on hand by batch and expiry, **unpaid customer invoices**, **unpaid supplier invoices**, and its trial balance or the cash, bank and mobile-money balances.
- [ ] Choose the **go-live date** (a quiet day, ideally the first of a month so the first period is clean) and the **parallel week** (one branch, the week before).

## 1. Load the master data (any time before; repeat as often as needed)

Administration → **Import data**. Each file is checked row by row before anything is saved; fix what it reports and re-run.

1. **Products** (SKU, name, units, class, barcode). Controlled medicines get class `CONTROLLED`.
2. **Suppliers** (licence, terms).
3. **Customers** (licence number and expiry, whether they may buy controlled drugs, terms, credit limit).
4. Check a sample on screen: ten products, five customers, with their licences.

## 2. The switch-over day

The old system stops taking transactions at a fixed time; from then everything is written on paper (or kept in the old system read-only). The steps below take a few hours.

1. [ ] **Count the stock** (or use yesterday's count) and export stock by batch. Import **Opening stock** (one file, **once**: each row adds to stock). Check *Stock → Stock valuation* against the old system's valuation; investigate any difference above rounding before going on.
2. [ ] Import **Opening receivables**: one row per unpaid customer invoice, with the old invoice number and what is still owed. Check the total in *Sales → Receivables* against the old system's debtors list, **customer by customer for the ten biggest**.
3. [ ] Import **Opening payables**: one row per unpaid supplier invoice. Check *Purchasing → Payables* against the old creditors list.
4. [ ] A wrong opening invoice can be removed (Sales or Payables list, with a reason) **only until accounting starts**. After that, the accountant corrects the opening balance instead.
5. [ ] **Start accounting** (Accounting → Overview): the go-live date is the cutover day. Receivables, inventory and payables are pre-filled from steps 1 to 3; type the **cash counted, bank balances, mobile-money balance, VAT** from the real world. Capital is the balancing figure. Read the opening journal back with the accountant.
6. [ ] The **control checks** on the Accounting overview must show **no differences**. If one does, stop and find it before trading.
7. [ ] Open each **till** with its real float. Make a **test sale and a test refund** at each branch with a real product, then reverse the test in the system (and put the cash back).
8. [ ] Print the **user guide** (`docs/USER_GUIDE.md`) for each role and walk each person through their daily tasks once.

## 3. The first week

- [ ] **Every evening**: close tills and note the differences; run the control checks; look at anything waiting for approval; compare the day's sales total with the paper or old-system record.
- [ ] **Day 2 and day 5**: compare stock on hand for twenty fast-moving products with a physical count.
- [ ] **End of week**: first bank reconciliation (import the statement, match, finish). Read *Administration → Application errors* and the audit log (reversals, refunds, adjustments).
- [ ] Keep the old system **read-only for 30 days**.

## 4. Go / no-go criteria (decide before the day)

Go only if all are true: backups are on; opening stock valuation agrees with the old system to within rounding; opening receivables and payables agree with the old lists; control checks show no differences; each branch has completed a test sale and refund; every user can sign in; the rollback owner is reachable.

## 5. Rollback

- **Before the first real sale:** nothing has been lost. Return to the old system. Wipe nothing; the imported data can be corrected and the cutover tried again.
- **After trading has started and it must stop:** take a database backup immediately (so nothing is lost), revert to the old system, and enter the transactions made in the new system (invoices, receipts, payments, stock movements) into it from the new system's reports (*Sales and margins*, *Receivables*, *Journals*, *Stock documents*). The new system's records are append-only and complete, so nothing is missing; this is data entry, not recovery.
- **Restoring a backup** is a last resort and replaces everything since the backup: see the restore runbook in `docs/PRODUCTION_READINESS.md`.

## 6. After the first month

- [ ] Close the first period (*Accounting → Overview → Close a period*) once bank reconciliation, the control checks and VAT are done.
- [ ] Review who holds which role (`docs/ACCESS_REVIEW.md`) with the owner.
- [ ] Switch the old system off after 30 days of agreement.
