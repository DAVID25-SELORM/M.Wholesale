# 5. UI/UX Specification

## 5.1 Design principles

1. **Speed over decoration** — users process hundreds of lines a day. Keyboard-first on desktop, scanner-first at counters and in the warehouse.
2. **Make the safe path the default** — FEFO auto-allocated, expired batches unselectable, credit status visible before a mistake is made.
3. **Explain every block** — when a sale is blocked ("Batch A123 recalled", "Credit limit exceeded by GHS 4,200"), say why and what the user can do (request override).
4. **Dense but legible** — compact tables, strong typographic hierarchy, restrained colour; colour is reserved for status (never the only signal).
5. **Works on modest hardware and connections** — 1366×768 laptops, low-end Android tablets, intermittent 3G/4G.
6. **One workflow, one place** — document pages contain the full lifecycle (lines, status timeline, approvals, payments, journal, audit).

## 5.2 Personas and primary devices

| Persona | Device | Primary tasks |
|---------|--------|---------------|
| Owner / GM | Laptop, phone | Dashboard, cash, margins, approvals on the go |
| Procurement | Desktop | POs, supplier invoices, reorder |
| Storekeeper / receiver | Tablet/phone + scanner | GRN, putaway, counts |
| Picker / packer | Handheld/Android + scanner | Pick, pack, label |
| Dispatcher / driver | Phone | Runs, POD |
| Counter cashier | Desktop + scanner + receipt printer | POS |
| Sales rep | Phone (offline) | Orders, customer balance, collections |
| Credit controller | Desktop | Ageing, reminders, promises |
| Accountant | Desktop | Journals, reconciliation, VAT, close |
| Superintendent pharmacist | Desktop/phone | Approvals, recalls, controlled register |

## 5.3 Information architecture

Left rail (collapsible) grouped by workflow; items appear only if the user has permission and the plan includes the module.

- **Home** (role dashboard)
- **Sales**: Orders, Invoices, Quotes, Credit notes, Returns, POS
- **Customers**: Customers, Statements, Credit control, Collections
- **Purchasing**: Requisitions, Purchase orders, Goods receipts, Supplier invoices, Supplier returns
- **Suppliers**
- **Inventory**: Stock overview, Batches & expiry, Transfers, Adjustments, Counts, Locations, Recalls & quarantine
- **Warehouse**: Pick queue, Pack, Dispatch
- **Delivery**: Runs, Routes, Vehicles & drivers
- **Finance**: Receipts, Payments, Expenses, Journals, Bank reconciliation, Tax, Reports
- **Catalogue**: Products, Price lists, Categories
- **Reports**
- **Data**: Imports/Exports
- **Admin**: Users & roles, Branches & warehouses, Settings, Subscription, Audit log, Integrations

Global elements: **command palette** (`Ctrl+K`: jump to anything, create document), global search (product/customer/invoice/batch number/barcode), branch/warehouse switcher, notifications bell (expiry, approvals, low stock, due payments), sync/offline indicator, user menu.

## 5.4 Visual system

- Tailwind + design tokens; shadcn/ui (Radix) components, customised. Light and dark themes; high-contrast option for bright warehouse screens.
- Type: Inter (or system UI fallback), tabular numerals for all numbers; right-aligned numeric columns; currency shown as `GHS 1,234.50`.
- Semantic palette: neutral base; brand accent (teal/green family suggested for pharmacy); status colours with icons + text: Available (green), Near expiry (amber), Expired/Recalled (red), Quarantine (purple), In transit (blue), Draft (grey).
- Expiry chips show remaining time (`4 mo`, `23 d`, `Expired`) and use the status colour + icon.
- 8-px spacing grid, 36-px default row height (28-px "compact" toggle), minimum 44-px touch targets in tablet/phone modes.
- Motion minimal; skeleton loaders; optimistic UI where safe (never for stock/money posting).

## 5.5 Core interaction patterns

- **Document page**: header (number, status chip, customer/supplier, dates), line grid with inline edit, side panel (totals, tax breakdown, credit exposure, approvals), tabs (Lines, Batches, Payments, Delivery, Journal, Audit, Attachments), sticky action bar (Save draft, Submit, Post, Print, More). Posted docs are read-only with "Create credit note / Reverse" actions.
- **Line grid**: spreadsheet-like — Tab/Enter navigation, type-ahead product search (name, generic, barcode, code), qty accepts `2c` (cartons) / `5b` (boxes) shortcuts, paste multiple lines from Excel, per-row inline warnings (low stock, short expiry, price below cost).
- **Batch picker**: shows FEFO-ordered batches with qty available, expiry chip, location; auto-selected; manual override needs permission + reason.
- **Lists**: saved filters/views, column chooser, multi-select bulk actions, export, virtualised rows, URL-shareable state.
- **Approvals**: inbox with context, approve/reject with comment, step-up auth for high-risk.
- **Forms**: inline validation, autosave drafts, unsaved-changes guard, duplicate warnings.
- **Empty states and onboarding checklists** per module (e.g. "Import products → Add warehouse → Receive opening stock").
- **Undo** only for non-posting actions; posting actions use confirmation with a plain-language summary ("Posting will reduce stock of 14 batches and create a debt of GHS 12,480").

## 5.6 Key screens (wireframe-level descriptions)

