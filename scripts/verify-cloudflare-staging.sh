#!/usr/bin/env bash
set -euo pipefail

API_BASE="${1:-https://winerim-middleware-api-staging.gugocreative.workers.dev}"
ORIGIN="${2:-https://staging.middleware.winerim.wine}"
EXPECT_REQUEST_STORAGE="${EXPECT_REQUEST_STORAGE:-disabled}"

echo "Checking health: ${API_BASE}/health"
health="$(curl -fsS "${API_BASE}/health")"
echo "${health}"
if [[ "${health}" != *'"environment":"staging"'* ]]; then
  echo "Expected staging health response" >&2
  exit 1
fi

echo "Checking onboarding validation"
validation="$(curl -sS -X POST "${API_BASE}/api/onboarding/test" \
  -H "Content-Type: application/json" \
  -d '{"provider":"revo","locationName":"Smoke"}')"
echo "${validation}"
if [[ "${validation}" != *'"error":"VALIDATION_FAILED"'* ]]; then
  echo "Expected validation failure for incomplete REVO payload" >&2
  exit 1
fi

echo "Checking CORS preflight for POST"
preflight_headers="$(curl -fsS -i -X OPTIONS "${API_BASE}/api/onboarding/requests" \
  -H "Origin: ${ORIGIN}" \
  -H "Access-Control-Request-Method: POST")"
echo "${preflight_headers}" | sed -n '1,12p'
if [[ "${preflight_headers}" != *"access-control-allow-origin: ${ORIGIN}"* ]]; then
  echo "Expected CORS allow-origin for ${ORIGIN}" >&2
  exit 1
fi

echo "Checking CORS preflight for PATCH"
patch_preflight_headers="$(curl -fsS -i -X OPTIONS "${API_BASE}/api/onboarding/requests/11111111-1111-1111-1111-111111111111" \
  -H "Origin: ${ORIGIN}" \
  -H "Access-Control-Request-Method: PATCH")"
echo "${patch_preflight_headers}" | sed -n '1,12p'
if [[ "${patch_preflight_headers}" != *"access-control-allow-methods: GET,POST,PATCH,OPTIONS"* ]]; then
  echo "Expected CORS allow-methods to include PATCH" >&2
  exit 1
fi

echo "Checking onboarding request storage mode"
requests_response="$(curl -sS "${API_BASE}/api/onboarding/requests")"
echo "${requests_response}"
if [[ "${EXPECT_REQUEST_STORAGE}" == "disabled" && "${requests_response}" != *'"error":"REQUEST_STORAGE_DISABLED"'* ]]; then
  echo "Expected onboarding request storage to be disabled" >&2
  exit 1
fi

echo "Cloudflare staging smoke test OK"
