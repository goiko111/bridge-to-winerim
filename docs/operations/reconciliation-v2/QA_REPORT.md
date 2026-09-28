# QA report — 2026-09-28

Status: **PASS as a deployment overlay; production remains intentionally untouched.**

## Executed locally

- `npm run test:reconciliation` — 5 files, 53 tests, all PASS, including the 25 adapted legacy tests.
- `npm run typecheck:reconciliation` — PASS.
- `npm run build:reconciliation` — PASS; the real dashboard and API module compiled through Vite. The single 800 kB preview chunk raises a non-blocking size warning; Lovable's full app may split it using its existing route chunking.
- Deno 2.9.6 `check` on all seven Edge Function entrypoints — PASS.
- PostgreSQL 16.14 temporary database: migration applied with the stable-id exclusion present, persisted exactly one exclusion row, rollback removed all 68 reconciliation relations; a second run without the stable id failed explicitly with `RECONCILIATION_EXCLUSION_IDENTITY_NOT_UNIQUE` — PASS.
- `git diff --check` — PASS.

## Guardrails verified

- The sales resource is fixed as `/sales/records` on the v2 base, producing only `GET /api/v2/sales/records`.
- No Winerim sale import, stock write, queue mutation or automatic repair endpoint exists.
- Raw sales, lines, movements, snapshots, checkpoints and locks are not granted to `authenticated`; the Edge read function performs tenant authorization first.
- Read-model pagination exposes incomplete coverage as HTTP 206; CSV refuses partial exports.
- Daily 24-hour rereads use restaurant timezone and business-day cutoff, while cursors/`afterId` remain monotonic.
- Glass stock behavior uses Winerim `stockEffect`/`unbackedQty`, not glass quantity versus bottle movement quantity.
- The authoritative external-resolution fixture contains exactly 19 SALE cases; extras or omissions are `CARDINALITY_CONFLICT`. Six DETAIL cases remain blocked.
- The closed-client connection has no name-based special case; exclusion is inserted in the same migration using its stable connection UUID and fleet discovery cannot override it.

## Gates that remain intentionally open

- `GET /api/v2/stock` is present in the HTML API documentation but absent from the frozen canonical OpenAPI. `refresh-current-stock` remains disabled until `WINERIM_STOCK_CONTRACT_ACK=api-v2-stock-v1` is deliberately approved.
- No cron is activated. The inert scheduler template may be activated only after two complete manual cycles on different closed business days.
- Lovable must run the normal complete-project build and tenant smoke tests after applying this overlay.
