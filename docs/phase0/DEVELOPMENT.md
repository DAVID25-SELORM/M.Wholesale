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
```
`npm run test:db` starts (or reuses) the container `wps-phase0-testdb`
(`public.ecr.aws/supabase/postgres`), rebuilds the `wps_test` database from `template0`, installs a small shim for
the pieces Supabase provides (`auth` schema, JWT-claim helpers, permissive default privileges, a low-privilege
`wps_authenticator` login that can only `SET ROLE` to anon/authenticated/service_role), applies every migration,
then runs `tests/database` and `tests/security`. API requests are simulated exactly as PostgREST does:
`SET LOCAL ROLE authenticated` + `request.jwt.claims`.

## Adding a tenant table (checklist)
1. `organization_id` + composite FKs to parents, `ON DELETE RESTRICT`, immutable-column trigger.
2. `ENABLE ROW LEVEL SECURITY`, policies using `private.current_organization_id()` + a permission/branch check.
3. Explicit `REVOKE ALL … FROM public, anon, authenticated`, then `GRANT SELECT` and column-level INSERT/UPDATE.
4. `private.set_updated_at()` and `private.audit_row_change('<entity>')` triggers.
5. Add tests to `tests/security` and let `hardening.test.ts` prove the catalog rules.
