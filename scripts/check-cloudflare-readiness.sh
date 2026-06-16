#!/usr/bin/env bash
set -euo pipefail

WORKERS_API_BASE="${WORKERS_API_BASE:-https://winerim-middleware-api-staging.gugocreative.workers.dev}"
CUSTOM_API_BASE="${CUSTOM_API_BASE:-https://api-staging.middleware.winerim.wine}"
PAGES_BASE="${PAGES_BASE:-https://staging.middleware.winerim.wine}"
ORIGIN="${ORIGIN:-https://staging.middleware.winerim.wine}"

failures=0
pending=0

mark_fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

mark_pending() {
  echo "PENDING: $1"
  pending=$((pending + 1))
}

check_health() {
  local label="$1"
  local base="$2"
  local required="$3"
  local response

  echo "Checking ${label}: ${base}/health"
  if ! response="$(curl -fsS --max-time 12 "${base}/health" 2>/dev/null)"; then
    if [[ "${required}" == "required" ]]; then
      mark_fail "${label} health is not reachable"
    else
      mark_pending "${label} health is not reachable yet"
    fi
    return
  fi

  echo "${response}"
  if [[ "${response}" != *'"ok":true'* ]]; then
    mark_fail "${label} health did not return ok=true"
  fi
}

check_preflight() {
  local label="$1"
  local base="$2"
  local method="$3"
  local path="$4"
  local required="$5"
  local headers

  echo "Checking ${label} CORS ${method}: ${base}${path}"
  if ! headers="$(curl -fsS -i --max-time 12 -X OPTIONS "${base}${path}" \
    -H "Origin: ${ORIGIN}" \
    -H "Access-Control-Request-Method: ${method}" 2>/dev/null)"; then
    if [[ "${required}" == "required" ]]; then
      mark_fail "${label} CORS ${method} preflight is not reachable"
    else
      mark_pending "${label} CORS ${method} preflight is not reachable yet"
    fi
    return
  fi

  echo "${headers}" | sed -n '1,12p'
  if [[ "${headers}" != *"access-control-allow-origin: ${ORIGIN}"* ]]; then
    mark_fail "${label} CORS ${method} does not allow ${ORIGIN}"
  fi
  if [[ "${headers}" != *"access-control-allow-credentials: true"* ]]; then
    mark_fail "${label} CORS ${method} does not allow credentials"
  fi
  if [[ "${method}" == "PATCH" && "${headers}" != *"PATCH"* ]]; then
    mark_fail "${label} CORS methods do not include PATCH"
  fi
}

check_pages() {
  local headers

  echo "Checking Pages staging: ${PAGES_BASE}/onboarding"
  if ! headers="$(curl -sS -I --max-time 12 "${PAGES_BASE}/onboarding" 2>/dev/null)"; then
    mark_pending "Pages staging is not reachable yet"
    return
  fi

  echo "${headers}" | sed -n '1,12p'
}

check_health "workers.dev API" "${WORKERS_API_BASE}" "required"
check_preflight "workers.dev API" "${WORKERS_API_BASE}" "POST" "/api/onboarding/requests" "required"
check_preflight "workers.dev API" "${WORKERS_API_BASE}" "PATCH" "/api/onboarding/requests/11111111-1111-1111-1111-111111111111" "required"

check_health "custom API domain" "${CUSTOM_API_BASE}" "optional"
check_preflight "custom API domain" "${CUSTOM_API_BASE}" "POST" "/api/onboarding/requests" "optional"
check_pages

echo "Readiness check complete: ${failures} failure(s), ${pending} pending item(s)."
if [[ "${failures}" -gt 0 ]]; then
  exit 1
fi
