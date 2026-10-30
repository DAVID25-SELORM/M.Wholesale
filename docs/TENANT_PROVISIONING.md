# Tenant onboarding

Each organization is a separate tenant. A user currently belongs to one organization;
branch switching does not switch tenants. Use a separate owner account for each tenant.

## Operator setup

Apply `supabase/migrations/20261029000100_tenant_onboarding.sql` after migration 040.
Keep `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in a protected operator environment.
Never expose the service key in frontend configuration. Ordinary tenant owners cannot
call the onboarding RPC or list other tenants.

1. Create/invite the new owner through Supabase Authentication. Let the owner complete
   email verification and password setup. Copy their Auth user UUID. Do not reuse an
   account already assigned to an organization.
2. Save an onboarding JSON file outside the repository containing:

```json
{
  "request_id": "GENERATE-A-NEW-UUID",
  "owner_user_id": "AUTH-USER-UUID",
  "first_name": "Jane",
  "last_name": "Owner",
  "organization_name": "New Pharmacy Ltd",
  "currency": "GHS",
  "country": "GH",
  "timezone": "Africa/Accra"
}
```

Generate the request UUID once using PowerShell `[guid]::NewGuid().ToString()`.

3. Run:

```powershell
node scripts/provision-tenant.mjs create D:\secure\onboarding.json
node scripts/provision-tenant.mjs list
```

Creation atomically creates the organization, head-office branch, owner profile and
OWNER assignment and records the request. If a response is lost, repeat the same
file: the same organization ID is returned. Changing details under an existing request
ID is rejected. The operator script never deletes an Auth account after an error.

4. Have the owner sign in again. Configure warehouses, catalogue, staff permissions,
   accounting and opening stock inside the new organization. Verify isolation with a
   second tenant account before accepting production use.

## Scope and deployment status

The CLI is also available alongside the tenant console described below. Subscription
billing, self-service signup and multiple memberships are not implemented here.
The onboarding migration requires hosted deployment. On 2026-10-29, fresh Docker
migrations and both onboarding security tests passed, covering permission denial,
verified ownership, retry behavior, conflicting details and tenant isolation.
Script syntax and focused lint checks passed. No real tenant was created during validation.

## Platform tenant console

Apply `20261029000200_platform_tenant_console.sql` and deploy the frontend. An existing
verified ERP user must be explicitly appointed by a database operator:

```sql
insert into private.platform_operators(user_id) values ('VERIFIED-OPERATOR-USER-UUID');
```

This grants cross-organization listing and tenant creation. Do not appoint ordinary
customer administrators. No platform operators are created automatically. Remove the
row to revoke access. Use the **Workspace** selector to choose **Platform Administration**,
or open `/platform/tenants`. Choose your organization's ERP in the same selector to
return to its operational workspace. The old `/admin/tenants` URL redirects to the
platform workspace. Platform pages have their own navigation and no branch selector.
The console
requires an existing ERP profile for sign-in, shows 25 tenants per page and uses the
same onboarding RPC as the CLI. It records the signed-in creator on the onboarding
request. Keep the displayed request ID if retrying after a lost response or reload.
It does not provide access to a tenant's business records or impersonate its owner.

Console verification: fresh Docker migrations and all three tenant security tests passed on 2026-10-29; focused lint passed. Hosted migration, frontend deployment and authenticated browser acceptance remain pending.
