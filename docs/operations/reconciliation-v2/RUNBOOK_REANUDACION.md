# Runbook de reanudación · Reconciliation v3 (AUDIT_ONLY)

Estado: todo implementado y probado con fixtures. Cron nuevo OFF (`supabase/scheduler/reconciliation_v2_schedule.example.sql` es inerte). `WINERIM_STOCK_CONTRACT_ACK` sin definir: `/api/v2/stock` bloqueado.

## Discrepancia de contrato
La documentación HTML vigente incluye `/restaurants` y `/stock`; el OpenAPI JSON antiguo no. Cliente, tipos y fixtures de `/stock` están completos, pero la ruta queda protegida hasta un readback real y ACK explícito.

## Pasos (en orden, sin saltar)
1. Introducir `WINERIM_FLEET_READ_TOKEN` en el formulario seguro de Lovable (nunca en chat).
2. `winerim-fleet-reader` con `dryRun=true`: comprobar que el restaurante activo aparece y Ocean Club (UUID 706b952e-767d-41af-9cba-8e225b16a877) sigue excluido.
3. Dos días de negocio cerrados, un restaurante activo: `sync-sales-records`, `sync-stock-movements`, `run-daily-reconciliation` con `dryRun=true`. Anotar páginas y llamadas.
4. Readback: cardinalidad exacta 19 SALE / 6 DETAIL (DETAIL bloqueados); otra cifra = CARDINALITY_CONFLICT → parar.
5. Paginación real (hasMore hasta false) e idempotencia (repetir el día: 0 inserciones nuevas).
6. Verificar cola = 0, auditoría = 220, cron nuevo = 0, writer/mappings/ventas/stock sin cambios.
7. Pedir GO expreso y hacer una única publicación.

## Rollback
`supabase/rollback/20260928000100_reconciliation_v2.rollback.sql` (validado en bloque atómico no destructivo). Los módulos nuevos (`closure.ts`, panel de referencias) son puros y se retiran borrando archivos.
