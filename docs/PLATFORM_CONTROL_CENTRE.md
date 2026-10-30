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

The original requested scope remains open. Pending items include owner/staff invitations; ownership transfer; full organization detail tabs; storage/features/trials enforcement; renewal scheduling; richer analytics; security/authentication policies; operational health and backup verification; branding assets; full export/sort/filter coverage; authenticated desktop/mobile visual verification.

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

## Onboarding queue stage

Migration `20261030000400_platform_onboarding_queue.sql` adds persisted review requests, status filtering, approval/rejection, sanitized failure tracking and retries. The create wizard now submits a request; approving it creates the organization. The existing operator-only direct onboarding RPC remains available for automation. Two-person approval is not mandated; an operator with organization-management permission can submit and approve.

Provisioning executes inside a subtransaction: failures roll back organization changes while the outer request records FAILED and the SQLSTATE. No raw exception text or tokens are stored. Completed approvals return the existing organization on retry. Rejected requests cannot be approved; a new request reference is required.

Apply migration 004 after migrations 001–003 before deploying this frontend. External delivery remains unconfigured. Authenticated visual verification remains outstanding.
## Support assignment stage

Migration `20261030000500_platform_support_assignment.sql` adds permission-checked assignee discovery, assignment validation and immutable assignment-history events. The support update dialog offers active verified support operators and unassignment. Existing assignments to deactivated operators remain visible for review; those operators cannot receive new assignments. The ticket list resolves active assignees to email labels.

Fresh Docker migration and five focused database suites: 15 tests passed, including invalid/inactive assignee rejection and assignment-history preservation. Apply migration 005 after 004 before deploying this frontend. Tenant-facing support intake is implemented in migration 006.
## Tenant support stage

Migration `20261030000600_tenant_support.sql` adds tenant support intake and conversations. Staff see their own requests; users with organization-management permission can see their organization’s requests. Organization identity is derived server-side. Suspended organizations have no access. Existing platform tickets and internal notes remain private; platform staff must explicitly select Reply to organization to publish a response. Tickets support closing/reopening and idempotent creation by request reference. No email or SMS is sent.

Apply 006 after 005. Authenticated browser/mobile verification is still outstanding; changes are not yet published.
Tenant support verification: 16 focused database tests passed across six suites; two component tests passed for onboarding and support retry handling. Support submissions reuse their request reference after errors and never send an organization ID from the browser. Switching conversations warns before discarding an unsent reply.

## Tenant announcements

Migration `20261030000700_tenant_announcements.sql` adds explicit publication/withdrawal and per-user read receipts. Existing announcements stay internal until published. Published announcements are global to active organizations, expire automatically from the feed, and expose no author identity or other users' read status. The ERP Announcements page supports refresh, pagination and mark-as-read. No external messages are sent.

Fresh Docker migrations and 17 focused database tests passed, including publication authorization, read-receipt isolation, withdrawal and suspended/anonymous denial. Apply 007 after 006 before frontend deployment. Browser visual verification remains outstanding.
## Invoice controls, role management and organization workspace

Migration 008 adds audited, retry-safe voiding of unpaid open invoices. Migration 009 adds organization/branch-scoped user role grants and revocations, restricted to platform users administrators. Self-editing and OWNER/SUPER_ADMIN role changes are blocked. Cross-organization role and branch assignments are rejected.

Organization details now separate profile, users, branches, warehouses, subscription and actual active usage. Tabs support arrow, Home and End keyboard navigation. Additional detail areas in the original specification remain pending.

Fresh Docker migrations through 009 and 18 focused database tests passed. The production build passed with the existing bundle-size warning. These changes are local; migrations 004–009 must precede frontend publication. This is a progress record, not a completed ERP handover.