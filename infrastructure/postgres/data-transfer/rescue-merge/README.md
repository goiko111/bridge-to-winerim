# Lovable to rescue-production merge lane

This directory is an isolated reconciliation lane. Planning and CLI dry-runs
are local-only and never connect to Lovable, Supabase, or a restaurant system.
The apply executor can connect only to the target PostgreSQL URL supplied in
`RESCUE_MERGE_TARGET_DATABASE_URL`; URLs are rejected on the command line. It
does not replace the current data-transfer toolkit.

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
   and matching hashes. It cannot open by itself. `executor.mjs` independently
   opens a stricter gate only after it recomputes the plan and verifies the
   backup artifact, explicit confirmations, database identity and live target.
11. Apply is one `SERIALIZABLE READ WRITE` transaction protected by a
   transaction-scoped advisory lock. The executor reads the current target,
   recomputes the original plan, and requires exact `planSha256` and
   `targetRowsSha256` matches before inserting anything. It issues only plain
   `INSERT` statements for reviewed `INSERT_MISSING` actions. It never uses
   `UPDATE`, `DELETE`, `TRUNCATE`, `UPSERT`, conflict suppression, queue writes,
   credential tables, or runtime tables.
12. After insertion and before commit, the executor reads the target again and
   requires the exact expected target digest, zero remaining `INSERT_MISSING`,
   no blockers, and one `IDENTICAL_NOOP` per inserted row. Any mismatch or
   database error executes `ROLLBACK`; no compensating delete is needed because
   the transaction has not committed.

## Executor inputs

All JSON inputs and outputs must be owner-only regular files (`0600` or `0400`),
not symlinks. Output directories must be `0700`.

- `--plan`: exact schema-version 4 output from `planRescueMerge`.
- `--artifact`: `{ "schemaVersion": 1, "plannerInput": { "context": ..., "tables": ... } }`.
- `--backup-manifest`: schema-version 1 attestation for a real target backup.
  It binds a checked encrypted file to the target database identity, exact
  target rows and plan. `manifestSha256` is
  `sha256(canonicalJson(manifest without manifestSha256))`.
- `--output-dir`: owner-only directory for the execution report.

Required backup-manifest fields:

```json
{
  "schemaVersion": 1,
  "environment": "rescue-production",
  "storageClass": "external-encrypted",
  "encrypted": true,
  "restorable": true,
  "restoreTested": true,
  "capturedAt": "2026-08-04T10:00:00.000Z",
  "restoreTestedAt": "2026-08-04T10:05:00.000Z",
  "databaseIdentitySha256": "<same digest as plan target watermark>",
  "targetRowsSha256": "<plan targetRowsSha256>",
  "conflictRecheckPlanSha256": "<plan planSha256>",
  "artifact": {
    "relativePath": "target-before.sql.age",
    "sha256": "<encrypted file sha256>",
    "bytes": 123
  },
  "manifestSha256": "<manifest digest>"
}
```

Backups may be at most 24 hours old and the restore test must be later than
capture. The database identity is
`sha256(canonicalJson({ database, systemIdentifier }))`, using
`pg_control_system()`. If the connected role cannot prove that identity, apply
fails closed; the executor installs no schema or privileged helper.

## CLI

Dry-run is the default. It verifies the plan, payload, backup manifest and
backup file locally, emits a `0600` report, and never reads a database URL:

```sh
npm run data:rescue-merge -- \
  --plan /secure/plan.json \
  --artifact /secure/source-and-target.json \
  --backup-manifest /secure/backup/manifest.json \
  --output-dir /secure/reports/run-001
```

Apply additionally requires the target URL in the environment and four exact
confirmations. Supplying a URL as an argument is forbidden:

```sh
RESCUE_MERGE_TARGET_DATABASE_URL='postgresql://...' \
npm run data:rescue-merge -- \
  --plan /secure/plan.json \
  --artifact /secure/source-and-target.json \
  --backup-manifest /secure/backup/manifest.json \
  --output-dir /secure/reports/run-002 \
  --apply \
  --confirm-apply APPLY_INSERT_MISSING_ONLY_TO_RESCUE_PRODUCTION \
  --confirm-plan-sha256 '<planSha256>' \
  --confirm-artifact-payload-sha256 '<artifactPayloadSha256>' \
  --confirm-backup-manifest-sha256 '<backup manifestSha256>'
```

Target snapshots must use the canonical projection in `postgres.mjs`: UTC
timestamps use millisecond `Z` form, `numeric` and `bigint` use decimal strings,
`date` uses `YYYY-MM-DD`, and `bytea` uses lower hex. An artifact with another
representation will not recheck and therefore cannot be applied.

## Local tests

```sh
npm run data:rescue-merge:test
```

The suite covers overlapping, duplicate, and conflicting sales; every
target-only duplicate blocker and digest; strict UTC timestamps, maximum-column
selection, and invalid-row fail-closed behavior; immutable policy selection and
enforcement-policy digest drift; complete and dependency-closed scopes;
recomputed payload-to-plan binding; temporal/watermark ordering; PK alias
propagation, webhook dependencies, and unresolved FKs; target-only receipts;
post-cutover rows; missing sales-line identity; connection sanitization and
identity blocking; a fresher target catalog; row-order-independent plan hashes;
and the planner's permanently closed standalone apply gate. Executor tests use
a transactionally faithful PostgreSQL mock for the explicit gate, backup
binding, advisory lock ordering, serializable transaction, target drift,
insert-only execution, exact post-reconciliation and automatic rollback. The
CLI test proves dry-run remains offline and emits `0600` artifacts.

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
instead of inventing equivalence or overwriting rescue-production. The executor
does not bypass them. In particular, `sales_line_items` cannot be merged
automatically, `stock_sync_log` without a durable idempotency key cannot be
merged, and a source connection with a different UUID cannot be created here.
