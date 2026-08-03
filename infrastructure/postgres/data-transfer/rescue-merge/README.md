# Lovable to rescue-production merge lane

This directory is a future, local-only reconciliation lane. It does not call
Lovable, Supabase, or a restaurant system. It does not replace the current data
transfer toolkit and it does not contain an apply executor.

## Contract

1. Export Lovable from one `REPEATABLE READ READ ONLY` transaction and one
   exported PostgreSQL snapshot. Record `snapshotAt`, WAL LSN, row digests, and
   the exact cutover timestamp.
2. Store the export outside the repository on verified encrypted storage. The
   planner accepts only an `external-encrypted` artifact with manifest and
   payload SHA-256 values. Database URLs and snapshot identifiers never enter
   the plan.
3. Exclude `provider_credentials` and every rescue runtime credential,
   idempotency, execution, and canary table from the Lovable artifact.
4. Sanitize `pos_connections` before comparison or insertion. A missing source
   connection can only be proposed as disabled, `PULL_ONLY`, `write_mode=NONE`,
   without endpoints, tokens, provider config, cursors, breaker state, catalog
   execution, stock execution, or auto-push.
5. Use primary and reviewed natural keys from `policies.mjs`. A source row may
   only become `INSERT_MISSING` when it is absent by both identities and its
   reviewed watermark is not later than the cutover.
6. An identical overlap becomes `IDENTICAL_NOOP`. A different overlap becomes
   `CONFLICT_SOURCE_TARGET` or `PROTECT_TARGET_NEWER`; neither produces an
   update. Target-only rows are always retained.
7. Rows created or refreshed in Lovable after cutover become
   `SOURCE_AFTER_CUTOVER_REVIEW`. They are not automatically imported.
8. Source and target comparisons each use one exported `REPEATABLE READ READ
   ONLY` snapshot. The plan is deterministic and always `dry-run`.
9. A future apply executor must separately call `evaluateApplyGate`, confirm
   the exact plan digest, take a fresh target snapshot after planning, prove it
   is restorable and restore-tested, and bind a serializable conflict recheck to
   that same plan digest.
10. Apply must be one transaction with a target advisory lock, serializable
   conflict recheck, insert-only SQL, post-apply reconciliation, and automatic
   rollback on any mismatch. None of that is implemented here yet.

## Local tests

```sh
node --test infrastructure/postgres/data-transfer/rescue-merge/planner.test.mjs
```

The suite covers overlapping, duplicate, and conflicting sales; target-only
receipts; post-cutover rows; missing sales-line identity; connection
sanitization; a fresher target catalog; and the rollback/apply gate.

## Schema gaps blocking a fully automatic merge

- `pos_connections` has no immutable cross-environment natural key. UUID is the
  only reliable identity today.
- `sales_line_items` has neither provider line ID nor invoice line ordinal. The
  former event/product uniqueness constraint was removed, so repeated products
  cannot be deduplicated safely.
- `stock_sync_log.idempotency_key` is nullable and its uniqueness is partial.
  Older/failed rows without a claim remain manual.
- `outbound_tasks` has no immutable task key or unique payload fingerprint. It
  must not be copied into a live queue.
- `agora_master_data` and mutable catalog/mapping tables have timestamps but no
  source version vector, ownership field, or immutable provider revision.
- `user_roles` references Auth identities, while Auth users are outside this
  data lane.
- Alerts, incidents, email attempts, onboarding lifecycle rows, and health
  observations lack complete cross-environment natural keys or require privacy
  review.

Until those gaps are fixed, the planner deliberately returns manual blockers
instead of inventing equivalence or overwriting rescue-production.
