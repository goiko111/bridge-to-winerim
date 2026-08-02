# Lovable export and staging reconciliation

`EXPORT_RESULT=TOOLING_READY_LOCAL_ONLY`

This runbook transfers only the 24 approved middleware-owned data tables from
Lovable Postgres into the independent Supabase staging database. It never
copies rows from the five staging-owned tables:

- `infrastructure_metadata`
- `provider_credentials`
- `runtime_connection_credentials`
- `runtime_execution_log`
- `runtime_idempotency`

The allowlist is versioned in `data-transfer/config.json`. A source database
may contain additional platform tables, but they are never dumped. The target
must contain exactly the 30 reviewed public tables and the sentinel
`public.infrastructure_metadata.environment=staging`.

## Safety contract

- Every command is a local dry-run unless its explicit live gate is present.
- Database URLs are accepted only through `LOVABLE_DATABASE_URL` and
  `STAGING_DATABASE_URL`; they are never command-line arguments or manifest
  fields.
- `provider_credentials` is staging-owned and required empty before and after
  import. Production rows from that table are never selected or archived.
- `pos_connections` is excluded from raw `pg_dump` table data. A checksummed,
  exact-column projection writes a binary copy with `api_token=''`, a fixed
  non-routable `base_url`, and nullable token, endpoint, provider-config and
  restaurant credential fields cleared. An unknown/reordered column fails the
  export closed.
- Export holds one `REPEATABLE READ READ ONLY` coordinator transaction,
  exports its snapshot, and uses that same snapshot for `pg_dump`, row counts
  and canonical row SHA-256 checksums.
- The manifest records snapshot timestamp, WAL LSN and only the SHA-256 of the
  ephemeral snapshot identifier.
- Import validates a direct or Session Pooler DSN by exact hostname, username
  project-ref component, database and port. A project ref found only as a URL
  substring is rejected.
- Import refuses a target whose ref/sentinel/table inventory differs, or whose
  required-empty staging tables are non-empty.
- Before import, the tool creates a target backup. Replacement is one
  transaction, without `CASCADE`, and aborts on the first error.
- Reconciliation compares schema and transfer-policy fingerprints, exact row
  counts, streaming canonical SHA-256 checksums, FK orphans and required-empty
  tables. A mismatch automatically restores and reconciles the target backup.
- State transitions use a same-directory temporary file, file `fsync`, atomic
  rename and directory `fsync`. Rollback records `ROLLED_BACK` only after the
  restored target reconciles with the digest-verified backup manifest; otherwise it
  records `ROLLBACK_FAILED`.
- Artifacts are sensitive data. Store them outside the repository on an
  encrypted volume, mode `0700`; manifests and state are mode `0600`.

Supabase recommends Session Pooler/direct connections for `pg_dump` and
`pg_restore`. Do not use transaction-mode pooling for the snapshot or restore.
Use PostgreSQL client tools matching or newer than the source server.

## Local validation only

These commands do not connect to Lovable or Supabase:

```sh
cd /private/tmp/winerim-data-hardening-agent
npm run data:transfer:plan
npm run data:transfer:export -- --artifact-dir /private/tmp/winerim-transfer/source
npm run data:transfer:test
npm run data:transfer:smoke:local
npx tsc --noEmit --pretty false
```

Expected: `TRANSFER_PLAN`, `EXPORT_DRY_RUN`, 15 focal tests green,
`LOCAL_TRANSFER_ROUNDTRIP_OK tables=24 credentials=sanitized` and typecheck
green.

## Gate 1: consistent source export

This gate performs read-only source activity. It is deliberately not executed
by the local preparation block.

```sh
export LOVABLE_DATABASE_URL='[secure source session/direct URL]'
npm run data:transfer:export -- \
  --artifact-dir /encrypted/winerim-transfer/lovable-YYYYMMDDTHHMMSSZ \
  --apply \
  --confirm-source lovable-production
unset LOVABLE_DATABASE_URL
```

Record `manifestSha256`, `snapshotAt`, `snapshotLsn`, the 24 counts/checksums
and the encrypted artifact location. Do not continue if any allowlisted table
is absent or the source cannot export a repeatable read-only snapshot.

