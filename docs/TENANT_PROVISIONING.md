# Tenant provisioning

Tenant creation is intentionally server-side. The provisioning RPC is restricted
to the Supabase service role and creates the organization, head-office branch,
owner profile and owner role in one transaction.

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in a protected operator shell,
then run:

```powershell
node scripts/provision-tenant.mjs owner@example.com 'temporary-password' Jane Owner 'New Pharmacy Ltd'
```

The command creates the Auth user and provisions the tenant. The owner should
complete password setup before production use, then configure warehouses, roles,
catalogue and opening data. Never put the service-role key in frontend code or
commit it to the repository.
