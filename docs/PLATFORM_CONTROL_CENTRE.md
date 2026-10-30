# Platform control centre implementation

## Plan

1. Preserve tenant RLS and the existing operator allowlist. Add private platform records, audited mutations and guarded reporting RPCs.
2. Add live overview/analytics, searchable organizations and organization lifecycle controls.
3. Add user visibility, configurable subscription plans and subscriptions, support records and announcements.
4. Replace the minimal platform shell with responsive navigation, independent branding and accessible controls.
5. Exercise migrations and authorization with Docker, then typecheck, lint and build.

## Deployment boundary

Database migrations must be applied before the corresponding frontend is published. Payment collection, email/SMS delivery, Auth policy changes, backup verification and session revocation require server/provider configuration. Persisting a requested policy is not proof that Supabase Auth enforces it. Unconfigured integrations must never report success.

Platform administration remains separate from tenant operations. Platform membership does not grant permission to read stock, sales, patient information or accounting entries across tenants.

## Implemented locally (2026-10-30)

- Independent platform login guard, permission-filtered navigation, mobile menu and local light/dark preference.
- Live organization/user growth, totals and country distribution. Search, status filtering, pagination and current-page CSV export.
- Organization profile/details, suspension, reactivation and irreversible archival; suspension uses existing tenant RLS enforcement.
- Verified exact-email owner lookup and three-step onboarding, retaining the request ID after failed submissions.
- User activation/deactivation (owners protected), permission-based operator grants and revocation; operators cannot change their own grants.
- Configurable plans, subscriptions, agreed-price snapshots and idempotent internal invoice issuance. No client payment-success operation.
- Active-user, branch and warehouse capacity enforcement for assigned plans; downgrade validation.
- Platform support tickets/replies/status updates, announcements, audit feed and notification read receipts.
- Persisted general settings and immutable platform mutation audit records.

## Not yet complete

The original requested scope remains open. Pending items include onboarding approval queues and durable failure tracking; owner/staff invitations; tenant role assignment and ownership transfer; full organization detail tabs; storage/features/trials enforcement; invoice voiding and renewal scheduling; support assignment and tenant-facing support/announcements; richer analytics; security/authentication policies; operational health and backup verification; branding assets; full export/sort/filter coverage; authenticated desktop/mobile visual verification.

Payment collection and email/SMS delivery are intentionally unconfigured by user choice. No provider secrets were added. Audit retention, session revocation, MFA and Auth configuration are not represented as enforced settings.

## Verification

- Fresh Docker migrations through `20261030000300_platform_usage_limits.sql`: passed.
- Focused database suites: 11 tests passed across platform control, billing and tenant onboarding.
- Onboarding component retry test: passed.
- TypeScript, scoped lint and final production build passed.
- The production bundle still emits Vite's large-chunk warning.
- Hosted migration/application state and authenticated responsive layouts have not been verified for this change set.

## Deployment order

1. Apply `20261030000100_platform_control_centre.sql`.
2. Apply `20261030000200_platform_billing_records.sql`.
3. Apply `20261030000300_platform_usage_limits.sql`.
4. Publish the frontend only after these migrations succeed.

Existing platform operators retain all platform permissions by default; newly managed operators receive the explicit permissions selected in the console. The existing tenant database is not reset by deployment. Docker tests use the disposable local `wps_test` database only.
