#!/usr/bin/env bash
set -euo pipefail
set +x

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

if [ "$#" -ne 1 ]; then
  printf 'Usage: STAGING_DB_URL=... %s executor|runtime\n' "$0" >&2
  exit 2
fi

component=$1
case "$component" in
  executor)
    config=wrangler.middleware-runtime-executor.toml
    ;;
  runtime)
    config=wrangler.middleware-runtime.toml
    ;;
  *)
    printf 'STAGING_RUNTIME_COMPONENT_INVALID\n' >&2
    exit 2
    ;;
esac

if [ -z "${STAGING_DB_URL:-}" ]; then
  printf 'STAGING_DB_URL_REQUIRED\n' >&2
  exit 2
fi

for command_name in node npx psql; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'BLOCKED: %s is not installed\n' "$command_name" >&2
    exit 2
  }
done

cd "$REPO_ROOT"
STAGING_DATABASE_URL="$STAGING_DB_URL" \
  node infrastructure/postgres/staging-target.mjs >/dev/null
infrastructure/postgres/verify-staging.sh "$STAGING_DB_URL"

grep -Eq '^RUNTIME_EXECUTION_ENABLED[[:space:]]*=[[:space:]]*"false"$' "$config" || {
  printf 'STAGING_RUNTIME_EXECUTION_MUST_REMAIN_DISABLED\n' >&2
  exit 1
}
if grep -Eq '^\[\[queues\.consumers\]\]' "$config"; then
  printf 'STAGING_RUNTIME_CONSUMER_BINDING_REJECTED\n' >&2
  exit 1
fi

npx wrangler deploy --config "$config" --env staging --strict
