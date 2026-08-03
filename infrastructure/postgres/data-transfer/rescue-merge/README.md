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
   payload SHA-256 values. `payloadSha256` is not trusted metadata: the planner
   recomputes it with `rescueMergeSourcePayloadSha256(tables)` over a versioned
   canonical envelope containing every source table and row, independent of row
   or table insertion order. A mismatch rejects the plan. The manifest digest,
   recomputed payload digest, source watermark, cutover, scope, and reviewed
   policy version plus SHA-256 are bound into `artifactBindingSha256` and
   therefore into `planSha256`. `targetRowsSha256` separately binds every exact
   target row, including target-only duplicates. Database URLs and raw snapshot
   identifiers never enter the plan.
3. Exclude `provider_credentials` and every rescue runtime credential,
   idempotency, execution, and canary table from the Lovable artifact.
4. Sanitize `pos_connections` before comparison. A source connection without
   the same target UUID becomes `CONNECTION_IDENTITY_UNRESOLVED`; it is never an
   automatic insert. Matching source rows are compared only after endpoints,
   tokens, provider config, cursors, breaker state, catalog/stock execution,
   and auto-push have been removed or disabled.
5. Use only the deeply frozen, versioned policies from `policies.mjs`; callers
   cannot inject replacements. The reviewed policy digest covers table rules,
   dependencies, FKs, credential detection and sanitization overrides, every
   blocking action type, maximum-timestamp selection, canonical row ordering,
   and target-duplicate handling. A source row may
   only become `INSERT_MISSING` when it is absent by both identities and its
   reviewed watermark is not later than the cutover.
6. An identical overlap becomes `IDENTICAL_NOOP`. A different overlap becomes
   `CONFLICT_SOURCE_TARGET` or `PROTECT_TARGET_NEWER`; neither produces an
   update. Target-only rows are always retained. Every row participating in a
   duplicate target primary or natural key becomes a digested
   `TARGET_DUPLICATE_KEY` blocker, even when no source row overlaps it.
7. Rows created or refreshed in Lovable after cutover become
   `SOURCE_AFTER_CUTOVER_REVIEW`. They are not automatically imported.
8. A plan must contain all reviewed source tables or declare an exact
   dependency-closed scope. Parent tables are processed first. A PK alias found
   through an identical natural key is propagated to child foreign keys;
   unresolved parents block the child. This includes the nullable
   `webhook_events.connection_id` dependency on `pos_connections`.
9. Source and target comparisons each use one exported `REPEATABLE READ READ
   ONLY` snapshot. The enforced order is
   `cutover <= source snapshot <= target snapshot <= plannedAt`. Each watermark
   includes matching capture time, WAL LSN, snapshot-ID digest, and distinct
   database-identity digest.
   Context and row timestamps must be valid RFC3339 UTC values ending in `Z`.
   Any configured timestamp field that is present but invalid rejects the plan;
   it never falls back to another timestamp column. Cutover and freshness use
   the maximum valid configured timestamp, not the first populated column.
10. Source rows, target rows, actions, aliases, and FK rewrites use canonical
   code-unit ordering. Reordering the same logical row sets does not change any
   payload, target, artifact-binding, or plan digest. The plan is always
   `dry-run`. `evaluateApplyGate` always
   returns `APPLY_GATE_BLOCKED`, even when its caller claims a snapshot, recheck,
   and matching hashes. It cannot open until a separately reviewed executor
   supplies cryptographically verified backup and database recheck evidence.
11. Apply must eventually be one transaction with a target advisory lock, serializable
   conflict recheck, insert-only SQL, post-apply reconciliation, and automatic
   rollback on any mismatch. None of that is implemented here yet.

## Local tests

```sh
node --test infrastructure/postgres/data-transfer/rescue-merge/planner.test.mjs
```

The suite covers overlapping, duplicate, and conflicting sales; every
target-only duplicate blocker and digest; strict UTC timestamps, maximum-column
selection, and invalid-row fail-closed behavior; immutable policy selection and
enforcement-policy digest drift; complete and dependency-closed scopes;
recomputed payload-to-plan binding; temporal/watermark ordering; PK alias
propagation, webhook dependencies, and unresolved FKs; target-only receipts;
post-cutover rows; missing sales-line identity; connection sanitization and
identity blocking; a fresher target catalog; row-order-independent plan hashes;
and the permanently closed apply gate.

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
