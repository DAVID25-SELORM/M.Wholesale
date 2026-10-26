# Completion backlog

Baseline: 2026-10-25. This tracks the full roadmap, not only numbered SQL migrations.
An existing page is implementation evidence, not acceptance evidence. Items below
remain open until their behavior, authorization, audit trail and tests are complete.

## Execution order

1. Stock correctness: substitution quantities, source bins, discrepancy accounting,
   controlled approval locking and reversal behavior.
2. Recall operations: customer recovery records, disposition, release authorization,
   drill support, closure evidence and populated traceability tests.
3. Procurement and finance gaps: requisitions, quotations, price agreements,
   expenses, petty cash, credit promises and approval policies.
4. Delivery and cold chain: proof of delivery attachments/signature/location,
   collections, temperature observations and excursion decisions.
5. Platform and commercial scope: global search, notifications/jobs, offline sync,
   CRM, analytics, subscriptions, tenant onboarding and customer portal.
6. Full regression, concurrency, performance, restore rehearsal and release package.

## Roadmap reconciliation

| Roadmap phase | Existing implementation evidence | Outstanding acceptance/work |
| --- | --- | --- |
| 0 Foundations | Docker scripts, TypeScript, local test runners, architecture ADR | Business specifications/prototypes and pilot acceptance; reconcile original stack assumptions with ADR |
| 1 Platform | Auth/session, scoped roles, audit, catalogue, parties, imports, settings | Global search is disabled; notification control is disabled; approval engine, jobs/outbox, MFA and file workflows need requirement-level review |
| 2 Inventory/procurement | Ledger, batches, orders/receipts, returns, transfers/counts, payables | Purchase requests and supplier quotations explicitly planned; destruction evidence, three-way matching and concurrency acceptance need review |
| 3 Sales/pilot | Quotes/orders/invoices, POS, credit notes, receipts/refunds, reminders, reports | Price agreements planned; offline sales/sync, promise-to-pay, cheque lifecycle, real opening balance reconciliation and pilot UAT outstanding |
| 4 Finance/compliance | Journals/statements, bank reconciliation, VAT report, controlled register, recalls | Expenses planned; petty cash, complaint/ADR, recall recovery/release/drill and accountant close acceptance outstanding |
| 5 Fulfilment | Picking, packing, dispatch, delivery runs, fleet, exception UI | Partial/cross-bin substitution, temperature excursions, richer POD, on-site collection, offline rep work and week-long warehouse acceptance outstanding |
| 6 Scale/commercial | Role dashboard, stock/sales reports | Forecasting, schedules/saved views, subscription billing/licensing, self-service tenant onboarding, SSO, scale/DR acceptance outstanding |
| 7 Integrations | No provider credentials supplied | DrugXOne/payment/accounting adapters require specifications and sandbox access; portal, second country pack and language support require implementation/scope validation |

## Acceptance gates

- Every workflow has meaningful permission/tenant/branch tests and audit evidence.
- Stock and financial changes reconcile, including failure/rollback and concurrency.
- UI uses real persisted operations and exposes failures; placeholders do not count.
- Fresh migrations and upgrade migration paths pass locally.
- Full local suites and build pass after the final changes, with dated results.
- Hosted changes remain staged for manual deployment unless separately authorized.
- Real opening data, accountant/pharmacist acceptance, provider access and external
  security review require external participation; do not fabricate completion.

## Current focused evidence

Migration 024: fresh local migration install, 23 picking/packing tests and typecheck
passed. It restricts replacement choices to the original location; it does not
implement cross-bin or partial-line replacement. Hosted application of 024 has not
been confirmed.

Migration 025 is local: controlled decision locking and request explanation/
eligibility validation. Fresh migration installation passed; all 33 tests across
picking and controlled adjustments passed, including the linked second-person
approval workflow. This does not close stock discrepancy,
cross-bin, partial substitution or concurrency acceptance requirements.
