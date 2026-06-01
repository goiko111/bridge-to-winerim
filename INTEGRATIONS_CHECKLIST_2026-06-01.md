# Checklist integraciones — 2026-06-01

> Foto operativa de Lovable Cloud tomada en modo lectura el 2026-06-01 06:26 CEST. No contiene credenciales.

## Resumen ejecutivo

- Conexiones reales en `pos_connections`: 8.
- Proveedores configurados en producción: solo `agora`.
- Conexiones Agora activas: 7.
- Conexiones Agora deshabilitadas: 1 (`Baco Getafe`, rollback legacy).
- Proxies/wizards existentes pero sin conexión productiva registrada: BDP NET, Revo, Toast, Numier, Clover, Simphony, ICG, HIOPOS, TCPOS, Square, Cassa, TouchBistro.
- Endpoint ligero Agora `export-master Families`:
  - Responde `200`: Baco, Katsu, Kava, La Candela, Luruna, Cienvinos, Sa Pedrera.
  - Responde `501`: Sa Vida.
- Stock Winerim global:
  - Históricos: `SUCCESS=809`, `BLOCKED=367`, `FAILED=203`.
  - Fallos nuevos últimos 7 días: `0`.
  - Fallos nuevos últimas 24h: `0`.
- Cola outbound global:
  - `QUEUED=1870`, `RUNNING=0`, `FAILED=3633`, `BLOCKED=2063`, `SUCCESS=89227`.
  - La cola abierta se concentra en Sa Vida, Sa Pedrera, Kava, Luruna y Cienvinos.

## Checklist por conexión Agora

### Baco Getafe

- Estado: deshabilitada a propósito.
- Motivo: rollback a legacy el 2026-05-29.
- POS Agora: responde `Families` con `200` y 48 familias.
- Lovable Cloud:
  - `enabled=false`.
  - `catalog_sync_enabled=false`.
  - `write_mode=NONE`.
  - `auto_push_on_create=false`.
  - `auto_push_on_update=false`.
  - `auto_push_verified_ready=false`.
- Catálogo Winerim cacheado: 95 vinos; stockIds: 83 botella, 21 copa, 19 magnum.
- Tracking: 118 productos Winerim marcados `HIDDEN`; 167 `NOT_PUSHED`.
- Mappings: 118 `CONFIRMED`, pero no deben usarse mientras la conexión está deshabilitada.
- Cola outbound abierta: 0.
- Stock: 41 `SUCCESS` históricos; sin fallos recientes.
- Conclusión: correcto como rollback. No reactivar automático sin nuevo piloto controlado.

### Restaurante Cienvinos Ecija

- Estado: activa.
- POS Agora: responde `Families` con `200` y 8 familias.
- Cursor ventas: `last_business_day_synced=2026-05-27`.
- Último chequeo: `last_sync_at=2026-05-28T05:54:58.655Z`.
- Capacidades: `READY`, `write_mode=XML_IMPORT`, pero `can_write_products=UNKNOWN` por degradación visual pendiente de confirmar tras redeploy.
- Auto catálogo:
  - `catalog_sync_enabled=true`.
  - `auto_push_on_create=true`.
  - `auto_push_on_update=false`.
  - `auto_push_verified_ready=true`.
- Catálogo Winerim: 395 vinos; stockIds: 372 botella, 49 copa, 7 magnum.
- Mappings: 428 `CONFIRMED`.
- Tracking: 91 `VERIFIED`, 337 `PUSHED`.
- Ventas guardadas: 0.
- Stock logs: 0.
- Cola outbound abierta: 85 `QUEUED` (`AGORA_XML_UPSERT_PRODUCT`).
- Riesgo: conexión activa pero sin ventas/cierres detectados y con 85 updates pendientes.
- Siguiente acción: drenar o revisar las 85 tareas, confirmar que el cron/redeploy actual respeta `auto_push_on_update=false`, y validar primer cierre real con producto Winerim.

### Katsu Izakaya

- Estado: activa.
- POS Agora: responde `Families` con `200` y 42 familias.
- Cursor ventas: `last_business_day_synced=2026-05-30`.
- Último chequeo: `last_sync_at=2026-05-31T00:00:14.910Z`.
- Capacidades: `NOT_CONNECTED`, `write_mode=NONE`, `can_write_products=UNKNOWN`.
- Auto catálogo:
  - `catalog_sync_enabled=true`.
  - `auto_push_on_create=true`.
  - `auto_push_on_update=true`.
  - `auto_push_verified_ready=false`.
- Catálogo Winerim: 94 vinos; stockIds: 37 botella, 37 copa, 1 magnum.
- Mappings: 40 `CONFIRMED`, 28 `REJECTED`.
- Tracking: 40 `VERIFIED`, 28 `FAILED`.
- Ventas guardadas: 803 totales; 114 últimos 7 días.
- Stock: 1 `FAILED` histórico; 0 fallos recientes; 0 `SUCCESS` en últimos 7 días.
- Cola outbound abierta: 0.
- Riesgo: ventas entran, pero la capacidad de escritura sigue marcada como no conectada y no hay validación reciente de stock.
- Siguiente acción: verificar escritura XML/import actual y, si procede, restaurar `provider_capabilities` a `READY/XML_IMPORT`; validar una venta Winerim real.

