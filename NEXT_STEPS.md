# NEXT_STEPS

> Tareas pendientes priorizadas. Al retomar: leer este archivo + `CURRENT_STATE.md`.

## P0 — Validación post-incidente Agora
- [ ] Monitorizar 7 días: número de invocaciones a `/api/export-master`, activaciones de circuit breaker, tareas zombie rescatadas.
- [ ] Confirmar con cliente Luruna que ya no ven IPs AWS saturando su SQL Server.
- [ ] Verificar que Sa Vida / Sa Pedrera reanudan al volver el POS.

## P1 — Extender resiliencia
- [ ] **Capa 4**: pre-flight health-check ligero (`GET /api/master-data` con timeout 5s) antes de procesar batch outbound.
- [ ] **Capa 5**: dashboard en `/integrations/agora` mostrando estado en tiempo real (último OK, breaker activo, tareas en cola, fallos 24h).
- [ ] Auditar otros proxies (BDP, Revo, Toast, Numier, ICG) buscando patrones similares: descargas redundantes de catálogo, ausencia de rate limit, ausencia de breaker.

## P2 — Mejoras
- [ ] Métricas Prometheus-style o tabla `proxy_metrics` para no depender de logs.
- [ ] Alertas automáticas cuando una conexión queda en breaker >2h.

## Bloqueos / esperando
- (ninguno)

## Notas para retomar
- Cron `rescue-zombie-outbound-tasks` corre cada 10 min.
- Cache XML Agora vive en memoria del worker → no persiste entre cold starts (es OK).
