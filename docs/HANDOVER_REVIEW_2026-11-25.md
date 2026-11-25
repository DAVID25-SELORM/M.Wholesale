# Handover review, 2026-11-25

This records what was checked, what was changed on the hosted project, and what is still open.
It is **not** a statement that the system is production-accepted.

## 1. Hosted database: drift found and closed

The whole hosted schema (columns, functions, grants, policies, triggers, constraints, indexes and system
role permissions) was compared with a fresh local build using `scripts/schema-fingerprint.sql`.

| Found | Effect on the live system | Action |
| --- | --- | --- |
| `20261027002200_recall_exposure` never applied | The customer trace on the Recalls screen could not work | Applied |
| `20261027002700_substitution_retry_history` schema change never applied | A substitution could not be requested again after a rejection or withdrawal | Applied (schema statements only) |
| `20261105000100_driver_temperature_capture` not yet applied | Driver capture unavailable; drivers kept broad temperature rights | Applied |
| `20261125000100_mfa_enforcement_and_policy_initplan` (new) | See section 3 | Applied |

Earlier reports that "all migrations are present" rested on probing objects from `20261027003800` onward.
That did not cover the two older gaps. Use the fingerprint comparison, not probes.

After applying, nothing is missing. Expected differences only: `rls_auto_enable()` (Supabase's own) and three
trigram indexes that name the `extensions` schema.

**Backups:** the project lists none and point-in-time recovery is off. Before applying anything, the rows of all
116 public and private tables were exported to `Documents\wholesale-db-backups\` on the build machine. That
export is a one-off safety copy. It excludes the auth schema, is not a restore-tested backup, and contains
personal data, so store or delete it accordingly.

## 2. Edge functions

- `invite-user`: already deployed and matching the repository. Not redeployed.
- `drugxone-sync`: reviewed, fixed, then deployed for the first time. No secrets are set, so it refuses every call.
  - **Fixed, serious:** the partner token was chosen by a business ID that any organization can type, and sent to
    a URL that organization also types. One tenant could have received another tenant's token. Tokens are now keyed
    by organization id, the business ID must match the operator's record, the destination origin must be on an
    operator allow list, and redirects are refused. See `docs/DRUGXONE_INTEGRATION.md`.
  - **Fixed:** failed deliveries were never retried.
  - Open: an event left `PROCESSING` by a crash is not reclaimed.

## 3. Added in this pass

- **Two-step sign-in (authenticator app)**, under the user menu, *Sign-in security*. Enforced in the database:
  once a factor is verified, a password-only session gets no organization or platform access, including through
  direct API calls. It is **opt-in per person**. Making it mandatory for particular roles is not built.
  Lost phone: a project administrator removes the factor under Supabase Authentication, after verifying identity.
- **Global search** across products, customers, suppliers, sales invoices and purchase orders, limited by
  permission in the screen and by row-level security in the database.
- Three row policies the performance advisor flagged now evaluate the user once per query.

## 4. Sign-in settings on the hosted project (read, not changed)

| Setting | Now | Needed | Why it matters |
| --- | --- | --- | --- |
| Custom SMTP | Not set; built-in mailer, 2 emails per hour | Your own mail sender | **Blocks onboarding:** a third invitation within an hour fails |
| Minimum password length | 6 | 10 or more (the app's screens ask for 12) | The API accepts weaker passwords than the screens do |
| Leaked-password protection | Off | On (may need a paid plan) | Known breached passwords are accepted |
| Public sign-up | Disabled | Disabled | Correct |
| Site URL and redirects | `m-wholesale.vercel.app` | Same, or your own domain | Correct |
| Authenticator (TOTP) | Enabled | Enabled | Correct |

## 5. Feature comparison

Research was by web search. Most product sources are vendor or directory pages, so treat them as marketing, not evidence.

**Already present:** batch and expiry stock with FEFO, quarantine and recalls with recovery, controlled-medicine
register and approvals, picking, packing, dispatch, delivery runs and fleet, package temperature logging, price
agreements, credit control, quotations to invoices, point of sale, purchasing to payables, accounting and bank
reconciliation, reorder suggestions, CRM, multi-tenant platform console.

**Not built, in suggested order:**

| Gap | Notes | Needs from you |
| --- | --- | --- |
| GRA e-VAT clearance | Secondary sources say VAT-registered businesses must use a certified invoicing system connected to GRA (Act 1151, from 2026) and that invoices are cleared before issue. **Not verified against the Act or GRA.** Possibly a legal blocker for live invoicing | Accountant's ruling, GRA onboarding, API specification and test credentials |
| Complaints and quality events, self-inspection | WHO TRS 1025 Annex 7 has sections on complaints and inspections. Only credit-note reason codes exist today. Check the Ghana FDA licensing guideline (2024) for exact duties | Your pharmacist's required fields and workflow |
| Pharmacy customer ordering portal | Listed by a Ghana vendor as a higher-tier wholesaler feature. Needs its own customer identity and isolation design | A scope decision |
| Expiry and stock alerts by email, SMS or WhatsApp | On-screen expiry views exist; nothing is sent | Provider account |
| Live mobile money collection | Today it is recorded as a payment method only | Provider account and contract |
| Demand forecasting | Reorder suggestions exist; no forecast model | Real sales history |
| Offline operation | Not built | A decision on which tasks must work offline |
| Temperature: per-organization limits, probe import, storage-room monitoring | Package readings only | Limits from your pharmacist; probe models |
| Richer proof of delivery (signature, photo) | Receiver name only | A scope decision |
| Printed labels and a two-batch trace view for partial substitutions | | |

Sources: [WHO TRS 1025 Annex 7](https://www.who.int/publications/m/item/trs-1025-annex-7),
[Ghana FDA premises licensing guideline](https://fdaghana.gov.gh/1_guideline-for-licensing-of-premises-for-the-storage-and-distribution-of-medical-products-_1),
[GRA certified invoicing guidelines (2024)](https://gra.gov.gh/wp-content/uploads/2024/07/E-VAT-GUIDELINES_20240222.pdf),
[TaxLawGH on VAT invoices](https://www.taxlawgh.com/ghana-vat-invoices),
[Fonoa on Ghana e-VAT](https://www.fonoa.com/resources/blog/ghana-e-vat-e-invoicing-2026),
[Kolonell on Accra wholesaler software](https://kolonell.com/en/blog/pharmaceutical-wholesaler-software-cost-accra-2026).

## 6. Before real users

1. Commit and push this work so the app has the sign-in code screen, *Sign-in security* and search.
2. Set up your mail sender, raise the password minimum, turn on leaked-password protection.
3. Move to a plan with backups and rehearse a restore.
4. Have owners and accounts staff turn on two-step sign-in. Do this **after** step 1: the old screens cannot ask for the code.
5. Ask your accountant about GRA e-VAT before issuing live invoices.
6. Run `docs/PILOT_ACCEPTANCE.md` with named business owners; arrange an external security review.
7. For live trading, follow `docs/CUTOVER.md`.
