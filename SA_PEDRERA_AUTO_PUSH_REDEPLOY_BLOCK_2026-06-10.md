# Sa Pedrera - auto-push pausado por deploy pendiente - 2026-06-10

## Hechos
- Conexion: `Sa Pedrera` (`e2f6ce27-0e94-444f-9d64-09ba425a2b83`).
- Objetivo de la sesion: reactivar con seguridad el auto-push de catalogo Winerim -> Agora despues de validar que el runtime de Lovable Cloud salta vinos/formats ya verificados.
- El codigo correcto ya esta en GitHub `main`; se hizo push del commit `ae9850c` (`Trigger Sa Pedrera auto-push guard redeploy`) para forzar redeploy de `agora-proxy` y `winerim-proxy`.
- Verificacion live repetida contra Lovable Cloud usando `agora-proxy` / `evaluate-auto-push` con el vino ya verificado `249018` (`T220- Elio Grasso Barbera d'Alba Vigna Martina`):
  - Esperado: `queued=0` y razon `create_skipped:formats_already_verified`.
  - Observado tres veces: `queued=1` con `_trigger_source=AUTO_CREATE`.
- Tareas creadas por las sondas y bloqueadas inmediatamente para que no toquen Agora:
  - `b69fc6ed-c54e-4837-aff4-6d21e546db61`.
  - `de8375c7-f155-41bd-b6cf-63cdc9c5df3a`.
  - `36b92b57-e448-4f3e-8810-14ba0e625d81`.
- Estado final verificado:
  - `auto_push_on_create=false`.
  - `auto_push_on_update=false`.
  - `auto_push_verified_ready=true`.
  - `enabled=true`, `catalog_sync_enabled=true`, `write_mode=XML_IMPORT`.
  - Tareas activas Sa Pedrera: `0 QUEUED / 0 RUNNING`.
- La CLI local de despliegue no puede desplegar Edge Functions porque no hay `SUPABASE_ACCESS_TOKEN`/token de deploy disponible en el entorno.

## Decision
- No reactivar `auto_push_on_create` ni `auto_push_on_update` en Sa Pedrera hasta que Lovable Cloud ejecute la version nueva de las Edge Functions y la sonda live devuelva `create_skipped:formats_already_verified`.

## Riesgos
- Si se reactivan los flags con el runtime actual, Lovable Cloud volvera a generar tandas `AUTO_CREATE` para vinos ya publicados, pudiendo reimportar productos y tocar Agora sin necesidad.
- Mientras los flags esten apagados, altas nuevas y cambios de precio/nombre en Winerim no suben automaticamente a Agora para Sa Pedrera.

## Rollback / seguridad
- No se ha tocado la configuracion visual de Agora ni los productos del cliente.
- Las tres tareas de prueba estan `BLOCKED`; no deben reintentarse.
- Para volver al estado seguro, mantener:
  - `auto_push_on_create=false`.
  - `auto_push_on_update=false`.

## Siguiente paso exacto
1. Redesplegar en Lovable Cloud las Edge Functions `agora-proxy` y `winerim-proxy`.
2. Repetir `evaluate-auto-push` sobre el vino `249018`.
3. Solo si devuelve `queued=0` + `create_skipped:formats_already_verified`, probar `winerim-proxy fetch-catalog` y comprobar `autoPushResult.reason=no_catalog_changes_detected` o `autoPushResult.differential=true`.
4. Entonces reactivar `auto_push_on_create=true` y `auto_push_on_update=true` en Sa Pedrera.