### A. Owner dashboard
KPI tiles (today sales, month-to-date vs last month, gross margin, cash collected, AR total & overdue, AP due this week, stock value). Charts: sales trend, top customers/products, collections vs target. Risk panel: expiry exposure by horizon (value at 30/60/90/180 days), credit-hold customers, slow stock value, pending approvals. Every tile drills into a filtered report.

### B. POS screen
Three zones: left scan/search + line list (large type), right totals & tender buttons, top customer chip (walk-in / pharmacy with balance & credit status). Always-visible: shift status, offline indicator, receipt printer status. Hotkeys: `F2` customer, `F4` hold, `F8` tender, `F9` cash, `F10` MoMo, `Esc` cancel line. Scanned item flashes a confirmation with name/strength/batch/expiry; short-dated or controlled items prompt inline. Supervisor PIN modal for void/discount/price override.

### C. Wholesale invoice / order entry
Customer header with credit-exposure bar (limit, used, this order, remaining) and licence validity flag. Line grid as per §5.5; right panel shows tax breakdown, margin (permission-gated), and approval requirements triggered. "Check availability" shows alternatives. Post → generates pick task or invoice depending on settings.

### D. Goods receipt (GRN) – tablet-first
Step flow: select PO/supplier → scan or search item → enter/scan batch & expiry (camera/GS1 parsing) → qty / bonus → condition & temperature → next. Running discrepancy panel (short/over/damaged). Photos attachable. Finish → quarantine items auto-routed, putaway tasks created.

### E. Pick & pack (handheld)
Task card shows: location, product, **batch to pick**, qty. Scan location → scan product/batch → confirm qty. Wrong batch scan = hard stop with sound/vibration. Progress bar per order; short-pick prompts substitute/backorder. Pack screen to assign picked items to cartons and print labels.

### F. Batch & expiry explorer
Table by product → batch with on-hand, value, days-to-expiry, location, supplier; heat-bar for expiry horizon; bulk actions (create supplier return, markdown, transfer to fast-moving branch, quarantine). Trace button opens the traceability view.

### G. Traceability view
Single input (batch no./product/invoice). Timeline graph: Supplier invoice → GRN → warehouse movements → customers (invoice, qty, date, delivery status). Export PDF/Excel, "Start recall" button.

### H. Recall console
Recall header (source, class, deadline), scope (batches), exposure summary (distributed / on hand / recovered), customer notification tracker, returns checklist, reconciliation and close-out. Big red status banner; blocked stock visible everywhere with a recall badge.

### I. Credit control
Ageing matrix (customers × buckets) with colour intensity; list view with filter by rep/region/bucket; customer drawer: invoices, promises, notes, one-click reminder (SMS/WhatsApp), hold/release actions, statement PDF.

### J. Receipts & allocation
Receive payment → select customer → auto-lists open invoices (oldest first) → type amount → auto-allocate or manual → remainder to on-account → receipt preview/send.

### K. Delivery run / driver app
Manifest list ordered by stop; each stop: customer, address, call button, invoices, cash due. Actions: Arrived, Delivered (signature + photo), Failed (reason), Return items. Offline-capable; syncs when online.

### L. Import wizard
Upload → auto-detect template → map columns → preview with error/warning counts → fix inline or download error file → commit → result summary with links.

### M. Admin: roles & permissions
Matrix of permissions grouped by module with scope selector; clone role; "view as" preview; separation-of-duties warnings.

## 5.7 Responsive behaviour

| Breakpoint | Behaviour |
|-----------|-----------|
| ≥ 1280 | Full left rail, multi-column document layout |
| 1024–1279 | Rail collapses to icons; side panels collapse to drawers |
| 768–1023 (tablet) | Touch-optimised density, bottom action bar, GRN/count/pick flows optimised |
| < 768 (phone) | Role-focused simplified apps: sales rep, driver, picker, approvals, dashboard; full admin screens remain accessible but not optimised |

## 5.8 Accessibility and localisation

- WCAG 2.1 AA: colour contrast, focus rings, ARIA labels, screen-reader-friendly tables, no colour-only signals, reduced-motion.
- Keyboard shortcuts documented (`?` opens cheat sheet).
- Strings externalised (i18next); English default; planned Twi, Ga, Ewe, Hausa, French packs for UI chrome (not for regulatory text).
- Number/date/phone formatting per locale (`+233`), Ghana Post GPS digital address field on addresses.

## 5.9 Printing and documents

Templates (HTML → PDF/thermal): sales invoice (with batch/expiry optional columns), proforma, delivery note, packing list, picking list, receipt, customer statement, purchase order, GRN, credit note, transfer note, recall notice, destruction certificate, controlled-drug register page, Z-report. Tenant branding (logo, colours, TIN, licence numbers, bank/MoMo details, footer terms). Template versions are pinned to posted documents for reproducibility.

## 5.10 Usability validation

- Prototype in Figma for POS, invoice entry, GRN, pick, credit control before build; test with 3–5 real users per persona (cashier, storekeeper, accountant).
- Success metrics: new cashier completes 10-line sale < 90 s after 30 min training; GRN of 20 lines < 5 min; invoice-to-pick handoff < 1 min; zero training needed for driver POD.
- Pilot instrumentation (task time, error rates, abandoned flows) to drive iteration.
