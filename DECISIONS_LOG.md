# DECISIONS_LOG

> Append-only. Una decisión por bloque. Formato: fecha · decisión · razón · alternativa descartada.

---

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