Only manifest schema version 2 artifacts are accepted. Older artifacts did not
prove the sanitizing projection and must not be imported.

## Gate 2: offline artifact verification

```sh
npm run data:transfer:reconcile -- \
  --artifact-dir /encrypted/winerim-transfer/lovable-YYYYMMDDTHHMMSSZ
```

Expected: `RECONCILE_OFFLINE_ARTIFACT_OK`.

## Gate 3: staging import

Keep API/runtime execution disabled. Use the Supabase direct or Session Pooler
URL for project `qpbmqvfnunkylvtvnyyx`. The target role must be able to set
`session_replication_role=replica`; otherwise the transaction fails without
partial import.

First print the exact plan, still without a connection:

```sh
npm run data:transfer:import -- \
  --artifact-dir /encrypted/winerim-transfer/lovable-YYYYMMDDTHHMMSSZ \
  --backup-dir /encrypted/winerim-transfer/staging-before-YYYYMMDDTHHMMSSZ \
  --confirm-manifest '<SOURCE_MANIFEST_SHA256>'
```

Then, only after review:

```sh
export STAGING_DATABASE_URL='[secure Supabase session/direct URL]'
npm run data:transfer:import -- \
  --artifact-dir /encrypted/winerim-transfer/lovable-YYYYMMDDTHHMMSSZ \
  --backup-dir /encrypted/winerim-transfer/staging-before-YYYYMMDDTHHMMSSZ \
  --confirm-manifest '<SOURCE_MANIFEST_SHA256>' \
  --confirm-target-ref qpbmqvfnunkylvtvnyyx \
  --apply
unset STAGING_DATABASE_URL
```

Expected: `IMPORT_RECONCILED`. A failed post-import reconciliation triggers an
automatic rollback and records `phase=ROLLED_BACK` in `import-state.json`.
That phase is written only after backup-manifest reconciliation; inspect and
escalate `phase=ROLLBACK_FAILED` rather than retrying import automatically.
If the process is interrupted, rerun the exact command with `--resume`. The
tool either proves the committed data already reconciles, resumes from the
verified target snapshot, or restores that snapshot; it never guesses across
different manifests or directories.

A source export itself cannot resume because its exported PostgreSQL snapshot
expires when the coordinator transaction closes. Restart a failed export in a
new empty directory and securely dispose of the incomplete private artifact
after review.

## Read-only recheck

```sh
export STAGING_DATABASE_URL='[secure Supabase session/direct URL]'
npm run data:transfer:reconcile -- \
  --artifact-dir /encrypted/winerim-transfer/lovable-YYYYMMDDTHHMMSSZ \
  --confirm-target-ref qpbmqvfnunkylvtvnyyx \
  --read-live
unset STAGING_DATABASE_URL
```

## Manual rollback gate

Use the exact target backup manifest, not the source manifest:

```sh
export STAGING_DATABASE_URL='[secure Supabase session/direct URL]'
npm run data:transfer:rollback -- \
  --backup-dir /encrypted/winerim-transfer/staging-before-YYYYMMDDTHHMMSSZ \
  --confirm-manifest '<TARGET_BACKUP_MANIFEST_SHA256>' \
  --confirm-target-ref qpbmqvfnunkylvtvnyyx \
  --apply
unset STAGING_DATABASE_URL
```

After rollback, repeat the staging read-only infrastructure verification. Do
not enable Cloudflare Queue consumers, Cron, runtime execution or production
traffic as part of this data-transfer runbook.

The target backup deliberately contains sanitized `pos_connections` rows and
empty credential tables. It cannot recover tokens that were incorrectly stored
in `pos_connections`. Provision staging-only credentials later through the
separate runtime credential process, after this transfer reconciles; never put
production credentials into either transfer artifact.

## Remaining live gates

1. Obtain a source Session/direct PostgreSQL URL with read-only privileges.
2. Choose an encrypted artifact location with enough free space.
3. Confirm a staging maintenance window while runtime stays disabled.
4. Run export, offline verification, target snapshot/import and reconciliation
   serially.
5. Retain the source artifact and target backup through the runtime canary and
   rollback window.
