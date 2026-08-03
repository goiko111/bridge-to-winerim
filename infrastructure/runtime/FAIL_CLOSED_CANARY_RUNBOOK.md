# Fail-closed canary package

Status: integrated locally in the private runtime and executor; remote canary
resources are still not deployed or active.

This package closes two QA gates without sharing the sales Queue and without
treating `RUNTIME_EXECUTION_ENABLED` as a writer lock.

## Invariants

1. One physical input Queue exists only for one canary run and one connection.
2. The Queue has one consumer, batch size `1`, concurrency `1`, three retries
   and its own physical DLQ.
3. A message outside the reviewed Queue/connection/lane/job/run is retried. It
   is never acknowledged and therefore remains observable through the DLQ.
   The accepted message must also match the reviewed message ID, idempotency
   key and canonical payload SHA-256 exactly.
4. DLQ acknowledgement requires both a sanitized R2 archive record and an
   alarm event. The alarm consumer writes a second R2 ledger record and a
   structured Cloudflare error log.
5. Before provider mutation, the runtime must acquire a Durable Object lease
   named by `connectionId` and present a proof secret known only by the new
   runtime.
   The private executor independently renews this lease immediately before
   each Winerim mutation and validates the reviewed credential version.
6. A lease grant is valid only after the previous writer credential was
   revoked or rotated and a sanitized `401`/`403` negative probe was recorded.
7. A Cloudflare lease alone cannot stop Lovable. Credential revocation is the
   actual external fence; the lease prevents a second new-runtime holder.

## Package files

- `cloudflare/canary-failclosed/src/exclusiveScope.ts`
- `cloudflare/canary-failclosed/src/writerFence.ts`
- `cloudflare/canary-failclosed/src/writerFenceWorker.ts`
- `cloudflare/canary-failclosed/src/dlqObserver.ts`
- four non-deployable Wrangler templates in the same directory, including a
  private rescue-production executor that keeps broad sales/cursor flags off
- `infrastructure/runtime/prepare-writer-fence-grant.mjs`
- `infrastructure/runtime/render-failclosed-canary-configs.mjs`
- `infrastructure/runtime/verify-failclosed-canary-package.mjs`
- `infrastructure/runtime/smoke-failclosed-canary.sh`

## Local verification

This performs no network calls or remote mutations:

```sh
bash infrastructure/runtime/smoke-failclosed-canary.sh
```

After the runtime integration is made, add the source-level gate:

```sh
node infrastructure/runtime/verify-failclosed-canary-package.mjs \
  --integration-source=cloudflare/workers/middleware-runtime/src/worker.ts
```

That command must fail until all three integration symbols are present.

## Resource plan, not executed

Use one unique run slug, for example `sa-pedrera-20260803-a`. The reviewed
names should be:

```text
winerim-rescue-prod-canary-sa-pedrera-20260803-a
winerim-rescue-prod-canary-sa-pedrera-20260803-a-dlq
winerim-rescue-prod-canary-sa-pedrera-20260803-a-alarms
winerim-rescue-prod-canary-sa-pedrera-20260803-a-observer-failures
```

Before creation, save `wrangler queues list` and reject the plan if any name
exists, if any shared sales Queue appears in the canary template, or if the
planned input Queue would have another producer or consumer.

Render the templates outside the repository with mode `0600`. The renderer
derives all four physical Queue names from `CANARY_RUN_ID`, rejects shared
Queue names and fails if any placeholder remains:

```sh
CANARY_RUN_ID=<SHORT_UNIQUE_RUN> \
CANARY_CONNECTION_ID=<UUID> \
CANARY_MESSAGE_ID=<REVIEWED_MESSAGE_ID> \
CANARY_IDEMPOTENCY_KEY=<REVIEWED_IDEMPOTENCY_KEY> \
CANARY_PAYLOAD_SHA256=<SHA256_OF_CANONICAL_PAYLOAD> \
CANARY_EXCLUSIVE_CREDENTIAL_VERSION=<ROTATED_VERSION> \
CANARY_RELEASE=<IMMUTABLE_COMMIT> \
CANARY_HOLDER_ID=<DEPLOYMENT_VERSION> \
RUNTIME_HYPERDRIVE_ID=<32_HEX_ID> \
RUNTIME_EXECUTOR_SERVICE_NAME=<PRIVATE_EXECUTOR> \
RUNTIME_VAULT_STORE_ID=<STORE_ID> \
RUNTIME_VAULT_SECRET_NAME=<SECRET_NAME> \
RUNTIME_VAULT_KEY_VERSION=<VERSION> \
WRITER_FENCE_SERVICE_NAME=<PRIVATE_FENCE_SERVICE> \
WRITER_FENCE_PROOF_STORE_ID=<STORE_ID> \
WRITER_FENCE_PROOF_SECRET_NAME=<SECRET_NAME> \
WRITER_FENCE_GRANT_STORE_ID=<STORE_ID> \
WRITER_FENCE_GRANT_SECRET_NAME=<SECRET_NAME> \
CANARY_DLQ_ARCHIVE_BUCKET=<R2_BUCKET> \
  node infrastructure/runtime/render-failclosed-canary-configs.mjs \
    --output-dir=/secure/tmp/canary-configs
```

