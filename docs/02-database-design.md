# 2. Database Design

PostgreSQL 16. Conventions apply to every table unless stated.

## 2.1 Conventions

- PK `id uuid` (UUIDv7 generated in app for index locality). Human numbers (`INV-2026-000123`) are separate columns.
- `tenant_id uuid NOT NULL` + RLS policy on every tenant table. Foreign keys are composite where practical: `(tenant_id, x_id)` → `(tenant_id, id)` to make cross-tenant references impossible.
- Audit columns: `created_at, created_by, updated_at, updated_by, row_version`.
- Money `numeric(18,4)`, quantities `numeric(18,4)` in **base unit**, rates `numeric(9,6)`. Rounding rules centralised (documents round at line level, then sum — configurable per tax regime).
- Master data: `archived_at timestamptz` (soft delete). Documents: `status` enum, never deleted.
- Enums as Postgres enums or lookup tables (lookup where tenants can extend).
- Large append-only tables (`stock_movements`, `audit_log`, `journal_lines`) partitioned by month on `occurred_at`/`created_at`.

## 2.2 Entity overview (by domain)

### Platform / tenancy
`tenants`, `branches`, `warehouses`, `warehouse_locations` (zone/aisle/rack/bin, with `type`: SALEABLE, QUARANTINE, DAMAGED, EXPIRED, RECALL_HOLD, RETURNS, COLD_CHAIN, CONTROLLED), `tenant_settings`, `plans`, `subscriptions`, `licences`, `licence_events`, `feature_flags`, `number_sequences`, `files`.

### Identity & access
`users`, `user_credentials`, `user_mfa`, `sessions`, `roles`, `permissions`, `role_permissions`, `user_role_assignments` (role + scope: tenant / branch_ids / warehouse_ids), `approval_policies` (e.g. discount > x% needs manager), `api_keys`, `login_events`.

### Catalogue
- `products` — generic name, brand name, product type (ETHICAL, OTC, CONTROLLED, MEDICAL_DEVICE, CONSUMABLE, COSMETIC, SUPPLEMENT), dosage form, strength, route, therapeutic class (ATC code), manufacturer, country of origin, FDA registration number + expiry, schedule/legal class (POM / P / GSL / controlled schedule), storage conditions (ambient / cold 2–8 °C / frozen / protect from light), `tax_category_id`, `track_batch` (default true), `track_serial`, `min_shelf_life_days_on_receipt`, reorder policy fields, `is_controlled`, `requires_prescription`.
- `product_units` — packaging hierarchy: `unit_name` (tablet, strip, box, carton), `factor_to_base`, `is_sellable`, `is_purchasable`.
- `product_barcodes` — GTIN/EAN/internal, per `product_unit`; unique per tenant.
- `product_suppliers` — preferred supplier, supplier SKU, lead time, last cost.
- `price_lists`, `price_list_items` (product_unit, price, valid_from/to, min_qty tiers), `customer_price_rules` (customer or customer group overrides), `promotions`.
- `manufacturers`, `therapeutic_classes`, `product_categories`, `substitution_groups` (same generic equivalents).

### Parties
- `suppliers` — name, type (MANUFACTURER, IMPORTER, LOCAL_DISTRIBUTOR), TIN, FDA/Pharmacy Council licence + expiry, payment terms, currency, bank details (encrypted), `approval_status` (approved supplier list).
- `customers` — pharmacy / hospital / clinic / chemical seller / institution / government / retail; business name, TIN, licence details (Pharmacy Council / FDA premises licence + expiry), `customer_group_id`, default price list, credit terms, credit limit, `credit_status` (OK, WATCH, ON_HOLD, BLOCKED), sales rep, delivery route.
- `party_contacts`, `party_addresses` (with GPS), `party_documents` (licences, scans, with expiry alerts), `customer_groups`.

### Inventory
- `batches` — `(tenant, product_id, supplier_id?, batch_no, mfg_date, expiry_date, unit_cost_base, status)`; unique `(tenant_id, product_id, batch_no, expiry_date)`; `status` ∈ AVAILABLE, QUARANTINE, RECALLED, EXPIRED, BLOCKED. Expiry is mandatory.
- `stock_balances` — `(tenant, warehouse_id, location_id, batch_id)` → `qty_on_hand`, `qty_reserved`, `qty_quarantine`; `CHECK (qty_on_hand >= 0)`, `CHECK (qty_reserved <= qty_on_hand)`.
- `stock_movements` (append-only, partitioned) — `movement_type` (RECEIPT, SALE, SALE_RETURN, PURCHASE_RETURN, TRANSFER_OUT, TRANSFER_IN, ADJUST_IN, ADJUST_OUT, COUNT_VARIANCE, STATUS_CHANGE, WRITE_OFF, DESTRUCTION, RECALL_HOLD, RECALL_RELEASE), `qty_delta`, `unit_cost`, `warehouse_id`, `location_id`, `batch_id`, `source_doc_type`, `source_doc_id`, `source_line_id`, `reason_code`, `occurred_at`, `posted_by`. Trigger blocks UPDATE/DELETE.
- `stock_reservations` — order line → batch reservation with expiry.
- `stock_transfers`, `stock_transfer_lines` (statuses: DRAFT, APPROVED, IN_TRANSIT, PARTIALLY_RECEIVED, RECEIVED, CANCELLED; in-transit stock held in a virtual transit location so nothing vanishes).
- `stock_adjustments`, `adjustment_lines` with `reason_code` (DAMAGE, THEFT, EXPIRED, COUNT, SAMPLE, DESTROYED…), approval, evidence file.
- `stock_counts`, `stock_count_lines` (blind count, variance, recount, approval) — cycle counts by zone/ABC class.
- `reorder_policies`, `expiry_policies` (alert at 180/90/60/30 days, block-sale threshold, short-dated discount rules).
- `destruction_certificates` — witnesses, regulator reference, linked write-offs.

