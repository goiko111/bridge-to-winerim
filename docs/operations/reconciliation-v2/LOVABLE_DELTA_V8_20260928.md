# Lovable delta v8 — authoritative wine classification

Apply over v7. Scope is limited to `run-daily-reconciliation` and its shared Agora reader.

## Defect

Clinic 26/09 contained 109 historical `sales_line_items.is_wine_candidate=true` flags that contradict the current `provider_products` catalogue. All 109 resolve today as explicit `NOT_WINE` (food, water, beer, coffee or cheese). They must not become mappings or block daily wine reconciliation.

## Fix

- Explicit line mapping with `winerim_product_id` remains authoritative wine evidence.
- Otherwise classify with current `provider_products`: `classification_override`, `is_wine_candidate`, then `winerim_wine_id`.
- A current `NOT_WINE` overrides a stale positive sales-line flag.
- If the current catalogue row is missing while the historical line says wine, classify `UNKNOWN` and fail closed with `AGORA_WINE_CLASSIFICATION_INCOMPLETE`.
- Report `unknownWineClassificationLines` separately.

## Expected Clinic 26/09 dry-run

- `sourceLines=360`
- `providerIdentifiedLines=360`
- `wineCandidateLines=28`
- `mappedWineLines=28`
- `unmappedWineLines=0`
- `unknownWineClassificationLines=0`
- no `AGORA_WINE_MAPPING_INCOMPLETE`
- daily completeness may still be false solely for absent Winerim/stock coverage.

## Guardrails

Deploy only `run-daily-reconciliation`. Invoke Clinic 26/09 exactly once with `dryRun:true`. No migration, Publish, cron, mappings, repairs, backfill, sales or stock writes. Compare sensitive-table counters before and after.
