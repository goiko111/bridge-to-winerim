#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POSTGRES_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$POSTGRES_DIR/../.." && pwd)
for command_name in initdb pg_ctl createdb psql node; do
  command -v "$command_name" >/dev/null 2>&1 || { printf 'BLOCKED: %s is not installed\n' "$command_name" >&2; exit 2; }
done

TMP_ROOT=$(mktemp -d /tmp/wrht.XXXXXX)
DATA_DIR="$TMP_ROOT/data"
BACKUP_ROOT="$TMP_ROOT/backups"
SEED_SQL="$TMP_ROOT/rescue-connections-disabled.sql"
PLAN_DIR="$TMP_ROOT/plans"
TRANSITION_DIR="$TMP_ROOT/transition"
PORT=$((58332 + ($$ % 300)))
PROJECT_REF=piyvadlzagtracciquap
DATABASE_NAME=winerim_rescue_production_test
DATABASE_USER=$(id -un)
CONNECTION_ID=00000000-0000-4000-8000-000000000001
SERVER_STARTED=0

cleanup() {
  if [ "$SERVER_STARTED" = 1 ]; then pg_ctl -D "$DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true; fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

initdb -D "$DATA_DIR" --auth=trust --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$DATA_DIR" -l "$TMP_ROOT/postgres.log" -o "-h 127.0.0.1 -p $PORT" -w start >/dev/null
SERVER_STARTED=1
createdb -h 127.0.0.1 -p "$PORT" "$DATABASE_NAME"

cat >"$SEED_SQL" <<'SQL'
BEGIN;
INSERT INTO public.pos_connections (
  id, location_name, provider, base_url, api_token, winerim_api_token,
  enabled, catalog_sync_enabled, sync_mode, write_mode,
  sync_frequency_minutes, backfill_days, last_sync_at, last_catalog_sync_at,
  last_business_day_synced, circuit_breaker_paused_until, circuit_breaker_reason,
  consecutive_failures
)
SELECT
  ('00000000-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
  'Rescue connection ' || item,
  CASE WHEN item = 31 THEN 'yurest' ELSE 'agora' END,
  'https://redacted.invalid', '', NULL,
  false, false, 'PULL_ONLY', 'NONE', 5, 0,
  NULL, NULL, NULL, NULL, NULL, 0
FROM generate_series(1, 31) item;
COMMIT;
SQL

mkdir -p "$BACKUP_ROOT" "$PLAN_DIR" "$TRANSITION_DIR"
chmod 700 "$BACKUP_ROOT" "$PLAN_DIR" "$TRANSITION_DIR"
printf 'winerim-rescue-production-backup:%s\n' "$PROJECT_REF" >"$BACKUP_ROOT/.winerim-rescue-production-backup"
chmod 600 "$BACKUP_ROOT/.winerim-rescue-production-backup"

export RESCUE_PRODUCTION_PROJECT_REF="$PROJECT_REF"
export RESCUE_PRODUCTION_EXPECTED_ENVIRONMENT=rescue-production
export RESCUE_PRODUCTION_DATABASE_URL="postgresql://$DATABASE_USER@127.0.0.1:$PORT/$DATABASE_NAME"
export RESCUE_PRODUCTION_SEED_SQL="$SEED_SQL"
export RESCUE_PRODUCTION_BACKUP_ROOT="$BACKUP_ROOT"
export RESCUE_PRODUCTION_EXPECTED_CONNECTIONS=31
export WINERIM_RESCUE_PRODUCTION_LOCAL_TEST=1

bootstrap_plan=$("$POSTGRES_DIR/apply-rescue-production.sh")
plan_sha=$(sed -n 's/.*plan_sha256=\([^ ]*\).*/\1/p' <<<"$bootstrap_plan")
seed_sha=$(sed -n 's/.*seed_sha256=\([^ ]*\).*/\1/p' <<<"$bootstrap_plan")
"$POSTGRES_DIR/apply-rescue-production.sh" \
  --apply \
  --confirm-project-ref "$PROJECT_REF" \
  --confirm-environment rescue-production \
  --confirm-plan-sha "$plan_sha" \
  --confirm-seed-sha "$seed_sha" \
  --confirm-action APPLY_EMPTY_RESCUE_PRODUCTION_BOOTSTRAP >/dev/null

node --input-type=module - "$REPO_ROOT" "$PLAN_DIR" "$CONNECTION_ID" <<'NODE'
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [repoRoot, outputDir, connectionId] = process.argv.slice(2);
const hydration = await import(pathToFileURL(`${repoRoot}/scripts/generate-disabled-connection-hydration.mjs`));
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const recompute = (plan) => {
  const payload = {
    schemaVersion: 2,
    connectionId: plan.connectionId,
    acceptedMappings: plan.acceptedMappings,
    winerimWines: plan.winerimWines,
    providerProducts: plan.providerProducts,
    agoraMasterData: {
      families: plan.agoraMasterData.families,
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
  };
  plan.hydrationDigest = createHash("sha256").update(canonicalJson(payload)).digest("hex");
};
const after = hydration.buildDisabledConnectionHydration({
  connectionId,
  snapshot: {
    connection: { data: { id: connectionId } },
    mappings: { data: [
      { provider_product_id: "500101", provider_product_name: "B Active", winerim_wine_id: "101", winerim_wine_name: "Wine", format_type: "BOTTLE", status: "CONFIRMED" },
      { provider_product_id: "700101", provider_product_name: "C Inactive", winerim_wine_id: "101", winerim_wine_name: "Wine", format_type: "GLASS", status: "CONFIRMED" },
    ] },
  },
  masterXml: `<Export><Families><Family Id="1" Name="WINERIM"/></Families><Products>
    <Product Id="500101" Name="B Active" FamilyId="1"><Prices><Price MainPrice="20"/></Prices></Product>
    <Product Id="700101" Name="C Inactive" FamilyId="1"><Prices><Price MainPrice="5"/></Prices></Product>
  </Products></Export>`,
  winesDocument: { success: true, wines: [{ id: 101, name: "Wine" }] },
  stockDocument: { success: true, stocks: [
    { id: 1001, stock: 3, stockActive: true, winePrice: { price: 20, variant: "botella", wine: { id: 101 } } },
    { id: 1002, stock: 0, stockActive: false, winePrice: { price: 5, variant: "copa", wine: { id: 101 } } },
  ] },
  generatedAt: "2026-08-03T10:00:00.000Z",
});
const before = structuredClone(after);
before.acceptedMappings = before.acceptedMappings.filter((mapping) => mapping.providerProductId !== "700101");
const provider = before.providerProducts.find((product) => product.providerProductId === "700101");
Object.assign(provider, {
  saleFormat: null,
  isWineCandidate: true,
  classificationStatus: "AMBIGUOUS",
  wineScore: 50,
  wineReasons: ["CURRENT_WINERIM_FAMILY", "REJECTED_STOCK_VARIANT_INACTIVE"],
  syncStatus: "BLOCKED",
  syncError: "HYDRATION_WINE_CANDIDATE_AMBIGUOUS",
  winerimWineId: null,
});
before.agoraMasterData.productsSummary = before.providerProducts.map((product) => ({
  provider_product_id: product.providerProductId,
  name: product.name,
  family: product.family,
  price: product.price,
  sale_format: product.saleFormat,
  classification_status: product.classificationStatus,
  winerim_wine_id: product.winerimWineId,
  raw_payload: product.rawPayload,
}));
before.counts.acceptedMappings = 1;
before.counts.rejectedMappings = 1;
before.counts.confirmedProviderWineCandidates = 1;
before.counts.ambiguousProviderWineCandidates = 1;
recompute(before);
writeFileSync(`${outputDir}/before.json`, `${JSON.stringify(before, null, 2)}\n`);
writeFileSync(`${outputDir}/after.json`, `${JSON.stringify(after, null, 2)}\n`);
writeFileSync(`${outputDir}/hydrate-before.sql`, hydration.renderHydrationSql(before));
NODE

node "$REPO_ROOT/scripts/generate-disabled-connection-hydration-transition.mjs" \
  --before-plan "$PLAN_DIR/before.json" \
  --after-plan "$PLAN_DIR/after.json" \
  --output-dir "$TRANSITION_DIR" >/dev/null

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$PLAN_DIR/hydrate-before.sql" >/dev/null
. "$POSTGRES_DIR/postgres-client-tools.sh"
configure_postgres_tools "$RESCUE_PRODUCTION_DATABASE_URL"
before_digest=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).hydrationDigest)' "$PLAN_DIR/before.json")
after_digest=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).hydrationDigest)' "$PLAN_DIR/after.json")
test "$(hydration_database_fingerprint "$RESCUE_PRODUCTION_DATABASE_URL" "$CONNECTION_ID")" = "$before_digest"

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TRANSITION_DIR/apply-hydration-transition.sql" >/dev/null
test "$(hydration_database_fingerprint "$RESCUE_PRODUCTION_DATABASE_URL" "$CONNECTION_ID")" = "$after_digest"
test "$(psql "$RESCUE_PRODUCTION_DATABASE_URL" -XAtq -c "SELECT count(*) FROM public.product_mappings WHERE connection_id='$CONNECTION_ID'")" = 2
test "$(psql "$RESCUE_PRODUCTION_DATABASE_URL" -XAtq -c "SELECT count(*) FROM public.product_mappings WHERE connection_id='$CONNECTION_ID' AND match_method='RESCUE_EXACT_ID_WINE_VARIANT_SALES_ONLY'")" = 1
if psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TRANSITION_DIR/apply-hydration-transition.sql" >/dev/null 2>&1; then
  printf 'FAIL: transition apply accepted an already-transitioned scope\n' >&2
  exit 1
fi

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TRANSITION_DIR/rollback-hydration-transition.sql" >/dev/null
test "$(hydration_database_fingerprint "$RESCUE_PRODUCTION_DATABASE_URL" "$CONNECTION_ID")" = "$before_digest"
test "$(psql "$RESCUE_PRODUCTION_DATABASE_URL" -XAtq -c "SELECT count(*) FROM public.product_mappings WHERE connection_id='$CONNECTION_ID'")" = 1

psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "INSERT INTO public.sales_events (connection_id, provider_doc_id, business_day) VALUES ('$CONNECTION_ID', 'must-block-transition', current_date)" >/dev/null
if psql "$RESCUE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$TRANSITION_DIR/apply-hydration-transition.sql" >/dev/null 2>&1; then
  printf 'FAIL: transition accepted non-empty operational scope\n' >&2
  exit 1
fi
test "$(hydration_database_fingerprint "$RESCUE_PRODUCTION_DATABASE_URL" "$CONNECTION_ID")" = "$before_digest"

printf 'DISABLED_HYDRATION_TRANSITION_TEST_OK\n'
