# Lovable delta v6 — wine scope and audit fingerprints

Apply over deployed v5. No migration and no unrelated changes.

## Confirmed causes

- Clinic 26/09 contains 360 Ágora lines. Provider identity is now available for all 360. Of those, 137 are wine candidates: 28 mapped to Winerim and 109 unmapped. The daily wine reconciler must process the 28 mapped wines, flag the 109 as `AGORA_WINE_MAPPING_INCOMPLETE`, and must not require a Winerim wine id from food or non-wine beverages.
- The 19 authorized reversal cases are the same cases stored in `agora_reversal_audit`, but the fixture used readable composite identities while the database stores their MD5 fingerprints. The fixture now uses the exact persisted fingerprints. Ocean Club remains outside the batch through `reconciliation_v2_connection_exclusions`; six DETAIL cases remain blocked.

## Deployment

Deploy only:

- `run-daily-reconciliation`;
- `verify-external-resolution` (because its shared authorized fixture changed).

Then run exactly once, all `dryRun:true`:

1. global verifier;
2. Clinic 26/09;
3. Clinic 27/09.

Expected:

- global: 19 authorized SALE, one excluded SALE, six DETAIL blocked, no cardinality conflict;
- Clinic 26/09 metrics: 360 source/provider-identified lines, 137 wine candidates, 28 mapped/eligible wines, 109 unmapped wines; incomplete reason is mapping coverage, not provider identity/analytics identity;
- Clinic 27/09 remains `SOURCE_INCOMPLETE` because the source has zero events for that business day;
- zero business writes and no Publish/cron/migration/backfill.

