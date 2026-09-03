# Fleet Queue isolation staging proof - 2026-09-03

Result:
`FLEET_QUEUE_ISOLATION=STAGING_PROVEN_PRODUCTION_NOT_DEPLOYED`

## Problem reproduced

The first Cloudflare staging run used `max_batch_size=1` and
`max_concurrency=2`, without application-level parallelism. It did not isolate
the two synthetic connections under low load:

- Worker version: `a6d3b500-6827-4a6f-822c-01115b507f6b`.
- Slow connection: started `09:35:40.325Z`, completed `09:36:40.325Z`.
- Fast connection: started `09:36:40.746Z`, completed `09:36:40.771Z`.
- The fast message waited for the slow message despite the platform
  concurrency cap being two.

This proves that the Queue autoscaler cap alone is not a deterministic
low-backlog isolation mechanism.

## Change

- Runtime messages are grouped by `connectionId` within each delivered batch.
- Up to two different connection groups execute concurrently.
- Messages belonging to the same connection remain strictly ordered.
- The catalog-only rendered consumer uses `max_batch_size=10`,
  `max_batch_timeout=5`, `max_concurrency=2` and the catalog lane explicitly.
- Existing reservation, idempotency, retry, terminal and DLQ behavior is
  unchanged.

## Cloudflare proof

The second run exercised the production queue consumer implementation through
a temporary synthetic-only Worker:

- Worker version: `053cfc4c-d686-42d8-9142-d8c19f90dc80`.
- Delivered batch size: `2`.
- Both connections started at `09:41:14.417Z`.
- Fast connection completed at `09:41:14.442Z` (`25 ms`).
- Slow connection completed at `09:42:14.417Z` (`60,000 ms`).

Therefore the healthy connection completed while the slow connection was
still running. The temporary Worker, Queue, DLQ and run secret were deleted
after the readback. No production queue, consumer, Worker, DNS, database,
restaurant credential or business record changed.

## Verification

- Runtime Worker suite: `25/25`.
- Catalog renderer: `4/4`.
- Synthetic harness: `4/4`.
- Full repository suite: `790` passed, `4` skipped.
- Production frontend build: pass.
- ESLint and `git diff --check`: pass.
- Production catalog config dry-run: pass, bundle `285.67 KiB`, gzip
  `58.99 KiB`, `RUNTIME_EXECUTION_ENABLED=false`, lane `catalog`.
- Rendered config SHA-256:
  `b87ff07f8df175ceb76b8f29f7557cb38ba0574fd1689ce685539b3e3bb6cd20`.

## Remaining gate

Before any production activation, reconcile the change onto the reviewed
clean Fleet branch, run the full test/build sweep, add SaleCenter and
preparation-routing readiness to the fleet audit, and obtain a fresh,
scope-specific production authorization. The final Casa Esteban sale canary
remains the last gate for exactly-once history and stock certification.