Do not store rendered IDs, grants or secret coordinates in Git.

## Writer fence procedure

1. Select one `connectionId`, one provider mutation and one deployment holder.
2. Stop that connection in the old writer without changing any other tenant.
3. Rotate the provider/Winerim mutation credential. Put the new credential
   only in the new private executor. Do not copy it back to Lovable.
4. Probe the old writer with its revoked credential. It must return `401` or
   `403`. Save a sanitized response and its SHA-256; never save the token.
5. Probe the rotated credential with a read-only endpoint. It must succeed.
6. Generate a random proof secret of at least 32 bytes. This is not the
   provider credential. Bind it only to the canary runtime.
7. Prepare the grant in a secure temporary path:

   ```sh
   CANARY_CONNECTION_ID=<UUID> \
   CANARY_RUN_ID=<RUN> \
   CANARY_HOLDER_ID=<DEPLOYMENT_VERSION> \
   CANARY_WRITER_FENCE_PROOF=<NEW_RANDOM_SECRET> \
   CANARY_EXCLUSIVE_CREDENTIAL_REF=runtime-vault://postgres/<CONNECTION>/<PROVIDER>/<KIND> \
   CANARY_EXCLUSIVE_CREDENTIAL_VERSION=<SHA256_ATTESTATION_OF_OPENED_ENCRYPTED_ROW> \
   LEGACY_WRITER_REVOKED_AT=<ISO_TIME> \
   LEGACY_WRITER_NEGATIVE_PROBE_STATUS=401 \
   LEGACY_WRITER_EVIDENCE_SHA256=<SANITIZED_EVIDENCE_SHA256> \
   CANARY_FENCE_EXPIRES_AT=<ISO_TIME_WITHIN_TWO_HOURS> \
     node infrastructure/runtime/prepare-writer-fence-grant.mjs \
       --output=/secure/tmp/writer-fence-grant.json
   ```

8. Store the grant and proof as separate Secrets Store values. The grant has
   only a proof hash and an attestation reference/version for the encrypted
   credential row. The provider credential remains encrypted in Postgres; the
   Cloudflare Secrets Store holds the vault master key, grant and proof.
9. Acquire/renew a `30..120` second lease immediately before each mutation.
   Reject it unless at least `15 s` remain: the Winerim mutation timeout is
   `10 s` and the extra `5 s` is the minimum safety margin.
   Missing binding, missing proof, expired grant, active foreign holder or
   malformed response means retry without opening the database or executor.

## Runtime integration contract

The public runtime guards the exact physical Queue and payload before opening
Hyperdrive or invoking the executor. The private executor independently renews
the lease immediately before every Winerim mutation and rejects expired or
drifted credential evidence. Broad sales, cursor and DLQ switches remain off in
the exclusive executor template. Run the integration-source verifier, full
runtime tests, executor-local tests, TypeScript, bundle and Wrangler dry-run
with Node 22 or newer on one immutable commit.

This sequence does not overlap the sales composition: it changes only the
outer Queue boundary after the sales branch is merged.

## Canary acceptance

- Queue inventory proves one physical input Queue and one consumer.
- Synthetic foreign-connection message reaches the dedicated DLQ and appears
  in both `dlq/` and `alarms/` R2 ledgers; it is never acknowledged by scope.
- Missing grant, proof or lease produces no provider request.
- Revoked legacy credential produces `401/403`; exclusive credential produces
  the expected read-only response.
- The one approved mutation has one fencing token, one idempotency key, one
  provider receipt and no second stock effect on replay.

## Rollback

1. Remove/pause the dedicated canary consumer first. Leave messages in the
   canary Queue or DLQ; do not move them to a shared Queue.
2. Let the lease expire and revoke the proof/grant Secrets Store values.
3. Keep the rotated provider credential exclusive. If the old runtime must
   resume, install that current credential there only after the Cloudflare
   consumer is gone and verify that Cloudflare receives `401/403`.
4. Preserve R2 DLQ/alarm ledgers and deployment IDs for reconciliation.
5. Never restore a database snapshot over confirmed canary receipts.
6. Follow `RESCUE_PRODUCTION_CUTOVER_RUNBOOK.md`; database rollback is
   append-only after the first real receipt and stock compensation is separately
   fenced and readback-gated.
