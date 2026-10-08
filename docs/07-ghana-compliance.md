# 7. Ghana Pharmaceutical Wholesale — Compliance Mapping and Open Questions

> **Important:** This is an engineering interpretation to drive design, *not legal or tax advice*. Statutes, rates and guidance below are from general knowledge and must be verified by a Ghanaian chartered accountant, a pharmacist/regulatory consultant and counsel before they are encoded as defaults. Rates and rules are therefore modelled as **configuration**, never hard-coded.

## 1. Regulatory landscape (to verify)

| Body / instrument | Relevance to the software |
|-------------------|---------------------------|
| **Food and Drugs Authority (FDA)** — Public Health Act, 2012 (Act 851) | Product registration numbers, premises registration/licence, import permits, GDP/GSP expectations, recalls, adverse-event reporting, inspections |
| **Pharmacy Council** — Pharmacy Act, 2013 (Act 857) | Licensing of premises and pharmacists; the **Superintendent Pharmacist** responsibility; wholesale premises registration; chemical sellers' regulation |
| **Narcotics Control Commission** & controlled-substances legislation | Controlled/narcotic drug records, permits, quantities, reporting (confirm current Act and schedules) |
| **Ghana Revenue Authority (GRA)** — Value Added Tax Act, 2013 (Act 870) and amendments, Income Tax Act, 2015 (Act 896), E-VAT / invoicing requirements | VAT & levies on invoices, TIN, returns, withholding tax, e-invoicing obligations, record-keeping |
| **Data Protection Commission** — Data Protection Act, 2012 (Act 843) | Registration as data controller, lawful processing, security safeguards, breach notification |
| **National Health Insurance Authority (NHIA)** | Mostly relevant to retail/hospital customers; wholesaler needs to support NHIS-claim-related pricing/product flags only if customers require it |
| **Ghana Standards Authority / customs** | Imported goods documentation (landed cost, import declarations) |

## 2. How requirements map to software features

### 2.1 Batch traceability (GDP expectation)
- Every unit received is tied to supplier, supplier invoice, GRN, batch, expiry; every unit issued is tied to batch and customer (`invoice_line_batches`).
- Forward/backward trace reports ≤ 10 s; exportable inspection pack.
- Batch number + expiry mandatory; same batch/different expiry flagged.
- Immutable ledger and audit satisfy "record cannot be altered without trace".

### 2.2 Expiry management
- FEFO enforced; configurable minimum remaining shelf-life on receipt and sale; automatic blocking and movement to an **expired/quarantine** area; destruction certificate workflow; supplier return of near-expiry stock where contracts allow.

### 2.3 Storage conditions / cold chain
- Product storage class; locations typed (ambient / cold / controlled); temperature log capture at receipt, storage (manual or later IoT), and transit; excursion workflow requiring pharmacist disposition.

### 2.4 Supplier invoices and approved suppliers
- Capture supplier invoice number (duplicate prevention per supplier), date, TIN, line tax, discounts; attach original; 3-way match. Approved-supplier list with licence validity checks (FDA/Pharmacy Council/manufacturer licence).

### 2.5 Customer licensing
- Customers (pharmacies, chemical sellers, hospitals) hold licence numbers + expiry; policy options: warn or block sales when licence expired; restrictions on selling prescription-only or controlled products to unlicensed buyers.

### 2.6 Credit transactions
- Credit terms, limits, exposure, ageing, holds, dunning, cheque register, bad-debt write-off with approval and GL impact. All statements and balances reproducible at any past date (as-at reporting). Interest/late fees are **optional and off by default** (confirm contractual/legal position).

### 2.7 VAT configuration (design — rates to be verified)
- Tax is modelled as: `tax_codes` (e.g. STANDARD, EXEMPT, ZERO_RATED, plus individual levy components) → `tax_rates` (effective-dated, with component breakdown and whether each component is recoverable) → assigned via **product tax category** and **customer tax status**.
- Ghana's regime has historically combined VAT with NHIL, GETFund and COVID-19 Health Recovery levies and has been reformed in recent years (including a flat-rate scheme for small traders and changes to levy treatment). **Do not hard-code**: the accountant must confirm for each category (many medicines/medical supplies have historically been VAT-exempt or relieved — whether a given SKU is exempt must be a product-level attribute, not a product-type assumption).
- Supports: tax-inclusive/exclusive pricing; line-level rounding policy; input vs output tax; non-recoverable input tax cost-loading; VAT return workpaper (output by code, input by code, net payable); credit notes reversing tax; TIN on invoices (supplier and customer); tenant VAT registration status and number.
- All posted documents snapshot the tax code, rate and amounts used.

