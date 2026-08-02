#!/usr/bin/env bash
set -euo pipefail

# Auditoria Cloudflare estrictamente read-only. No imprime valores de secrets.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="$ROOT/wrangler.middleware.toml"
WORKER_HOST="winerim-middleware-api-staging.gugocreative.workers.dev"

section() {
  printf '\n== %s ==\n' "$1"
}

section "Wrangler y permisos"
npx wrangler --version
npx wrangler whoami

section "Worker staging"
npx wrangler deployments status --config "$CONFIG" --env staging
npx wrangler deployments list --config "$CONFIG" --env staging
npx wrangler secret list --config "$CONFIG" --env staging

section "Pages"
npx wrangler pages project list

section "Queues"
npx wrangler queues list

section "Hyperdrive"
npx wrangler hyperdrive list

section "DNS publico"
for host in \
  middleware.winerim.wine \
  staging.middleware.winerim.wine \
  api-staging.middleware.winerim.wine \
  api.middleware.winerim.wine
do
  printf '%s\tA=' "$host"
  dig +short A "$host" | paste -sd, -
  printf '\tAAAA='
  dig +short AAAA "$host" | paste -sd, -
  printf '\tCNAME='
  dig +short CNAME "$host" | paste -sd, -
  printf '\n'
done

section "Worker workers.dev"
curl --connect-timeout 5 --max-time 10 -sS \
  -w '\nHTTP=%{http_code} TOTAL=%{time_total}\n' \
  "https://$WORKER_HOST/health"
curl --connect-timeout 5 --max-time 10 -sS \
  -w '\nHTTP=%{http_code} TOTAL=%{time_total}\n' \
  "https://$WORKER_HOST/api/checklist?provider=agora"

section "API opcional: routes, DNS y Access"
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${CLOUDFLARE_ACCOUNT_ID:-}" && -n "${CLOUDFLARE_ZONE_ID:-}" ]]; then
  auth_header="Authorization: Bearer $CLOUDFLARE_API_TOKEN"

  curl --connect-timeout 5 --max-time 15 -fsS \
    -H "$auth_header" \
    "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/workers/routes" \
    | jq '{success,result:[(.result // [])[] | select((.pattern // "") | test("middleware\\.winerim\\.wine")) | {id,pattern,script}],errors}'

  curl --connect-timeout 5 --max-time 15 -sS \
    -H "$auth_header" \
    "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records?per_page=100" \
    | jq '{success,result:[(.result // [])[] | select((.name // "") | test("(^|\\.)middleware\\.winerim\\.wine$")) | {id,name,type,content,proxied,ttl}],errors}'

  curl --connect-timeout 5 --max-time 15 -sS \
    -H "$auth_header" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps?per_page=100" \
    | jq '{success,result:[(.result // [])[] | select((((.domain // "") + " " + (.name // "")) | test("middleware";"i"))) | {id,name,domain,type,session_duration}],errors}'
else
  printf '%s\n' "SKIP: define CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID y CLOUDFLARE_ZONE_ID para la auditoria API opcional."
fi

section "Fin"
printf '%s\n' "READ_ONLY_AUDIT_COMPLETE"
