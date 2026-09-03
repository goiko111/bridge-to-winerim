# Middleware follow-up ledger - 2026-09-03

This ledger is sequencing only. It authorizes no production mutation.

## Active evidence gates

| Connection | State | Next safe action | Writer action |
| --- | --- | --- | --- |
| Taberna del Clinic | Own-infra live; BOTTLE path observed | Passively observe the first closed `GLASS` invoice and trace invoice, mapping, claim, history and stock receipt | None |
| Casa Esteban | Source preflight passed; own-infra inert | Public/preview URL controls verified disabled; create a fresh bound grant, then take a fresh snapshot/diff | No activation until an append readback succeeds |
| Taberna del Clinic legacy wine | Bounded hide batch in progress | Continue only after every task in batch `001` has verified its own product readback | No writer/sales/stock change |
| Albariza | Audit lane active | Refresh catalogue, format, price, sales/history, stock and idempotency evidence without mutations | Read-only |
| Cedric/Amaii/Ocean Club | Audit lane active | Separate Ocean and Amaii identity/gates, then document each outstanding mapping and stock decision | Read-only |

## 2026-09-03 sidecar receipts

- **Clinic:** live sales lane is healthy (`sales.sync-intraday` 16:11:52
  CEST, no active breaker/lease). The observed glass button is generic legacy
  `ProductId=425`, not an unmapped Winerim GLASS regression. Wine-only legacy
  hide batch `001` completed `10/10` with per-product import receipts; batch
  `002` is a separate bounded group of ten, awaiting the same readback gate.
- **Albariza:** prevention remains evidenced at `44/44` glasses, but the
  current full catalogue/sales/stock readback is blocked by a 30-second
  control-plane timeout. State remains `SLA_DEGRADED/READBACK_BLOCKED`.
- **Flama:** own-infra remains inert, blocked by DNS/origin for
  `flama.dynalias.com`.
- **O Bistro:** exact catalogue hydrate is known (`103 wines / 138 variants`),
  but the writer remains inert after `WRITER_FENCE_DATABASE_UNAVAILABLE`.
- **Ocean Club:** historic catalogue evidence is `113/113`; sales/history and
  stock lack a current canary certification. **Amaii by OC** has no separate
  connection identity yet and is `BLOCKED_IDENTITY_NOT_FOUND`.

## Read-only discovery queue

1. Flama: source reachability, catalog hierarchy/product visibility, price and sales freshness; distinguish DNS/origin from mapping or routing.
2. O Bistro: contractual authenticated API, current writer, catalog/product visibility, sales and stock chain; distinguish a reachable panel from the Agora integration API.
3. Taberna de Elia: two contractual source reads separated in time, then current catalog/sales/stock and queue/breaker evidence. Treat persistent 503 as a SAT/origin gate.

## Platform work after evidence

1. Per-connection certification scorecard with source evidence timestamp, writer, catalog, sales/history, stock, freshness, queue/breaker and blocker.
2. Operations UI design: roles `viewer`, `operator`, `admin`; read-only default; audited approval gates for write, replay, stock and legacy visibility; no secret display.
3. Durable integration-rule registry: versioned per connection, schema-validated, owner and test coverage. No rules keyed by restaurant name.
4. Separate UI modules: operational control (connection state, queues, leases, breakers, scopes and gated actions) and audit evidence (diffs, sales, stock, historical data, formats and certification gates). Both default read-only and have separate RBAC/API boundaries.

## Security incident

On 2026-09-03, a first Cloudflare materializer API token was inadvertently revealed in an automation result while being created. It was immediately revoked. A replacement was created only after user approval and stored directly as a Worker secret; no token value is retained in repository artifacts or operational documentation.

## Invariants

- One writer per connection; no legacy change before a snapshot and exact coverage proof.
- Closed invoices are the sales source; open tickets are never entered into Winerim history.
- Historical recovery is `history-only` and cannot mutate stock.
- Stock uses the connection policy and exact-once receipt/readback only.
