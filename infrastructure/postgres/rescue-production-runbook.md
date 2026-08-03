# Rescue production bootstrap

This tooling provisions only a new, separate Supabase rescue production database.
It never selects a project, creates a project, deploys code, enables a connection,
loads credentials, advances a cursor, or starts a queue consumer.

## Hard gates

- The only accepted Supabase project ref is `piyvadlzagtracciquap`, the separate
  rescue production in `eu-west-3`. Staging, the recovering Lovable production,
  and every other project ref are rejected in code.
- Set `RESCUE_PRODUCTION_EXPECTED_ENVIRONMENT=rescue-production` exactly.
- Supply the database URL through `RESCUE_PRODUCTION_DATABASE_URL`; never put it
  in command arguments, shell history, reports, or commits.
- Use an absolute durable backup root inside the already mounted encrypted disk
  image. The production backup gate requires both the explicit confirmation
  variable and a live macOS `hdiutil info` chain from the backup root to a
  readable backing image with `image-encrypted : TRUE`. The `/dev/disk...`
  reported by `df` for the backup root must exactly match the device mounted by
  that image, so a nested unencrypted filesystem cannot inherit trust from an
  encrypted parent path. It rejects ordinary folders, unencrypted disk images,
  and mount paths or devices that belong to a different image. `diskutil Encrypted: No` on the mounted APFS volume is not used as the
  encryption verdict because the encryption belongs to the backing sparsebundle.
  The reviewed current chain is:

  ```text
  /Users/GOIKO/Documents/WinerimSecure/mounted-staging-backups
    -> /Users/GOIKO/Documents/WinerimSecure/winerim-staging-backups.sparsebundle
    -> hdiutil image-encrypted : TRUE
  ```

  Do not create a replacement volume. Create a mode `0600` marker in the
  existing backup root:

  ```bash
  printf 'winerim-rescue-production-backup:%s\n' "$RESCUE_PRODUCTION_PROJECT_REF" \
    > "$RESCUE_PRODUCTION_BACKUP_ROOT/.winerim-rescue-production-backup"
  chmod 600 "$RESCUE_PRODUCTION_BACKUP_ROOT/.winerim-rescue-production-backup"
  export WINERIM_RESCUE_PRODUCTION_BACKUP_CONFIRMED=YES_ENCRYPTED_DURABLE_VOLUME
  ```

- `RESCUE_PRODUCTION_SEED_SQL` must point to the reviewed, credential-free rescue
  seed. The apply verifier requires exactly 31 connections, 30 Agora plus one
  Yurest, all disabled and redacted.
- The target must have zero public tables and zero `middleware_%` roles. An
  existing or partial target is rejected.
- Backup, pre-canary and rollback require a PostgreSQL 17 server plus PostgreSQL
  17 `psql`, `pg_dump` and `pg_restore` clients; any other major fails closed.

## Plan and apply

Run the plan first:

```bash
export RESCUE_PRODUCTION_PROJECT_REF='<new-project-ref>'
export RESCUE_PRODUCTION_EXPECTED_ENVIRONMENT='rescue-production'
export RESCUE_PRODUCTION_DATABASE_URL='<secret-dsn>'
export RESCUE_PRODUCTION_SEED_SQL='/absolute/path/rescue-connections-disabled.sql'
export RESCUE_PRODUCTION_BACKUP_ROOT='/absolute/encrypted/durable/path'

infrastructure/postgres/apply-rescue-production.sh
```

Record the printed plan and seed SHA-256 values. Apply only with the same source
tree and seed:

```bash
infrastructure/postgres/apply-rescue-production.sh \
  --apply \
  --confirm-project-ref "$RESCUE_PRODUCTION_PROJECT_REF" \
  --confirm-environment rescue-production \
  --confirm-plan-sha '<plan-sha256>' \
  --confirm-seed-sha '<seed-sha256>' \
  --confirm-action APPLY_EMPTY_RESCUE_PRODUCTION_BOOTSTRAP
```

The apply path takes a verified logical pre-backup, builds and applies the
reviewed bootstrap, applies the inert seed, verifies the complete contract, and
takes a logical post-backup. A successful result still has no credentials,
writers, queues, canaries, sales, stock logs, mappings, or runtime login roles.

## Verification contract

`verify-rescue-production.sh` is read-only and requires:

- `infrastructure_metadata.environment=rescue-production`;
- the exact reviewed 30-table inventory and RLS on every public table;
- three safe `NOLOGIN` middleware roles, no memberships, no browser-role table
  grants, and no public execution on security-definer functions;
- exactly 31 inert connections with `unsafe=0`;
- zero runtime, queue, sales, stock, mapping, master, tracking, credential, or
  active-canary rows;