### 2.8 E-VAT / GRA invoicing
- Confirm whether the tenant must issue invoices through GRA's E-VAT system (and the integration mode: API vs device). Software reserves `evat_reference`/`evat_qr` fields, an adapter interface, and a "submission queue with retry". Offline behaviour must be defined with GRA rules.

### 2.9 Controlled drugs
- Controlled-drug register with running balance per product/batch and per location, transaction witness, supplier/customer licence/permit reference, periodic reconciliation, restricted roles, and export in the regulator's format (format to be obtained).

### 2.10 Recalls and quality
- Recall registered → matching batches placed on RECALL_HOLD in all warehouses → customers listed from sales history → notification → returns tracked → reconciliation and close-out report. Mock-recall drills with timing. Complaint and adverse-event capture with regulator report export (format to be obtained).

### 2.11 Record retention
- Default 7 years for financial and stock/traceability records (verify minimums for tax and FDA); configurable; archived not deleted.

### 2.12 Withholding tax and statutory items
- Withholding tax on specified supplier payments, SSNIT/PAYE payroll are **out of scope** for the first releases (payroll integration later); capture WHT on supplier payments as optional configuration after accountant confirmation.

## 3. Open questions that need your decision (blocking or high-impact)

| # | Question | Why it matters | Needed by |
|---|----------|---------------|-----------|
| 1 | Who is the pilot customer, and how many branches/warehouses/users/SKUs do they have? | Sizing, workflows, MVP scope | Phase 0 |
| 2 | Are your target customers VAT-registered? Which of their products are exempt/standard/zero-rated, and which levies apply? Can an accountant sign off the tax matrix? | Invoice correctness | Phase 0 |
| 3 | Is GRA E-VAT integration mandatory for the target tenants, and in which mode? | Phase 3 vs 6 timing | Phase 1 |
| 4 | Do tenants handle controlled/narcotic drugs, and which register format is required? | FR-13/controlled register scope | Phase 2 |
| 5 | Which FDA/Pharmacy Council fields and documents must appear on invoices/delivery notes? | Document templates | Phase 1 |
| 6 | Is FDA track-and-trace / serialisation expected soon (GS1 DataMatrix)? | Barcode/serial design | Phase 2 |
| 7 | Hosting: AWS Cape Town vs another region/provider; any data-residency preference or requirement? | Latency, compliance, cost | Phase 0 |
| 8 | Preferred payment providers (MTN MoMo, Telecel Cash, AirtelTigo Money, Hubtel, Paystack, bank)? | Integration plan | Phase 3 |
| 9 | Messaging: SMS sender ID, WhatsApp Business account available? | Reminders/statements | Phase 3 |
| 10 | DrugXOne: API docs, auth, data model, commercial terms, timeline? | FR-20 scope | Phase 5 |
| 11 | Commercial model: SaaS subscription tiers/pricing, trial length, who provides support? | Licensing design | Phase 1 |
| 12 | Hardware standards: barcode scanners, thermal printers, label printers, tablets/handhelds you will support or certify? | Compatibility testing | Phase 2 |
| 13 | Credit policy defaults: allow interest on late payments? post-dated cheques common? | Credit module rules | Phase 3 |
| 14 | Negative stock: allowed ever? Backdating limits? | Posting rules | Phase 2 |
| 15 | Is payroll/HR in scope later? Fixed assets? | Finance scope | Phase 4 |
| 16 | Product master source: will you bootstrap from a licensed drug database or build per-tenant? | Data-entry burden | Phase 1 |
| 17 | Brand/product name, logo, domain | Branding & tenancy URLs | Phase 1 |
| 18 | Repository hosting and CI provider (nothing is pushed until you approve) | Delivery tooling | Phase 0 |

## 4. Country-pack boundary (for international expansion)

Items that vary by country and must live in a `CountryPack`, not in core code: tax codes & rate logic, e-invoicing adapter, regulator identifier fields and validations, controlled-drug register format, required document legends, currency/rounding/decimal conventions, public holidays, address formats, statutory report templates, default chart-of-accounts template, data-protection settings, retention defaults.
