# 6. Phased Implementation Roadmap

Durations assume a core team of ~5–6 engineers (2 backend, 2 frontend, 1 full-stack/DevOps, 1 QA part-time) plus a product owner and a pharmacist/domain advisor. Scale the calendar if the team is smaller. Estimates are planning-grade (±30%), to be re-baselined after Phase 0.

## 6.1 Phase overview

| Phase | Name | Weeks | Outcome |
|-------|------|-------|---------|
| 0 | Foundations & validation | 3–4 | Signed-off specs, prototypes, repo, CI, environments |
| 1 | Platform core | 6 | Auth, tenancy, RBAC, audit, catalogue, parties, import framework |
| 2 | Inventory & procurement | 8 | Warehouses, batches, ledger, PO → GRN → supplier invoice, transfers, adjustments |
| 3 | Sales, credit & payments **(MVP / pilot)** | 10 | Orders, invoicing, FEFO, credit control, receipts, basic POS, documents, basic reports |
| 4 | Finance & compliance | 8 | GL, expenses, VAT, bank rec, period close, returns, recalls, controlled-drug register |
| 5 | Fulfilment & delivery | 6 | Pick/pack/dispatch, runs, POD, mobile apps, cold-chain logs |
| 6 | Analytics, subscriptions & scale | 6 | Dashboards, forecasting, billing/licensing, vendor console, e-VAT, SSO |
| 7 | Integrations & expansion | open | DrugXOne, payment gateways, accounting connectors, second country pack |

MVP for a first paying pilot = end of Phase 3 (~ 33–35 weeks from kickoff). Parallelisation (e.g. fulfilment work starting before finance completes) can bring this down; the order above is the lowest-risk sequence because stock and credit correctness must be proven before finance and logistics build on them.

## 6.2 Phase detail

### Phase 0 — Foundations & validation (3–4 wks)
- Workshops with 2–3 real wholesalers: map current processes (receiving, pricing, credit, dispatch, returns, recalls), collect sample documents (invoices, GRNs, price lists, Excel sheets).
- Resolve open questions in doc 7 (VAT, E-VAT, controlled drugs, licensing fields).
- Clickable prototypes (Figma) for POS, invoice, GRN, pick, credit control; user testing.
- Monorepo scaffold (pnpm/Turborepo), TypeScript strict, ESLint boundaries, Prettier, commit hooks, Docker Compose dev stack, Prisma baseline, Testcontainers setup, CI pipeline (local runner scripts now; hosted CI when repository hosting is agreed), observability baseline.
- **Technical spikes**: RLS + Prisma pattern; FEFO allocation under concurrency (load test); offline sync/idempotency; PDF rendering; GS1 barcode parsing; Excel import at 50k rows.
- ADRs (architecture decision records) for key choices.
- **Exit criteria**: approved architecture & scope, approved prototypes, spikes passed, pilot customer(s) identified, backlog sized.

### Phase 1 — Platform core (6 wks)
- Tenancy, branches, warehouses (basic), settings, numbering sequences, i18n, theming.
- Identity: users, invitation, Argon2id, JWT+refresh, TOTP MFA, sessions, RBAC with scoped roles, approval-policy engine, audit log (hash-chained).
- Catalogue: products, units/packs, barcodes, categories, manufacturers, tax categories; price lists (basic).
- Parties: suppliers, customers (with licence docs and expiry alerts), contacts, addresses.
- Excel import/export framework (staged, validated, row errors) + product/customer/supplier import.
- File storage, notification framework, background jobs, outbox.
- App shell: navigation, command palette, global search, list/detail patterns, design system.
- **Exit**: RLS leakage tests green; RBAC permission matrix tests; ASVS L2 checklist for auth passed; demo-able master data.

