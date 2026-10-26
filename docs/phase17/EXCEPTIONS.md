# Phase 17e: fulfilment exceptions

This stage resolves short picks without rewriting invoice allocation evidence.

- Supervisors can accept a short pick, create a ship-short credit note, or place the order on hold.
- A same-product substitute batch is checked for expiry, customer shelf life and available stock.
- Approved substitutions post an auditable adjustment that removes replacement stock. Damaged/expired original goods are recorded in quarantine; missing or unspecified shortages are not restored.
- Controlled substitutions enter the existing second-person controlled-adjustment workflow; approval synchronizes the substitution, actual batch and exception automatically.
- The exceptions dashboard shows open decisions and offers eligible batch choices for non-controlled substitutions. Controlled requests remain visible in Controlled adjustments so the requester and approver remain different users.
- Holds pause picking and packing; releasing a hold restores `RELEASED`, `PICKING` or `PICKED` according to the recorded lines and exceptions.

Local follow-up corrections use one transactional submission RPC and validate approvals against current order state. Whole-line substitutions update the packing quantity and settle the order. Partial-line substitutions are rejected until original and substitute batch quantities can be tracked separately. See [completion status](../COMPLETION_STATUS.md) for remaining work and deployment status.

The migration does not change sales invoices, prices or delivery stock movements except for the explicit substitution adjustment and the existing credit-note flow.

Migration 025 preserves new substitution request explanations in `request_reason`.
Older requests retain null because their original explanations were not stored.
Request validation rejects recalled, undated and partially picked replacements.
Linked controlled approval, rejection and withdrawal acquire the fulfilment order
lock before the controlled request lock. Independent-approver permissions remain
enforced by the controlled-adjustment functions.

Migration 026 uses the short-pick reason for stock disposition in both approval
paths. NOT_FOUND/OTHER do not assert a physical return; DAMAGED/EXPIRED record
the original quantity in quarantine. The UI explains the physical confirmation
required. This preserves the original invoice allocation while recording the
replacement deduction as an audited adjustment. Existing pending controlled
requests with obsolete lines are blocked for supervisor review. Historical posted
adjustments are not rewritten; historical reconciliation remains outstanding.

Migration 027 retains rejected/withdrawn attempts and permits a new request for
the same open exception. Only one pending or approved attempt may exist. For an
obsolete controlled request, its requester withdraws it in Controlled adjustments,
then submits a fresh substitution from Fulfilment exceptions. The old request,
stock-line proposal and decision remain available in the audit history.

Migration 028 adds explicit replacement locations. Batch choices are separated
by stock balance/bin; the request verifies organization, warehouse, product,
batch, available status and quantity. Posting uses the recorded replacement bin,
while any quarantined original goods retain their original bin. The original
pick allocation remains unchanged; the pick list shows the actual replacement
location. Older three-argument requests still default to the original location.
Whole-line substitution remains the supported quantity model.
