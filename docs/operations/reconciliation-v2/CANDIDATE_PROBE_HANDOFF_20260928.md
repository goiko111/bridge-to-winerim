# Candidate probe handoff — 2026-09-28

Base Lovable commit audited: `961116a68f7e3b97f2e266ba3bc0652fc0532109`.

## Scope

This delta closes only the pre-binding identity loop. It extends `winerim-fleet-reader` with the fixed action `VERIFY_CANDIDATE_SALES`.

- Server-side platform-admin authentication is mandatory.
- The only upstream business resource is `GET /api/v2/sales/records` through the existing fixed client route `/sales/records`.
- The candidate `restaurantId` must occur exactly once in a complete live `/restaurants` discovery.
- The request accepts exactly `action`, `connectionId`, `restaurantId` and `businessDay`.
- `businessDay` must be a complete, closed local day. The function derives the next day and follows every page, bounded by the existing `MAX_PAGES=100` fail-closed limit.
- It returns normalized evidence only. It omits table text, arbitrary source fields, raw objects, tokens and authorization headers.
- It never persists sales, movements, bindings or checkpoints.
- Its private audit stores only actor, target, date, outcome, page/record counts, an evidence hash and a sanitized error code.
- Rate limit: one probe per admin/restaurant per 60 seconds and at most ten per admin per hour, enforced atomically in PostgreSQL.

## Files

- `supabase/functions/_shared/reconciliation-v2/candidateProbe.ts`
- `supabase/functions/winerim-fleet-reader/index.ts`
- `supabase/migrations/20260928000200_candidate_probe.sql`
- `docs/operations/proposed-migrations/20260928000200_candidate_probe.rollback.sql`
- `src/test/candidateProbe.test.ts`
- `src/test/reconciliationGuards.test.ts`
- `tsconfig.reconciliation.json`
- `package.reconciliation.merge.json`
- `package.json` only adds the candidate test to `test:reconciliation`; preserve every other destination script.

## Verified locally

- `npm run test:reconciliation`: 58/58 PASS.
- `npm run typecheck:reconciliation`: PASS.
- `npm run build:reconciliation`: PASS; existing non-blocking 800 kB preview warning.

## Platform-only application

1. Verify the current Lovable commit has not changed in the touched files. Stop on drift.
2. Apply the additive migration once.
3. Deploy only `winerim-fleet-reader`; no frontend Publish and no cron.
4. Run the Deno check for the reader and its shared imports.
5. Invoke once as a platform admin:

```json
{
  "action": "VERIFY_CANDIDATE_SALES",
  "connectionId": "1c5177f1-9459-4ee9-8b6e-4780f8b6b96b",
  "restaurantId": 346,
  "businessDay": "2026-09-27"
}
```

6. Compare the normalized evidence with definitive Ágora lines for Clinic on 27/09. Do not use the name alone or ambiguous aggregates.
7. The binding currently exists because it was created in an earlier authorized Lovable run. Do not create another. If evidence contradicts identity, disable that one binding and stop; otherwise update only `verified_via`/`verified_at` to record the candidate-sales proof after explicit review.
8. Keep cron, `/stock`, auto-repair, reversals and Publish disabled.

## Rollback

Deploy the previous `winerim-fleet-reader`, then apply `20260928000200_candidate_probe.rollback.sql`. The rollback removes only this audit table and its rate-limit function.
