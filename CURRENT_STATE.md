# CURRENT_STATE

> Estado vivo del proyecto. Actualizar en cada sesión (y durante si hay cambios significativos).

_Última actualización: 2026-05-05_

## Hechos (qué está desplegado y verificado)

### Sistema de resiliencia Agora (activo)
- **Cache XML productos** (`fetchAgoraProductsXmlCached`, TTL 60s) en `agora-proxy/index.ts`. Reduce descargas del catálogo Agora ~10x (~600/h → ~60/h por conexión).
- **Rate limiter** por `connection_id`: máx **2 req/s** dentro de `fetchWithRetry`.
- **Clasificador de errores** (`classifyPosError`): `POS_DOWN` | `POS_OVERLOADED` | `BUSINESS_ERROR`.
- **Circuit breaker** (`applyCircuitBreaker`):
  - `POS_DOWN` → pausa 60 min tras 5 fallos consecutivos.
  - `POS_OVERLOADED` → pausa 15 min tras 10 fallos consecutivos.
  - Se respeta en `agora-cron-dispatcher` (filtra por `circuit_breaker_paused_until`).
- **Cron rescate de zombies**: `rescue_zombie_outbound_tasks()` cada 10 min marca `RUNNING > 15 min` como `FAILED`.

### Limpieza realizada
- 43 tareas zombie liberadas.
- ~11.500 tareas redundantes/fallidas (Sa Vida / Sa Pedrera / Kava) marcadas como `BLOCKED` o `FAILED`.

### Estado por conexión Agora
- **Luruna**: operativo. Sin saturación de SQL pool.
- **Sa Vida / Sa Pedrera**: con "Connection refused" — POS local probablemente apagado. Se autorrecuperarán al primer task OK.
- **Kava**: ver últimas tareas.

## Decisiones recientes
Ver `DECISIONS_LOG.md`.

## Hipótesis abiertas
- Las IPs AWS reportadas por el cliente Agora corresponden a Edge Functions de Supabase — **confirmado**, ya no es hipótesis.
- Con cache + rate limit + breaker no debería volver a saturarse el SQL pool del cliente. **Pendiente de validar 7 días sin incidentes.**

## Riesgos / pendientes de monitorizar
- Capa 4 (pre-flight health-check ligero) no implementada.
- Capa 5 (dashboard estado conexiones en tiempo real) no implementada.
- Otros proveedores (BDP, Revo, Toast, etc.) NO tienen aún el patrón rate-limit + breaker. No auditados aún.

## Estado documentos
- `PROJECT_CONTEXT.md`: creado.
- `CURRENT_STATE.md`: este archivo, creado.
- `DECISIONS_LOG.md`: creado con histórico reciente.
- `NEXT_STEPS.md`: creado.
