# Production readiness review

Scope: security of the whole schema, behaviour under the browser's production security headers, speed with a year of realistic data, backup/restore, and a go-live checklist.

## 1. What was checked and what was found

| Check | How | Result |
|---|---|---|
| Whole-schema security audit | `tests/security/schema-audit.test.ts` (runs in the DB suite) | No gaps. Every table has row-level security; anonymous users hold no rights; signed-in users cannot delete or truncate anything; money and stock tables are read-only to users and written only by checked functions; every privileged function pins its search path and checks permission or organization first; evidence tables are append-only. Now a permanent guard: a future migration that breaks one of these fails the suite. |
| Production headers (CSP etc.) | `node scripts/preview-prod.mjs` serves the production build with the exact `vercel.json` headers | Sign-in, PDF generation and Excel import work with no CSP violations. |
| Speed at volume | `npm run test:perf` (3,000 products, 6,000 batches, 600 customers, 30,000 invoices, 15,000 receipts, 20,000 stock movements) | **One real problem found and fixed** (below). |
| Backup / restore | Dump and restore drill (section 3) | Restored copy matches the source row for row. |
| Route crawl on a phone-size screen (375 px) | Production build, signed in as owner, all 44 menu pages opened in turn, watching console errors, crashes and sideways scrolling | No console errors, no crashes, no horizontal overflow. (Demo data is nearly empty, so pages full of long real rows still deserve a look during the parallel week.) |

### The performance problem

Row-level security called the permission check **once per row**, at roughly 0.3 ms each. With 30,000 invoices, counting them took 10 s and a year's sales report took 21 s. The rule did not change; it is now evaluated once per query (one permission check plus one list of the user's branches).

| Query (30,000 invoices) | Before | After |
|---|--:|--:|
| Invoice list, exact count | 10,325 ms | 15 ms |
| Stock summary, page of 50 | 5,546 ms | 33 ms |
| Receivables ageing | 16,885 ms | 69 ms |
| Overdue customers | 10,321 ms | 36 ms |
| Sales report, one year | 21,588 ms | 326 ms |
| VAT summary, one year | 10,354 ms | 49 ms |
| Reorder suggestions | 7,047 ms | 301 ms |
| Stock valuation | 4,608 ms | 87 ms |

Full table: `docs/PERFORMANCE.md`. The fix is migration `20261022000100_rls_permission_checks_once` (apply with `scripts/apply-performance.sql`). It rewrites 91 policies and 9 report functions from the catalog, and all 315 database security tests pass on the result. A new test fails if any policy goes back to a per-row check.

Other change: production source maps are now `hidden` (still generated for error tracking, but no longer advertised to every visitor).

## 2. Go-live checklist

**Supabase (Authentication → settings)**
- [ ] Site URL = `https://m-wholesale.vercel.app` (or the final domain); add only the real redirect URLs.
- [ ] Email confirmations on; set a custom SMTP sender (the built-in mailer is rate-limited and for testing only).
- [ ] Password policy: minimum 10 characters, leaked-password protection on.
- [ ] Multi-factor authentication enabled; require it for owner and accounts roles.
- [ ] Sign-ups disabled (users join by invitation only).
- [ ] Rate limits for sign-in left at defaults or tighter.

**Supabase (Project)**
- [ ] Paid plan with daily backups, and Point-in-Time Recovery if you can afford it (this is real money data).
- [ ] Network restrictions / SSL enforced (default on).
- [ ] The service-role key exists only in Supabase and any server you control; never in Vercel's browser variables or the repo.

**Vercel**
- [ ] Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment variables.
- [ ] Custom domain with HTTPS; update the Supabase redirect URLs and the `connect-src` entry in `vercel.json` if the project URL changes.

**Monitoring**
- [x] Application errors are built in: a crashed screen shows a calm message and is reported (page path, error, stack, build version, no form data or tokens) to **Administration → Application errors**, which owners and auditors read. Apply `scripts/apply-phase15.sql` to switch it on. A third-party tracker (e.g. Sentry) is optional on top; if you add one, allow its host in `connect-src` in `vercel.json` and upload the hidden source maps at build time.
- [ ] Supabase email alerts for database size, CPU and failed requests.
- [ ] Someone looks at the audit log weekly (Reports → audit) for unusual reversals, refunds and stock adjustments.

**Data import and cutover** (the detailed, tick-box version is `docs/CUTOVER.md`; Phase 16 added the customer import and the opening receivables and payables imports that this needs)
1. Freeze: agree a cut-off date; stop entering transactions in the old system.
2. Import (Excel import is built): products, customers, suppliers, price lists, then opening stock by batch and expiry as an OPENING stock document, opening customer balances as opening invoices.
3. Reconcile: stock valuation and receivables ageing against the old system's totals; sign off by owner and accountant.
4. Run a parallel week with one branch.
5. Go live. **Rollback** = keep the old system read-only for 30 days and take a database backup immediately before cutover (restore drill below).

**People**
- [ ] Review `docs/ACCESS_REVIEW.md` findings with the owner (accounts manager powers, branch-manager refunds, controlled-drug adjustment approval).
- [ ] Create real user accounts per person; remove demo and test users; roles assigned by the owner only.
- [ ] Train cashiers on till opening/closing and reversals vs. credit notes.

## 3. Backup and restore runbook

**Hosted:** Supabase dashboard → Database → Backups (daily; PITR if enabled). Restoring replaces the whole project's data, so do it only for a real disaster and tell all users first.

**Your own copy (recommended weekly, kept off the platform):**
```bash
pg_dump "postgresql://postgres:<DB_PASSWORD>@db.vrqanbbxkxvpegogsqej.supabase.co:5432/postgres" --no-owner --schema=public -Fc -f wholesale-$(date +%F).dump
```
Store it encrypted (it contains customer and licence data), in two places.

**Restore drill (run quarterly):** create an empty database, `pg_restore --no-owner -d <scratch_db> wholesale-<date>.dump`, then compare row counts of `sales_invoices`, `products`, `audit_logs`, and the stock valuation against production. This was run on the local stack on 2026-10-15: dump 1.6 MB, restored, counts identical (143 invoices, 274 products, 3,742 audit rows in both).

**Accidental data mistakes** are handled inside the application (reversals, credit notes, stock adjustments with reasons; nothing is deleted), so a restore should never be needed for a user error.

## 4. Known limits and open items

- Volume figures come from a local database; hosted latency adds the network round trip (typically 50-150 ms per call) but not more database time. Re-run `npm run test:perf` after schema changes.
- The perf test seeds data with triggers switched off for speed; it measures reads and one posting, not bulk-posting throughput.
- Not yet done: GRA e-VAT integration and the customer portal (waiting on your inputs, see `docs/phase12/`). The accounting ledger and bank reconciliation are built (Phase 13, `docs/phase13/`).
