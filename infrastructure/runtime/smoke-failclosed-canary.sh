#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

node infrastructure/runtime/verify-failclosed-canary-package.mjs

RENDER_DIR="$(mktemp -d)"
trap 'rm -rf "$RENDER_DIR"' EXIT
CANARY_RUN_ID=smoke-a \
CANARY_CONNECTION_ID=11111111-1111-4111-8111-111111111111 \
CANARY_MESSAGE_ID=message-smoke-a \
CANARY_IDEMPOTENCY_KEY=idempotency-smoke-a \
CANARY_PAYLOAD_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
CANARY_EXCLUSIVE_CREDENTIAL_VERSION=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
CANARY_RELEASE=smoke-release \
CANARY_HOLDER_ID=smoke-holder \
RUNTIME_HYPERDRIVE_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
RUNTIME_EXECUTOR_SERVICE_NAME=runtime-executor-smoke \
RUNTIME_VAULT_STORE_ID=runtime-vault-store-smoke \
RUNTIME_VAULT_SECRET_NAME=runtime-vault-secret-smoke \
RUNTIME_VAULT_KEY_VERSION=v1 \
WRITER_FENCE_SERVICE_NAME=writer-fence-smoke \
WRITER_FENCE_PROOF_STORE_ID=proof-store-smoke \
WRITER_FENCE_PROOF_SECRET_NAME=proof-secret-smoke \
WRITER_FENCE_GRANT_STORE_ID=grant-store-smoke \
WRITER_FENCE_GRANT_SECRET_NAME=grant-secret-smoke \
CANARY_DLQ_ARCHIVE_BUCKET=winerim-canary-dlq-smoke \
  node infrastructure/runtime/render-failclosed-canary-configs.mjs \
    --output-dir="$RENDER_DIR" >/dev/null

test "$(find "$RENDER_DIR" -type f | wc -l | tr -d ' ')" = "5"
test "$(find "$RENDER_DIR" -type f ! -perm 600 | wc -l | tr -d ' ')" = "0"
! rg -Fq '{{' "$RENDER_DIR"
! rg -Fq 'winerim-staging-sales' "$RENDER_DIR"
! rg -Fq 'winerim-rescue-prod-sales' "$RENDER_DIR"
node - "$RENDER_DIR/canary-deployment-manifest.json" <<'NODE'
const { readFileSync } = require("node:fs");
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (manifest.runId !== "smoke-a") throw new Error("SMOKE_MANIFEST_RUN_MISMATCH");
if (manifest.scopeNote !== "rescue-canary-run:smoke-a") {
  throw new Error("SMOKE_MANIFEST_SCOPE_MISMATCH");
}
if (Object.keys(manifest.resources.queues).length !== 4) {
  throw new Error("SMOKE_MANIFEST_QUEUE_INVENTORY_MISMATCH");
}
if (Object.keys(manifest.resources.workers).length !== 4) {
  throw new Error("SMOKE_MANIFEST_WORKER_INVENTORY_MISMATCH");
}
NODE
npx vitest run \
  --config cloudflare/canary-failclosed/vitest.config.ts

printf '%s\n' 'FAILCLOSED_CANARY_SMOKE_OK remote_mutations=0'
