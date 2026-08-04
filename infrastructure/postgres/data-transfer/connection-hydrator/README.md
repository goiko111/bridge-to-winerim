# Per-connection inactive hydrator

This lane exports exactly one Agora `connection_id` from a restored PostgreSQL
snapshot and prepares an insert-only hydration bundle for the rescue database.
It is intentionally separate from fleet activation and credential provisioning.

## Safety contract

- Source export is one `REPEATABLE READ READ ONLY` transaction.
- Database URLs are accepted only through environment variables and are never
  written to manifests or logs.
- `pos_connections` is stripped of endpoints, tokens, `provider_config`,
  restaurant identifiers, cursors, breaker state and every write/auto-push
  switch. The target connection is always `enabled=false`,
  `catalog_sync_enabled=false`, `sync_mode=PULL_ONLY`, `write_mode=NONE`.
- Nested credential-like JSON keys and inline authorization values are
  redacted. Artifacts and directories are owner-only (`0600`/`0700`).
- `outbound_tasks` is never imported. It is classified without payloads or raw
  errors. `winerim_push_tracking.task_id` is set to `NULL` so no queue FK crosses
  runtimes.
- UUIDs, provider document identities and stock idempotency keys are preserved.
  Any target PK/natural-key conflict blocks the plan; there is no `UPSERT`.
- Target preparation is read-only. Apply requires an exact plan digest, target
  database identity, explicit phrase and (for non-local databases) the separate
  `CONNECTION_HYDRATOR_ALLOW_NONLOCAL_TARGET=1` gate.
- The CLI is the canonical apply path: it rechecks the exact semantic target
  preimage hash inside the serializable transaction. Generated SQL is also
  connection-count-bound, refuses active runtime scopes/credentials and has
  pre/post assertions, but remains a review/manual-emergency artifact.
- Rollback deletes only IDs proven absent in the captured target preimage and
  refuses an active connection.

## Commands

```bash
export CONNECTION_HYDRATOR_SOURCE_DATABASE_URL='postgresql:///lovable_restore?host=/tmp&port=55432'
node infrastructure/postgres/data-transfer/connection-hydrator/cli.mjs export \
  --connection-id '<uuid>' --output-dir '/secure/source-artifact'

node infrastructure/postgres/data-transfer/connection-hydrator/cli.mjs verify \
  --artifact-dir '/secure/source-artifact'

export CONNECTION_HYDRATOR_TARGET_DATABASE_URL='postgresql:///scratch?host=/tmp&port=55432'
node infrastructure/postgres/data-transfer/connection-hydrator/cli.mjs prepare \
  --artifact-dir '/secure/source-artifact' --output-dir '/secure/plan-artifact'
```

`hydrate`, `reconcile`, and `rollback` are documented by `cli.mjs help`. Do not
run `hydrate` or `rollback` against production until the target preimage,
rollback bundle and connection-level cutover gate have been independently
reviewed.
