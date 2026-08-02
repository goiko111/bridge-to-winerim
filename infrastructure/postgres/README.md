# Postgres staging bootstrap audit

## Verdict

`PORTABLE_BOOTSTRAP_READY / EMPTY_DATABASE_REPLAY_OK`

The repository has enough SQL to reconstruct most of the application schema,
but `supabase/migrations/` is not a safe one-command bootstrap for an empty,
provider-neutral Postgres database. The directory mixes schema, permissive RLS,
managed-platform objects, client-specific configuration and production repair
operations.

This directory can build a deterministic staging bootstrap and replay it against
a disposable local Postgres instance. `apply-staging.sh` is fail-closed and must
only receive an explicitly selected empty staging database URL. Nothing in this
directory is applied remotely by validation or replay.

## Artifacts

- `migration-manifest.tsv`: all 76 migrations, in source order, with SHA-256,
  dependency, replay action and reason.
- `release-migration-manifest-addendum.tsv`: focused classification and source
  hashes for the 13 release migrations previously absent from the manifest.
- `expected-schema-release-addendum.txt`: detailed contract contributed by
  those 13 migrations.
- `0002_release_schema_addendum.sql`: reviewed portable materialization of that
  contract: health tables without legacy contacts or database HTTP, provider
  sale timestamps, runtime-owned dispatch locks and the durable stock-log FK.
- `expected-schema.txt`: active middleware contract: 28 public tables, six
  portable functions, two columns, one index and one SET NULL foreign key.
- `build-bootstrap.sh`: concatenates the reviewed historical schema, role
  hardening and portable release addendum into one generated SQL artifact.
- `validate.sh`: static checksum/classification audit and optional read-only
  catalog inspection when `DATABASE_URL` is explicitly supplied.
- `validate-readonly.sql`: catalog queries wrapped in `BEGIN READ ONLY` and
  `ROLLBACK`.
- `test-empty-replay.sh`: creates a disposable local Postgres cluster, replays
  the generated bootstrap, checks objects, columns, constraints, RLS and
  runtime grants, then deletes the cluster. It never contacts a remote database.
- `validate-release-addendum.sh`: verifies all 13 release source checksums and
  their focused classification without touching a database.

## Facts from the audit

### Reconstructable core

The source migrations define these functional groups:

1. Connections and provider configuration.
2. Sales events and line items.
3. Winerim/provider catalogs and product mappings.
4. Stock synchronization audit and variant idempotency.
5. Outbound task queue, retry timing and circuit-breaker state.
6. Provider credentials and webhook deduplication.
7. Agora master cache and push tracking.
8. Operator roles, onboarding, notification contacts and incidents.

Chronological order must be preserved. Several later migrations depend on
tables, columns and helper functions created earlier.

### Portable release addendum

The 13 release migrations from `20260625044943` through `20260716122252`
cannot be replayed verbatim as portable bootstrap SQL:

- the original health migration mixes two required health tables with an old
  `connection_notification_contacts` shape and a database HTTP helper;
- two migration-id placeholders contain only `SELECT 1`;
- three later files duplicate canonical schema/data migrations;
- one migration requeues three production task IDs;
- the refund guard is data reconciliation and remains post-import only.

`0002_release_schema_addendum.sql` therefore materializes only the requested
portable schema. It does not create the legacy contacts shape, does not contain
`pg_net` or outbound HTTP, and grants health/lock access only through the
`middleware_runtime` role established by `0001_harden_runtime_roles.sql`.

### Managed-platform dependencies

- `authenticated` and `service_role` are referenced by policies or grants.
- `storage.buckets` and `storage.objects` are required only by the HIOPOS import
  migration.
- `pg_net` and `pg_cron` are used by legacy database-driven recursion/jobs.
- `gen_random_uuid()` requires a supported Postgres version or compatible UUID
  implementation. The target should be Postgres 16 or 17; do not pin extension
  versions.

The Cloudflare target should execute HTTP, queues and schedules in Workers,
Queues and Cron Triggers. Therefore `pg_net`, `pg_cron`,
`schedule_next_queue_batch` and `schedule_next_catalog_batch` are excluded from
the portable core unless a temporary compatibility phase is deliberately
approved.

### Security gates

The historical SQL does not yet satisfy the documented strict tenant boundary:

- Most initial tables have `USING (true)` / `WITH CHECK (true)` policies,
  several without a `TO` role and therefore applicable to `PUBLIC`.
- `winerim_push_tracking` explicitly grants its policies to `PUBLIC`.
- `middleware_incidents` lets every authenticated operator read every row.
- `user_roles` has RLS enabled but no policies and no foreign key to the chosen
  identity provider.
- `has_role`, `claim_outbound_tasks` and `rescue_zombie_outbound_tasks` are
  `SECURITY DEFINER`; their migrations do not revoke default `PUBLIC EXECUTE`.
- `stock_sync_log`, `winerim_wines` and `product_mappings` carry
  `connection_id` without a foreign key to `pos_connections`.

