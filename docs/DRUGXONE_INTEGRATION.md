# DrugXone integration contract

The ERP remains the source of truth for wholesale products, batch stock, prices, customer credit, sales orders and fulfilment. DrugXone is an external marketplace projection and order channel.

## Current boundary

DrugXone currently exposes Supabase RPCs such as `list_marketplace_catalogue()` and `create_marketplace_orders()`, but those RPCs are not a stable partner API. The ERP must not connect to DrugXone's database from the browser or share a Supabase service key with a tenant user.

The integration uses a trusted server adapter with credentials held only in server secrets. The ERP migration `20261103000100_drugxone_integration_foundation.sql` stores connection metadata, product mappings, order mappings and an append-only sync queue. It stores no API token or secret.

## Phased rollout

1. **Contract and sandbox:** agree the DrugXone partner endpoints, external business identifier, product/offer identifiers, units, minimum order quantities and status vocabulary. Use a sandbox tenant and synthetic data.
2. **Read-only catalogue:** publish ERP products, active batches, expiry dates, available quantities, prices, pack units and lead times. Reject ambiguous product mappings; never match by name alone.
3. **Order intake:** accept a DrugXone order with an idempotency key and create an ERP draft sales order. Staff confirm it before reservation, invoicing or fulfilment.
4. **Status projection:** send accepted, picking, packed, dispatched, cancelled and completed states back to DrugXone. Partial fulfilment and backorders must carry line quantities.
5. **Pilot expansion:** enable one tenant, then multiple tenants only after cross-tenant, duplicate, replay, expiry, recalled-batch and failure-retry tests pass.

## Required partner API properties

- TLS and a per-tenant credential; no credentials in browser code or normal settings.
- Request timestamp, signature/token verification, replay window and idempotency key.
- Stable external IDs for businesses, products/offers, orders and order lines.
- Explicit acknowledgement and retry-safe responses.
- Health endpoint that reports configuration without revealing secrets.
- Correlation IDs and sanitized error responses.

HealthFlow's documented `/hms-api` endpoints are a separate patient/prescription integration and are not part of the DrugXone marketplace contract.
