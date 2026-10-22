# Permanent multi-tenancy policy

This application is a pooled, multi-tenant SaaS product for independent pharmacy wholesalers. Treat this policy as a release requirement for every module, migration, API function, background task, integration, and report.

## Isolation requirements

- Resolve the active organization from the authenticated user's profile. Never accept an organization identifier from browser input to select a tenant context.
- Every organization-owned row carries `organization_id`, has row-level security, and uses organization-scoped composite foreign keys for references to other tenant-owned rows. Tenant ownership is immutable.
- Enforce branch and warehouse permissions in the database as well as in the UI. A UI filter or route guard is not a security boundary.
- Cover reads, inserts, updates, deletes, RPCs, exports, reports, imports, scheduled work, retries, and error paths. Server-side and service-role code must scope every query to the intended organization and authorized branches/warehouses.
- Keep platform administration separate from wholesaler administration. Provisioning and platform controls are server-only. Wholesaler staff administer only their own organization's records and users.
- Shared reference data and system role templates may be global only when explicitly designed as platform-owned, read-only data. Document each such exception; never place wholesaler business records in a global scope.
- Never weaken tenant isolation or introduce global business-data access without explicit authorization.

## Required review before adding a module

Review the schema, constraints, RLS policies, grants, triggers, database functions, API endpoints, background jobs, integrations, exports, and reports for tenant and branch/warehouse scope. Add cross-tenant tests that attempt foreign-tenant reads, direct-ID lookups, writes, spoofed ownership, cross-tenant references, and report/function argument abuse. Include these tests in the development phase's security suite and require them to pass before release.

## Current implementation map

The implementation uses `organization_id` (not the legacy `tenant_id` described in some early design notes). Its database policies resolve identity using `private.current_organization_id()`. See [Phase 0 security](phase0/SECURITY.md), [development checklist](phase0/DEVELOPMENT.md), and `tests/security/tenant-sweep.test.ts` for current enforcement and coverage. Known global exceptions are shared reference catalogs and system role templates, which are read-only to application users.

This policy is normative; older architecture sketches that describe a different tenant column or control-plane layout do not override it.
