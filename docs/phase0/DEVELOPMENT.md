# Phase 0 — Development guide

## Prerequisites
Node 20+ (tested on 24), npm, Docker. The Supabase CLI is optional (`npx supabase@latest` is used by
`npm run db:types`).

```bash
npm install
cp .env.example .env.local     # or let `npm run stack:up` write it for you
```

## Environment variables
| Variable | Where | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | browser | Project URL (local dev: the Vite dev server, which proxies `/auth/v1` and `/rest/v1`) |
| `VITE_SUPABASE_ANON_KEY` | browser | **Public** anon/publishable key only |
| `DEV_SEED_PASSWORD` | `scripts/seed-dev.mjs` only | Required, ≥ 12 chars, no default |
| service-role key | never in the repo | Local dev: generated into `.stack/secrets.json` (git-ignored). Real projects: server secrets only |
| `WPS_TEST_PORT`, `WPS_TEST_PASSWORD`, `WPS_TEST_CONTAINER` | optional | Throwaway test database container overrides |

## Local stack (lightweight)
```bash
npm run stack:up        # real Supabase Postgres image + GoTrue + PostgREST, applies migrations, writes .env.local
DEV_SEED_PASSWORD='choose-a-long-password' npm run seed:dev   # two demo organizations + users
npm run dev             # http://127.0.0.1:5273
npm run stack:down      # stop auth/API containers (data kept)    ·   npm run stack:reset   # wipe + rebuild
```
Seed users (all use the password you supplied): `owner@demo.test`, `kumasi.manager@demo.test` (Kumasi only),
`auditor@demo.test`, `cashier@demo.test`, `viewer@demo.test`, `inactive@demo.test` (deactivated), and a second
tenant `owner@other.test` for isolation checks. `supabase/config.toml` is also present, so a full
`npx supabase start` works as well (ports 55321+; not exercised in this repository's verification).

## Migrations
* One SQL file per change in `supabase/migrations/`, timestamped, deterministic, ordered. **Never edit an applied
  migration** — add a new one. The dev stack records what it applied in `public._wps_migrations`.
* Apply to a hosted project with `npx supabase db push` (after `supabase link`) — a manual, reviewed step.
* After schema changes: `npm run test:db -- --migrate-only` then `npm run db:types` (regenerates
  `src/types/database.ts`).

## Edge Function deployment (`invite-user`)
Code: `supabase/functions/invite-user/index.ts` (single self-contained file). Supabase injects `SUPABASE_URL`,
`SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`; optional secrets: `SITE_URL` (default
`https://m-wholesale.vercel.app`) and `ALLOWED_ORIGINS` (comma-separated extra origins).
Deploy with `npx supabase functions deploy invite-user` (after `supabase login` + `link`) or paste the file into
Dashboard → Edge Functions → *Deploy a new function → Via Editor*. Keep **Verify JWT** on. Also add your site to
Authentication → URL Configuration (Site URL + Redirect URLs `https://<site>/**`), otherwise invitation links are
rejected. The local lightweight stack has no mailer, so invitations are exercised through unit tests, not end to end.

## Tests
```bash
npm run typecheck     # tsc strict (noUncheckedIndexedAccess)
npm run lint          # eslint (react-hooks rules incl. no setState-in-effect)
npm test              # frontend unit/component tests (vitest + jsdom)
npm run test:db       # database + security tests against a FRESH throwaway Postgres (docker)
npm run build         # typecheck + production build
npm run test:all      # typecheck + lint + unit + db tests
npm run test:e2e      # end-to-end tests in a real browser against the LOCAL stack (see below)
npm run test:perf     # volume test (a year of data) against a throwaway database
```
`npm run test:db` starts (or reuses) the container `wps-phase0-testdb`
(`public.ecr.aws/supabase/postgres`), rebuilds the `wps_test` database from `template0`, installs a small shim for
the pieces Supabase provides (`auth` schema, JWT-claim helpers, permissive default privileges, a low-privilege
`wps_authenticator` login that can only `SET ROLE` to anon/authenticated/service_role), applies every migration,
then runs `tests/database` and `tests/security`. API requests are simulated exactly as PostgREST does:
`SET LOCAL ROLE authenticated` + `request.jwt.claims`.

## End-to-end tests (`npm run test:e2e`)
Playwright drives the **Chrome (or Edge) already installed** on the machine (nothing is downloaded; set `E2E_BROWSER=msedge` to use Edge) against the real app and the **local** database stack, never against production. `scripts/e2e.mjs` resets the local dev database, seeds the demo users (`scripts/seed-dev.mjs`) with a fresh random password, and runs the tests; `playwright.config.ts` starts the dev server. To re-run against a database you already seeded: `E2E_KEEP_DB=1 E2E_PASSWORD=<the password> npm run test:e2e`; to run one file: `npm run test:e2e -- settings`. Requires `node scripts/dev-stack.mjs up` once (it writes `.stack/secrets.json`).

`tests/e2e/global-setup.ts` signs each seeded user in once and keeps the session in `tests/e2e/.auth` (git-ignored), so specs start signed in:

| Spec | Covers |
|---|---|
| `auth.spec.ts` | protected routes redirect to sign-in, no sign-up, safe failure messages, sign-in and sign-out, a deactivated user sees "access disabled", the idle notice |
| `navigation.spec.ts` | permission-aware menu per role, unauthorized page on typed addresses, view-only settings |
| `branches-and-isolation.spec.ts` | branch selector per user and tamper-proofing, one-branch manager scoping (screens and API), organization B cannot read, change or insert into organization A (screens and direct API calls with ids and organization_id) |
| `administration.spec.ts` | branch create / edit / duplicate refusal / deactivate and the audit log, warehouse locations, users, roles, organization profile, honest dashboard |
| `settings.spec.ts` | saving and persistence, a saved default reaching a form, validation, reasons for security settings, numbering |
| `responsive.spec.ts` | no sideways page scroll on 18 pages at 1440, 1024, 768, 390 and 375 px, menu reachable, dialogs inside the screen, the invoice page |

Failures leave a screenshot in `tests/e2e/.results` (git-ignored). The tests create their own uniquely named data, so they also pass on a database that has been used.

## Adding a tenant table (checklist)
1. `organization_id` + composite FKs to parents, `ON DELETE RESTRICT`, immutable-column trigger.
2. `ENABLE ROW LEVEL SECURITY`, policies using `private.current_organization_id()` + a permission/branch check.
3. Explicit `REVOKE ALL … FROM public, anon, authenticated`, then `GRANT SELECT` and column-level INSERT/UPDATE.
4. `private.set_updated_at()` and `private.audit_row_change('<entity>')` triggers.
5. Add tests to `tests/security` and let `hardening.test.ts` prove the catalog rules.
