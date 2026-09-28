# Lovable delta v7 — final runtime gates

Apply this delta over commit `1d9f7821333aa14a9c067f308b9577b7074399ae`.

## Corrections

1. Global authorization compares the durable identity available in both sources: case fingerprint plus sale/detail/quantity. Enriched receipt, wine, variant and format fields remain available to the later causal-evidence checks; they are not discarded or fabricated.
2. The 28-day analytics coverage is reported separately in `analytics.coverage` and `metrics.analyticsCoverage`. Historical dashboard rows with an old payload shape no longer mark an otherwise complete daily reconciliation source as incomplete.

## Deployment

Run focused tests, reconciliation typecheck, build and Deno check. Deploy only:

- `run-daily-reconciliation`
- `verify-external-resolution`

Then execute once, `dryRun:true`: global verifier, Clinic 2026-09-26 and Clinic 2026-09-27. Do not migrate, Publish, schedule, map, repair, import sales or modify stock.
