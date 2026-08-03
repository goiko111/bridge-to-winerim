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
- Use an absolute encrypted durable backup root. Create a mode `0600` marker:

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
  canary, with zero effective rows while no approved canary scope exists.

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

## Immediate rollback

Rollback is deliberately available only before the rescue target has handled
any real data. It rejects active connections, credentials, canaries, sales,
stock logs, mappings, master data, tracking, outbound work, or unknown tables.

Select the exact `pre-bootstrap` artifact directory printed by apply, then plan:

```bash
export RESCUE_PRODUCTION_ROLLBACK_ARTIFACT_DIR='/absolute/path/to/pre-bootstrap-artifact'
infrastructure/postgres/rollback-rescue-production.sh
```

Apply only after reviewing the printed SHA:

```bash
infrastructure/postgres/rollback-rescue-production.sh \
  --apply \
  --confirm-project-ref "$RESCUE_PRODUCTION_PROJECT_REF" \
  --confirm-plan-sha '<rollback-plan-sha256>' \
  --confirm-action ROLLBACK_UNUSED_RESCUE_PRODUCTION
```

The rollback takes another logical backup, restores the exact empty prestate,
removes only the three bootstrap middleware roles that did not exist before,
verifies zero public tables and zero middleware roles, and takes a post-rollback
logical backup. Once any real business/runtime row exists, use a separately
reviewed reconciliation or point-in-time recovery plan instead.
