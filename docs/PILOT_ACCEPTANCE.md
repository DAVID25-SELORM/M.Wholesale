# Pilot acceptance record

Status: pending business sign-off. Technical tests do not sign off business operations.

Use a dedicated pilot organization and synthetic customers, products and transactions. Record the deployed commit, migration version, date, tester and document IDs for each result. Do not use patient information or actual customer payments for test data.

## Entry conditions

- Confirm deployed frontend and database migrations match.
- Confirm two isolated pilot organizations and branch-scoped test accounts exist.
- Confirm the business has an independently recoverable production backup and has rehearsed restoration to a separate environment.
- Keep external payment collection and email/SMS explicitly unconfigured until their providers are approved and verified.

## Business acceptance scenarios

| Workflow | Operator | Required evidence | Result |
| --- | --- | --- | --- |
| Purchase request to receipt | Purchasing and warehouse | Request approval, order, received quantities, batch/expiry/bin, stock movement and supplier balance agree | Pending |
| Sales invoice and receipt | Sales and accounts | Allocation, invoice totals, receipt allocation, customer balance and journal agree | Pending |
| Partial pick and substitution | Picker and independent approver | Original and replacement quantities/bins remain traceable through packing; incompatible batches rejected | Pending |
| Controlled goods | Pharmacist and independent approver | Requester cannot self-approve; register and ledger match | Pending |
| Recall | Authorized recall manager | Affected customers/batches traced; unrelated quarantine retained; recovery evidence and release reason recorded | Pending |
| Expense approval | Requester and accounts approver | Self-approval rejected; approved expense posts once; duplicate retry does not duplicate journal | Pending |
| Tenant isolation | Platform and tenant administrators | Tenant A cannot read/write tenant B; branch-scoped users cannot operate other branches | Pending |
| Ownership transfer | Independent platform operator | Verified replacement receives ownership, previous ownership removed, other roles preserved, audit recorded | Pending |
| Subscription and trial | Billing operator | Trial dates enforced; expired trial blocks direct tenant access; activation restores access; invoices stay unpaid without verified payment | Pending |
| Support and announcements | Tenant user and support operator | Internal notes stay private; only published announcements appear; close/reopen and read status persist | Pending |
| Recovery | Deployment operator | Restored environment contains matching records, authentication configuration and required files; recovery time recorded | Pending |
| Device usability | Pilot users | Complete primary workflows on desktop, tablet and phone; record viewport and screenshots of defects | Pending |

## Sign-off

For each scenario record: pass/fail, document IDs, expected/actual values, defect reference, tester and date. Resolve every critical defect and rerun the affected scenario before sign-off.

Final approval requires named business owners for purchasing, warehouse/pharmacy, sales, finance and platform operations. Record their approval and any accepted limitations here. The coding assistant must not enter approvals on their behalf.

## Recovery rehearsal tooling

`node scripts/restore-drill.mjs` backs up only the disposable local `wps_test` database, restores into a uniquely named scratch database, compares row counts and content digests, then removes that scratch database. Run after database tests finish. It is not evidence of hosted backup availability, file recovery, production recovery time or provider retention settings.
