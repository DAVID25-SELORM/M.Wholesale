# Cold-chain temperature logging

Migration `20261104000200_temperature_logging.sql` (hosted apply script: `scripts/apply-temperature-logging.sql`, not yet applied).

## What it does

- A cold-chain package (flagged when packing) can have temperature readings recorded at four moments: packing, dispatch, in transit, delivery.
- The allowed range comes from the strictest storage condition among the goods packed in it:
  frozen -25 to -15 °C, refrigerated 2 to 8 °C, cool 8 to 15 °C, ambient 15 to 30 °C.
  These are fixed defaults in `private.temperature_limits`. They are not yet configurable per organization.
- Readings are append-only evidence. The limits in force are stored on each reading.
- An out-of-range reading opens an **excursion** automatically.
- A different person holding `temperature.decide` must **accept for use** or **reject the goods**, with a reason of at least 10 characters. The person who recorded the reading cannot decide it.
- An open excursion, or a rejected one, blocks dispatch of the delivery. A rejected package is cleared by voiding it and repacking from good stock.
- Nothing here moves stock or touches an invoice, price or amount.

## Permissions

| Permission | Holders |
| --- | --- |
| `temperature.view` | Super admin, owner, general manager, branch manager, warehouse manager, warehouse packer, dispatcher, driver, pharmacist, auditor |
| `temperature.record` | Super admin, owner, general manager, branch manager, warehouse manager, warehouse packer, dispatcher, driver |
| `temperature.decide` | Super admin, owner, general manager, branch manager, warehouse manager, pharmacist |

All access is limited to the caller's organization and branch. Tables have no write grants; every change goes through
`record_temperature_reading`, `resolve_temperature_excursion` and `cold_chain_packages`.

## Tests

- `tests/security/temperature.test.ts`: ranges, strictest-condition rule, dispatch block, four-eyes, reject and repack, permission, cross-branch and cross-tenant refusals, no direct writes, no stock movement.
- `tests/e2e/temperature.spec.ts`: record in range and out of range in the browser, four-eyes refusal shown, cashier has no menu entry and sees the unauthorized page.

## Not included yet

- Per-organization temperature limits and per-product overrides.
- Automatic data-logger or probe import, and alarms or notifications.
- Temperature capture by drivers on a phone while on a run (the readings table supports a delivery stage; the driver screen does not yet use it).
- Storage-room (warehouse location) temperature monitoring. This covers packages only.
