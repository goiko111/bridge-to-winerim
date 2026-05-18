# DECISIONS_LOG

> Append-only. Una decisión por bloque. Formato: fecha · decisión · razón · alternativa descartada.

---

## 2026-05-18 · Desactivar cron `agora-dispatch-restore-stock` y eliminar `restore-stock` del dispatcher
- **Decisión**: `cron.unschedule('agora-dispatch-restore-stock')` (jobid 12) y eliminar el case `"restore-stock"` del `agora-cron-dispatcher` + del tipo `DispatchBody`. La acción `restore-glass-overdiscount` sigue existiendo en `agora-proxy` pero solo se puede invocar manualmente.
- **Razón**: El cron corría cada 5min con `apply: true` y reescribía el stock de Winerim en Sa Vida como `max(0, baseline - allHistoricalSales)`, dejando a 0 los vinos más vendidos cada vez que el cliente los reponía manualmente. Era una herramienta one-shot programada por error como recurrente.
- **Alternativa descartada**: subir el TTL del baseline o filtrar por fecha — sigue siendo destructivo para ajustes manuales del cliente.

---

## 2026-05-18 · Agora Kava no expone ventas en tiempo real → mantener flujo diario + proponer doble cierre
- **Decisión**: Confirmar que la versión de Agora desplegada en Kava SOLO devuelve datos por `/api/export/?filter=Invoices` (tras cierre de caja). Los filtros `Tickets`, `Orders`, `OpenInvoices`, `Receipts` devuelven HTTP 500. Mantener `auto-sync-sales` con scan hasta D-1 y proponer al cliente realizar doble cierre (comida + cena) para tener visibilidad 2 veces/día.
- **Razón**: No existe endpoint público en esta versión de Agora para tickets en curso. Forzar SQL directo al servidor del cliente requiere abrir puertos y rompe el contrato API-only.
- **Alternativa descartada**: (a) acceso SQL Server directo al backend de Agora — alto riesgo operativo y de seguridad; (b) polling especulativo de filtros no documentados — ya probado, devuelve 500.

---

## 2026-05-05 (tarde) · Extraer resiliencia a `_shared/resilience.ts`
- **Decisión**: Mover `fetchWithRetry`/`classifyPosError`/`applyCircuitBreaker` (originales en agora-proxy) a un módulo compartido + añadir `isConnectionPaused` y `preflightCheck`.
- **Razón**: Necesario para extender el patrón a BDP, Revo, Toast, Numier, ICG sin duplicar código.
- **Alternativa descartada**: copiar las funciones en cada proxy (deuda técnica inmediata).

## 2026-05-05 (tarde) · Aplicar SOLO guard de breaker en los 5 proxies (no reemplazar todos los fetch)
- **Decisión**: Añadir `isConnectionPaused` al inicio de cada handler. No reemplazar las llamadas `fetch(...)` internas todavía.
- **Razón**: Cubre el 80% del beneficio (cortar tráfico a un POS pausado) con cambio mínimo y reversible. Reescribir todas las llamadas en 6.3k LOC en una sola sesión es alto riesgo.
- **Alternativa descartada**: refactor masivo de cada proxy para usar `createResilientFetch` (queda como P1 siguiente).

## 2026-05-05 (tarde) · Pre-flight solo en jobs que tocan POS del cliente
- **Decisión**: En `agora-cron-dispatcher` añadir `GET /api/` con timeout 5s solo para `outbound-queue`, `sales-stock`, `restore-stock`. `catalog` queda sin filtro.
- **Razón**: `catalog` también sincroniza Winerim (no solo Agora); aunque el POS esté caído, el lado Winerim debe correr.
- **Alternativa descartada**: pre-flight en todos los jobs.

## 2026-05-05 (tarde) · Panel de salud genérico (no específico de Agora)
- **Decisión**: `ConnectionHealthPanel` recibe solo `connectionId`. Misma componente reutilizable para todos los providers.
- **Razón**: La Capa 3 ya marca a los 5 proxies con la misma semántica de breaker → un panel sirve para todos.
- **Alternativa descartada**: panel específico de Agora (no escalaba al resto).



## 2026-05-05 · Adoptar protocolo de 4 documentos de sesión
- **Decisión**: Trabajar con `PROJECT_CONTEXT.md`, `CURRENT_STATE.md`, `DECISIONS_LOG.md`, `NEXT_STEPS.md` como fuente de verdad. Leerlos al inicio y actualizarlos al cierre de cada sesión.
- **Razón**: Evitar asumir estado no documentado entre sesiones; trazabilidad de decisiones.
- **Alternativa descartada**: confiar solo en memoria del agente (`mem://`) — útil pero no transparente para el humano.

## 2026-05-05 · Cache de `/api/export-master/?filter=Products` (60s TTL)
- **Decisión**: Toda lectura del catálogo Agora pasa por `fetchAgoraProductsXmlCached`.
- **Razón**: Cada tarea de write descargaba ~1MB del XML para verificar → saturaba el SQL pool del cliente (Luruna).
- **Alternativa descartada**: subir el TTL más alto — sacrifica frescura tras escrituras.

## 2026-05-05 · Sistema de resiliencia multicapa para Agora
- **Decisión**: Implementar capas 1 (rate limiter 2 req/s), 2 (clasificador + circuit breaker), 3 (cron rescate zombies). Posponer capas 4 (health-check) y 5 (dashboard).
- **Razón**: Las 3 primeras eliminan el modo de fallo crítico (saturación POS + cola atascada). Las otras dos son QoL.
- **Alternativa descartada**: pausar manualmente las conexiones — no escalable.

## 2026-05-05 · Cleanup masivo de tareas (Sa Vida / Sa Pedrera / Kava)
- **Decisión**: Marcar tareas con "Connection refused" / >10 intentos como `BLOCKED`; zombies `RUNNING >15min` como `FAILED`.
- **Razón**: 11.879 tareas FAILED bloqueaban diagnóstico y consumían reintentos.
- **Alternativa descartada**: dejarlas — generaba ruido permanente.

## 2026-05-05 · Confirmar que las IPs AWS del informe del cliente son nuestras Edge Functions
- **Decisión**: Asumir responsabilidad y arreglar (no esquivar).
- **Razón**: Coincidencia con rangos de Supabase Edge Functions; patrón de carga coherente con nuestro proxy.
