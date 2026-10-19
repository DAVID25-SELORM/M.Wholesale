# Settings

Administration → **Settings** (`/admin/settings`). Every control on that screen saves and reads real configuration that the system uses; there are no decorative switches. Where the system has no backend for something (notification channels, integrations), the screen says so and offers nothing to change.

## How it is built

- **Registry.** `private.setting_defs()` (migration `20261026000100_settings`) is the single list of supported settings: category, key, type, bounds, default, whether it belongs to a branch, whether it is sensitive. A trigger on `system_settings` rejects anything else, for every writer including direct table writes and the server role: unknown keys, wrong types, out-of-range values, a branch setting without a branch (or the reverse), and a default warehouse that is not an active warehouse of that branch.
- **Authority.** Changing a setting needs `settings.manage` (organization-wide for organization settings; at that branch for a branch setting). Reading the *effective values* (`app_settings`) is open to every signed-in member of the organization because screens need them (a cashier's till receipt prints the footer); the Settings screen itself needs `settings.view`. **No setting may hold a secret**: they are visible to all members.
- **Audit.** Every change is recorded by the `system_settings` audit trigger (actor, time, previous and new value). The **sensitive** settings (the idle time-out) cannot be changed or reset without a reason of at least five characters, which is stored with the audit entry. Document numbering changes are audited explicitly (`numbering.configured`, previous and new format).
- **Reset.** Sending `null` removes the saved value, so the default applies again (audited as a deletion).

## What can be configured, and what reads it

| Section | Setting | Rule | Used by |
|---|---|---|---|
| Company and documents | Document footer | text, at most 300 characters | invoice, credit note, quotation and delivery-note PDFs; till receipts |
| | Payment instructions | text, at most 500 | invoice and quotation PDFs |
| | Company profile, branches | (their own screens, linked) | Organization and Branches pages |
| Sales and credit | Default payment terms for new customers | whole days, 0 to 365 | the new-customer form (also the default for imports through the form) |
| | Default credit limit for new customers | 0 to 1,000,000,000, two decimals | the new-customer form |
| | Quotation validity | whole days, 1 to 365 | new quotations' "valid until" date |
| Purchasing | Default payment terms for new suppliers | whole days, 0 to 365 | the new-supplier form |
| Inventory and warehouses | Near-expiry window | whole days, 1 to 730 | the Stock screen's near-expiry totals and the expiry badges |
| | Default sales warehouse (per branch) | an active warehouse of that branch | new invoices, quotations, orders and till shifts at that branch |
| Document numbering | Prefix, length, restart period, per document type | see below | every new document number |
| Security and session | Sign out after inactivity | 0 (off) or 5 to 480 minutes; **reason required** | the app signs the browser out after that idle time |
| Notifications, integrations | none | | placeholders: no channel or connection exists yet |

## Document numbering

`configure_document_numbering` lets the owner change the prefix (1 to 16 letters, digits or dashes, no leading or trailing dash), the number of digits (3 to 12) and the restart period (never, yearly, monthly) for 16 kinds of document. Rules that make a duplicate number impossible: the counter is never touched or lowered; a prefix cannot be shared with another document type; the restart period can only change **before the first number is issued** (switching an in-use sequence between periods could reissue a number). The change applies to the next number issued; numbers already issued are never rewritten. Concurrency is unchanged: numbers come from `generate_document_number` under a row lock (60 simultaneous callers get 60 distinct, gap-free numbers: `tests/database/numbering.test.ts`).

## What the idle time-out is, and is not

It is an **app-level convenience** to protect shared counters and unattended screens: the browser signs itself out (and judges by the clock when a tab wakes after sleep). It is not a server rule; the server session lifetime is set in the hosting dashboard (see the production readiness checklist). Multiple tabs each keep their own idle timer.

## Tests

`tests/security/settings.test.ts` (registry validation, scoping, permissions, sensitive reasons and audit, effective-value merging, reset, numbering rules and audit, tenant separation), `tests/unit/settings.test.tsx` (the screen, validation, reasons, numbering preview, idle sign-out), `tests/e2e/settings.spec.ts` (in a real browser, including that a saved default really reaches the new-customer form).
