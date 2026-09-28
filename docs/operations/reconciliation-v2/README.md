# Winerim Fleet Reconciliation v2

## Purpose

Read Ágora evidence already stored in Supabase and Winerim evidence through the read-only fleet API, reconcile both sides per restaurant/day, and expose a tenant-safe audit and analytics view.

This package is deliberately **AUDIT_ONLY**. It cannot import a sale, change stock, requeue an operation, cancel a sale, modify a mapping or repair data.

## Source contracts

- Fleet: `GET /api/v2/restaurants`
- Sales and lines: API v2 resource `GET /sales/records` (effective URL `GET /api/v2/sales/records`)
- Stock movements: `GET /api/v2/stock/movements`
- Current stock: `GET /api/v2/stock` (disabled until the contract gate is satisfied)

The sales sync observes the documented 60-second delay and keeps a daily 24-hour overlap aligned to each binding's timezone and cutoff. Stock movements use the same overlap and a monotonic `afterId`. Every page is committed with its checkpoint atomically. Reaching the 100-page safety limit yields `SOURCE_INCOMPLETE`; it is never presented as complete.

## Identity and matching

1. Exact: `sourceSystem + externalOrderId/orderId + sourceLineId + format`.
2. Fallback only when date and exact time, Winerim wine id, format, quantity and amount all match and the candidate is unique.
3. A Winerim line is consumed once.
4. Missing source identity, incomplete pagination or stale coverage yields `SOURCE_INCOMPLETE`, not a guessed missing sale.

## Stock and returns

Stock effects are accepted only from Winerim evidence. Returns require a causal link through sale id, sale detail id, receipt id or an explicit sale reference. Time proximity is never sufficient. Multiple exact movements may satisfy one correction when their quantities add up and each movement is internally consistent.

Glass sales are not compared numerically with bottle movements. `stockEffect.status`, `stockApplied` and `unbackedQty` are authoritative; this supports both glasses that do not yet open a bottle and the glass that triggers a bottle deduction.

## External-resolution boundary

The bundled authoritative batch contains exactly 19 SALE cases. Its case fingerprint and candidate target must equal the persisted audit row. Any extra or missing item is `CARDINALITY_CONFLICT`. The closed-client exclusion is seeded by immutable connection id in `reconciliation_v2_connection_exclusions`; execution never depends on a restaurant-name literal. The migration aborts when that stable identity is absent or non-unique. Six DETAIL/glass cases remain `BLOCKED_DETAIL_SCOPE`.

## API cost model

For one active restaurant:

- Incremental sales: one request per page, normally one; maximum 100.
- Stock movements: one request per page, normally one; maximum 100.
- Current stock: one request per 100 stock rows; contract-gated.
- Fleet discovery: one request per fleet page; run sparingly, not every 15 minutes.

Database reads are grouped by restaurant/date and paged in batches. Raw operational/evidence tables are service-role only. The dashboard can read only through the Edge read model, which authenticates the user and validates tenant access before issuing server-side queries. A capped read returns 206 with visible coverage; CSV is refused rather than silently truncated.

Analytics accepts only definitive invoice/refund documents, collapses repeated TPV representations by exact source identity, and treats missing identity/amount as incomplete coverage. A row is `WINE` only when it has a Winerim mapping or an explicit category rule.
