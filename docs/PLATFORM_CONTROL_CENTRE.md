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
## Ownership transfer

Migration 010 adds explicit ownership replacement within an active organization. Both organization and user administration permissions are required. The actor must be independent of both affected members. The replacement must be an active, email-verified member; the previous owner is checked under locks. Ownership changes and the reason are audited atomically. Other roles are retained. The organization Ownership tab provides the workflow.

Fresh Docker migrations through 010 and the ownership/role security suites passed (2 tests); production build and scoped lint passed. Migration 010 has not been applied to the hosted database by this session. Broader completion items above remain open.

Ownership follow-up (2026-10-31): the transfer form now loads current owners and eligible verified replacements through a permission-checked RPC, rather than asking an operator to identify owners from all members. Added tests for unverified replacements and missing user-management permission. The first database test attempt was blocked because Docker Desktop was stopped; the application was started for a retry. Scoped lint passed. Migration 010 remains unpublished.

## Filtered exports (2026-10-31)

Platform tables now support exporting all matching records across pages, with progress and cancellation. Existing permission-checked read RPCs remain the data source. Exports stop on changed totals, duplicate identities, incomplete pages or more than 100,000 records. CSV formula escaping is retained. Pagination is not a transactional snapshot: concurrent edits that preserve totals may still be reflected across pages.

The ownership follow-up passed all three database tests across ownership and role suites after Docker started. The organization component test and production build also passed. Three initial export unit tests passed; external delivery remains unconfigured.

## Organization activity (2026-10-31)

Migration 20261031000100 adds organization-scoped platform audit history. Both organization-management and audit permissions are required. The organization Activity tab includes pagination, refresh and current-page CSV export. Operational ERP audit data is not exposed by this endpoint.

Fresh Docker migration and the new security test passed, covering pagination, organization isolation, invalid pages and denied access for tenant users, anonymous callers and operators lacking audit permission. Apply this migration after 010 before publishing the Activity tab. User confirmed migration 010 applied.

## Revenue and renewal (2026-10-31)

The Revenue navigation entry exposes existing live billing aggregates, separating monthly recurring commitments from verified collections and keeping each currency separate. Both datasets support CSV download. No collection provider is configured.

Migration 20261031000200 adds explicit renewal of ended active subscription periods. It retains agreed pricing, advances one calendar billing cycle, and creates an unpaid invoice in the same transaction. Stale expected-end dates, premature renewals, inactive organizations/plans and overlapping invoice periods are rejected. This is operator-initiated renewal; automatic scheduling is still pending.

User confirmed the organization activity migration applied. Production build and six frontend tests passed for revenue, export and organization details. The existing large-bundle warning remains. Broader ERP completion and hosted verification remain open.

## Full regression follow-up

Full frontend suite: 36 files, 212 tests passed. First full database run: 463 passed, five failed. Updated explicit function-grant expectations for the implemented APIs, document numbering for purchase requests, and the organization-parameter boundary test to reject ordinary tenant/anonymous access to each allowed platform endpoint. The API catalog remains an explicit allowlist.

Migration 20261031000300 corrects nine recent RLS policies to use the existing once-per-query permission/branch-set pattern. It preserves tenant equality and branch restrictions. This fixes the schema audit performance invariant instead of weakening its assertion. Full database regression is being rerun after these changes.

Final local regression results for this continuation (2026-10-31): all 48 database suites / 468 tests passed after migration 20261031000300; all 36 frontend suites / 212 tests passed. Production build passed with the existing large-chunk warning. Full lint and subsequent scoped lint passed.

Browser verification attempt: native computer-use pipe unavailable; browser extension inventory found the ERP tab, but attaching timed out waiting for Emulation.setFocusEmulationEnabled. No authenticated visual acceptance is claimed. New renewal and RLS migrations remain unapplied to hosted database by this session. Automatic renewal scheduling, remaining configuration/operational controls, and production acceptance remain open.
