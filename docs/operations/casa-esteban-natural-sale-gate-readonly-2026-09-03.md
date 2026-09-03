# Casa Esteban - natural sale gate (read-only, 2026-09-03)

## Result

`BLOCKED_NO_AUTHENTICATED_NATURAL_SALE_EVIDENCE`

## Read-only evidence

- Connection: `5bed7bf7-f28a-4a1c-95f4-bc02ecb9298f` (Casa Esteban, Agora).
- Observed at `2026-09-03T10:47:00Z`: `enabled=false`, `PULL_ONLY`,
  `write_mode=NONE`, catalogue sync disabled, no breaker, no live lease, and
  zero active own-infra scopes, credentials, or writer fences.
- The retained sales snapshot has zero mapped Casa Esteban lines. Consequently
  there is no invoice/line -> mapping -> claim -> Winerim history -> stock
  receipt chain that can certify a natural Winerim-button sale.
- Recent own-infra runtime entries include successful scheduled sales jobs, but
  a scheduler `SUCCESS` is not evidence of an invoice or a sale import.
- A strictly read-only authenticated source check was prepared. It stopped
  before any HTTP call because the legacy control-plane row has no available
  API credential and own-infra has no active credential material. No token was
  printed, persisted, or searched for outside the approved secret boundary.

## Writer attribution

There is no traceable mapped sales claim or stock receipt. Therefore it cannot
be attributed to own-infra or legacy Lovable; both would be an inference. The
only observed execution records are own-infra scheduler entries, not a sale.

## Next material gate

An operator must select the existing credential in the approved secret manager
for a single read-only session, or supply the exact invoice date/ID through the
existing secure support channel. Then run the prepared source reader only for
that day and correlate the invoice line with `sales_events`,
`sales_line_items`, `runtime_idempotency`, and `stock_sync_log`. No activation,
writer scope, deployment, replay, backfill, stock, or cursor change is needed
for that audit.
