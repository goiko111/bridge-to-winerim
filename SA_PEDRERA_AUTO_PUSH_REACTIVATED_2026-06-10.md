# Sa Pedrera - auto-push reactivado - 2026-06-10

## Hechos
- Conexion: `Sa Pedrera` (`e2f6ce27-0e94-444f-9d64-09ba425a2b83`).
- Lovable Cloud confirmo redeploy de `agora-proxy` y `winerim-proxy` a la ultima version de `main`.
- Lovable Cloud valido sonda dry-run con `forceEvaluate:true` sobre el vino `249018`; resultado esperado:
  - `queued=0`.
  - `wouldQueue=0`.
  - `create_skipped:formats_already_verified`.
  - Sin escrituras.
- Se ejecuto `winerim-proxy` / `fetch-catalog` con `auto_push_on_create=false` y `auto_push_on_update=false`:
  - `success=true`.
  - `totalWines=401`.
  - Primer lote: `newWines=0`, `changedWines=24`.
  - `autoPushResult.differential=true`, `createCandidates=0`, `updateCandidates=24`, `parts=[]`.
  - No se encolo nada porque los flags seguian apagados.
- Se espero a que la cadena de refresco de catalogo quedara estable:
  - `417` filas tocadas desde el inicio del refresco.
  - Ultimo `updated_at` observado estable: `2026-06-10T12:11:26.742133+00:00`.
  - Cola abierta durante el refresco: `0 QUEUED / 0 RUNNING`.
- Se activaron flags finales:
  - `auto_push_on_create=true`.
  - `auto_push_on_update=true`.
  - `auto_push_verified_ready=true`.
- Sonda normal post-activacion, sin `forceEvaluate`, contra `249018`:
  - `queued=0`.
  - `wouldQueue=0`.
  - `skipped=1`.
  - Incluye `create_skipped:formats_already_verified`.
  - No creo tareas.
- Vigilancia posterior durante ~1 minuto:
  - Flags siguen encendidos.
  - Tareas activas: `0 QUEUED / 0 RUNNING`.
  - No hubo nuevos movimientos de cache.

## Decision
- Reactivar el automatico de catalogo Winerim -> Agora para Sa Pedrera (`auto_push_on_create/update=true`) tras validar runtime actualizado, diferencial activo y cola estable.

## Riesgos
- Si Winerim cambia muchos precios/nombres a la vez, el proximo cron puede crear una tanda legitima de `AUTO_UPDATE`; se debe vigilar el primer ciclo automatico.
- El automatico no resuelve por si solo ventas legacy sin mapping confirmado; eso sigue siendo otra linea de trabajo.

## Rollback
- Si aparece una tanda inesperada o el cliente reporta impacto visual, volver a:
  - `auto_push_on_create=false`.
  - `auto_push_on_update=false`.
- No reintentar las tareas bloqueadas de sonda del 2026-06-10.

## Siguiente paso
- Vigilar el proximo ciclo de cron de catalogo en Sa Pedrera: debe permanecer sin cola masiva salvo cambios reales de Winerim.
- Probar una venta real de botella y copa desde familias Winerim y validar `sales_line_items.mapped=true` + `stock_sync_log.SUCCESS`.

## Seguimiento 2026-06-10 14:20 CEST
- Primer ciclo real tras activar:
  - `3` tareas `AUTO_CREATE`.
  - `processed=3`, `succeeded=3`, `failed=0`, `remaining=0`.
  - Cola final: `0 QUEUED / 0 RUNNING`.
- Vinos publicados/verificados:
  - `105908` — `Egly-Ouriet 'Les Prémices'` → Agora `605908`.
  - `175356` — `T213-Saint-Émilion Grand Cru` → Agora `675356`.
  - `205597` — `B437- Château Beauregard` → Agora `705597`.
- Los 3 quedaron `VERIFIED` en `winerim_push_tracking` y `CONFIRMED` en `product_mappings`.
- Se limpio `last_sync_error` antiguo de `205597` porque era stale tras publicacion correcta.
