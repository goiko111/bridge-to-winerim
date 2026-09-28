# Deployment handoff for Lovable

Target Supabase project: `csiertktrefwewsmequr`.

## Invariants

- Audit-only. Do not add sale, stock, history, queue or mapping writes.
- Do not touch the existing Ágora writer or its scheduler.
- Do not infer external order ids by prefix or recreate legacy identities.
- Do not reactivate the closed-client connection. Preserve the stable-id row in `reconciliation_v2_connection_exclusions`; do not add name-based logic.
- Do not unblock the six DETAIL/glass cases.
- Do not replace RLS reads with service-role data returned indiscriminately to the browser.

## Apply order

1. Inspect the migration against the existing schema names listed in `CONTRACT_GAPS.md`.
2. Apply `supabase/migrations/20260928000100_reconciliation_v2.sql` once.
3. Add secrets/variables by name only:
   - `WINERIM_FLEET_READ_TOKEN` — Winerim `wfk_` read token.
   - `EDGE_ALLOWED_ORIGINS` — comma-separated exact UI origins.
   - Standard Supabase Edge variables (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).
   - Keep `WINERIM_STOCK_CONTRACT_ACK` unset until the stock contract gate is resolved.
4. Deploy these functions without invoking them yet:
   - `winerim-fleet-reader` (sustituye la versión parcial anterior; solo descubrimiento y bindings explícitos)
   - `sync-sales-records`
   - `sync-stock-movements`
   - `refresh-current-stock`
   - `run-daily-reconciliation`
   - `read-reconciliation-results`
   - `verify-external-resolution`
5. Merge `src/features/daily-reconciliation`, then apply the supplied additions directly to the real `src/App.tsx` and `src/components/Layout.tsx`. Do not create or use `src/middleware-main.tsx`.
6. Merge only the three scripts from `package.reconciliation.merge.json` into the existing `package.json`; never replace the project file or remove existing Cloudflare/Wrangler scripts and dependencies.
7. Run the pre-migration section of `PREDEPLOY_CHECKS.sql`; the stable exclusion identity must return exactly one match. Apply the migration, then run its post-migration sections.
8. Invoke `winerim-fleet-reader` with `{"dryRun":true}`. Confirm the dynamic fleet; do not expect a fixed count.
9. Select one active non-excluded connection and invoke `sync-sales-records`, `sync-stock-movements` and `run-daily-reconciliation` with `dryRun:true`.
10. Confirm that no operational table changed and all responses say `mode:AUDIT_ONLY`.
11. Run `verify-external-resolution` with `dryRun:true`; require authoritative count 19 and no cardinality conflict. DETAIL remains blocked.
12. Only after review, repeat the evidence ingestion functions with `dryRun:false`. This writes local evidence/checkpoints only.
13. Deploy the UI once and run the smoke checklist below.
14. Do not activate scheduling in this deployment. Use the inert template in `supabase/scheduler/reconciliation_v2_schedule.example.sql` only after two complete manual cycles on different business days return PASS.

## Smoke checklist

- Platform admin sees the fleet; a restaurant user can read only an assigned connection through the Edge function.
- Changing `connectionId` to another tenant returns HTTP 403. Direct browser SELECT on raw sales/movements/checkpoints is denied.
- Revenue cards equal category totals; shares total 100% excluding zero-revenue periods.
- Wine/other beverages/food/unclassified are distinct.
- Ágora/Winerim line table exposes state, reference, format, invoice, time, units and amount.
- CSV and JSON exports contain only the authorized restaurant and period.
- A capped page run returns HTTP 206 and `SOURCE_INCOMPLETE`.
- A truncated read returns HTTP 206 with `readCoverage.complete=false`; CSV refuses to emit a partial export.
- Missing or invalid fleet token fails in a controlled way.
- Current stock returns `STOCK_CONTRACT_NOT_ACKNOWLEDGED` while its gate is unset.
- Existing writer, claims, queues, mappings and scheduler show no regression.
- Manual cycle 1 and cycle 2 (different closed business days) both show: complete sales incremental pass, complete 24-hour overlap, complete movements pass, stable idempotent row counts on rerun and no cursor regression.

## Rollback

1. Disable any separately created schedules.
2. Roll back the UI route and functions.
3. Export reconciliation evidence if retention is desired.
4. Execute `docs/operations/proposed-migrations/20260928000100_reconciliation_v2.rollback.sql`.
5. Verify that the existing operational writer and scheduler remain unchanged.

## Final prompt for Lovable

> Aplica el ZIP completo de Reconciliation v3 al proyecto Supabase `csiertktrefwewsmequr` siguiendo exactamente `docs/operations/reconciliation-v2/DEPLOYMENT_HANDOFF_LOVABLE.md`. No rediseñes la solución ni reutilices el paquete parcial anterior. Mantén todo `AUDIT_ONLY`: no añadas importaciones de ventas, cambios de stock, reparaciones, mutaciones de cola o cambios en el writer/scheduler de Ágora. Comprueba primero los nombres del esquema existente y la RLS; valida la identidad estable de exclusión, aplica la migración una sola vez, despliega las siete Edge Functions, integra la pantalla en `src/App.tsx`/`src/components/Layout.tsx` y ejecuta únicamente los dry-runs y smoke tests indicados. La conexión excluida debe seguir inerte por su UUID persistido; los seis casos DETAIL/copas siguen bloqueados; el lote externo autorizado debe ser exactamente 19 o responder `CARDINALITY_CONFLICT`. Mantén `/api/v2/stock` deshabilitado hasta resolver su paridad contractual. No reemplaces `package.json`: fusiona solo `package.reconciliation.merge.json`. Si todo pasa, realiza un único despliegue final y entrégame hashes, resultados de pruebas, migración aplicada, funciones desplegadas, URL de la pantalla y confirmación explícita de que el writer operativo no cambió.
