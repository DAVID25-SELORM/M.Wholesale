# 3. Functional Requirements

Priority: **M** = MVP (phases 1–3), **S** = Should (phases 4–5), **C** = Could/later. IDs are stable references for tests and tickets.

## Personas (roles)

Owner/MD, General Manager, Branch Manager, Superintendent Pharmacist, Procurement Officer, Warehouse Manager, Storekeeper/Picker, Packer/Dispatcher, Driver, Sales Rep (field), Counter/POS Cashier, Accountant, Credit Controller, Auditor (read-only), Platform Admin (vendor).

---

## FR-01 Pharmaceutical product management
- 01.1 **M** Create products with generic + brand name, strength, dosage form, pack hierarchy, manufacturer, ATC class, legal class (POM/P/GSL/controlled), FDA registration no. and expiry, storage conditions, tax category.
- 01.2 **M** Multiple barcodes per pack level (GTIN-13/14, internal); scan to find.
- 01.3 **M** Duplicate detection (name + strength + form + manufacturer) and merge tool with full history retention.
- 01.4 **M** Block sale/purchase of products whose FDA registration is expired (configurable warn vs block).
- 01.5 **M** Substitution groups (same generic) shown at sale when out of stock.
- 01.6 **M** Reorder level, max level, lead time, ABC class; suggested reorder quantities from sales velocity.
- 01.7 **S** Product images, leaflets (PIL/SmPC) attachments.
- 01.8 **S** Price lists: wholesale, retail, institutional, per-customer-group, tier/quantity breaks, effective dating, margin guardrails (min margin warning).
- 01.9 **S** Bulk price update with preview and approval; price-change history.
- 01.10 **C** Import from a pharmaceutical master list (e.g. Ghana EML / FDA register / DrugXOne catalogue).

## FR-02 Multi-warehouse inventory
- 02.1 **M** Multiple warehouses per branch; locations (zone/rack/bin) with types (saleable, quarantine, damaged, expired, returns, recall hold, cold chain, controlled).
- 02.2 **M** Real-time on-hand, reserved, available, in-transit, quarantined per product/batch/warehouse/location.
- 02.3 **M** Stock ledger with full movement history; drill from any balance to its movements.
- 02.4 **M** Reservation on order confirmation, auto-release on cancel/timeout.
- 02.5 **M** Stock valuation at batch cost / weighted average; valuation report reconciling to GL.
- 02.6 **S** Cycle counting plans (by zone, ABC), blind counts, variance approval, recount.
- 02.7 **S** Min/max replenishment suggestions between warehouses.
- 02.8 **C** Bin-level slotting suggestions, putaway rules.

## FR-03 Batch and expiry tracking
- 03.1 **M** Batch number and expiry date mandatory at receipt; optional mfg date; scan GS1 DataMatrix/128 where present.
- 03.2 **M** **FEFO** auto-allocation on sales/picking (override requires permission + reason).
- 03.3 **M** Minimum remaining shelf-life rules: at receipt (reject/flag if < X months or < Y% of life), and per customer (e.g. hospitals require ≥ 12 months).
- 03.4 **M** Expiry dashboard and alerts at configurable horizons (e.g. 180/90/60/30 days), grouped by supplier for return-to-supplier negotiation.
- 03.5 **M** Expired batches auto-blocked from sale and moved to the expired location through proper movements.
- 03.6 **M** Same batch number with different expiry is treated as a distinct batch and flagged for review.
- 03.7 **M** Full traceability both directions (forward: batch → customers; backward: invoice → batch → supplier invoice), exportable PDF/Excel within seconds.
- 03.8 **S** Short-dated stock promotion rules (auto discount tiers by remaining days).
- 03.9 **S** Serial-number tracking for flagged products / devices.
- 03.10 **C** Aggregation/serialisation support when Ghana FDA track-and-trace requirements are confirmed.