### Phase 2 — Inventory & procurement (8 wks)
- Stock ledger, balances, locations & statuses, batch master, FEFO allocation service, reservations.
- Opening stock import by batch; stock valuation report; expiry dashboard & alerts.
- Purchasing: requisition, PO, approvals, GRN (scan, batch/expiry, discrepancies, quarantine routing), supplier invoice capture + 3-way match, purchase returns, supplier ledger.
- Transfers (with in-transit), adjustments with approvals, write-off/destruction certificate, cycle counts.
- Reconciliation job (balances = Σ movements) and invariant tests (property-based).
- **Exit**: end-to-end receive→store→adjust→transfer works; ledger invariants proven under concurrent load; GRN usability test passed.

### Phase 3 — Sales, credit & payments — MVP (10 wks)
- Customer price rules, quotes, sales orders, invoice posting with batch allocation, credit notes/returns (basic), tax engine (configurable codes), document PDFs (invoice, delivery note, receipt, statement).
- Credit management: terms, limits, exposure checks, holds, overrides, ageing, statements, reminders (SMS/WhatsApp/email), promise-to-pay.
- Receipts & allocation, cheques register, MoMo/bank receipts, daily collections, on-account balances.
- POS v1: scan sales, shifts/cash-up, holds, thermal receipts, offline cash sales + sync exceptions.
- Basic reports: sales, stock, expiry, ageing, collections, margin; owner dashboard v1.
- Pilot hardening: data migration playbook, training material, support runbook, backup/restore drill, pen-test (external), performance tests.
- **Exit (pilot go-live gate)**: UAT signed by pilot; no Sev-1/2 open; stock & AR reconcile 100% to the pilot's opening position; RPO/RTO drill passed; security review passed.

### Phase 4 — Finance & compliance (8 wks)
- Chart of accounts, posting engine mappings (GRN, supplier invoice, sales, COGS, receipts, returns, adjustments), manual journals, periods & locks.
- Expenses with approvals, petty cash, supplier payments/WHT, bank import & reconciliation, MoMo clearing reconciliation.
- VAT/levy returns workpapers, trial balance, P&L, balance sheet, cash flow, inventory-to-GL reconciliation.
- Returns policy engine, **recall management** with drill mode, quarantine release workflow, complaint/ADR capture, controlled-drug register, regulator inspection pack export.
- **Exit**: accountant-validated month-end close on pilot data; mock recall performed within target time; GL reconciles with sub-ledgers to zero variance.

### Phase 5 — Fulfilment & delivery (6 wks)
- Pick waves/tasks, handheld pick app, short-pick handling, packing & labels, dispatch gate rules.
- Delivery runs, route sheets, driver PWA with POD (signature/photo/GPS), failed delivery handling, on-site cash collection, customer notifications.
- Cold-chain: temperature logs at receipt/pack/transit, excursion workflow.
- Sales rep mobile (offline orders, balances, collections).
- **Exit**: pilot warehouse runs pick/pack/dispatch for a full week without paper fallback.

### Phase 6 — Analytics, subscription & scale (6 wks)
- Dashboards per role, report scheduler, saved views, forecasting (reorder suggestions, seasonality), ABC-XYZ.
- Subscription & licensing: plans, feature flags, limits, billing invoices, grace/suspension, usage metering, vendor admin console with consented impersonation.
- GRA E-VAT adapter (if required), SSO, advanced approvals, read replica for reporting, performance/scale testing to targets, DR region.
- **Exit**: onboarding of a new tenant fully self-service; scale test at 10× pilot volume.

### Phase 7 — Integrations & expansion
- DrugXOne adapter (catalogue, prices/stock publication, inbound orders), payment-gateway adapters, accounting connectors, B2B customer portal, second country pack (currency/tax/regulator), multi-language UI.

## 6.3 Release & environment strategy

- Trunk-based development, short-lived branches, feature flags; weekly staging release, fortnightly production release after pilot.
- Environments: dev (local) → staging (prod-like, anonymised data) → production. Migrations follow expand/contract; every migration rehearsed on a production-size copy.
- Definition of Done: acceptance criteria met, tests (unit + integration + E2E where flow-critical), RLS/permission tests, audit events emitted, docs updated, accessibility check, observability added.

