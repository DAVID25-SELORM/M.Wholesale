# Phase 0 — Security model

## Trust boundaries
| Actor | Can do | How it is enforced |
|---|---|---|
| Anonymous | Sign in; nothing else | `anon` has **no** table/column privileges and no function EXECUTE (tested) |
| Signed-in user | Only what their organization + role + branch scope allow | RLS policies, column grants, triggers, guarded RPCs |
| Browser code | Anon key + the user's own JWT | the SPA contains no service key (`grep` clean); `.env.example` documents this |
| Server / CI | Provisioning, migrations | `service_role` key kept outside the browser; provisioning functions executable only by it |

## Tenant isolation (why Organization A can never touch Organization B)
1. `private.current_organization_id()` resolves the caller's organization from `auth.uid()` (the verified JWT
   subject) → `profiles` → `organizations`. It returns `NULL` for unknown users, **inactive users and inactive
   organizations**, so all tenant policies fail closed.
2. Every tenant table has `organization_id = current_organization_id()` in its USING / WITH CHECK clauses.
3. `organization_id` is **never accepted from the client**: it is not in any INSERT/UPDATE column grant
   (supplying it → `42501 permission denied`), it is filled by a column default from the session, and a WITH
   CHECK re-verifies it.
4. Composite foreign keys make cross-organization references impossible even for trusted code; immutable-column
   triggers stop re-parenting.
5. Helper functions are `SECURITY DEFINER` with `search_path = ''` (fully-qualified names), `STABLE`, live in the
   non-exposed `private` schema, only ever answer questions about `auth.uid()`, and have EXECUTE revoked from
   PUBLIC/anon (hardening migration + catalog tests). They avoid RLS recursion by reading `profiles`/`user_roles`
   as the function owner.
6. `can_access_branch()` intentionally does not look the branch up in `branches` (a lookup cannot see a row
   inserted by the same statement, which broke `INSERT … RETURNING` — found by the tests); every policy pairs it
   with the row's own `organization_id` check.

## Privileges (defence in depth)
* Supabase grants new `public` tables to `anon`/`authenticated` by default; migration 07 **revokes everything
  explicitly** and grants only `SELECT` + the exact writable columns. The test database replicates Supabase's
  permissive default privileges, so these revokes are proven.
* No DELETE / TRUNCATE / REFERENCES / TRIGGER is granted to client roles anywhere.
* `profiles.is_active`, `organizations.is_active` (no column grant on the latter's `is_active`),
  `warehouses.branch_id`, ownership columns, ids and timestamps are not client-writable.
* RBAC tables are read-only to clients; changes go through RPCs that apply the anti-escalation rules.
* Function EXECUTE allow-list is asserted exactly in `tests/security/hardening.test.ts`.

## Audit log
* Written only by SECURITY DEFINER triggers (`audit_row_change`) and `private.write_audit` — clients have no
  INSERT. Actor = `auth.uid()` (not client-supplied); updates store only changed columns; optional reason.
* **Append-only for everyone:** `BEFORE UPDATE/DELETE` row triggers and a `BEFORE TRUNCATE` statement trigger
  raise `42501`, so even the table owner and `service_role` cannot rewrite history through SQL. (A database
  superuser can still disable triggers — outside the application trust boundary; mitigated by managed-database
  access controls, backups and log shipping.)
* Covered in Phase 0: organization, branch, warehouse, warehouse location, user (profile created /
  updated / activated / deactivated), user role assigned / revoked, system setting.

## Session & auth settings
`supabase/config.toml`: sign-ups disabled, JWT expiry 1 h with refresh-token rotation, minimum password 12
characters with upper/lower/digit, secure password change. Supabase-js keeps the session in `localStorage`
(its default); a strict CSP and no third-party scripts are the mitigation — see "Production checklist".
The branch selector's `localStorage` value is a UI preference only and is re-validated against the server's
branch list.

## Inviting users (Edge Function `invite-user`)
Sign-up is disabled, so people join by invitation. Sending an invitation needs the service-role key, which must
never reach a browser, so it runs in `supabase/functions/invite-user`:

1. **Pre-check with the caller's own JWT** — `prepare_invitation(role, branch)` (database) requires `users.invite`
   organization-wide, validates role/branch against the *caller's* organization and applies the same
   anti-escalation rule as `assign_user_role` (you cannot invite someone into a role stronger than your own).
   `organization_id` is never read from the request.
2. `auth.admin.inviteUserByEmail` (service role) creates the auth user and sends the e-mail. Existing accounts are
   rejected (409): inviting never attaches someone else's account to your organization.
3. `complete_invitation(...)` — executable by `service_role` only — creates the profile, the role assignment
   and a `user.invited` audit entry **attributed to the inviter**. If this step fails the auth user is deleted again.
4. **Resend** re-runs `prepare_resend` and only works until the invitation is accepted.

The e-mail link lands on `/accept-invite`, where supabase-js exchanges the one-time token for a session and the
person chooses a password (12+ chars, upper, lower, digit). **Forgot password** (`/forgot-password` →
`/reset-password`) is the recovery path if they leave before choosing one; it answers identically whether or not the
account exists. The function only redirects to allow-listed origins (`SITE_URL`, `ALLOWED_ORIGINS`, localhost dev),
never to a caller-supplied URL, returns generic messages for server failures, and is covered by unit tests with
fakes (`tests/unit/invite-function.test.ts`) and database tests (`tests/security/invitations.test.ts`).

`provision_organization` / `provision_user` remain service-role-only helpers for bootstrapping the first owner.
Supabase's built-in mailer is rate-limited (a few e-mails per hour): configure custom SMTP before inviting at scale.

## Verified by tests (see TEST report)
Anonymous denial · inactive user/organization denial · cross-tenant read and write attempts · organization_id
spoofing · re-parenting · branch restrictions (including locations and default branch) · role escalation ·
last-admin protection · settings and audit permissions · audit immutability (users and owner) · catalog hardening
(RLS everywhere, no anon grants, search_path pinned, exact EXECUTE surface) — plus a live tamper run in the
browser pane against GoTrue + PostgREST.

## Production checklist (outside Phase 0 code)
* Serve over HTTPS with CSP (`default-src 'self'`; connect-src = your Supabase URL), `X-Frame-Options: DENY`,
  `Referrer-Policy: same-origin`, HSTS — set at the hosting layer.
* Enable leaked-password protection and TOTP MFA in the hosted Supabase Auth settings; require MFA for
  OWNER/SUPER_ADMIN/ACCOUNTS roles once the enrolment UI exists.
* Keep the service-role key only in server secrets; rotate on staff changes; never use it in `VITE_*` vars.
* Enable PITR backups and restrict superuser/`supabase_admin` access.
* Add rate limits (Supabase Auth limits are configured in `config.toml`) and bot protection on sign-in.