## FR-04 Purchasing and procurement
- 04.1 **M** Purchase requisition → PO → approval workflow (value thresholds, role-based).
- 04.2 **M** PO printing/PDF/email/WhatsApp to supplier; PO status (open, partial, closed).
- 04.3 **M** **Goods Receipt (GRN)** against PO or blind: scan product, enter batch/expiry/qty/bonus qty, cost, discrepancies (short/over/damaged/near-expiry), temperature on arrival for cold-chain; photo evidence; rejected qty goes to quarantine.
- 04.4 **M** **Supplier invoice capture** with supplier's invoice number (duplicate check on supplier+number), date, line tax, discounts, freight; scan/attach; three-way match (PO–GRN–invoice) with tolerance and exceptions queue.
- 04.5 **M** Bonus/free goods handling (e.g. 10+1) with correct effective cost.
- 04.6 **M** Supplier credit notes and purchase returns (expired/damaged/recalled) with approval and stock deduction by batch.
- 04.7 **S** Landed cost allocation (freight, clearing, duty) across GRN lines.
- 04.8 **S** Supplier price comparison across suppliers; last-cost and cost-variance alerts.
- 04.9 **S** Auto-suggested POs from reorder policies; consolidated multi-warehouse needs.
- 04.10 **S** Import PO/foreign currency purchases with FX.

## FR-05 Supplier management
- 05.1 **M** Supplier master with licences (FDA/Pharmacy Council/manufacturing), TIN, bank details, payment terms; expiry alerts on licences.
- 05.2 **M** Approved Supplier List: block POs to unapproved or licence-expired suppliers (configurable).
- 05.3 **M** Supplier ledger/statement, ageing payables, due-date calendar.
- 05.4 **M** Supplier payments (bank, cheque, MoMo, cash) with allocation to invoices; WHT handling where applicable (see doc 7).
- 05.5 **S** Supplier performance scorecard (fill rate, on-time, short-expiry rate, returns rate, price stability).
- 05.6 **S** Supplier portal/e-mail confirmations (later).

## FR-06 Wholesale sales and invoicing
- 06.1 **M** Quote → sales order → pick/pack → invoice → delivery; or direct invoice; or order-to-invoice on dispatch (tenant setting).
- 06.2 **M** Customer-specific pricing, quantity breaks, line and invoice discounts with approval thresholds; price override audit.
- 06.3 **M** Auto batch allocation (FEFO) shown on invoice and delivery note; split lines across batches.
- 06.4 **M** Stock availability check with substitute suggestions; backorder support.
- 06.5 **M** Credit-limit and overdue checks at order and at invoice posting; override with approval and reason; credit hold.
- 06.6 **M** Tax computed per line from tax category/customer status (exempt, zero-rated, standard); invoice displays tax breakdown and TIN; supports tax-inclusive/exclusive pricing.
- 06.7 **M** Invoice PDF (A4) and thermal formats with tenant branding, bank/MoMo details, terms, batch & expiry columns (configurable), QR code.
- 06.8 **M** Credit notes (price, quantity, return, bad stock) referencing original invoice; cannot exceed invoiced quantity.
- 06.9 **M** Unique, sequential, gap-free numbering per branch/year; posted invoices immutable.
- 06.10 **S** Sales rep field orders on mobile (offline), customer visit notes, targets & commissions.
- 06.11 **S** Standing/recurring orders; customer self-service reorder via link/portal.
- 06.12 **S** E-VAT / GRA e-invoice submission where required.
- 06.13 **C** B2B customer portal; ordering via DrugXOne channel.

## FR-07 POS and barcode scanning
- 07.1 **M** Fast scan-driven sale screen: scan/search, qty by pack level, auto FEFO batch, running totals, tender split (cash/MoMo/card/credit-on-account).
- 07.2 **M** Hold/resume sales; line voids and returns with supervisor PIN; every override logged.
- 07.3 **M** Shifts: opening float, cash drops, cash-up with expected vs counted variance, Z-report.
- 07.4 **M** Thermal receipt printing (80 mm) and A4 invoice reprint with "duplicate" marker.
- 07.5 **M** Walk-in vs registered customers; POS credit sale only to credit-approved customers.
- 07.6 **M** Offline mode for cash sales with sync exception queue.
- 07.7 **S** Customer-facing display, cash drawer kick, scale integration.
- 07.8 **S** Loyalty/discount cards for retail-type customers.

