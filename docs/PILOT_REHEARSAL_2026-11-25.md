# Pilot rehearsal, 2026-11-25

A technical rehearsal of the scenarios in `PILOT_ACCEPTANCE.md`, on a local database with synthetic data.
**It is not business sign-off.** No named business owner has tested or approved anything, the live system was
not used, and the results column in `PILOT_ACCEPTANCE.md` stays "Pending".

Base commit `3ff8123` plus the changes made during this rehearsal.

## How it was run

- Scenarios 1 to 7: `tests/security/pilot-rehearsal.test.ts`, calling the database as the job roles a business
  would assign (not the owner, except for accounting setup). It now runs with every database test run.
  It exercises the database, **not the screens**. Document numbers below are from synthetic local data.
- Scenarios 8 to 10: the existing automated suites. These are not a role-by-role business rehearsal.
- Scenario 11: `node scripts/restore-drill.mjs`.
- Scenario 12: the browser tests rerun at phone and tablet sizes in desktop Chrome. No physical devices.

## Results

| # | Scenario | Technical result | Evidence |
| --- | --- | --- | --- |
| 1 | Purchase request to receipt | Pass, **only with a senior role** (findings 1, 2) | PRQ-2026-000001 to PO-2026-000001; 40 received, 40 in the chosen bin under the entered batch; payable 500.00 before payment and 0.00 after; journals balance. A senior user cannot approve their own request |
| 2 | Sales invoice and receipt | Pass | INV-2026-000001, RCP-2026-000001; total 2,000.00, nothing outstanding; earliest expiry allocated first (60 then 20); AR, inventory, AP and trial balance differences all 0 |
| 3 | Partial pick and substitution | Pass | Short-dated batch not offered and refused; 5 original and 3 replacement units packed as separate batches. Whoever chose the replacement cannot verify the line |
| 4 | Controlled goods | Pass | Unauthorised customer refused; a senior user cannot approve their own adjustment; pharmacist approved. Received 30, adjusted -2, issued 5; register and ledger both 23 |
| 5 | Recall | Pass | 6 units traced to the right invoice; recalled stock could not be sold; recovery recorded; 10 released, the unrelated 4 stayed in quarantine |
| 6 | Expense approval | Pass (finding 3) | Self-approval refused; 25.00 debit and credit; a retry created no second journal |
| 7 | Tenant isolation | Pass | Another organization's owner saw no rows in 15 key tables; the isolation and tenant sweep suites pass |
| 8 | Ownership transfer | Suite passes | `platform-ownership` |
| 9 | Subscription and trial | Suites pass | `platform-trials`, `platform-billing`, `platform-renewal` |
| 10 | Support and announcements | Suites pass | `platform-support`, `tenant-support`, `tenant-announcements` |
| 11 | Recovery | **Local only** | 118 tables, 1,975 rows restored and matched. The live project, its sign-in accounts and settings were not restored; recovery time not recorded |
| 12 | Device usability | Pass after a fix (finding 4) | See below |

Scenarios 7 to 10 together: 9 files, 37 tests.

### Device runs

- Phone (390 x 844): first run 29 of 31; the two failures were global search. After the fix, the search and
  layout specs pass (16 of 16). The other workflow specs passed in the first phone run.
- Tablet (768 x 1024): 26 of 26 (search, picking, delivery runs, temperature, fleet, recalls, settings,
  administration).
- Not covered in a browser at any size: purchase to receipt, invoicing and receipts, point of sale,
  controlled adjustments and expense approval as complete end-to-end tasks.
- Rerun with `E2E_VIEWPORT=390x844`.

## Findings

### Need your decision (role permissions were not changed)

1. **Only senior roles can approve a purchase request.** The procurement manager cannot.
2. **Only senior roles can turn an approved request into a purchase order.** It needs both
   `purchasing.request` and `purchasing.create`, and the procurement officer, procurement manager and warehouse
   manager each lack one. With 1 and 2, routine restocking waits on the owner or a manager twice.
   Possible change: give the procurement manager `purchasing.request` and `purchasing.request_approve`.
   Self-approval would stay blocked.
3. **The accounts officer cannot submit an expense** (it needs `journals.create`). An accounts manager can, but
   then needs a second approver. With one accounts manager, the owner or general manager approves every expense.
   Decide whether that is intended.

### Defect found and fixed

4. **Search did not exist on phones.** The new search box was hidden on narrow screens, and the layout tests
   could not detect that. A search button now opens it. This fix is not live until it is pushed and deployed.

### Staffing to plan

5. Several controls need a second person: purchase requests, controlled adjustments, expenses, temperature
   excursions and checking controlled medicines. For controlled medicines, the checker must not have picked,
   packed or chosen the replacement. The live system appears to have one user today, so none of these can be
   completed there yet. Create at least the pharmacist, a second approver and warehouse staff before the pilot.

## Still required for sign-off

Named owners for purchasing, warehouse and pharmacy, sales, finance and platform operations must run the
scenarios themselves on the deployed pilot organization, on their own devices, and record pass or fail, with a
tested recovery of the real backup. An independent security review is also outstanding.