### Procurement
`purchase_requisitions`, `purchase_orders`/`_lines`, `goods_receipts` (GRN)/`_lines` (batch no., expiry, qty, bonus qty, cost, discrepancy/rejection reason, temperature on arrival), `supplier_invoices`/`_lines` (supplier's invoice number, date, tax lines, 3-way match status), `supplier_credit_notes`, `purchase_returns`, `supplier_payments`, `supplier_payment_allocations`, `landed_cost_charges` + allocations, `supplier_price_history`.

### Sales
`quotations`, `sales_orders`/`_lines`, `sales_invoices`/`_lines` (each line references **batch allocations**), `invoice_line_batches` (invoice line → batch → qty → cost: this is the traceability link), `credit_notes`/`_lines`, `sales_returns`/`_lines` (with return reason, condition, restock decision), `delivery_notes`, `price_overrides` (who approved), `proforma_invoices`.
POS: `pos_terminals`, `pos_shifts` (float, cash-up, variance), `pos_sales` (use `sales_invoices` with `channel='POS'` — one invoice table, channel column), `held_sales`.

### Receivables & payments
`payment_receipts` (customer, method, amount, reference, date, status), `receipt_allocations` (receipt → invoice, amount), `unallocated_credit` (on-account balance), `payment_methods` (cash, bank transfer, cheque, MoMo-MTN/Telecel/AT, card, offset), `cheques` (post-dated, banked, cleared, bounced), `bank_accounts`, `bank_statement_imports`/`_lines`, `bank_reconciliations`, `customer_statements`, `dunning_events` (reminders sent), `credit_limit_changes` (history + approver), `bad_debt_writeoffs`, `payment_promises`.

### Finance
`chart_of_accounts` (code, type, parent, tax mapping, `is_control`), `fiscal_years`, `fiscal_periods` (open/soft-close/hard-close), `journal_entries`, `journal_lines` (partitioned; `account_id, debit, credit, party_id?, dimension: branch, cost_centre`), `account_mappings` (event type → accounts), `expense_categories`, `expenses`/`expense_lines` (attachments, approval, paid-from), `recurring_journals`, `tax_codes`, `tax_rates` (effective-dated), `tax_returns`, `exchange_rates`, `budgets`, `assets` (fixed assets, depreciation — phase 4).
Constraint: deferred constraint trigger asserts `SUM(debit) = SUM(credit)` per entry at commit.

### Quality, returns & recalls
`recalls` (source: FDA / manufacturer / internal; class I/II/III; scope products/batches; status; instructions), `recall_batch_scope`, `recall_actions` (per affected customer: notified, returned, reconciled quantity), `quarantine_holds`, `quality_incidents`/`complaints`, `temperature_logs` (cold-chain readings), `controlled_drug_register` (per-transaction running balance for controlled items, witness fields), `adverse_event_reports` (ADR forwarded to FDA).

### Fulfilment & delivery
`pick_waves`, `pick_tasks`/`_lines` (suggested batch + location FEFO; scanned confirmation), `packing_units` (cartons/cooler boxes, weight, seal no.), `dispatch_notes`, `delivery_routes`, `vehicles`, `drivers`, `delivery_runs` (route + vehicle + driver + date), `delivery_stops` (invoice, ETA, status, signature, photo, GPS, cash collected, returns on the spot), `delivery_exceptions`.

### Data exchange, integration, audit
`import_jobs`/`import_rows` (staging + per-row errors), `export_jobs`, `saved_reports`, `report_schedules`, `external_refs`, `outbox_events`, `webhook_endpoints`/`deliveries`, `notifications`, `notification_templates`, `audit_log` (partitioned: actor, action, entity, entity_id, before/after JSONB, ip, device, request_id).

## 2.3 Key relationships (traceability spine)

```
supplier ─< supplier_invoice ─< supplier_invoice_line >─ goods_receipt_line ─> batch
                                                                  │
                                      stock_movements (RECEIPT) ◄─┘
batch ─< stock_balances (warehouse/location)
batch ─< invoice_line_batches >─ sales_invoice_line >─ sales_invoice >─ customer
batch ─< stock_movements (SALE / TRANSFER / RETURN / ADJUST / DESTRUCTION)
recall ─< recall_batch_scope >─ batch  ⇒  invoice_line_batches ⇒ affected customers
```

Two canned queries must stay fast (index-backed, tested on 50M movements):
- **Forward trace**: batch → every customer/invoice that received it, with quantities and dates.
- **Backward trace**: customer invoice line → batch → GRN → supplier invoice → supplier.

## 2.4 Critical constraints and invariants

| Invariant | Mechanism |
|-----------|-----------|
| No stock without batch + expiry | `NOT NULL` + FK from `stock_balances.batch_id` |
| Stock never negative (unless tenant flag) | `CHECK` + serialised updates in posting transaction |
| Expired/recalled/quarantined batches cannot be sold | Allocation query filters `status` and `expiry_date > today + min_days`; DB trigger rejects `invoice_line_batches` on blocked batches (defence in depth) |
| Movements immutable | `BEFORE UPDATE OR DELETE` trigger raises exception |
| `stock_balances` = Σ `stock_movements` | Nightly reconciliation job + alert on drift |
| Journals balance | Deferred constraint trigger |
| Posted documents immutable | Status-guard trigger; reversals only |
| Invoice number gap-free & unique | `number_sequences` locked row; unique `(tenant_id, doc_type, number)` |
| Payment allocations ≤ receipt and ≤ invoice outstanding | Constraint trigger / checked in transaction |
| No posting in locked period | Trigger on `journal_entries` and stock movements dated in hard-closed periods |
| Credit limit | Evaluated in the same transaction as invoice approval (exposure = outstanding AR + open orders − unallocated receipts) |
| Cross-tenant impossibility | RLS + composite FKs |

## 2.5 Indexing and performance

- Composite indexes lead with `tenant_id`.
- Batch picking: partial index on `stock_balances (tenant_id, warehouse_id, product_id, expiry_date) WHERE qty_on_hand - qty_reserved > 0` (denormalise `product_id`, `expiry_date` into balances for FEFO scans).
- `pg_trgm` GIN on product names, generic names, customer names; B-tree on barcodes.
- Partition `stock_movements`, `journal_lines`, `audit_log` monthly; detach/archive old partitions to cold storage after the retention window.
- Reporting: materialised views (refreshed by worker) for stock valuation, ageing, sales summary; heavy analytics hit a read replica.
- Expiry sweeps: a nightly job flips `batches.status` to EXPIRED and moves stock into the EXPIRED location through proper movements (not silent updates).

## 2.6 Accounting design

- Default Ghana wholesale chart of accounts template seeded per tenant (editable).
- **Event → journal mappings** (configurable):
  - *GRN posted*: Dr Inventory, Cr GRNI (goods received not invoiced).
  - *Supplier invoice posted*: Dr GRNI (+ price variance), Dr Input tax, Cr Accounts payable.
  - *Sales invoice posted*: Dr AR (or Cash/Clearing for POS), Cr Sales revenue by category, Cr Output tax(es); and Dr COGS, Cr Inventory using the allocated batch costs.
  - *Receipt*: Dr Bank/Cash/MoMo clearing, Cr AR (or Customer deposits if unallocated).
  - *Credit note / return*: reverse revenue and tax; restock → Dr Inventory, Cr COGS (or Dr Write-off if not restockable).
  - *Adjustment/write-off/destruction*: Dr Inventory loss/expiry expense, Cr Inventory.
  - *Transfers*: inter-branch via transit account if branches are separate cost centres.
- Reports derive from the ledger: trial balance, P&L, balance sheet, cash flow (indirect), AR/AP ageing, inventory valuation reconciling to the Inventory control account.

## 2.7 Data retention and archiving

- Financial documents & ledgers: ≥ 7 years (statutory — confirm with accountant); stock movements & batch trace: retain for at least product shelf-life + regulatory minimum (default 7 years, configurable up).
- Audit log: ≥ 7 years; PII minimisation for deactivated users (pseudonymise, keep audit references).
- Archive strategy: old partitions to compressed object storage, queryable on demand.

## 2.8 Migration & seed data

- Prisma schema for models; raw SQL migrations (checked in, reviewed) for RLS policies, triggers, partitions, extensions.
- Seeds: tax codes (config), chart of accounts template, roles/permissions, reason codes, units of measure, dosage forms, ATC classes (import), regions/districts of Ghana, payment methods.
- Opening balance import wizard: products → customers/suppliers → open invoices (AR/AP) → opening stock by batch → trial balance; reconciliations enforced before go-live.