## FR-08 Customer and pharmacy accounts
- 08.1 **M** Customer types: community pharmacy, chemical seller, hospital, clinic, institution, government/NHIS-related, distributor, walk-in.
- 08.2 **M** Capture and verify licences (Pharmacy Council / FDA premises / chemical seller licence) with expiry alerts and sales blocking rules (configurable; controlled products require valid licence/permit).
- 08.3 **M** Multiple delivery addresses with GPS; contacts; sales rep; price list; payment terms; credit limit.
- 08.4 **M** Customer 360: orders, invoices, balance, ageing, last payments, returns, top products, notes.
- 08.5 **S** Customer segments, targets, dormant-customer alerts.
- 08.6 **S** Statement of account on demand and scheduled (email/WhatsApp).

## FR-09 Credit sales and debt management
- 09.1 **M** Credit terms (e.g. net 7/14/30, end-of-month, cheque-on-delivery) and per-customer credit limits with temporary uplift (expiry date, approver).
- 09.2 **M** Exposure = outstanding invoices + open orders − unallocated receipts; shown at order entry.
- 09.3 **M** Ageing (current, 1–30, 31–60, 61–90, 90+), by customer/rep/branch/region.
- 09.4 **M** Automatic credit hold policies (days overdue, limit breach) with release approval.
- 09.5 **M** Dunning: reminder schedule (SMS/WhatsApp/email), promise-to-pay tracking, collection notes, call logs.
- 09.6 **M** Post-dated cheque register; bounced-cheque handling reversing receipt and flagging customer.
- 09.7 **S** Bad-debt provision and write-off with approval and GL posting; recovery tracking.
- 09.8 **S** Customer risk scoring from payment history; suggested limits.
- 09.9 **S** Debt settlement plans (instalments).

## FR-10 Payment receipts and reconciliation
- 10.1 **M** Receipt entry for cash, bank transfer, cheque, MoMo (MTN/Telecel/AT), card; allocate to specific invoices or oldest-first; on-account/overpayment retained as credit.
- 10.2 **M** Receipt PDF/SMS to customer; receipts immutable (reverse only).
- 10.3 **M** Bank statement import (CSV/Excel) with auto-match suggestions and manual reconcile; reconciliation report with unreconciled items.
- 10.4 **M** Mobile-money clearing account reconciliation against provider statements.
- 10.5 **M** Daily collections summary per cashier/rep/branch; cash banked tracking.
- 10.6 **S** Payment-gateway integration with webhook auto-posting; payment links on invoices.
- 10.7 **S** Prompt-payment discount handling.

## FR-11 Financial accounting and expenses
- 11.1 **M** Chart of accounts (template + custom), fiscal years/periods, period open/close with lock.
- 11.2 **M** Automatic journals from all operational documents (see doc 2 §2.6); manual journals with approval and attachments; reversing journals.
- 11.3 **M** Expense capture: category, vendor, branch/cost centre, tax, attachment, approval, payment (cash/bank/petty cash).
- 11.4 **M** Reports: trial balance, general ledger, P&L, balance sheet, cash flow, AR/AP ageing, inventory valuation, VAT summary.
- 11.5 **M** VAT/levy tracking: output and input tax by code; VAT return workpaper export (see doc 7).
- 11.6 **S** Petty cash, fixed assets & depreciation, accruals/prepayments, budgets vs actuals, cost centres/branch P&L.
- 11.7 **S** Withholding tax capture on supplier payments; corporate/other statutory schedules.
- 11.8 **S** Multi-currency and FX revaluation.
- 11.9 **C** Export to external accounting systems.

## FR-12 Stock transfers and adjustments
- 12.1 **M** Inter-warehouse and inter-branch transfers: request → approve → pick → dispatch (in transit) → receive with discrepancies; batch-level.
- 12.2 **M** Adjustments with mandatory reason code, approval above threshold, attachment evidence, GL impact.
- 12.3 **M** Status changes by batch (quarantine ↔ available) with reason and authoriser.
- 12.4 **M** Write-off & destruction workflow generating a destruction certificate with witness fields and regulator reference.
- 12.5 **S** Stock count sessions (full & cycle) with variance posting.

