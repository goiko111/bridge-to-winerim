# Rescue production cutover

Status: prepared, all connections disabled, no production canary approved by
this document alone.

## Two independent sources

- The rescue database is the new operational source. It starts from the
  reviewed schema and disabled connection inventory.
- The recovering Lovable database is a later reconciliation source. Its rows
  are imported table by table only after identity and idempotency comparison.
- Never restore a Lovable snapshot over receipts already confirmed by the new
  runtime.

## Freeze gate

Before any remote deployment, require one clean Git commit and record its full
SHA in the canary manifest. Repeat TypeScript, runtime, executor, fail-closed,
PostgreSQL replay, post-bootstrap restore and Wrangler dry-run on that exact
commit. A dirty tree or a changed test fixture is an automatic no-go.

## Activation order

1. Keep all `pos_connections.enabled=false`, catalog disabled, `PULL_ONLY` and
   `write_mode=NONE`.
2. Load credentials for one restaurant into the private vault only.
3. Perform read-only Agora and Winerim probes and cache only that restaurant.
4. Reconcile every historical receipt, including `stock_sync_log` rows whose
   `sales_event_id` is null. Set a forward-only business-day cutover.
5. Rotate the provider mutation credential away from the old runtime and prove
   the old credential returns `401` or `403`.
6. Create one physical Queue for one reviewed message and one private consumer.
7. Run one real, legitimate sale canary. A canary is not synthetic history and
   must be retained as an immutable business receipt.
8. Require the provider receipt, database receipt, Winerim readback and replay
   with the same idempotency key to show no second stock effect.
9. Observe two healthy cycles before adding another message or restaurant.

## Pre-canary artifact

The mode-0600 artifact must contain only non-secret evidence:

- connection, run, message and immutable commit IDs;
- canonical payload SHA-256 and idempotency key;
- provider document/line identity and Winerim stock identity;
- Winerim stock immediately before the mutation;
- counts and hashes of existing matching sales/stock receipts, including
  detached legacy receipts;
- backup manifest SHA-256, Worker version and writer-fence grant SHA-256;
- the old-writer negative-probe evidence SHA-256.

Any existing receipt with ambiguous identity is a no-go. Secrets, DSNs and
tokens are never part of this artifact.

## Rollback after the first canary

Database restore is forbidden after the first confirmed mutation. Rollback is
operational and append-only:

1. Pause the dedicated canary consumer and revoke the fence grant/proof.
2. Keep the exclusive provider credential away from both writers until the
   readback is classified.
3. Preserve the sale and provider receipt. Never delete a legitimate canary
   sale from either history.
4. If the request timed out, read back by the exact `orderId` and idempotency
   key before any replay. Replay only the identical payload; a new key is
   forbidden.
5. If Winerim confirms the expected stock effect, append/reconcile the missing
   database receipt and do not compensate stock.
6. If Winerim shows an unexpected stock value, do not automatically write an
   inverse. Freeze that restaurant. A compensation may restore the exact
   pre-canary stock only when a fresh readback still equals the canary's exact
   post-stock and proves no later sale or manual adjustment occurred. The
   compensation needs its own fence, idempotency key and append-only receipt.
7. Restore runtime code by immutable Worker version only after the consumer is
   paused. Code rollback does not erase data.

The first live canary remains blocked until the compensation/readback path is
tested with fixtures and the real provider supports exact idempotent readback.

## Fleet expansion

For each restaurant require: healthy connectivity and breaker, fresh master,
catalog diff/readback, exact product mappings, definitive sales, bottle and
glass stock evidence, empty critical Queue, no legacy ambiguity, five-minute
SLA evidence and a rollback artifact. `No alerts` is not certification.