## 6.4 Quality plan

| Level | Scope | Target |
|-------|-------|--------|
| Unit | Domain logic (tax, pricing, FEFO, costing, allocation) | ≥ 90% on domain packages |
| Integration | API + Postgres (RLS, triggers, ledger invariants) | All critical paths |
| E2E (Playwright) | POS, invoice→dispatch→receipt, GRN→putaway, recall | Nightly |
| Property-based | Stock ≥ 0, journals balance, allocations ≤ totals | Per PR |
| Performance (k6) | POS, invoicing, search, reports | Before each phase exit |
| Security | SAST/DAST, dependency scan, pen test | Per release / pre-pilot / annual |
| UAT | Pilot users with scripted scenarios | Phase 3, 4, 5 exits |

## 6.5 Data migration & onboarding playbook

1. Collect master data and balances in provided templates (products, customers, suppliers, opening stock by batch, open AR/AP, trial balance).
2. Dry-run imports in staging; reconcile counts and totals; business sign-off.
3. Freeze trading window → final delta import → go-live; parallel-run period (2 weeks) for pilot with daily reconciliation.
4. Training: role-based sessions + quick-reference cards + in-app guides; super-users per branch.
5. Hypercare: daily check-ins for 2 weeks, rapid-fix lane.

## 6.6 Team and governance

- Roles: Product owner, Tech lead/architect, Backend ×2, Frontend ×2, DevOps/SRE (shared), QA, UX designer (part-time), Pharmacist advisor, Accountant advisor.
- Cadence: 2-week sprints, demo to stakeholders each sprint, monthly roadmap review, ADR log, risk register reviewed fortnightly.

## 6.7 Risk register (top items)

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|-----------|
| Tax/VAT rules change or are misunderstood | Wrong invoices, penalties | High | Tax as effective-dated config; accountant sign-off; country pack; regression test suite of tax scenarios |
| Poor connectivity at sites | Lost sales/unusable | High | PWA offline for POS/warehouse, light payloads, sync-exception queue |
| Dirty/unstructured legacy data | Delayed go-live, wrong stock | High | Import wizard with validation, dry-runs, reconciliation gates, data-cleaning service |
| Scope creep (20 modules) | Delay | High | MVP defined at end of Phase 3; MoSCoW; change control |
| Stock/ledger bugs (silent drift) | Loss of trust | Medium | Append-only ledger, nightly reconciliation, invariant tests, audit |
| Concurrency oversell | Stock disputes | Medium | Row-level locking/SKIP LOCKED, spike & load test in Phase 0 |
| Prisma limits with RLS/partitions | Complexity | Medium | Raw-SQL migrations, thin repository layer, spike in Phase 0 |
| Regulatory requirements unknown (track-and-trace, controlled drugs) | Rework | Medium | Early regulator/pharmacist consultation; GS1-ready design |
| DrugXOne API unavailable/unstable | Integration delay | Medium | Isolated adapter; canonical models; Phase 7 |
| User adoption/resistance | Failed rollout | Medium | Co-design, training, super-users, parallel run, fast support |
| Key-person dependency | Delay | Medium | Documentation, pairing, ADRs |
| Cloud cost/latency | Margin/UX | Low–Med | Region selection, caching, right-sizing, FinOps review |

## 6.8 Decisions needed from you to start Phase 0

1. Approve (or amend) the stack and the modular-monolith approach.
2. Confirm the MVP boundary (end of Phase 3) and the pilot customer.
3. Provide: sample invoices, price lists, product lists, a typical GRN/supplier invoice, current credit policy.
4. Name an accountant and a superintendent pharmacist who can answer compliance questions.
5. Choose hosting region/provider and repository hosting for later (nothing will be pushed until you say so).
6. Confirm team size/budget so timeline can be re-baselined.
7. Resolve the items in [07-ghana-compliance.md §3](07-ghana-compliance.md).
