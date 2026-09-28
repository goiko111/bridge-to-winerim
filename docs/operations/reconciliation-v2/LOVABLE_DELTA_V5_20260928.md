# Lovable delta v5 — Ágora persisted shape and excluded SALE

Apply this delta over the already deployed reconciliation v4. Do not repeat migrations or deploy unrelated functions.

## Changes

1. `agoraReader.ts` accepts both the normalized camel-case fixture and the real Ágora payload persisted by Lovable:
   - closed invoices: `InvoiceItems[].Lines[]`;
   - open tickets: `Lines[]`;
   - Pascal-case provider fields such as `ProductId`, `CreationDate`, `Index` and `TotalAmount`.
2. Provider line identity is derived only from provider evidence: explicit `lineId`, or `GlobalId + Index`. Local Supabase UUIDs are never used as TPV identities.
3. Fully discounted lines match against the gross price evidence, while the reconciler and analytics retain Ágora's net `TotalAmount`.
4. The global verifier excludes only connections listed in `reconciliation_v2_connection_exclusions`. The extra twentieth SALE is Ocean Club (`706b952e-767d-41af-9cba-8e225b16a877`), already excluded as `client_closed`. The authorized set remains exactly 19 SALE and 6 DETAIL blocked.

## Verified before handoff

- Clinic 26/09 actual payload: 360 persisted lines; 358 exact matches plus two discounted non-wine lines. The new gross-evidence rule resolves those two without weakening product, quantity, timestamp or name matching.
- Reconciliation tests: 78/78 PASS.
- Reconciliation typecheck: PASS.
- Reconciliation production build: PASS.
- `git diff --check`: PASS.

## Deployment scope

Deploy only:

- `run-daily-reconciliation` (including updated shared `agoraReader.ts`);
- `verify-external-resolution` (including its existing shared dependencies).

Do not Publish the frontend. Do not run migrations. Do not enable cron, `/stock`, repair, backfill or any sales/stock writer.

After deployment, run once:

1. global verifier with `dryRun:true`: expected 19 authorized SALE, 1 excluded SALE and 6 DETAIL blocked;
2. Clinic `run-daily-reconciliation` for 26/09 and 27/09 with `dryRun:true`;
3. prove zero rows added to sales, stock movements, checkpoints, reconciliation executions/results and zero scheduled tasks.

