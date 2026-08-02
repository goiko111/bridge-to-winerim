# Middleware runtime scaffold

Staging-only scaffold for moving the existing five-minute dispatcher and
`outbound_tasks` semantics to Cloudflare Queues and Cron Triggers.

It is intentionally fail-closed:

- `wrangler.middleware-runtime.toml` has no production environment or route;
- `workers_dev=false` and `RUNTIME_EXECUTION_ENABLED=false`;
- the cron and Queue producer bindings point only to existing staging assets;
- there are no Queue consumers, Hyperdrive binding or runtime executor binding;
- `/health` is liveness-only and `/ready` stays `503` until every staging gate
  is deliberately configured;
- no Lovable REST, POS or Winerim call is used as a fallback.

## Preserved contracts

- one immutable envelope per `connectionId` and operation;
- deterministic SHA-256 idempotency key per connection, job, logical scope and
  payload;
- five-minute UTC slot dedupe for Cron redelivery;
- current Agora dispatcher actions through `buildLegacyRuntimeInvocation`;
- batch size `10` and per-connection limit `2 req/s` as integration settings;
- POS retry schedule `2, 4, 8, 16, 32, 60` minutes, capped at one hour;
- POS business errors are terminal and do not trip the circuit breaker;
- Winerim live-sale `409` and line-level `retryable=true` preserve the same
  envelope/idempotency key and retry after one second, with a three-attempt cap
  when that profile is used.
- leaf envelopes exist for sales import, absolute stock sync and maintenance;
  they intentionally have no legacy proxy mapping and require ported handlers.

## Staging bindings

The Queue names were checked with `wrangler queues list`. At the verification
cut they had zero producers and zero consumers.

| Worker binding | Existing Queue |
|---|---|
| `MIDDLEWARE_CATALOG_QUEUE` | `winerim-staging-catalog` |
| `MIDDLEWARE_SALES_STOCK_QUEUE` | `winerim-staging-sales` |
| `MIDDLEWARE_SALES_IMPORT_QUEUE` | `winerim-staging-sales` |
| `MIDDLEWARE_STOCK_SYNC_QUEUE` | `winerim-staging-stock` |
| `MIDDLEWARE_OUTBOUND_QUEUE` | `winerim-staging-outbound` |
| `MIDDLEWARE_MAINTENANCE_QUEUE` | `winerim-staging-maintenance` |

`winerim-staging-dead-letter` exists but is not bound yet because this config
does not declare consumers. Add it only together with a reviewed consumer.

The deployable TOML deliberately omits `MIDDLEWARE_DB`. The only Hyperdrive
currently visible belongs to another system and must not be reused. The file
`wrangler.middleware-runtime.hyperdrive.toml.example` contains the binding
shape without a fabricated ID. It is documentation and must never be passed to
Wrangler directly.

## Local gates

Wrangler 4.118 requires Node 22 or newer.

```sh
npm run cf:runtime:test
npm run cf:runtime:dry-run:staging
```

The dry-run bundles the Worker and validates the Queue/cron configuration. It
does not upload a Worker, create consumers or change remote resources. With no
Hyperdrive and `RUNTIME_EXECUTION_ENABLED=false`, the scheduled handler exits
before loading connections or publishing messages.

## Staging deploy runbook

Do not run this sequence until the diff and Cloudflare account are confirmed.

1. Confirm Node 22+, authenticated account and exact Queue inventory:

   ```sh
   node --version
   npx wrangler whoami
   npx wrangler queues list
   ```

2. Pass tests and dry-run, then record the current deployment version:

   ```sh
   npm run cf:runtime:test
   npm run cf:runtime:dry-run:staging
   npm run cf:runtime:deployments:staging
   ```

3. Deploy only the inert staging Worker:

   ```sh
   npm run cf:runtime:deploy:staging
   npm run cf:runtime:deployments:staging
   ```

4. Confirm that the deployment has no routes or Queue consumers, execution is
   disabled, and no Queue producer count or message count changes unexpectedly.

No production environment is present in this configuration. Enabling runtime
execution is a later gate that requires a middleware-owned staging Hyperdrive,
the Postgres runtime tables, an injected `RUNTIME_EXECUTOR`, consumer/DLQ
configuration and a canary plan.

## Rollback runbook

Record the prior healthy Worker version before deployment. Roll back code and
bindings with that exact version ID:

```sh
npm run cf:runtime:rollback:staging -- <VERSION_ID>
npm run cf:runtime:deployments:staging
```

Do not delete the Queue assets during a Worker rollback. If a later change adds
Hyperdrive or consumers, first roll back to this inert version, verify no
consumption, and only then remove those later bindings through a reviewed
configuration change.

## Integration hooks

Already implemented locally:

1. `scheduled()` loads enabled Agora connections from managed PostgreSQL and
   publishes immutable envelopes by lane.
2. Queue reservations, retries and terminal/success transitions use the
   persistent `runtime_idempotency` and `runtime_execution_log` tables.
3. Provider-neutral handlers and PostgreSQL/HTTP adapters exist for catalog,
   sales, stock and outbound. HTTP adapters enforce host allowlists, timeouts,
   response limits and blocked redirects.
4. The outbound contract includes the `2 req/s` limiter and breaker decisions.

Still required before execution can be enabled:

1. Create and bind a middleware-owned staging Hyperdrive to both the API and
   runtime Workers.
2. Compose and deploy the private `RUNTIME_EXECUTOR` service over the reviewed
   adapters, with encrypted per-connection credentials. The public runtime
   Worker does not decrypt or expose secrets.
3. Add reviewed consumers and the DLQ binding, then run a synthetic dry-run and
   one non-critical staging canary before any production configuration.

Cloudflare references:

- https://developers.cloudflare.com/queues/configuration/javascript-apis/
- https://developers.cloudflare.com/queues/configuration/batching-retries/
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