- the runtime has only the scoped sales/cursor/receipt privileges required by a
  canary, with zero effective rows while no approved canary scope exists;
- whenever `RESCUE_PRODUCTION_RUNTIME_DATABASE_URL` is supplied, that DSN must
  report both `session_user` and `current_user` as
  `middleware_runtime_login`. An operator DSN or `SET ROLE` cannot stand in for
  the runtime identity.

Every post-bootstrap backup includes `restore-prerequisites.sql`. Restore into a
new, otherwise unused database. PostgreSQL creates an empty `public` schema by
default while the custom dump contains its own `CREATE SCHEMA public`, so remove
only that empty default schema before replay:

```bash
psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c 'DROP SCHEMA public CASCADE'
psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$ARTIFACT_DIR/restore-prerequisites.sql"
pg_restore --dbname="$RESTORE_DATABASE_URL" --no-owner --exit-on-error \
  "$ARTIFACT_DIR/public.dump"
```

Never run those commands against the active rescue database. The prerequisites
create only missing passwordless compatibility roles and the three middleware
base roles referenced by grants and RLS policies. After restore, run the
read-only inventory checks and require `30` public tables, `31` disabled
connections and `unsafe=0` before creating any LOGIN role.
Application LOGIN roles and their passwords are intentionally excluded and must
be recreated or rotated from the approved secret store after a restore.

## Encrypted post-hydration backup

`post-hydration` is a separate fail-closed phase for the first exact catalog
hydration while every connection is still disabled. It is not a pre-canary
approval and does not permit credentials, runtime work, sales, stock, outbound
tasks, cursors, or activation.

The phase requires an explicit connection UUID and exact expected row counts.
For the reviewed El Bejeque hydration:

```bash
export RESCUE_PRODUCTION_HYDRATION_CONNECTION_ID='ba44c13a-5f48-4a49-8b3f-04049b244d94'
export RESCUE_PRODUCTION_EXPECTED_HYDRATION_WINERIM_WINES=70
export RESCUE_PRODUCTION_EXPECTED_HYDRATION_PROVIDER_PRODUCTS=409
export RESCUE_PRODUCTION_EXPECTED_HYDRATION_PRODUCT_MAPPINGS=95
export RESCUE_PRODUCTION_EXPECTED_HYDRATION_MASTER_ROWS=1
export RESCUE_PRODUCTION_HYDRATION_PLAN_FILE='/absolute/path/to/reviewed/hydration-plan.json'

infrastructure/postgres/backup-rescue-production.sh post-hydration
```

The backup is refused unless all of these invariants hold:

- the public schema is the exact reviewed 30-table inventory;
- exactly 31 connections exist and all are disabled, catalog-off,
  `PULL_ONLY`, `write_mode=NONE`, credential-free, cursor-free and breaker-free;
- `winerim_wines`, `provider_products`, `product_mappings` and
  `agora_master_data` contain exactly `70/409/95/1` rows for the supplied UUID
  and no rows for any other connection;
- the supplied regular, non-symlink hydration plan has the reviewed schema,
  connection and counts; its canonical content recomputes to its own
  `hydrationDigest`, and the master row carries that exact digest marker;
- every mapping has the exact semantic fingerprint from the reviewed plan,
  including product/wine identity, format, method, score, reasons, exact stock
  ID, variant-specific stock column, `stockActive` and `winePrice.variant`;
- the `23` inactive exact variants (`21` glass and `2` bottle) use the
  `RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY` method and remain history-only;
- the complete canonical database projection of `winerim_wines`,
  `provider_products`, `product_mappings` and `agora_master_data` recomputes to
  the reviewed `hydrationDigest`; same-count changes to any semantic field are
  rejected;
- `provider_credentials`, runtime credentials/scopes/receipts, sales, stock
  receipts and outbound work are empty;
- every public table outside metadata, connections and the four hydration
  tables is empty, including `winerim_push_tracking`.

On production targets this phase uses the same encrypted-disk-image gate as all
other production backups. Its manifest uses schema version `5`, stores a
read-only copy of the reviewed hydration plan, and records the hydration UUID,
all four exact counts, recomputed `hydrationDigest`, plan SHA-256 and mapping
semantic SHA-256 in addition to the dump, TOC, role, membership, inventory and
restore-prerequisite hashes. It also records server, `psql`, `pg_dump` and
`pg_restore` major versions, all fixed to `17`. Keep the artifact path and
`manifest.txt.sha256` outside source control.