### Kava

- Estado: activa.
- POS Agora: responde `Families` con `200` y 93 familias.
- Cursor ventas: `last_business_day_synced=2026-05-30`.
- Último chequeo: `last_sync_at=2026-05-31T00:00:11.105Z`.
- Capacidades: `READY`, `write_mode=XML_IMPORT`, `can_write_products=UNKNOWN`.
- Auto catálogo:
  - `catalog_sync_enabled=true`.
  - `auto_push_on_create=true`.
  - `auto_push_on_update=true`.
  - `auto_push_verified_ready=true`.
- Catálogo Winerim: 211 vinos; stockIds: 203 botella, 19 copa, 1 magnum.
- Mappings: 255 `CONFIRMED`, 12 `REJECTED`, 37 `PENDING`.
- Tracking: 195 `VERIFIED`, 28 `QUEUED`, 5 `HIDDEN`, 1 `FAILED`, 4 `NOT_PUSHED`.
- Ventas guardadas: 236 totales; 17 últimos 7 días.
- Stock: 104 `SUCCESS`, 26 `BLOCKED`, 13 `FAILED` históricos; 53 `SUCCESS` últimos 7 días; 0 fallos recientes.
- Cola outbound abierta: 220 (`204 QUEUED`, `7 FAILED`, `9 BLOCKED`).
- Riesgo: el flujo de ventas/stock funciona, pero hay cola de catálogo pendiente y mappings pendientes.
- Siguiente acción: revisar/drenar 220 tareas y resolver 37 mappings `PENDING`.

### La Candela de Triana

- Estado: activa.
- POS Agora: responde `Families` con `200` y 57 familias.
- Cursor ventas: `last_business_day_synced=2026-05-31`.
- Último chequeo: `last_sync_at=2026-06-01T00:00:15.257Z`.
- Capacidades: `NOT_CONNECTED`, `write_mode=NONE`, `can_write_products=UNKNOWN`.
- Auto catálogo:
  - `catalog_sync_enabled=true`.
  - `auto_push_on_create=true`.
  - `auto_push_on_update=true`.
  - `auto_push_verified_ready=false`.
- Catálogo Winerim: 77 vinos; stockIds: 74 botella, 3 copa, 0 magnum.
- Mappings: 77 `CONFIRMED`, 1 `REJECTED`.
- Tracking: 77 `VERIFIED`, 1 `FAILED`.
- Ventas guardadas: 2098 totales; 656 últimos 7 días.
- Stock logs: 0.
- Cola outbound abierta: 0.
- Riesgo: ventas entran bien, pero no hay stock logs y la capacidad está marcada como no conectada.
- Siguiente acción: confirmar si hay productos Winerim vendidos; si sí, investigar por qué no se genera `stock_sync_log`. Verificar escritura/capacidad.

### Luruna

- Estado: activa.
- POS Agora: responde `Families` con `200` y 97 familias.
- Cursor ventas: `last_business_day_synced=2026-05-31`.
- Último chequeo: `last_sync_at=2026-06-01T00:00:22.641Z`.
- Capacidades: `READY`, `write_mode=XML_IMPORT`, `can_write_products=UNKNOWN`.
- Auto catálogo:
  - `catalog_sync_enabled=true`.
  - `auto_push_on_create=true`.
  - `auto_push_on_update=true`.
  - `auto_push_verified_ready=true`.
- Catálogo Winerim: 125 vinos; stockIds: 116 botella, 3 copa, 5 magnum.
- Mappings: 124 `CONFIRMED`, 1 `REJECTED`.
- Tracking: 110 `VERIFIED`, 18 `QUEUED`, 1 `HIDDEN`, 2 `NOT_PUSHED`.
- Ventas guardadas: 1600 totales; 522 últimos 7 días.
- Stock: 8 `SUCCESS` históricos; 1 `SUCCESS` últimos 7 días; 0 fallos recientes.
- Cola outbound abierta: 192 (`124 QUEUED`, `10 FAILED`, `58 BLOCKED`).
- Riesgo: ventas recientes entran y hay algún stock OK, pero quedan tareas de catálogo pendientes y pocas copas con stockId.
- Siguiente acción: drenar cola y revisar si las 18 `QUEUED` de tracking deben publicarse o quedar bloqueadas.

### Sa Pedrera

- Estado: activa.
- POS Agora: responde `Families` con `200` y 72 familias.
- Cursor ventas: `last_business_day_synced=2026-05-30`.
- Último chequeo: `last_sync_at=2026-05-31T00:00:12.836Z`.
- Capacidades: `READY`, `write_mode=XML_IMPORT`, `can_write_products=UNKNOWN`.
- Auto catálogo:
  - `catalog_sync_enabled=true`.
  - `auto_push_on_create=true`.
  - `auto_push_on_update=true`.
  - `auto_push_verified_ready=true`.
