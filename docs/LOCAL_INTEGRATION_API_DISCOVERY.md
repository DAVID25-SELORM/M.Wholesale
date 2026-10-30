# DrugXOne and HealthFlow API discovery

Inspected local source on 2026-10-27. This documents local implementations, not confirmation of deployed availability. No credentials were read or copied and no external requests were made.

## HealthFlow

Existing reference: `D:/APPS/HealthFlow Pharmacy/docs/HMS_API_INTEGRATION.md`.
Implementation: `api/hms-api/handler.js`; routing configuration: `vercel.json`.
Base path: `<HealthFlow deployment>/hms-api`.

| Method | Path relative to base | Purpose | Success |
| --- | --- | --- | --- |
| GET | `/health` | Configuration health | 200 |
| GET | `/medicines` | Medicine/stock lookup | 200 |
| GET | `/medicines/{id}` | Medicine details | 200 |
| POST | `/patients` | Patient upsert | 200 |
| POST | `/prescriptions` | Pending prescription for pharmacy review | 201 |
| GET | `/dispensing/{reference}` | Prescription/sale dispensing status | 200 |

Authentication: except health, `x-hms-api-token: <token>` or `Authorization: Bearer <token>`; token header name is configurable with `HMS_API_TOKEN_HEADER`. Server validates against `HMS_API_TOKEN`. This is a shared integration token, not a Supabase user session.

Medicine search supports `search`, `in_stock`, `branch_id`, and `limit` (default 50, maximum 100). The existing reference contains patient and prescription JSON examples. Errors use `{error, code?}`. The handler defaults to a 1 MiB body limit, configurable via `HMS_API_MAX_BODY_BYTES`.

Server configuration: `SUPABASE_URL` (fallback `VITE_SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY`, `HMS_API_TOKEN`, optional `HMS_API_ALLOWED_ORIGINS`. Keep credentials on the server.

**Integration gap:** these are hospital-to-pharmacy interfaces. The inspected HMS router does not expose wholesale purchase-order intake, supplier catalogue updates, or goods-receipt import. Those contracts still need to be designed and implemented for this ERP. The shared-token, service-role handler needs an explicit tenant/branch authorization review before multi-tenant use; the presence of a branch filter alone is not authorization.

## DrugXOne

Project identity confirmed by `D:/APPS/pharma-hub-connect/README.md`.
No standalone OpenAPI/Swagger API reference was found in the tracked-looking source/documentation inventory. The application uses Vercel HTTP handlers plus Supabase database APIs/RPCs.

### Verified checkout contract

Source: `api/orders/create.ts`.

`POST <DrugXOne deployment>/api/orders/create`

Authentication: `Authorization: Bearer <Supabase user access token>`. Handler validates the token using `auth.getUser`; a shared API key is not an interchangeable credential.

```json
{
  "requestId": "<UUID retained for retry>",
  "pharmacyId": "<pharmacy UUID>",
  "items": [{"productId": "<marketplace product UUID>", "quantity": 2, "category": "cash_private"}],
  "creditWholesalerIds": [],
  "settlementMethods": {"<wholesaler UUID>": "cod"}
}
```

Quantity must be a positive integer. Categories: `nhis`, `cash_private`, `other`; database checkout requires classified lines. Settlement values: `cod`, `credit`, `bank_transfer`, `momo`, `cheque`, `other`; `pay_now` additionally requires online-payment configuration. The server calls `create_marketplace_orders_once` with request/caller/business identifiers.

Success: HTTP 200 `{orderCount: number, awaitingPayment?: [{orderId, orderNumber, wholesalerId, amountGhs}]}`. Errors include 400 validation/database failure, 401 missing/invalid token, 405 unsupported method, 500 missing server configuration. Reuse `requestId` for retries; verify the backing RPC's deployed idempotency contract before enabling retries in production.

### Additional discovered HTTP handlers

- `/api/orders/confirm-payment`, `/api/orders/send-receipt`
- `/api/payments/initialize`, `/api/payments/verify`, `/api/payments/webhook`, `/api/payments/reconcile`
- `/api/payments/admin-reverify`, `/api/payments/admin-refund`, `/api/payments/admin-payout`
- `/api/staff/[action]`, `/api/platform-staff/[action]`
- `/api/push/subscribe`, `/api/push/dispatch`

These are an inventory, not verified request contracts. Administrative/payment endpoints must not be used as catalogue synchronization endpoints. Product, order and business identifiers must be mapped between systems; ERP IDs cannot be passed as marketplace IDs.

Related docs: `docs/external-procurement.md`, `docs/external-supply-orders.md`, `docs/payments/runbook.md`, `supabase/SETUP.md`.

## Next integration work

1. Confirm deployed versions/base URLs and provision scoped sandbox identities.
2. Define the desired direction: ERP catalogue/availability to DrugXOne; marketplace orders to ERP; HealthFlow replenishment orders to ERP; dispatch/receipts back to counterparties.
3. Define tenant/business, product, pack-unit and branch mappings, including price/tax and batch/expiry semantics.
4. Implement explicit service-to-service scopes, idempotency, outbox delivery, signed callbacks and reconciliation. Existing user-facing checkout is not a complete wholesaler synchronization API.
5. Publish versioned OpenAPI contracts from the implemented adapters and exercise them against sandboxes before enabling production delivery.

Local source access removes the documentation-discovery blocker. It does not establish deployed credentials or prove live connectivity.
