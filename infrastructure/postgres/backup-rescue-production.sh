#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/postgres-client-tools.sh"
PHASE=${1:-}
DATABASE_URL=${RESCUE_PRODUCTION_DATABASE_URL:-}
BACKUP_ROOT=${RESCUE_PRODUCTION_BACKUP_ROOT:-}
HYDRATION_CONNECTION_ID=${RESCUE_PRODUCTION_HYDRATION_CONNECTION_ID:-}
HYDRATION_PLAN_FILE=${RESCUE_PRODUCTION_HYDRATION_PLAN_FILE:-}
EXPECTED_HYDRATION_WINERIM_WINES=${RESCUE_PRODUCTION_EXPECTED_HYDRATION_WINERIM_WINES:-}
EXPECTED_HYDRATION_PROVIDER_PRODUCTS=${RESCUE_PRODUCTION_EXPECTED_HYDRATION_PROVIDER_PRODUCTS:-}
EXPECTED_HYDRATION_PRODUCT_MAPPINGS=${RESCUE_PRODUCTION_EXPECTED_HYDRATION_PRODUCT_MAPPINGS:-}
EXPECTED_HYDRATION_MASTER_ROWS=${RESCUE_PRODUCTION_EXPECTED_HYDRATION_MASTER_ROWS:-}
HYDRATION_AWARE=0

case "$PHASE" in
  pre-bootstrap|post-bootstrap|post-hydration|pre-canary|pre-rollback|post-rollback|post-canary-rollback) ;;
  *) printf 'Usage: %s <pre-bootstrap|post-bootstrap|post-hydration|pre-canary|pre-rollback|post-rollback|post-canary-rollback>\n' "$0" >&2; exit 2 ;;
esac