- Catálogo Winerim: 408 vinos; stockIds: 362 botella, 21 copa, 29 magnum.
- Mappings: 463 `CONFIRMED`, 291 `REJECTED`, 20 `PENDING`.
- Tracking: 393 `VERIFIED`, 17 `HIDDEN`, 5 `FAILED`, 1 `QUEUED`, 1 `NOT_PUSHED`.
- Ventas guardadas: 227 totales; 39 últimos 7 días.
- Stock: 147 `SUCCESS`, 78 `BLOCKED`, 12 `FAILED` históricos; 32 `SUCCESS` últimos 7 días; 0 fallos recientes.
- Cola outbound abierta: 831 (`402 QUEUED`, `294 FAILED`, `135 BLOCKED`).
- Riesgo: stock reciente funciona, pero hay mucha cola histórica y mappings rechazados.
- Siguiente acción: separar cola histórica no accionable de tareas realmente pendientes; resolver 20 mappings `PENDING`.

### Sa Vida

- Estado: activa en `pos_connections`, pero no operativa.
- POS Agora: `export-master Families` devuelve `501`.
- Cursor ventas: `last_business_day_synced=2026-05-03`.
- Último chequeo: `last_sync_at=2026-05-04T00:27:15.426Z`.
- Capacidades: `NOT_CONNECTED`, `write_mode=NONE`, `can_write_products=UNKNOWN`.
- Auto catálogo:
  - `catalog_sync_enabled=true`.
  - `auto_push_on_create=true`.
  - `auto_push_on_update=true`.
  - `auto_push_verified_ready=false`.
- Catálogo Winerim: 1401 vinos; stockIds: 1029 botella, 217 copa, 11 magnum.
- Mappings: 1205 `CONFIRMED`, 866 `REJECTED`.
- Tracking: 852 `VERIFIED`, 390 `NOT_PUSHED`, 112 `QUEUED`, 209 `FAILED`.
- Ventas guardadas: 551 totales; 0 últimos 7 días.
- Stock: 509 `SUCCESS`, 263 `BLOCKED`, 177 `FAILED` históricos; 88 `SUCCESS` últimos 7 días; 0 fallos recientes.
- Cola outbound abierta: 6238 (`1055 QUEUED`, `3322 FAILED`, `1861 BLOCKED`).
- Riesgo: debe considerarse bloqueada. La API REST/puerto/versión no está sana para catálogo/ventas actuales.
- Siguiente acción: deshabilitar o pausar operativamente hasta que Agora/cliente confirme módulo REST, URL/puerto y endpoints `export-master/export` con HTTP 200. No procesar cola.

## Checklist por proveedor sin conexión productiva

- BDP NET: proxy, wizard y hook existen. Guard de circuit breaker compartido integrado. Pendiente completar `createResilientFetch` en fetch internos y onboarding de cliente.
- Revo XEF: proxy, wizard y hook existen. Guard de breaker integrado. Pendiente decidir unificación con su rate limit propio.
- Toast: proxy, wizard y hook existen. Guard de breaker integrado salvo `store-credentials`. Pendiente unificar breaker propio con global.
- Numier: proxy, wizard y hook existen. Guard de breaker integrado. Pendiente reemplazar fetch internos por resiliencia compartida.
- ICG FrontRest: proxy, wizard y hook existen. Guard de breaker integrado. Pendiente reducir riesgo de SQL/config dinámica.
- Clover: proxy, OAuth, webhooks, wizard y hook existen. Sin conexión productiva actual.
- Simphony: proxy, wizard y hook existen. Sin conexión productiva actual.
- Square: proxy, wizard y hook existen. Sin conexión productiva actual.
- TCPOS Kumo: proxy, wizard y hook existen. Sin conexión productiva actual.
- Cassa in Cloud: proxy, wizard y hook existen. Sin conexión productiva actual.
- HIOPOS/HiOffice: proxy, wizard, hook y storage privado existen. Sin conexión productiva actual.
- TouchBistro: proxy, wizard, hook y storage privado existen. Sin conexión productiva actual.

## Prioridades recomendadas

1. Sa Vida: pausar/deshabilitar hasta resolver HTTP 501 y no procesar su cola.
2. Cienvinos: drenar 85 tareas `QUEUED` y confirmar por qué no hay ventas/cierres desde 2026-05-27.
3. Sa Pedrera/Kava/Luruna: limpiar colas abiertas y mappings `PENDING`; mantener ventas/stock funcionando.
4. Katsu/La Candela: corregir `provider_capabilities` y validar stock real, porque ventas entran pero capacidad aparece `NOT_CONNECTED`.
5. Baco: mantener deshabilitada en Winerim; solo reactivar con nuevo piloto y validación visual previa.
6. Flota: implementar auto-update diferencial antes de mantener `auto_push_on_update=true` en clientes antiguos.