Restore only into a new PostgreSQL 17 database using the standard procedure
above. Before accepting the restored artifact, verify the manifest digest and
require the same 30-table inventory, `31` inert connections, the exact
`70/409/95/1` rows owned by the recorded connection UUID, and zero rows in all
other tables. A successful restore does not create LOGIN roles or authorize a
canary; those remain separate reviewed gates.

## Current pre-canary rollback baseline

There is no retained production `pre-bootstrap` artifact. Do not present the
empty-database rollback as the current recovery path. The current rollback must
be a fresh, restorable `pre-canary` backup of the fully inert rescue state:
exactly 30 reviewed tables, 31 disabled connections, no credentials, no active
scope, no runtime/debt/sales/stock rows, and the hardened three-login-role
contract. Migration `0008` must already pass the read-only verifier before this
backup is allowed. This runbook does not authorize applying `0008`.

With the rescue database still inert and both operator and real runtime DSNs
provided, create the baseline once:

```bash
export RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES=3
export RESCUE_PRODUCTION_RUNTIME_DATABASE_URL='<middleware_runtime_login-dsn>'
infrastructure/postgres/verify-rescue-production.sh
infrastructure/postgres/backup-rescue-production.sh pre-canary
```

Record the exact artifact directory and manifest digest outside shell history.
The backup script refuses this phase unless the inert verifier passes and the
macOS backing image is confirmed encrypted by `hdiutil`.

After the separately reviewed preparation writes exactly one candidate scope,
one enabled connection and the two active encrypted credentials, run the
read-only pre-canary gate before starting any consumer:

```bash
export RESCUE_PRODUCTION_CANARY_CONNECTION_ID='<approved-connection-uuid>'
infrastructure/postgres/verify-rescue-production-pre-canary.sh
```

That gate requires the enabled connection and unique unexpired canary scope to
have the same UUID, exactly `agora` and `winerim` active credentials, no active
catalog/control plane outside the candidate, and zero prior outbound debt,
idempotency/execution receipts, sales, lines, or stock receipts. It also
recomputes the complete four-table hydration fingerprint and requires it to
equal the exact digest stored in the master hydration marker.

## Roll back to pre-canary

Select the exact `pre-canary` artifact directory printed above, then plan:

```bash
export RESCUE_PRODUCTION_ROLLBACK_ARTIFACT_DIR='/absolute/path/to/pre-canary-artifact'
infrastructure/postgres/rollback-rescue-production.sh
```

Apply only after reviewing the printed SHA. The SHA binds the rollback phase,
scope, candidate connection, exact per-table counts, a canonical fingerprint of
the complete current public state and middleware roles, plus hashes of every
backup/rollback/verifier dependency. A scope change or any same-count semantic
mutation therefore invalidates the prior confirmation:

```bash
infrastructure/postgres/rollback-rescue-production.sh \
  --apply \
  --confirm-project-ref "$RESCUE_PRODUCTION_PROJECT_REF" \
  --confirm-plan-sha '<rollback-plan-sha256>' \
  --confirm-action ROLLBACK_RESCUE_PRODUCTION_TO_PRE_CANARY
```

The rollback first takes a `pre-rollback` backup, restores the reviewed inert
30-table artifact with its restore prerequisites, retains the existing login
roles, reruns the full inert verifier through the real runtime identity, and
takes a `post-canary-rollback` backup. It accepts at most one scoped canary and
rejects another active connection, active catalog outside the candidate,
unscoped operational rows, outbound debt, unknown tables, or an incomplete or
tampered artifact.

The same rollback distinguishes a completely empty `pre-hydration-inert` state
from a strictly inert `hydration-only:<connection-uuid>` state before a canary
is enabled. Both require zero enabled/catalog/write connections, zero canary
scopes, credentials, runtime receipts, sales, stock receipts, and outbound work.
The hydration-only form limits catalog rows to exactly one connection across
`winerim_wines`, `provider_products`, `product_mappings`, `agora_master_data`
and `winerim_push_tracking`. A second hydrated connection or any row outside
that allowlist fails closed; it never invents a `0000...` candidate. This permits
undoing a single-connection hydration back to the empty `pre-canary` artifact
without authorizing production deletes.

The legacy `pre-bootstrap` rollback remains only for a freshly created target
whose real pre-bootstrap artifact actually exists (and for the disposable local
flow test). It is not the rollback baseline for the current rescue production.

## Local regression tests

These tests create only disposable local PostgreSQL clusters and synthetic disk
image metadata. They do not connect to Supabase or create production backups:

```bash
node infrastructure/postgres/tests/test-encrypted-backup-root.mjs
infrastructure/postgres/tests/test-rescue-production-flow.sh
infrastructure/postgres/tests/test-rescue-production-pre-canary.sh
infrastructure/postgres/test-runtime-sales-canary-permissions.sh
```