if [ "$PHASE" = post-hydration ] \
  || { [ "$PHASE" = pre-canary ] && [ -n "$HYDRATION_CONNECTION_ID" ]; } \
  || { [ "$PHASE" = post-canary-rollback ] && [ -n "$HYDRATION_CONNECTION_ID" ]; }; then
  HYDRATION_AWARE=1
  if [[ ! "$HYDRATION_CONNECTION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
    printf 'RESCUE_PRODUCTION_HYDRATION_CONNECTION_ID_INVALID\n' >&2
    exit 2
  fi
  for expected_hydration_count in \
    "$EXPECTED_HYDRATION_WINERIM_WINES" \
    "$EXPECTED_HYDRATION_PROVIDER_PRODUCTS" \
    "$EXPECTED_HYDRATION_PRODUCT_MAPPINGS" \
    "$EXPECTED_HYDRATION_MASTER_ROWS"; do
    case "$expected_hydration_count" in
      ''|*[!0-9]*) printf 'RESCUE_PRODUCTION_EXPECTED_HYDRATION_COUNTS_INVALID\n' >&2; exit 2 ;;
    esac
    [ "$expected_hydration_count" -gt 0 ] || {
      printf 'RESCUE_PRODUCTION_EXPECTED_HYDRATION_COUNTS_INVALID\n' >&2
      exit 2
    }
  done
  test -n "$HYDRATION_PLAN_FILE" || {
    printf 'RESCUE_PRODUCTION_HYDRATION_PLAN_FILE_REQUIRED\n' >&2
    exit 2
  }
  case "$HYDRATION_PLAN_FILE" in /*) ;; *) printf 'ABSOLUTE_HYDRATION_PLAN_FILE_REQUIRED\n' >&2; exit 2 ;; esac
  test -f "$HYDRATION_PLAN_FILE" && test ! -L "$HYDRATION_PLAN_FILE" || {
    printf 'RESCUE_PRODUCTION_HYDRATION_PLAN_FILE_REJECTED\n' >&2
    exit 2
  }
fi

for command_name in node; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'BLOCKED_MISSING_COMMAND=%s\n' "$command_name" >&2
    exit 2
  }
done
if command -v sha256sum >/dev/null 2>&1; then
  SHA256=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SHA256=(shasum -a 256)
else
  printf 'BLOCKED_MISSING_COMMAND=sha256sum_or_shasum\n' >&2
  exit 2
fi

test -n "$DATABASE_URL" || { printf 'RESCUE_PRODUCTION_DATABASE_URL_REQUIRED\n' >&2; exit 2; }
test -n "$BACKUP_ROOT" || { printf 'RESCUE_PRODUCTION_BACKUP_ROOT_REQUIRED\n' >&2; exit 2; }
case "$BACKUP_ROOT" in /*) ;; *) printf 'ABSOLUTE_BACKUP_ROOT_REQUIRED\n' >&2; exit 2 ;; esac

target_json=$(node "$SCRIPT_DIR/rescue-production-target.mjs")
project_ref=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).projectRef)' "$target_json")
target_mode=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).mode)' "$target_json")

if [ "$target_mode" != local-disposable ]; then
  test "${GITHUB_ACTIONS:-false}" != true || {
    printf 'DURABLE_BACKUP_HOST_REQUIRED_GITHUB_RUNNER_REJECTED\n' >&2
    exit 3
  }
  case "$BACKUP_ROOT" in
    /tmp|/tmp/*|/private/tmp|/private/tmp/*|/var/tmp|/var/tmp/*|/private/var/tmp|/private/var/tmp/*|/dev/shm|/dev/shm/*|/run|/run/*|/var/folders|/var/folders/*|/private/var/folders|/private/var/folders/*)
      printf 'DURABLE_BACKUP_ROOT_REQUIRED\n' >&2; exit 3 ;;
  esac
  test "${WINERIM_RESCUE_PRODUCTION_BACKUP_CONFIRMED:-}" = YES_ENCRYPTED_DURABLE_VOLUME || {
    printf 'ENCRYPTED_DURABLE_BACKUP_CONFIRMATION_REQUIRED\n' >&2; exit 3;
  }
fi

if [ "$target_mode" = local-disposable ]; then
  mkdir -p "$BACKUP_ROOT"
else
  test -d "$BACKUP_ROOT" || { printf 'EXISTING_BACKUP_ROOT_REQUIRED\n' >&2; exit 3; }
fi
backup_root_real=$(CDPATH= cd -- "$BACKUP_ROOT" && pwd -P)
backup_storage=local-disposable
if [ "$target_mode" != local-disposable ]; then
  test "$(uname -s)" = Darwin || {
    printf 'ENCRYPTED_BACKUP_IMAGE_VERIFICATION_REQUIRES_MACOS\n' >&2
    exit 3
  }
  command -v hdiutil >/dev/null 2>&1 || {
    printf 'BLOCKED_MISSING_COMMAND=hdiutil\n' >&2
    exit 3
  }
  command -v df >/dev/null 2>&1 || {
    printf 'BLOCKED_MISSING_COMMAND=df\n' >&2
    exit 3
  }
  backup_root_device=$(df -P "$backup_root_real" | awk 'NR == 2 {print $1}')
  case "$backup_root_device" in /dev/*) ;; *) printf 'BACKUP_ROOT_DEVICE_REJECTED\n' >&2; exit 3 ;; esac
  if ! encryption_result=$(hdiutil info | node "$SCRIPT_DIR/verify-encrypted-backup-root.mjs" "$backup_root_real" "$backup_root_device"); then
    printf 'ENCRYPTED_BACKUP_IMAGE_VERIFICATION_FAILED\n' >&2
    exit 3
  fi
  printf '%s\n' "$encryption_result"
  backup_storage=encrypted-disk-image
fi
chmod 700 "$backup_root_real"
marker="$backup_root_real/.winerim-rescue-production-backup"
test -f "$marker" || { printf 'RESCUE_PRODUCTION_BACKUP_MARKER_REQUIRED\n' >&2; exit 3; }
test "$(cat "$marker")" = "winerim-rescue-production-backup:$project_ref" || {
  printf 'RESCUE_PRODUCTION_BACKUP_MARKER_REJECTED\n' >&2; exit 3;
}
marker_mode=$(stat -c '%a' "$marker" 2>/dev/null || stat -f '%Lp' "$marker")
test "$marker_mode" = 600 || { printf 'RESCUE_PRODUCTION_BACKUP_MARKER_MODE_REJECTED\n' >&2; exit 3; }

READ_ONLY_OPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000"
query() {
  PGOPTIONS="$READ_ONLY_OPTIONS" "$PSQL_CMD" "$DATABASE_URL" -XAtq -F $'\t' -v ON_ERROR_STOP=1 -c "$1"
}

configure_postgres_tools "$DATABASE_URL"

connected_database=$(query 'SELECT current_database()')
expected_database=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).database)' "$target_json")
test "$connected_database" = "$expected_database" || { printf 'CONNECTED_DATABASE_IDENTITY_MISMATCH\n' >&2; exit 3; }

metadata_exists=$(query "SELECT (to_regclass('public.infrastructure_metadata') IS NOT NULL)::int")
if [ "$metadata_exists" = 1 ]; then
  environment=$(query "SELECT coalesce((SELECT value FROM public.infrastructure_metadata WHERE key='environment'), 'missing-row')")
else
  environment=absent
fi
case "$PHASE" in
  pre-bootstrap)
    test "$environment" = absent || { printf 'PRE_BOOTSTRAP_ENVIRONMENT_REJECTED\n' >&2; exit 3; }
    ;;
  post-bootstrap|post-hydration|pre-canary|pre-rollback|post-canary-rollback)
    test "$environment" = rescue-production || { printf 'RESCUE_PRODUCTION_SENTINEL_MISMATCH\n' >&2; exit 3; }
    ;;
  post-rollback)
    test "$environment" = absent || { printf 'POST_ROLLBACK_ENVIRONMENT_REJECTED\n' >&2; exit 3; }
    ;;
esac

if [ "$HYDRATION_AWARE" = 1 ]; then
  hydration_plan_metadata=$(node - "$HYDRATION_PLAN_FILE" "$HYDRATION_CONNECTION_ID" \
    "$EXPECTED_HYDRATION_WINERIM_WINES" "$EXPECTED_HYDRATION_PROVIDER_PRODUCTS" \
    "$EXPECTED_HYDRATION_PRODUCT_MAPPINGS" "$EXPECTED_HYDRATION_MASTER_ROWS" <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");

const [path, connectionId, wines, providers, mappings, masters] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(path, "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const fail = (message) => { throw new Error(message); };
if (plan?.schemaVersion !== 2 || plan?.kind !== "disabled-connection-hydration") fail("HYDRATION_PLAN_CONTRACT_INVALID");
if (plan.connectionId !== connectionId) fail("HYDRATION_PLAN_CONNECTION_MISMATCH");
if (!/^[0-9a-f]{64}$/.test(String(plan.hydrationDigest ?? ""))) fail("HYDRATION_PLAN_DIGEST_INVALID");
const expectedCounts = {
  currentWinerimWines: Number(wines),
  currentAgoraProducts: Number(providers),
  acceptedMappings: Number(mappings),
};
for (const [key, value] of Object.entries(expectedCounts)) {
  if (plan?.counts?.[key] !== value) fail(`HYDRATION_PLAN_COUNT_MISMATCH_${key}`);
}
if (Number(masters) !== 1) fail("HYDRATION_PLAN_MASTER_COUNT_INVALID");
if (!Array.isArray(plan.acceptedMappings) || plan.acceptedMappings.length !== Number(mappings)) fail("HYDRATION_PLAN_MAPPINGS_INVALID");
if (!Array.isArray(plan.winerimWines) || plan.winerimWines.length !== Number(wines)) fail("HYDRATION_PLAN_WINES_INVALID");
if (!Array.isArray(plan.providerProducts) || plan.providerProducts.length !== Number(providers)) fail("HYDRATION_PLAN_PRODUCTS_INVALID");
const computedHydrationDigest = sha256(canonicalJson({
  schemaVersion: 2,
  connectionId,
  acceptedMappings: plan.acceptedMappings,
  winerimWines: plan.winerimWines,
  providerProducts: plan.providerProducts,
  agoraMasterData: {
    families: plan?.agoraMasterData?.families,
    products: plan.providerProducts.map((product) => ({
      providerProductId: product.providerProductId,
      name: product.name,
      family: product.family,
      price: product.price,
      saleFormat: product.saleFormat,
      classificationStatus: product.classificationStatus,
      winerimWineId: product.winerimWineId,
      rawPayload: product.rawPayload,
    })),
  },
}));
if (computedHydrationDigest !== plan.hydrationDigest) fail("HYDRATION_PLAN_DIGEST_REJECTED");
const variantName = { BOTTLE: "botella", GLASS: "copa", MAGNUM: "magnum" };
const semanticMappings = plan.acceptedMappings.map((mapping) => {
  const formatType = String(mapping.formatType ?? "").toUpperCase();
  const stockId = Number(mapping.stockId);
  if (!variantName[formatType] || !Number.isInteger(stockId) || stockId <= 0 || typeof mapping.stockActive !== "boolean") {
    fail("HYDRATION_PLAN_MAPPING_STOCK_INVALID");
  }
  const stockActive = mapping.stockActive === true;
  const expectedMatchMethod = stockActive
    ? "RESCUE_EXACT_ID_WINE_VARIANT"
    : "RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY";
  if (mapping.matchMethod !== expectedMatchMethod) fail("HYDRATION_PLAN_MAPPING_METHOD_INVALID");
  return {
    providerProductId: String(mapping.providerProductId),
    providerProductName: String(mapping.providerProductName),
    winerimWineId: String(mapping.winerimWineId),
    winerimWineName: String(mapping.winerimWineName),
    formatType,
    stockVariant: variantName[formatType],
    stockId,
    variantColumnStockId: stockId,
    rawStockVariant: variantName[formatType],
    stockActive,
    status: "CONFIRMED",
    matchMethod: expectedMatchMethod,
    matchScore: 1,
    matchReasons: [
      "CURRENT_AGORA_PRODUCT_ID",
      "CURRENT_WINERIM_WINE_ID",
      `CURRENT_${formatType}_STOCK_ID_${stockId}`,
      stockActive
        ? `CURRENT_${formatType}_STOCK_ACTIVE_TRUE`
        : `CURRENT_${formatType}_STOCK_ACTIVE_FALSE_SALES_ONLY`,
    ].sort(),
  };
}).sort((left, right) => left.providerProductId < right.providerProductId ? -1 : left.providerProductId > right.providerProductId ? 1 : 0);
process.stdout.write([
  plan.hydrationDigest,
  sha256(readFileSync(path)),
  sha256(canonicalJson(semanticMappings)),
].join("\t"));
NODE
  ) || {
    printf 'POST_HYDRATION_PLAN_VALIDATION_REJECTED\n' >&2
    exit 3
  }
  IFS=$'\t' read -r hydration_digest hydration_plan_sha hydration_mapping_semantic_sha <<<"$hydration_plan_metadata"
  for digest in "$hydration_digest" "$hydration_plan_sha" "$hydration_mapping_semantic_sha"; do
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || {
      printf 'POST_HYDRATION_PLAN_METADATA_REJECTED\n' >&2
      exit 3
    }
  done

  expected_tables=$(cat "$SCRIPT_DIR/expected-tables-runtime-postupgrade.txt")
  actual_tables=$(query "SELECT string_agg(c.relname, E'\\n' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
  test "$actual_tables" = "$expected_tables" || {
    printf 'POST_HYDRATION_PUBLIC_TABLE_INVENTORY_REJECTED\n' >&2
    exit 3
  }

  connection_count=$(query 'SELECT count(*) FROM public.pos_connections')
  test "$connection_count" = 31 || {
    printf 'POST_HYDRATION_CONNECTION_COUNT_REJECTED expected=31 actual=%s\n' "$connection_count" >&2
    exit 3
  }
  unsafe_connections=$(query "SELECT count(*) FROM public.pos_connections WHERE enabled OR catalog_sync_enabled OR sync_mode <> 'PULL_ONLY' OR write_mode <> 'NONE' OR backfill_days <> 0 OR last_sync_at IS NOT NULL OR last_catalog_sync_at IS NOT NULL OR last_business_day_synced IS NOT NULL OR circuit_breaker_paused_until IS NOT NULL OR consecutive_failures <> 0 OR base_url <> 'https://redacted.invalid' OR api_token <> '' OR winerim_api_token IS NOT NULL")
  test "$unsafe_connections" = 0 || {
    printf 'POST_HYDRATION_CONNECTIONS_NOT_FULLY_INERT count=%s\n' "$unsafe_connections" >&2
    exit 3
  }

  candidate="'$HYDRATION_CONNECTION_ID'::uuid"
  candidate_exists=$(query "SELECT count(*) FROM public.pos_connections WHERE id=$candidate")
  test "$candidate_exists" = 1 || {
    printf 'POST_HYDRATION_CONNECTION_NOT_FOUND\n' >&2
    exit 3
  }

  hydration_counts=$(query "SELECT (SELECT count(*) FROM public.winerim_wines WHERE connection_id=$candidate) || '|' || (SELECT count(*) FROM public.provider_products WHERE connection_id=$candidate) || '|' || (SELECT count(*) FROM public.product_mappings WHERE connection_id=$candidate) || '|' || (SELECT count(*) FROM public.agora_master_data WHERE connection_id=$candidate)")
  expected_hydration_counts="$EXPECTED_HYDRATION_WINERIM_WINES|$EXPECTED_HYDRATION_PROVIDER_PRODUCTS|$EXPECTED_HYDRATION_PRODUCT_MAPPINGS|$EXPECTED_HYDRATION_MASTER_ROWS"
  test "$hydration_counts" = "$expected_hydration_counts" || {
    printf 'POST_HYDRATION_EXACT_COUNTS_REJECTED expected=%s actual=%s\n' "$expected_hydration_counts" "$hydration_counts" >&2
    exit 3
  }

  master_digest_marker=$(query "SELECT coalesce(string_agg(raw_xml_preview, '' ORDER BY id), '') FROM public.agora_master_data WHERE connection_id=$candidate")
  test "$master_digest_marker" = "WINERIM_RESCUE_HYDRATION_V2_SHA256:$hydration_digest" || {
    printf 'POST_HYDRATION_MASTER_DIGEST_REJECTED\n' >&2
    exit 3
  }

  hydration_mapping_json=$(query "SELECT coalesce(jsonb_agg(mapping_semantic ORDER BY provider_product_id), '[]'::jsonb)::text FROM (SELECT pm.provider_product_id, jsonb_build_object('providerProductId', pm.provider_product_id, 'providerProductName', pm.provider_product_name, 'winerimWineId', pm.winerim_wine_id, 'winerimWineName', pm.winerim_wine_name, 'formatType', pm.format_type, 'stockVariant', CASE pm.format_type WHEN 'BOTTLE' THEN 'botella' WHEN 'GLASS' THEN 'copa' WHEN 'MAGNUM' THEN 'magnum' END, 'stockId', stock_reason.stock_id, 'variantColumnStockId', CASE pm.format_type WHEN 'BOTTLE' THEN ww.bottle_stock_id WHEN 'GLASS' THEN ww.glass_stock_id WHEN 'MAGNUM' THEN ww.magnum_stock_id END, 'rawStockVariant', lower(stock_source.stock->'winePrice'->>'variant'), 'stockActive', coalesce((stock_source.stock->>'stockActive')::boolean, false), 'status', pm.status, 'matchMethod', pm.match_method, 'matchScore', pm.match_score, 'matchReasons', to_jsonb(ARRAY(SELECT reason FROM unnest(pm.match_reasons) reason ORDER BY reason))) AS mapping_semantic FROM public.product_mappings pm JOIN public.winerim_wines ww ON ww.connection_id=pm.connection_id AND ww.winerim_id=pm.winerim_wine_id LEFT JOIN LATERAL (SELECT substring(reason FROM '([1-9][0-9]*)$')::bigint AS stock_id FROM unnest(pm.match_reasons) reason WHERE reason ~ ('^CURRENT_' || pm.format_type || '_STOCK_ID_[1-9][0-9]*$') ORDER BY reason LIMIT 1) stock_reason ON true LEFT JOIN LATERAL (SELECT stock FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ww.raw_payload->'stocks')='array' THEN ww.raw_payload->'stocks' ELSE '[]'::jsonb END) stock WHERE stock->>'id'=stock_reason.stock_id::text LIMIT 1) stock_source ON true WHERE pm.connection_id=$candidate) semantic_rows")
  hydration_mapping_actual_sha=$(node -e 'const {createHash}=require("node:crypto"); const canonical=(v)=>Array.isArray(v)?`[${v.map(canonical).join(",")}]`:v&&typeof v==="object"?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`:JSON.stringify(v); process.stdout.write(createHash("sha256").update(canonical(JSON.parse(process.argv[1]))).digest("hex"));' "$hydration_mapping_json")
  test "$hydration_mapping_actual_sha" = "$hydration_mapping_semantic_sha" || {
    printf 'POST_HYDRATION_MAPPING_SEMANTIC_FINGERPRINT_REJECTED expected=%s actual=%s\n' "$hydration_mapping_semantic_sha" "$hydration_mapping_actual_sha" >&2
    exit 3
  }

  outside_candidate=$(query "SELECT (SELECT count(*) FROM public.winerim_wines WHERE connection_id<>$candidate) + (SELECT count(*) FROM public.provider_products WHERE connection_id<>$candidate) + (SELECT count(*) FROM public.product_mappings WHERE connection_id<>$candidate) + (SELECT count(*) FROM public.agora_master_data WHERE connection_id<>$candidate)")
  test "$outside_candidate" = 0 || {
    printf 'POST_HYDRATION_ROWS_OUTSIDE_EXPECTED_CONNECTION count=%s\n' "$outside_candidate" >&2
    exit 3
  }

  operational_rows=$(query "SELECT (SELECT count(*) FROM public.provider_credentials) || '|' || (SELECT count(*) FROM public.runtime_connection_credentials) || '|' || (SELECT count(*) FROM public.runtime_canary_connections) || '|' || (SELECT count(*) FROM public.runtime_idempotency) || '|' || (SELECT count(*) FROM public.runtime_execution_log) || '|' || (SELECT count(*) FROM public.sales_events) || '|' || (SELECT count(*) FROM public.sales_line_items) || '|' || (SELECT count(*) FROM public.stock_sync_log) || '|' || (SELECT count(*) FROM public.outbound_tasks)")
  test "$operational_rows" = '0|0|0|0|0|0|0|0|0' || {
    printf 'POST_HYDRATION_OPERATIONAL_ROWS_REJECTED counts=%s\n' "$operational_rows" >&2
    exit 3
  }

  disallowed_rows=$(query "SELECT coalesce(sum((xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I', c.relname), false, true, '')))[1]::text::bigint), 0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('infrastructure_metadata','pos_connections','winerim_wines','provider_products','product_mappings','agora_master_data')")
  test "$disallowed_rows" = 0 || {
    printf 'POST_HYDRATION_ROWS_IN_DISALLOWED_TABLES count=%s\n' "$disallowed_rows" >&2
    exit 3
  }

  if ! hydration_database_sha=$(hydration_database_fingerprint "$DATABASE_URL" "$HYDRATION_CONNECTION_ID"); then
    printf 'POST_HYDRATION_DATABASE_FINGERPRINT_REJECTED\n' >&2
    exit 3
  fi
  test "$hydration_database_sha" = "$hydration_digest" || {
    printf 'POST_HYDRATION_DATABASE_DIGEST_REJECTED expected=%s actual=%s\n' "$hydration_digest" "$hydration_database_sha" >&2
    exit 3
  }
fi

if [ "$PHASE" = pre-canary ]; then
  test -n "${RESCUE_PRODUCTION_RUNTIME_DATABASE_URL:-}" || {
    printf 'RESCUE_PRODUCTION_RUNTIME_DATABASE_URL_REQUIRED_FOR_PRE_CANARY_BACKUP\n' >&2
    exit 3
  }
  if ! RESCUE_PRODUCTION_EXPECTED_LOGIN_ROLES=3 \
    RESCUE_PRODUCTION_HYDRATION_CONNECTION_ID="$HYDRATION_CONNECTION_ID" \
    RESCUE_PRODUCTION_HYDRATION_PLAN_FILE="$HYDRATION_PLAN_FILE" \
    RESCUE_PRODUCTION_EXPECTED_HYDRATION_WINERIM_WINES="$EXPECTED_HYDRATION_WINERIM_WINES" \
    RESCUE_PRODUCTION_EXPECTED_HYDRATION_PROVIDER_PRODUCTS="$EXPECTED_HYDRATION_PROVIDER_PRODUCTS" \
    RESCUE_PRODUCTION_EXPECTED_HYDRATION_PRODUCT_MAPPINGS="$EXPECTED_HYDRATION_PRODUCT_MAPPINGS" \
    RESCUE_PRODUCTION_EXPECTED_HYDRATION_MASTER_ROWS="$EXPECTED_HYDRATION_MASTER_ROWS" \
    "$SCRIPT_DIR/verify-rescue-production.sh" >/dev/null; then
    printf 'PRE_CANARY_INERT_STATE_VERIFICATION_FAILED\n' >&2
    exit 3
  fi
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
artifact_dir="$backup_root_real/$project_ref/$stamp-$PHASE-$$"
mkdir -p "$artifact_dir"
chmod 700 "$artifact_dir"
dump="$artifact_dir/public.dump"
toc="$artifact_dir/public.toc"
roles="$artifact_dir/roles.tsv"
memberships="$artifact_dir/memberships.tsv"
inventory="$artifact_dir/public-tables.tsv"
prerequisites="$artifact_dir/restore-prerequisites.sql"
manifest="$artifact_dir/manifest.txt"
manifest_digest="$artifact_dir/manifest.txt.sha256"

"$PG_DUMP_CMD" "$DATABASE_URL" --schema=public --format=custom --no-owner --file="$dump"
"$PG_RESTORE_CMD" --list "$dump" >"$toc"
query "SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname LIKE 'middleware_%' ORDER BY rolname" >"$roles"
query "SELECT granted.rolname, member.rolname, membership.admin_option FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE granted.rolname LIKE 'middleware_%' OR member.rolname LIKE 'middleware_%' ORDER BY granted.rolname, member.rolname" >"$memberships"
query "SELECT c.relname, (xpath('/row/count/text()', query_to_xml(format('SELECT count(*) AS count FROM public.%I', c.relname), false, true, '')))[1]::text::bigint FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname" >"$inventory"

cat >"$prerequisites" <<'SQL'
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_api') THEN
    CREATE ROLE middleware_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_runtime') THEN
    CREATE ROLE middleware_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'middleware_readonly') THEN
    CREATE ROLE middleware_readonly NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$roles$;
SQL

chmod 600 "$dump" "$toc" "$roles" "$memberships" "$inventory" "$prerequisites"
dump_sha=$("${SHA256[@]}" "$dump" | awk '{print $1}')
toc_sha=$("${SHA256[@]}" "$toc" | awk '{print $1}')
roles_sha=$("${SHA256[@]}" "$roles" | awk '{print $1}')
memberships_sha=$("${SHA256[@]}" "$memberships" | awk '{print $1}')
inventory_sha=$("${SHA256[@]}" "$inventory" | awk '{print $1}')
prerequisites_sha=$("${SHA256[@]}" "$prerequisites" | awk '{print $1}')
table_count=$(wc -l <"$inventory" | tr -d ' ')
manifest_schema_version=3
[ "$HYDRATION_AWARE" != 1 ] || manifest_schema_version=5
printf 'schema_version=%s\nproject_ref=%s\nexpected_environment=rescue-production\nobserved_environment=%s\nphase=%s\nbackup_storage=%s\npostgres_server_major=%s\npsql_major=%s\npg_dump_major=%s\npg_restore_major=%s\npublic_table_count=%s\ndump_sha256=%s\ntoc_sha256=%s\nroles_sha256=%s\nmemberships_sha256=%s\ninventory_sha256=%s\nrestore_prerequisites_sha256=%s\n' \
  "$manifest_schema_version" "$project_ref" "$environment" "$PHASE" "$backup_storage" \
  "$POSTGRES_SERVER_MAJOR" "$POSTGRES_PSQL_MAJOR" "$POSTGRES_DUMP_MAJOR" "$POSTGRES_RESTORE_MAJOR" \
  "$table_count" "$dump_sha" "$toc_sha" "$roles_sha" "$memberships_sha" "$inventory_sha" "$prerequisites_sha" >"$manifest"
if [ "$HYDRATION_AWARE" = 1 ]; then
  hydration_plan_artifact="$artifact_dir/hydration-plan.json"
  cp "$HYDRATION_PLAN_FILE" "$hydration_plan_artifact"
  chmod 600 "$hydration_plan_artifact"
  test "$("${SHA256[@]}" "$hydration_plan_artifact" | awk '{print $1}')" = "$hydration_plan_sha" || {
    printf 'POST_HYDRATION_PLAN_COPY_DIGEST_REJECTED\n' >&2
    exit 3
  }
  printf 'hydration_connection_id=%s\nhydration_winerim_wines=%s\nhydration_provider_products=%s\nhydration_product_mappings=%s\nhydration_master_rows=%s\nhydration_digest=%s\nhydration_plan_sha256=%s\nhydration_mappings_semantic_sha256=%s\n' \
    "$HYDRATION_CONNECTION_ID" \
    "$EXPECTED_HYDRATION_WINERIM_WINES" \
    "$EXPECTED_HYDRATION_PROVIDER_PRODUCTS" \
    "$EXPECTED_HYDRATION_PRODUCT_MAPPINGS" \
    "$EXPECTED_HYDRATION_MASTER_ROWS" \
    "$hydration_digest" \
    "$hydration_plan_sha" \
    "$hydration_mapping_semantic_sha" >>"$manifest"
fi
chmod 600 "$manifest"
(cd "$artifact_dir" && "${SHA256[@]}" manifest.txt) >"$manifest_digest"
chmod 600 "$manifest_digest"

printf 'RESCUE_PRODUCTION_BACKUP_OK phase=%s project_ref=%s public_tables=%s artifact_dir=%s manifest_sha256=%s\n' \
  "$PHASE" "$project_ref" "$table_count" "$artifact_dir" "$(awk '{print $1}' "$manifest_digest")"
