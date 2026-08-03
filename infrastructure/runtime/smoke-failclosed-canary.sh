#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
NODE_BIN="${CANARY_NODE_BIN:-node}"

if ! "$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  printf '%s\n' 'FAILCLOSED_CANARY_SMOKE_NODE_22_REQUIRED' >&2
  exit 1
fi

"$NODE_BIN" infrastructure/runtime/verify-failclosed-canary-package.mjs

RENDER_DIR="$(mktemp -d)"
trap 'rm -rf "$RENDER_DIR"' EXIT
CANARY_RUN_ID=smoke-a \
CANARY_CONNECTION_ID=11111111-1111-4111-8111-111111111111 \
CANARY_MESSAGE_ID=message-smoke-a \
CANARY_IDEMPOTENCY_KEY=idempotency-smoke-a \
CANARY_PAYLOAD_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
CANARY_EXCLUSIVE_CREDENTIAL_VERSION=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
CANARY_CREDENTIAL_SET_SHA256=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
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
  "$NODE_BIN" infrastructure/runtime/render-failclosed-canary-configs.mjs \
    --output-dir="$RENDER_DIR" >/dev/null

test "$(find "$RENDER_DIR" -type f | wc -l | tr -d ' ')" = "9"
test "$(find "$RENDER_DIR" -type f ! -perm 600 | wc -l | tr -d ' ')" = "0"
! rg -Fq '{{' "$RENDER_DIR"
! rg -Fq 'winerim-staging-sales' "$RENDER_DIR"
! rg -Fq 'winerim-rescue-prod-sales' "$RENDER_DIR"
"$NODE_BIN" - "$RENDER_DIR/canary-deployment-manifest.json" <<'NODE'
const { readFileSync } = require("node:fs");
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (manifest.runId !== "smoke-a") throw new Error("SMOKE_MANIFEST_RUN_MISMATCH");
if (manifest.scopeNote !== "rescue-canary-run:smoke-a") {
  throw new Error("SMOKE_MANIFEST_SCOPE_MISMATCH");
}
if (
  manifest.version !== 2
  || manifest.credentialBinding?.keyVersion !== "v1"
  || manifest.credentialBinding?.exclusiveAttestationSha256 !== "b".repeat(64)
  || manifest.credentialBinding?.credentialSetSha256 !== "c".repeat(64)
  || manifest.credentialPolicy?.exclusiveWriterCredentialKind !== "winerim"
  || manifest.credentialPolicy?.agoraCredentialMode !== "shared-read-only"
  || manifest.mutationPolicy?.agoraCatalogApply !== false
  || manifest.mutationPolicy?.agoraOutboundMutation !== false
  || manifest.mutationPolicy?.winerimMutation !== true
) {
  throw new Error("SMOKE_MANIFEST_CREDENTIAL_BINDING_MISMATCH");
}
if (Object.keys(manifest.resources.queues).length !== 4) {
  throw new Error("SMOKE_MANIFEST_QUEUE_INVENTORY_MISMATCH");
}
if (Object.keys(manifest.resources.workers).length !== 4) {
  throw new Error("SMOKE_MANIFEST_WORKER_INVENTORY_MISMATCH");
}
if (Object.keys(manifest.bundleSha256 ?? {}).length !== 4) {
  throw new Error("SMOKE_MANIFEST_BUNDLE_INVENTORY_MISMATCH");
}
NODE

workerd_startup_smoke() {
  local worker="$1"
  local port="$2"
  local log
  local pid
  log="$(mktemp)"
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_MIDDLEWARE_DB=postgres://postgres:postgres@127.0.0.1:5432/postgres \
    "$NODE_BIN" node_modules/wrangler/bin/wrangler.js dev \
      --config "$RENDER_DIR/wrangler.$worker.toml" \
      --local --ip 127.0.0.1 --port "$port" >"$log" 2>&1 &
  pid=$!
  for _ in $(seq 1 60); do
    if rg -Fq 'Ready on http://127.0.0.1:' "$log" \
      || rg -Fq 'Local server updated and ready' "$log"; then
      if rg -Fq 'Dynamic require of' "$log"; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        rm -f "$log"
        printf 'FAILCLOSED_CANARY_WORKERD_DYNAMIC_REQUIRE_%s\n' "$worker" >&2
        return 1
      fi
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      rm -f "$log"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      cat "$log" >&2
      wait "$pid" 2>/dev/null || true
      printf 'FAILCLOSED_CANARY_WORKERD_START_FAILED_%s\n' "$worker" >&2
      rm -f "$log"
      return 1
    fi
    sleep 0.1
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  cat "$log" >&2
  printf 'FAILCLOSED_CANARY_WORKERD_START_TIMEOUT_%s\n' "$worker" >&2
  rm -f "$log"
  return 1
}

workerd_startup_smoke consumer 18791
workerd_startup_smoke executor 18792
npx vitest run \
  --config cloudflare/canary-failclosed/vitest.config.ts

printf '%s\n' 'FAILCLOSED_CANARY_SMOKE_OK remote_mutations=0'
