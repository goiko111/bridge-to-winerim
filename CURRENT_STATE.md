# CURRENT_STATE

> Estado vivo del proyecto. Actualizar en cada sesión (y durante si hay cambios significativos).

_Última actualización: 2026-05-05 (sesión tarde)_

## Hechos (qué está desplegado y verificado)

### Sistema de resiliencia Agora (activo, sin cambios)
- Cache XML productos `fetchAgoraProductsXmlCached` (TTL 60s).
- Rate limiter 2 req/s por `connection_id`.
- Clasificador `classifyPosError` y `applyCircuitBreaker` (POS_DOWN 60min / POS_OVERLOADED 15min).
- Cron `rescue_zombie_outbound_tasks()` cada 10 min.

### Capa 3 — Resiliencia compartida (NUEVO, desplegado)
- Nuevo módulo `supabase/functions/_shared/resilience.ts` exportando:
  - `createResilientFetch(connectionId)` — throttle 2 req/s + retry + timeout.
  - `classifyPosError`, `applyCircuitBreaker`, `resetFailureCounter`.
  - `isConnectionPaused(supabase, connectionId)` — guard reusable.
  - `preflightCheck(url, init, timeoutMs)` — sonda de alcance.
- Guard `isConnectionPaused` integrado en handlers principales de:
  - `bdp-proxy` (tras validar connectionId)
  - `revo-proxy` (tras cargar conexión)
  - `toast-proxy` (tras leer payload, salvo `store-credentials`)
  - `numier-proxy` (tras validar connectionId)
  - `icg-proxy` (tras cargar conexión)
- Si la conexión está pausada por breaker, los proxies devuelven HTTP 503 con `code: CIRCUIT_BREAKER_OPEN`.

### Capa 4 — Pre-flight en agora-cron-dispatcher (NUEVO, desplegado)
- Para jobs `outbound-queue`, `sales-stock` y `restore-stock`, antes de despachar se hace `GET <baseUrl>/api/` con timeout 5s por conexión.
- Conexiones inalcanzables se saltan en este ciclo y se reportan en `skippedByPreflight`.
- Job `catalog` no se filtra (Winerim siempre debe sincronizarse aunque el POS esté caído).

### Capa 5 — Panel de salud por conexión (NUEVO)
- Nuevo componente `src/components/ConnectionHealthPanel.tsx` (genérico, multi-provider).
- Métricas: estado (Healthy/Degraded/Disabled/Circuit breaker open), último sync, queued, running, failed 24h, blocked, consecutive failures, último error.
- Auto-refresh 15s.
- Renderizado en `AgoraWizard` justo bajo el header cuando hay `connectionId`.
- Reusable: cualquier wizard de otro provider puede importarlo y pasarle `connectionId`.

## Hipótesis abiertas
- Resiliencia extendida cubre el caso de saturación si el cliente reabre el problema. Falta validar en producción real con BDP/Revo/Toast/Numier/ICG (todavía sin clientes activos saturando).
- 7 días sin incidente Agora aún por confirmar (llevamos ~1 día).

## Riesgos / pendientes
- Los proxies aplicados solo tienen el guard de breaker, NO usan aún `createResilientFetch` en sus llamadas internas. Próxima iteración: reemplazar `fetch(...)` por la versión throttle dentro de cada proxy.
- Toast tiene su propio breaker alternativo en `provider_config.circuit_breaker` — coexiste con el global. Decidir si unificar.