## FR-13 Returns and pharmaceutical recalls
- 13.1 **M** Customer returns: reason (damaged, expired, wrong item, over-supply, recall), verification against original invoice+batch, disposition (restock, quarantine, destroy, return to supplier), credit note.
- 13.2 **M** Policy engine: return window, short-expiry acceptance rules, restocking only when storage conditions met and batch is saleable.
- 13.3 **M** **Recall management**: register recall (source, class, scope by product/batch), immediately place all matching batch stock on **RECALL_HOLD** across all warehouses; list every customer/invoice that received affected batches with quantities; generate notification letters/SMS; track returns per customer; reconcile recovered vs distributed vs on hand; close-out report for FDA/manufacturer.
- 13.4 **M** Recall drill mode (mock recall) with timing report for audits.
- 13.5 **S** Quality complaints and adverse-drug-reaction capture with regulator report export.
- 13.6 **S** Supplier return/credit follow-up for recalled and expired stock.

## FR-14 Warehouse picking, packing and dispatch
- 14.1 **M** Pick lists generated from confirmed orders, FEFO batch + location suggested, sorted by walking path; mobile scanning to confirm product + batch + qty.
- 14.2 **M** Short-pick handling (substitute, backorder, partial), re-allocation.
- 14.3 **M** Packing: cartons/cooler boxes, packing list, seals; label printing (carton labels with customer, invoice, contents).
- 14.4 **M** Dispatch note and delivery note; dispatch only when payment/credit status allows (configurable gate).
- 14.5 **S** Wave/batch picking and zone picking; pick productivity metrics.
- 14.6 **S** Cold-chain packing record (cooler type, ice pack, packed time).
- 14.7 **S** Controlled-substance double-verification at pick.

## FR-15 Delivery and distribution management
- 15.1 **M** Delivery runs: assign invoices to routes/vehicles/drivers; sequence stops; printable manifest.
- 15.2 **M** Driver mobile web view: stop list, navigation link, mark delivered/failed, **proof of delivery** (signature, photo, timestamp, GPS), on-the-spot returns and cash collection.
- 15.3 **M** Delivery status visible to sales/customer service; SMS/WhatsApp to customer with ETA/delivered.
- 15.4 **S** Route optimisation (distance/time windows), vehicle capacity, fuel and trip cost tracking.
- 15.5 **S** Third-party courier support with tracking number.
- 15.6 **S** Vehicle temperature logging for cold-chain deliveries.

## FR-16 Staff roles and permissions
- 16.1 **M** Role-based access control with fine-grained permissions (`module.resource.action`), scoped to tenant/branch/warehouse.
- 16.2 **M** Pre-built roles (see Personas) that tenants can clone and customise; separation-of-duties rules (creator ≠ approver; cash handler ≠ reconciler).
- 16.3 **M** Approval workflows configurable by document type and value (discounts, credit overrides, adjustments, write-offs, POs, expense payments).
- 16.4 **M** User lifecycle: invite, activate, suspend, offboard; session/device management; MFA.
- 16.5 **M** Activity log per user; field-level history on sensitive master data (credit limit, price, cost).
- 16.6 **S** Time-bound delegation (cover during leave); IP/device/location restrictions for privileged roles.

## FR-17 Reports, dashboards and analytics
- 17.1 **M** Role-specific dashboards (owner: sales/margin/cash/AR/AP/expiry exposure; warehouse: open picks, receiving queue; credit: ageing/promises; procurement: reorder/open POs).
- 17.2 **M** Standard reports: sales (by product/customer/rep/branch/category/period), margin, purchases, stock on hand/valuation, stock movement, expiry (by horizon), slow/fast/dead stock, reorder, ageing AR/AP, collections, expenses, P&L, VAT, controlled-drug register, recall status, batch trace.
- 17.3 **M** Filter, sort, group, drill-down, date comparison; export to Excel/CSV/PDF.
- 17.4 **S** Scheduled reports by email/WhatsApp; saved views; user-built report designer.
- 17.5 **S** Demand forecasting, seasonality, ABC-XYZ, stock cover, lost-sales analysis.
- 17.6 **C** BI connector (read replica/warehouse), embedded charts API.