Do not expose the staging schema to a browser, PostgREST role or shared runtime
until a separate reviewed security migration defines database roles, grants,
tenant predicates and function EXECUTE privileges.

### Operational migrations excluded from bootstrap

The manifest excludes migrations that enable clients, rewind cursors, retry or
block tasks, reset tracking, delete sales, change live push flags or encode a
one-off business decision. They are historical operations, not schema.

`20260421091232_9adcfd7c-462a-4788-b85d-16d2dd8fc036.sql` is retained as
`POST_IMPORT_REVIEW`: it reconciles imported mapping data and is only meaningful
after a production snapshot has been imported and checked.

## Empty database runbook

### Gate 1: choose the managed Postgres service

Record before provisioning:

- provider and region;
- Postgres major version (16 or 17);
- private networking/TLS and Cloudflare Hyperdrive compatibility;
- point-in-time recovery, backup retention and restore test policy;
- connection limits and pooling;
- extension availability;
- maintenance and upgrade window.

No provider is selected by this audit, so no remote database was created.

### Gate 2: define identity and database roles

Decide whether the Cloudflare control plane talks directly to Postgres only, or
whether a Data API/Auth service is also required. Then define, in a reviewed
migration:

- migration owner;
- runtime role with least privilege;
- read-only diagnostics role;
- operator/user identity mapping;
- replacement semantics, if any, for `authenticated` and `service_role`;
- explicit `REVOKE EXECUTE FROM PUBLIC` for privileged functions;
- connection-scoped RLS or a documented reason for keeping all access behind
  one trusted backend role.

Do not create compatibility roles merely to make old SQL pass.

### Gate 3: build a clean bootstrap set

Start from the manifest in chronological order:

- include `INCLUDE`, `INCLUDE_WITH_REVIEW` and
  `INCLUDE_SECURITY_GATE` schema migrations;
- omit `EXCLUDE_OPERATIONAL`;
- omit `EXCLUDE_CLOUDFLARE_TARGET`;
- keep `CONDITIONAL_PLATFORM` out unless the corresponding service exists;
- defer `POST_IMPORT_REVIEW` until after data import.
- represent `MATERIALIZED_PORTABLE` source rows only through
  `0002_release_schema_addendum.sql`; never concatenate those source files too.
- omit `EXCLUDE_NOOP` and `EXCLUDE_DUPLICATE` rows.

Before applying it anywhere, add the reviewed security migration from Gate 2.
The final bootstrap must be tested against a disposable empty Postgres instance
and then regenerated into a clean, immutable migration chain. Do not mark the
historical source files as applied if they were not actually executed.

### Gate 4: validate schema without data

Run static validation:

```bash
infrastructure/postgres/validate.sh
```

Test the classified schema chain on an empty local Postgres installation:

```bash
infrastructure/postgres/test-empty-replay.sh
```

Current verified result: `EMPTY_REPLAY_HARDENED_OK` with 28 public tables, six
public functions, RLS on every public table, no legacy/public role policies,
no `PUBLIC` execution on security-definer functions and no database HTTP health
helper.

The generated bootstrap creates temporary compatibility roles required by the
historical SQL, then revokes their data/function access during hardening. The
runtime application role is `middleware_runtime`; `middleware_api` is the
least-privilege control-plane role and `middleware_readonly` is the diagnostic
role. Provider-specific LOGIN principals must be created outside the repository
and granted exactly one of these NOLOGIN roles.

After a staging database exists, run the same script with a read-only
connection role:

```bash
DATABASE_URL='postgresql://READ_ONLY_CONNECTION' \
  infrastructure/postgres/validate.sh
```

The SQL starts a read-only transaction. It reports object presence, RLS state,
function privilege exposure, relevant extensions and known database roles. The
script does not apply or repair anything.

### Gate 5: data and runtime compatibility

After a consistent production export becomes available:

1. Import into an isolated database with crons, queues and outbound networking
   disabled.
2. Reconcile row counts, primary keys, unique constraints and foreign keys.
3. Run the post-import reconciliation only after inspecting its diff.
4. Migrate credentials through a secret-safe process; do not log them or copy
   them into repository files.
5. Regenerate database types from staging and compare them with application
   queries. The checked-in generated types predate the final four migrations
   and omit the new incident/control-plane tables and stock idempotency fields.
6. Run worker read-only tests before enabling queues, crons or POS traffic.

## Exact blockers before staging can be called ready

1. Managed Postgres provider/region/version has not been selected or
   provisioned.
2. Production identity handoff and credential rotation into the runtime role
   have not been executed.
3. HIOPOS storage replacement is not selected.
4. The portable replacement for legacy database `pg_net`/`pg_cron` recursion is not
   fully deployed in Cloudflare.
5. A consistent production export is unavailable during the current Lovable
   Cloud data-plane incident.

These are explicit gates, not assumptions. No production or remote staging
state was changed by this work.
