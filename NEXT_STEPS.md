# NEXT_STEPS

> Tareas pendientes priorizadas. Al retomar: leer este archivo + `CURRENT_STATE.md`.

## P0 — Validación
- [ ] Monitorizar 7 días (Agora): invocaciones a `/api/export-master`, breaker activations, zombies rescatados.
- [ ] Confirmar con Luruna que no ven más IPs AWS saturando su SQL Server.
- [ ] Verificar que Sa Vida / Sa Pedrera reanudan al volver el POS.
- [ ] Probar manualmente el guard de breaker: pausar una conexión BDP/Revo/Numier/ICG/Toast vía SQL y comprobar que el proxy devuelve 503 `CIRCUIT_BREAKER_OPEN`.
- [ ] Probar el panel `ConnectionHealthPanel` en preview con la conexión Luruna.

## P1 — Completar Capa 3 en cada proxy
- [ ] Reemplazar `fetch(...)` internos por `createResilientFetch(connectionId)` en:
  - [ ] bdp-proxy (1904 LOC, ~8 fetch)
  - [ ] revo-proxy (1704 LOC) — ya tiene su `revoFetch` con rate 120 req/min; valorar si unificar.
  - [ ] toast-proxy (881 LOC) — tiene `fetchWithRetry` propio + breaker en `provider_config`. Decidir unificación.
  - [ ] numier-proxy (1022 LOC, ~10 fetch)
  - [ ] icg-proxy (664 LOC)
- [ ] En cada uno: tras error de fetch, llamar `classifyPosError` + `applyCircuitBreaker`. Tras éxito, llamar `resetFailureCounter`.

## P1 — Panel salud en otros wizards
- [ ] Montar `<ConnectionHealthPanel connectionId={...} />` en BdpWizard, RevoWizard, ToastWizard, NumierWizard, IcgWizard, CloverWizard, SimphonyWizard, SquareWizard, CassaWizard, TcposWizard, HioposWizard, TouchBistroWizard.

## P2 — Mejoras
- [ ] Métricas históricas (tabla `proxy_metrics`) en lugar de depender de logs.
- [ ] Alertas automáticas cuando una conexión queda en breaker >2h.
- [ ] Vista "fleet status" en `/integrations` con un `ConnectionHealthPanel` por cada conexión activa.

## Bloqueos / esperando
- (ninguno)

## Notas
- Cron `rescue-zombie-outbound-tasks` corre cada 10 min.
- El módulo compartido vive en `supabase/functions/_shared/resilience.ts`. Importar con ruta relativa `../_shared/resilience.ts`.
- Toast tiene su propio breaker en `provider_config.circuit_breaker` — el global lo respeta porque actualiza `pos_connections.circuit_breaker_paused_until`. Convivencia OK pero no ideal.
