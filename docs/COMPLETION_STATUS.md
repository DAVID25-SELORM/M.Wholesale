# Completion status

This is a work-in-progress record, not production acceptance or a handover.
The original roadmap in `06-roadmap.md` contains substantially more scope than
the implemented numbered migration stages. Migration count does not measure
software completion.

## Local verification recorded on 2026-10-24

- Production build passed (bundle size warning remains).
- Typecheck and lint passed.
- Updated unit suite: 194 passed across 27 files.
- Existing browser suite: 47 passed.
- Follow-up recall and delivery-run browser checks: 2 passed.
- Whole-line substitution regression passed after fixing ambiguous option columns
  and the stock adjustment reason code.
- Initial database suite: 423 passed, one error-message regression; corrected.
- Clean full database/security rerun: 427 passed across 31 files.

## Deployment boundary

Local follow-up on 2026-10-25: migration 024 installed successfully on a fresh
test database; all 23 picking/packing tests passed, including the new cross-bin
eligibility regression. Typecheck passed. This is focused coverage, not a new
full-suite or production acceptance result.

The user confirmed hosted migrations through `20261027002300`.
Later migrations and application changes are local. They have not been pushed
or applied to production by this work. External integrations are deferred because
the user has no provider credentials available yet.

## Current local corrections

- Migration 028 implements explicit replacement-bin selection for whole-line
  substitutions, records the source location for posting and displays the actual
  location on pick lists. Fresh Docker migration installation, all 35 focused
  picking/controlled tests and typecheck passed. Partial-line quantities remain
  outstanding. Earlier location restrictions below describe superseded stages.

- Migration 027 permits new attempts after withdrawal/rejection while preserving
  old decisions and enforcing one pending/approved attempt per exception. Fresh
  migration installation and all 35 focused tests passed on 2026-10-25, including
  withdrawal, reissue and independent approval of a controlled substitution.

- Migration 026 stops restoring missing/unspecified shortages to available stock;
  damaged/expired originals go to quarantine. Both approval paths share the line
  builder. Fresh migration installation and all 35 focused picking/controlled
  tests passed on 2026-10-25. Historical postings are unchanged; legacy controlled
  requests with obsolete lines are blocked pending review/reissue support.

- Migration 025 preserves request reasons, validates replacement eligibility at
  request creation, and locks linked orders before controlled approval/rejection/
  cancellation requests. Fresh migration installation and all 33 focused picking/
  controlled-adjustment tests passed on 2026-10-25. Full-suite and adversarial
  concurrency acceptance remain open.

- Migration 024 aligns substitution choices and direct requests with the original
  pick location, excludes recalled choices, and locks the order before substitution
  request/approval rows. Cross-bin replacement is still unsupported.

- Recall selection, batch selection, quarantine actions and typed frontend access.
- Quarantine preserves locations and returns all stock document references.
- Recall closure requires scoped batches and no remaining available affected stock.
- Recall guards prevent sales, release to available stock and dispatch of recalled batches.
- Substitution options use a read-only permission check instead of locking from a stable function.
- Hold release restores the appropriate picking state; reversal clears active hold metadata.
- Substitution submission and approval handoff use one transaction.
- Whole-line substitution approval validates current state, expiry, shelf life and recall status,
  then updates picked quantities and settles the order.
- Resolved short picks cannot be reset over stock or credit evidence.
- Short-pick decisions re-read after acquiring the order lock.
- Ship-short draft credits convert base quantities to the original invoice unit.
- Delivery-run table access uses the same branch/assigned-driver checks as RPC reads.
- Picking screens expose hold and release actions and a hold filter.
- Recall customer trace lists original invoice allocations and approved substitutions
  with customer contacts and latest delivery status; runtime verification is pending.

## Remaining local work before completion

- Partial-line substitution needs separate original/replacement batch quantities
  throughout picking, package contents, labels and traceability. It is currently
  rejected to avoid recording two batches as one.
- Recall recovery tracking and quarantine-release authorization
  are not a complete workflow yet. Current dispatch checks deliberately block even
  original allocated recalled batches after substitution, pending investigation.
- The new guards have regression coverage recorded above. Additional adversarial
  concurrency coverage and controlled-substitution scenarios remain necessary.
- Review existing approved substitutions for historical quantity/batch inconsistencies;
  new triggers do not silently rewrite historical transactions.
- Remaining planned navigation includes approvals, price agreements, purchasing requests,
  supplier quotations, expenses, CRM and additional intelligence screens. Their presence
  in the roadmap must not be represented as implemented functionality.
- Roadmap features such as offline operations, temperature logging, richer proof of
  delivery, subscriptions and the customer portal still need scope-by-scope completion.

## External release dependencies

- Provider specifications and sandbox access for integrations when available.
- Production authentication, mail, backup and hosting configuration.
- Real opening data, reconciliation, staff access and business acceptance.

See `CUTOVER.md` for the operational acceptance steps. None are marked complete
merely because a local build succeeds.
