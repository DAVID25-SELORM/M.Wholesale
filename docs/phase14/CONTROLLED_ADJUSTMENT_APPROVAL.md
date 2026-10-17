# Phase 14: second-person approval for controlled-drug adjustments

Migration: `20261023000100_controlled_adjustment_approval`. Apply with `scripts/apply-phase14.sql` (one transaction).

## Why

The access review (`docs/ACCESS_REVIEW.md`, finding 4 of Phase 12) found that a warehouse manager could adjust controlled stock, and read the controlled-drugs register, with nobody checking. A controlled medicine that disappears through a stock adjustment is the classic way a register is falsified.

## What changed

- **An adjustment of a controlled medicine is now a request.** Stock → Adjust stock behaves as before for ordinary products. When any line is a controlled product, the same screen says so and sends a *request* (with a reason and a written explanation of at least five characters) instead of posting.
- **A second person decides.** Warehouse → Controlled adjustments lists requests. Someone with the new right `inventory.controlled_approve` (pharmacist, owner, super admin, general manager) approves or rejects. **Nobody can approve their own request, not even an owner**: the database refuses it, and the schema also forbids an approved request whose approver equals its requester.
- **The stock document is posted only on approval,** attributed to the approver, numbered like any adjustment, with the request number and explanation in its notes. The request, the decision and the stock document are audited; the controlled-drugs register shows the movement as before.
- **Direct adjustment is refused.** `post_stock_document('ADJUSTMENT', …)` with a controlled product raises "adjusting a controlled medicine needs a second person's approval", for everyone including owners. Branch-limited approvers can decide only their own branch's requests. The requester can withdraw a pending request; nobody else can.
- If the stock is not there when the approver approves, the approval fails and the request stays pending (reject it with a reason).

## Unchanged on purpose

Stock counts keep their own existing approval (counter and approver already differ). Transfers and status changes of controlled medicines, sales and returns, and everything about ordinary products are unchanged.

## Access-review findings not changed

- **Branch managers can refund** (`refunds.create`): left as is. Branch managers take cash refunds from their own till shift at the counter; removing the right would stop that. If you separate cash handling from management, remove the right from the built-in role (or assign your cashiers a refund-capable role).
- **Accounts manager runs the whole supplier-payment cycle, and procurement manager raises and approves purchase orders:** an organisation decision. With two people in finance or buying, give the preparing right to the second person and keep approving with the manager.