## FR-18 Excel imports and exports
- 18.1 **M** Template-based imports: products, barcodes, price lists, customers, suppliers, opening stock (by batch), opening AR/AP, chart of accounts, users.
- 18.2 **M** Staged import: upload → map columns → validate → **row-level error report** → fix/re-upload → commit atomically; dry-run mode; import history and rollback for opening-balance imports.
- 18.3 **M** Export of any list/report to .xlsx/.csv respecting permissions and field-level masking; large exports run async and are delivered via download link.
- 18.4 **S** Saved mapping templates per supplier (e.g. supplier price lists / invoices as Excel).
- 18.5 **S** Fuzzy product matching on import (barcode > exact name > trigram) with review screen.

## FR-19 Subscription and licensing management
- 19.1 **M** Plans with feature flags and limits (branches, users, warehouses, POS terminals, invoices/month, storage).
- 19.2 **M** Tenant onboarding wizard (business details, TIN, branches, tax settings, opening data).
- 19.3 **M** Licence states: trial, active, grace, suspended (read-only), cancelled; enforced centrally; data export always allowed.
- 19.4 **S** Billing: invoices to tenants in GHS, MoMo/card/bank payment, receipts, dunning, add-ons; usage metering.
- 19.5 **S** Vendor admin console: tenant list, impersonation with audit (consent-gated), support tooling, health metrics.
- 19.6 **C** Reseller/partner hierarchy.

## FR-20 Future DrugXOne integration (readiness)
- 20.1 **M (design only)** Canonical product/price/order/stock models and `external_refs` mapping; adapter interface; outbox for outbound events; idempotent inbound order endpoint.
- 20.2 **S** Product catalogue sync (DrugXOne ↔ internal), GTIN/ATC mapping.
- 20.3 **S** Inbound orders from DrugXOne create sales orders with channel tag; availability and price publishing outbound.
- 20.4 **C** Settlement/payment status sync.
- *Blocked on*: DrugXOne API documentation, auth model, commercial agreement.

---

## Non-functional requirements (summary)

| ID | Requirement |
|----|-------------|
| NFR-1 | WCAG 2.1 AA, keyboard-first on desktop, touch-friendly on tablets/phones |
| NFR-2 | All screens usable at 1366×768 (common in Ghana) and on 360 px phones for warehouse/driver/sales |
| NFR-3 | Data-heavy tables virtualised, ≥ 100k rows; instant filtering |
| NFR-4 | Full audit trail of create/update/post/void/approve with before/after |
| NFR-5 | Daily automated backups; restore tested quarterly |
| NFR-6 | Light-data mode, compressed assets; works on slow 3G for core flows |
| NFR-7 | Localisation: GHS formatting, `dd/MM/yyyy`, English now; i18n-ready |
| NFR-8 | Every posted document reproducible as PDF from stored snapshot (template version pinned) |
| NFR-9 | Zero data loss on offline sync; duplicates impossible |
| NFR-10 | Accessibility of invoices/receipts for printing in black-and-white on dot-matrix/thermal |

## Key business rules (cross-cutting)

1. A sale line without an allocated, saleable batch cannot be posted.
2. Credit sale cannot post if exposure + invoice > limit unless approved override.
3. Cost and price changes never rewrite history; documents snapshot price, cost, tax at posting.
4. Controlled medicines require licensed-buyer verification and are written to the controlled-drug register with running balance.
5. A recall hold overrides all other statuses and cannot be lifted without Superintendent Pharmacist approval.
6. Backdating beyond a configurable limit requires approval; closed periods are immutable.
7. The Superintendent Pharmacist (named per licensed premises) is a first-class role: required approver for controlled drugs, recalls, destruction, and quarantine release.
