# CURRENT_STATE

> Estado vivo del proyecto. Actualizar en cada sesión (y durante si hay cambios significativos).

_Última actualización: 2026-05-28_

## Hechos (qué está desplegado y verificado)

### Auditoría Sync Monitor / flota Agora — 2026-05-28 07:59 CEST
- Se revisó el estado real en Lovable Cloud tras el reporte del Sync Monitor con `Baco Getafe` y `Restaurante Cienvinos Ecija` mostrando `Last Sync Never` y la pestaña `Stock Sync` mostrando 100 fallos.
- Causa de `Last Sync Never` en Baco/Cienvinos:
  - Ambas conexiones tenían `last_business_day_synced=2026-05-27` y estaban activas, pero `last_sync_at=null`.
  - `auto-sync-sales` respondía correctamente `No pending days to sync`, pero no actualizaba `last_sync_at` cuando no había días pendientes. Era un problema de semántica/visualización del monitor, no una prueba de desconexión.
  - Se ejecutó `auto-sync-sales` manualmente en ambas: resultado `success=true`, `daysSynced=0`, `stockSync=null`, `No pending days to sync`.
  - Se actualizó `last_sync_at` en ambas a `2026-05-28T05:54:58.655Z` después de ese chequeo real.
- Estado final Baco Getafe:
  - `enabled=true`, `last_business_day_synced=2026-05-27`, `last_sync_at=2026-05-28T05:54:58.655Z`, sin breaker, `consecutive_failures=0`.
  - Capacidades restauradas a `can_write_products=YES`, `readiness_status=READY`, `write_mode=XML_IMPORT`.
  - Catálogo Winerim: 95 vinos, 94 `READY`; stockIds cacheados: 83 botella, 21 copa, 19 magnum.
  - Mappings: 118 confirmados (82 botella, 21 copa, 15 magnum).
  - Cola abierta: 0 tareas `QUEUED/RUNNING/FAILED/BLOCKED`.
  - Stock hoy: 0 logs, porque todavía no hay venta/cierre nuevo con producto WINERIM tras la activación.
- Estado final Restaurante Cienvinos Ecija:
  - `enabled=true`, `last_business_day_synced=2026-05-27`, `last_sync_at=2026-05-28T05:54:58.655Z`, sin breaker, `consecutive_failures=0`.
  - Capacidades `can_write_products=YES`, `readiness_status=READY`, `write_mode=XML_IMPORT`.
  - Catálogo Winerim: 378 vinos, 373 `READY`; stockIds cacheados: 372 botella, 49 copa, 7 magnum.
  - Mappings: 428 confirmados (372 botella, 49 copa, 7 magnum).
  - Se drenaron las tareas de actualización de catálogo que reaparecieron para Cienvinos:
    - `process-xml-outbound-queue`: 22 OK, 0 fallos.
    - `process-xml-outbound-queue`: 51 OK, 0 fallos.
    - `process-xml-outbound-queue`: 5 OK, 0 fallos.
    - 16 tareas residuales `RUNNING` se procesaron individualmente con `process-xml-outbound-task` y terminaron `SUCCESS`.
  - Estado final de cola: 0 tareas `QUEUED/RUNNING/FAILED/BLOCKED`.
  - Stock hoy: 0 logs, porque todavía no hay venta/cierre nuevo con producto WINERIM tras la activación.
- Los fallos visibles en la pestaña `Stock Sync` de la captura NO eran de Baco ni de Cienvinos.
  - En las últimas 100 filas globales del monitor, el reparto observado era: Sa Vida 72 `FAILED`, Sa Pedrera 21 `FAILED`, Kava 7 `FAILED`.
  - La pantalla no mostraba columna de ubicación, por eso parecía que el fallo podía pertenecer a cualquier conexión visible.
- Causa técnica de esos fallos de stock:
  - `GET /stock/wine/{winerim_id} -> 404` significa que el token Winerim de esa conexión no tiene acceso a ese vino o el mapping apunta a un `winerim_id` que ya no pertenece al menú/token actual.
  - `Variant 'copa' not found for wine ...` significa que la venta resuelta apunta a copa, pero Winerim no expone stock de copa para ese vino bajo ese token.
  - No es un fallo de descuento fraccional ni de Baco/Cienvinos; es inconsistencia de mapping/catálogo/variante en instalaciones existentes.
- Stock con éxito sí se está registrando en instalaciones existentes:
  - Ejemplos de 2026-05-28 muestran `status=SUCCESS`, `variant`, `stock_id` y `winerim_response.previousStock/newStock/soldQty` en `stock_sync_log`.
  - En esos casos el middleware emite `PUT /api/v2/stock/{stockId}` y deja trazabilidad local en `stock_sync_log`.
- Estado de flota Agora, no apto para declarar "todo listo" todavía:
  - Baco y Cienvinos quedan operativamente limpios para catálogo automático y preparados para procesar el siguiente cierre; falta validar una venta real WINERIM.
  - Katsu y La Candela guardan ventas, pero tienen 0 stockIds cacheados; requieren backfill/re-sync de catálogo Winerim antes de considerarlas sanas para stock variant-aware.
  - Kava y Sa Pedrera tienen stock successes, pero también fallos `404`/variante y colas/backlogs históricos; requieren reparación de mappings/stockIds.
  - Luruna guarda ventas, pero mantiene stockIds incompletos y backlog histórico.
  - Sa Vida sigue siendo contradictoria: `enabled=true` en `pos_connections`, pero `provider_capabilities.readiness_status=NOT_CONNECTED`, `write_mode=NONE`, último sync real `2026-05-04`, backlog muy grande y fallos repetidos de stock. No debe darse por sana hasta resolver API REST/HTTP 501 y mappings.
- Cambios de código preparados en esta sesión:
  - `agora-proxy.auto-sync-sales` actualiza `last_sync_at` también cuando no hay días pendientes, sin avanzar `last_business_day_synced`.
  - `SyncMonitor` muestra ubicación en la pestaña `Stock Sync` y, si una conexión tiene cursor diario pero no `last_sync_at`, muestra `Checked through <fecha>` en vez de `Never`.
- Despliegue/publicación de esta sesión:
  - Commit `b0a2c7b` (`Clarify Agora sync monitor state`) subido a GitHub `main`.
  - A las `2026-05-28T06:03Z`, Lovable Cloud aún no había redeployado el nuevo `agora-proxy`: una invocación `auto-sync-sales` en Baco respondió OK pero no actualizó `last_sync_at`.
  - Mientras seguía activo el runtime anterior, Cienvinos volvió a reencolar updates de catálogo; se drenaron de nuevo (`48 OK`, `2 OK`, y 2 `RUNNING` residuales procesadas individualmente). Verificación final tras limpieza: Baco/Cienvinos con 0 tareas abiertas y `can_write_products=YES`.
- Validación local de estos cambios:
  - `npm test -- --run src/test/stockSyncUtils.test.ts src/test/agoraProductNaming.test.ts` pasa: 12 tests.
  - `npx tsc --noEmit` pasa.
  - `npm run build` pasa con warnings conocidos de Browserslist desactualizado y bundle principal >500 kB.

### Despliegue P0 vía GitHub — 2026-05-28
- Se comprobó que el navegador integrado no tenía sesión autenticada en Lovable Cloud; el acceso al proyecto redirigía a login.
- Se verificó que el repositorio oficial `goiko111/bridge-to-winerim` estaba por detrás de la copia de auditoría: no contenía las migraciones P0, fixes de Agora, tests ni documentos de rollback.
- Se clonó una copia limpia del repo oficial en `/tmp/bridge-to-winerim-remote`, se copiaron los cambios P0 excluyendo `.env`, y se comprobó que el hash de `.env` no cambió.
- Validaciones ejecutadas en la copia limpia antes de publicar:
  - `npm ci --ignore-scripts --no-audit --no-fund` pasa.
  - `npm test -- --run src/test/agoraProductNaming.test.ts src/test/stockSyncUtils.test.ts` pasa: 12 tests.
  - `npx tsc --noEmit` pasa.
  - `npm run build` pasa con warnings conocidos de Browserslist desactualizado y bundle principal >500 kB.
  - Lint acotado de los archivos nuevos críticos pasa.
  - Parse TypeScript de `agora-proxy`, `agora-cron-dispatcher` y `winerim-proxy` pasa.
- Se hizo push a `main` del repo oficial con commit `5ecee98` (`Stabilize Agora automation and stock sync`).
- Tras esperar sincronización, el backend real seguía sin tener aplicadas las migraciones SQL:
  - `stock_sync_log.variant` devuelve error de columna inexistente.
  - `user_roles` devuelve tabla inexistente.
- El push a GitHub deja el código y las migraciones disponibles para Lovable, pero no confirma por sí solo que Lovable Cloud haya aplicado DDL ni redeployado Edge Functions.
- En ese checkpoint inicial no se activó `enabled=true` en Cienvinos ni Baco; ambos se activaron después en la sección "Activación operativa Cienvinos y Baco".

### Lovable Cloud P0 aplicado y verificado — 2026-05-28
- La sesión autenticada de Lovable Cloud quedó disponible en Chrome externo; el navegador integrado seguía sin sesión útil.
- Se aplicaron en Lovable Cloud SQL editor las migraciones:
  - `20260526090000_stock_sync_variant_idempotency.sql`.
  - `20260526091000_user_roles_has_role.sql`.
- La alerta de operación destructiva del editor se debió al texto `ON DELETE CASCADE` de la foreign key de `user_roles`; no se ejecutó ningún borrado de datos.
- Verificación REST contra el backend real:
  - `stock_sync_log` acepta `variant`, `stock_id`, `idempotency_key` (`HTTP 200`).
  - `user_roles` existe (`HTTP 200`).
  - `has_role(fake_user, admin)` devuelve `false` (`HTTP 200`).
  - `claim_outbound_tasks(fake_connection, ["NOOP"])` devuelve `[]` (`HTTP 200`); la firma correcta es `p_task_types TEXT[]`.
- Lovable Cloud redeployó `agora-proxy`, `winerim-proxy`, `agora-cron-dispatcher` y `revo-proxy`; la lista de Edge Functions mostró esas 4 funciones actualizadas hace segundos.
- Lovable generó commits de redeploy (`8dff6d3`, `a7cefe8`, merge `164d092`) que tocaron `src/integrations/supabase/types.ts` y un cast menor en `AgoraTodaysSalesStock`. Esos cambios de fuente se revierten porque el protocolo del proyecto prohíbe editar `src/integrations/supabase/{client,types}.ts`.
- Cienvinos y Baco se verificaron después del redeploy y siguen `enabled=false`, `write_mode=XML_IMPORT`; no se activó cron ni se tocaron credenciales.
- Validación read-only tras el redeploy:
  - Cienvinos `find-last-business-day` 7 días: 0 facturas cerradas.
  - Baco `find-last-business-day` 7 días: días `2026-05-27` a `2026-05-22`, 449 facturas.
  - Baco `fetch-day` para `2026-05-27`: 86 eventos, 436 líneas, 95 candidatas a vino, 0 resueltas contra productos Winerim; no se ejecutó `save-sales` ni ninguna escritura de stock.
- La activación automática quedó pendiente en ese momento hasta nueva instrucción operativa del usuario.

### Activación operativa Cienvinos y Baco — 2026-05-28
- A petición del usuario, `Restaurante Cienvinos Ecija` y `Baco Getafe` quedaron activos en Lovable Cloud:
  - `enabled=true`.
  - `write_mode=XML_IMPORT`.
  - `catalog_sync_enabled=true`.
  - `auto_push_verified_ready=true`.
  - `auto_push_on_create=true`.
  - `auto_push_on_update=false`.
  - `last_business_day_synced=2026-05-27`.
- Razón del cursor inicial `2026-05-27`:
  - Cienvinos no tiene facturas cerradas en los últimos 30 días; dejar el cursor vacío haría que el cron reescanee histórico vacío en cada ciclo.
  - Baco tiene 29 días con facturas recientes y 2.239 facturas en 30 días, pero son cierres legacy previos/sin líneas resueltas contra WINERIM; procesarlos no validaría stock y sí añadiría carga innecesaria al POS.
  - Desde el siguiente cierre real, el flujo automático empezará a procesar días nuevos.
- Checks antes de activar:
  - `agora-proxy test` correcto en ambas conexiones.
  - Capacidad de escritura `provider_capabilities`: `can_write_products=YES`, `readiness_status=READY`, `write_mode=XML_IMPORT`.
  - Sin breakers activos (`circuit_breaker_paused_until=null`, `consecutive_failures=0`).
  - Sin tareas abiertas (`QUEUED/RUNNING/FAILED/BLOCKED`) en ambas conexiones.
  - StockIds cacheados:
    - Cienvinos: 378 vinos, 373 `READY`, 372 bottle stockIds, 49 glass stockIds, 7 magnum stockIds.
    - Baco: 95 vinos, 94 `READY`, 83 bottle stockIds, 21 glass stockIds, 19 magnum stockIds.
- Validación manual post-activación:
  - Dispatcher `sales-stock` por conexión: `succeeded=1`, `skippedByBreaker=0`, `skippedByPreflight=0`, `daysSynced=0`, mensaje `No pending days to sync`.
  - Dispatcher inicial `outbound-queue` por conexión: `processed=0`, `remaining=0`, `breakerTripped=false`.
  - Al completarse los lotes de catálogo/enriquecimiento de Cienvinos se generaron 374 tareas `AGORA_XML_UPSERT_PRODUCT` de actualización (`UPDATE`, origen histórico `MANUAL`) en 5 tandas: 82, 77, 75, 75 y 65. Se procesaron todas contra Agora con resultado `SUCCESS`; Baco no dejó tareas abiertas.
  - Durante el procesamiento se detectó un caso de tareas reclamadas que quedaban en `RUNNING` al agotarse el presupuesto temporal de la Edge Function. Las tareas afectadas se procesaron individualmente por el flujo normal de importación/verificación, sin marcarlas manualmente como éxito.
  - Lectura final en Lovable Cloud (2026-05-28 05:17 UTC): ambas conexiones `enabled=true`, `can_write_products=YES`, `readiness_status=READY`, sin breakers, sin tareas abiertas (`QUEUED/RUNNING/FAILED/BLOCKED`) y sin `stock_sync_log` nuevos el 2026-05-28.
- Correcciones de código preparadas para evitar regresión:
  - `agora-proxy.process-xml-outbound-queue` y la cola legacy no reclaman nuevos lotes si queda poco presupuesto de ejecución, y devuelven a `QUEUED` las tareas reclamadas pero no procesadas para no dejar zombies `RUNNING`.
  - `agora-proxy.sync-master-data` preserva un `can_write_products=YES` ya verificado; una lectura de master data no debe degradar una conexión que ya probó un XML import real.
  - `winerim-proxy` cambia el auto-queue de vinos que pasan a `READY` para usar `evaluate-auto-push` en modo `CREATE`, respetando `auto_push_on_create`, `auto_push_verified_ready`, `write_mode` y capacidades, en lugar de llamar al encolador manual directamente.
  - Commit `e1633d9` subido a GitHub con estos hotfixes. Prueba posterior en Lovable Cloud (`sync-master-data` Baco) indicó que el runtime aún no había redeployado el nuevo `agora-proxy`; se restauró el valor operativo `can_write_products=YES` en ambas conexiones y queda pendiente confirmar redeploy.
- Decisión operativa importante:
  - `auto_push_on_update` queda apagado temporalmente. En el código actual, `fetch-catalog` evalúa el lote procesado como `UPDATE` aunque no haya cambios reales; encenderlo ahora podría reencolar/reimportar muchos vinos en cada sincronización de catálogo. Siguiente mejora: auto-update diferencial por cambios reales de precio/nombre/formato antes de activarlo.

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
- Para jobs `outbound-queue` y `sales-stock`, antes de despachar se hace `GET <baseUrl>/api/` con timeout 5s por conexión.
- Conexiones inalcanzables se saltan en este ciclo y se reportan en `skippedByPreflight`.
- Job `catalog` no se filtra (Winerim siempre debe sincronizarse aunque el POS esté caído).
- `restore-stock` ya no forma parte del dispatcher automático; la acción legacy queda solo manual/protegida.

### Capa 5 — Panel de salud por conexión (NUEVO)
- Nuevo componente `src/components/ConnectionHealthPanel.tsx` (genérico, multi-provider).
- Métricas: estado (Healthy/Degraded/Disabled/Circuit breaker open), último sync, queued, running, failed 24h, blocked, consecutive failures, último error.
- Auto-refresh 15s.
- Renderizado en `AgoraWizard` justo bajo el header cuando hay `connectionId`.
- Reusable: cualquier wizard de otro provider puede importarlo y pasarle `connectionId`.

### Katsu Izakaya — visibilidad legacy vinos en Agora
- Conexión `982f1e63-5f15-48b8-b35f-037eafd4593e` verificada tras master data `2026-05-19T10:05:09Z`.
- Familias legacy vino `VINOS` IDs `11` y `33`, y `VINOS POR COPAS` ID `37`, tienen `ShowInPos=false`.
- En `products_summary_json`, familias `33` y `37` suman 190 productos y todos están no vendibles (`UseAsDirectSale=false` o `SaleableAsMain=false`); 0 siguen vendibles.
- `Hidden` puede venir `null` en Agora y no debe usarse como señal principal: la UI/TPV se controla por `ShowInPos`, `UseAsDirectSale` y `SaleableAsMain`.

### Auditoría Codex — 2026-05-26 (ZIP + guía Agora)
- El directorio raíz `/Users/GOIKO/Documents/Playground` contiene 4 docs de sesión de otro proyecto (`Winerim RIMs + Márgenes / Meta Ads`). Para esta auditoría se usaron como fuente de verdad los 4 docs incluidos en el ZIP `bridge-to-winerim-main (19).zip`.
- Código auditado desde `/Users/GOIKO/Documents/Playground/bridge-to-winerim-audit/bridge-to-winerim-main`.
- Guía Agora `Guía del Integrador.pdf` extraída a texto y revisada para contrastar catálogo/productos/formatos.
- Validación local inicial, antes de la implementación P0:
  - `npm ci` falla porque `package-lock.json` no está sincronizado con `package.json`.
  - `npm install --no-package-lock --no-audit --no-fund` se usó solo en la copia de auditoría para instalar dependencias sin modificar lockfile.
  - `npx tsc --noEmit` pasa.
  - `npm test` pasa solo un test placeholder (`expect(true).toBe(true)`), sin cobertura real de negocio.
  - `npm run build` pasa con warnings: `@import` CSS fuera de orden y bundle principal >500 kB.
  - `npm run lint` falla con 908 problemas (822 errores, 86 warnings).
- Hallazgos técnicos principales detectados en auditoría:
  - `agora-proxy` define dos ramas `auto-sync-sales`; la primera retorna antes y deja inalcanzable la segunda rama que pretendía incluir el día actual.
  - `syncStockForDay` ya es variant-aware para emitir stock por variante, pero la idempotencia en `stock_sync_log` no distingue variante/stock_id ni tiene claim atómico; una variante exitosa puede hacer que otra variante fallida del mismo vino/evento se salte en reintentos.
  - La acción manual `restore-glass-overdiscount` conserva lógica fraccional legacy (`estimated_glasses_per_bottle`) y puede escribir stock absoluto si se invoca con `apply=true`.
  - `sync-master-data` aún descarga `Products` de Agora con `fetchWithRetry` directo en vez de `fetchAgoraProductsXmlCached`, incumpliendo la regla dura del proyecto.
  - No se encontró implementación de `user_roles` ni `has_role() SECURITY DEFINER`; las migraciones mantienen muchas policies `Allow all`.
  - El ZIP incluye `.env` y `.gitignore` no ignora `.env`.
  - Colas outbound Agora/Revo reclaman tareas con patrón select-then-update, no atómico.
  - `revo-proxy` no incrementa correctamente `attempts` en un camino de error por precedencia de operadores.
  - `icg-proxy` construye SQL dinámico desde configuración; con RLS permisiva, cualquier edición no controlada de `provider_config` elevaría el riesgo operativo.

### Documentación Winerim API Token v2 — 2026-05-26
- Fuente local recibida: `/Users/GOIKO/Downloads/API_TOKEN_V2_DOCUMENTATION.html`.
- El HTML identifica la API como Winerim API Token v2, base URL `https://app.winerim.com/api/v2`, versión `2.0.1`, última actualización indicada: julio 2025.
- Autenticación: cabecera `WINERIM-API-TOKEN`; el token limita acceso a recursos del usuario/menu asociado.
- Endpoints documentados:
  - `GET /api/v2/wines?page=&limit=` con paginación y límite 1-100.
  - `GET /api/v2/wines/{id}` con detalle completo, `prices[]` y `erpStock`.
  - `GET /api/v2/stock` y `GET /api/v2/stock/wine/{wineId}`.
  - `PUT /api/v2/stock/{stockId}` para actualizar una variante concreta.
  - `POST /api/v2/wines/bulk` con hasta 100 IDs.
  - `PUT /api/v2/stock/bulk` con hasta 100 updates.
- Confirmaciones relevantes:
  - Cada vino puede tener varios stocks por variante; el stock correcto se identifica por `prices[].erpStock.id`.
  - `stock` es entero `>= 0`; los campos `stockActive`, `treshold`, `tresholdActive`, `maxQty`, `identifier` y ubicación son opcionales.
  - `prices[].erpStock.identifier` existe y puede servir como código/SKU por variante.
  - El bulk de stock declara éxito parcial (`processed`, `failed`, `errors[]`) y límite recomendado de 5 req/s.
- Contrastes detectados antes de la implementación P0:
  - El ejemplo del HTML usa `variant: "glass"`; `winerim-proxy` solo reconocía `copa` al extraer precio/stock de copa. Corregido el 2026-05-26 con normalización de aliases.
  - El HTML documenta `PUT /stock/bulk` como disponible, pero el estado previo indica que en producción devolvía HTML/login. Requiere verificación real antes de activarlo en el flujo automático.
  - El HTML no documenta `GET /stock/{stockId}`; `agora-proxy.syncStockForDay` lo usaba para obtener baseline cuando ya tenía stockId cacheado. Corregido el 2026-05-26 usando `GET /stock/wine/{wineId}`.

### Implementación P0 defensiva — 2026-05-26
- Rollback documentado en `ROLLBACK_2026-05-26.md`.
- DB:
  - Nueva migración `20260526090000_stock_sync_variant_idempotency.sql` añade `variant`, `stock_id`, `idempotency_key` a `stock_sync_log`, índices de soporte y función `claim_outbound_tasks(...)` con `FOR UPDATE SKIP LOCKED`.
  - Nueva migración `20260526091000_user_roles_has_role.sql` añade tabla `user_roles` y función `has_role()` `SECURITY DEFINER` sin endurecer todavía las policies existentes.
- `agora-proxy`:
  - `syncStockForDay` pasa a reclamar líneas con `idempotency_key` por `sales_line_item_id + variant`, evitando doble deducción por invocaciones concurrentes.
  - Compatibilidad legacy: logs `SUCCESS` anteriores sin `idempotency_key` bloquean re-deducciones históricas del mismo evento/vino.
  - La lectura de baseline deja de usar `GET /stock/{stockId}` y pasa a `GET /stock/wine/{wineId}`, endpoint documentado.
  - Las colas `process-outbound-queue` y `process-xml-outbound-queue` usan `claim_outbound_tasks(...)` si existe, con fallback al patrón anterior si la migración aún no está aplicada.
  - `sync-master-data` usa `fetchAgoraProductsXmlCached` para `Products`.
  - La rama duplicada/inaccesible de `auto-sync-sales` fue eliminada; se conserva el comportamiento efectivo anterior D-1/post-cierre.
  - `restore-glass-overdiscount` queda protegido: no escribe con `apply=true` salvo flag explícito `allowLegacyFractionalRestore=true`.
- `winerim-proxy`:
  - Normaliza aliases de variantes (`copa/glass`, `botella/bottle`, `magnum`) al extraer precios y `erpStock.id`.
  - `bulk-update-stock` ya no asume JSON: captura respuestas HTML/no JSON y devuelve `success=false` por chunk fallido.
- `revo-proxy`:
  - Corregido incremento de `attempts` en error de write directo.
  - `process-outbound-queue` usa `claim_outbound_tasks(...)` con fallback.
- Higiene:
  - `.gitignore` ignora `.env` y `.env.*`, manteniendo `!.env.example`.
  - `package-lock.json` queda sincronizado: `npm ci --ignore-scripts --no-audit --no-fund` pasa.
  - `src/index.css` mueve `@import` antes de Tailwind y elimina el warning CSS de orden.
- Validación local:
  - `npm ci --ignore-scripts --no-audit --no-fund` pasa.
  - `npm test` pasa: 2 archivos, 5 tests.
  - `npx tsc --noEmit` pasa.
  - `npm run build` pasa. Quedan warnings no bloqueantes: Browserslist desactualizado y bundle principal >500 kB.
  - `npm run lint` sigue fallando por deuda previa: 902 problemas (816 errores, 86 warnings), mejora frente a los 908 iniciales.

### Auditoría front Agora — 2026-05-26
- Alcance revisado:
  - `src/pages/AgoraWizard.tsx` (wizard principal, 14 pasos declarados).
  - Hooks `useAgoraConnection`, `useAgoraMasterData`, `useOutboundSync`.
  - Paneles Agora: salud, familias, visibilidad de familias/productos, catálogo Winerim, matching manual/AI, outbound, ventas/stock, PriceList probe y comparación de conexiones.
- Hechos de arquitectura:
  - El front de Agora se entiende como un wizard operativo completo, no solo onboarding: conecta credenciales, descubre catálogo, gestiona master data, clasifica familias/productos, empuja catálogo Winerim a Agora, procesa cola outbound, diagnostica precios/PriceLists, revisa ventas y habilita cron.
  - `AgoraWizard.tsx` concentra demasiada lógica de UI, queries y efectos (5053 líneas); los paneles auxiliares también mezclan queries directas al backend con decisiones operativas.
  - La UI ya incorpora varios guardrails valiosos: `ConnectionHealthPanel`, readiness badges, auto-push verification gate, PriceList Persistence Probe, estado de push por formato y paneles de visibilidad.
- Hallazgos funcionales:
  - Navegación: el wizard declara paso 14 `Go Live`, pero `handleNext` usa `Math.min(13, s + 1)`. El botón `Next` no llega nunca al paso 14; solo se llega clicando el stepper.
  - Riesgo stock: el botón manual `Save to DB` de Sales & Mapping llama a `save-sales`; backend guarda ventas y actualiza `last_business_day_synced`, pero no lanza `syncStockForDay`. Si se usa manualmente para un día cerrado, el cron puede saltarse ese día y no descontar stock.
  - Panel `AgoraTodaysSalesStock`: interpreta `stock_sync_log.status === "SYNCED"`, pero backend escribe `SUCCESS`. El panel puede mostrar stock sincronizado como pendiente/parcial.
  - Panel `AgoraTodaysSalesStock`: usa `stock_quantity` agregado y suma ventas de formatos distintos para mostrar “stock antes → ahora”. Tras stock variant-aware, esto puede mezclar botella/copa/magnum y presentar números engañosos.
  - Textos del front hablan de “today”, “auto-runs every 15 min” y “ventas cada 15 min”, pero el estado real de Agora/Kava es D-1/post-cierre por `Invoices`. La UI puede inducir a esperar tiempo real donde no existe.
  - Catálogo Winerim: la UI muestra y diagnostica `MAGNUM`, y backend soporta `MAGNUM`, pero varios botones de push/preview envían solo `["BOTTLE","GLASS"]`. Magnum queda visible como listo pero no se empuja desde acciones principales.
  - Visibilidad familias: `AgoraFamilyVisibilityPanel` interpreta `ShowInPos` ausente/null como oculto (`String(f.ShowInPos) === "true"`), mientras otros paneles defaultan true. Puede falsear contadores y estados.
  - Visibilidad productos: un producto en familia oculta puede marcarse “visible” a nivel producto, pero seguirá invisible por herencia familiar. La UI no bloquea ni guía esa contradicción.
  - Visibilidad familias: acciones individuales “Archivar familia + productos” escriben inmediatamente en Agora sin confirmación; la acción bulk sí tiene confirmación.
  - Visibilidad familias: el texto dice “mover a ARCHIVO WINERIM”, pero la implementación oculta familia/productos; no mueve a la familia `999999`.
  - Matching manual: al crear un mapping manual siempre envía `formatType: "BOTTLE"`. Si el producto POS es copa o magnum, el registro queda semánticamente incorrecto aunque la resolución de ventas pueda usar el formato de la línea.
  - Gestión de conexión: `testConnection` crea una fila `pos_connections` antes de probar credenciales cuando no hay `connectionId`. Si el test falla quedan conexiones “New Location” inválidas.
  - Queue front: `processQueue` calcula progreso desde `outboundTasks` capturado en el closure, pero no lo declara como dependencia; puede mostrar progreso inexacto si la lista cambió.
  - Lint acotado a front Agora: `npx eslint src/pages/AgoraWizard.tsx src/hooks/useAgoraConnection.ts src/hooks/useAgoraMasterData.ts src/hooks/useOutboundSync.ts src/components/Agora*.tsx src/components/ConnectionHealthPanel.tsx src/components/PilotFamiliesPanel.tsx` falla con 209 problemas (191 errores, 18 warnings), mayoritariamente `any` y dependencias de hooks.
- Validación ejecutada:
  - `npm test -- --run src/test/stockSyncUtils.test.ts` pasa: 4 tests.
  - Lint acotado falla por deuda local de front Agora; no se hicieron cambios funcionales en esta auditoría.

### Implementación automatización Agora — 2026-05-26
- Hechos:
  - `agora-proxy.save-sales` ya no es solo “guardar ventas”: tras guardar un día cerrado, lanza sincronización de stock Winerim si hay líneas resueltas y token Winerim.
  - `last_business_day_synced` solo avanza si no hay fallo de stock para ese día. Si Winerim falla o falta token con líneas resueltas, se actualiza `last_sync_at`, pero el cursor diario queda sin avanzar para que el cron lo reintente.
  - `auto-sync-sales` procesa días cerrados secuencialmente: guarda ventas, sincroniza stock del día, avanza cursor día a día solo tras éxito, y se bloquea en el primer día con fallo para no saltarse stock.
  - `auto-sync-sales` añade catch-up idempotente de stock para días guardados recientes (lookback máximo 30 días, acotado por `backfill_days`). Esto rescata casos donde ya había ventas guardadas pero el cursor había avanzado antes de descontar stock.
  - `syncStockForDay` mantiene `idempotency_key` por línea/variante, pero añade guarda por `sales_event_id + winerim_product_id + variant` ya sincronizado. Esto evita doble descuento cuando `sales_line_items` se borra/reinserta al re-guardar un día.
  - `save-sales` devuelve `stockSync`, `cursorAdvanced` y `warning` para que el front muestre si el stock quedó confirmado.
  - El wizard Agora ya permite avanzar al paso 14 `Go Live` con `handleNext`.
  - Acciones principales de catálogo/outbound envían `MAGNUM` junto con `BOTTLE` y `GLASS`; el backend sigue validando por vino/precio antes de generar XML.
  - `AgoraTodaysSalesStock` acepta `SUCCESS` y `SYNCED`, muestra transiciones `previousStock -> newStock` por variante cuando existen en `winerim_response`, y deja de presentar un “stock antes” calculado mezclando copa/botella/magnum.
  - `AgoraManualMatchPanel` permite elegir formato `BOTTLE`/`GLASS`/`MAGNUM` en mappings manuales y deriva una sugerencia inicial desde el nombre del producto Agora.
  - `AgoraFamilyVisibilityPanel` normaliza booleanos (`ShowInPos` null/ausente default true), confirma acciones individuales de archivar/restaurar familia, y corrige el texto: se oculta en Agora, no se mueve a `ARCHIVO WINERIM`.
  - `AgoraProductVisibilityPanel` bloquea marcar producto visible si su familia está oculta.
  - `testConnection` crea filas Agora deshabilitadas durante el test y borra la fila si el test falla, evitando conexiones basura “New Location”.
  - `useOutboundSync.processQueue` incluye `outboundTasks` en dependencias para que el progreso se calcule sobre una lista actualizada.
  - `_shared/stockSyncUtils.ts` expone utilidades puras para claves estables de grupo y decisión de avance de cursor; quedan cubiertas por tests unitarios.
- Decisiones:
  - El modo automático para clientes Agora queda basado en días cerrados (`Invoices`) y reintentos idempotentes, no en polling intradía global.
  - Se prioriza no descontar dos veces frente a recalcular deltas si un ticket histórico ya sincronizado se re-guarda con cantidades distintas. Si un cliente modifica tickets cerrados, requiere procedimiento específico.
  - `MAGNUM` se activa en UI principal porque el backend ya lo valida por disponibilidad/precio; no se añade nuevo toggle de configuración en esta iteración.
- Validación local:
  - `npm test -- --run` pasa: 2 archivos, 8 tests.
  - `npx tsc --noEmit` pasa.
  - `npm run build` pasa. Warnings no bloqueantes: Browserslist desactualizado y bundle principal >500 kB.
  - `npm run lint` sigue fallando por deuda histórica del repo (819 errores, 85 warnings en la ejecución completa). Se corrigieron errores obvios introducidos en archivos tocados, pero no se aborda la deuda global en esta sesión.
  - `deno check` no está disponible en este entorno (`deno: command not found`). Como sustituto parcial, se parsearon `agora-proxy` y `agora-cron-dispatcher` con el transpilador TypeScript local sin diagnósticos de sintaxis.

### Integración Agora Cienvinos Ecija — 2026-05-27
- Cliente: `Restaurante Cienvinos Ecija`.
- Conexión creada en Lovable Cloud con `connection_id=21ee3345-1090-4e83-94f2-43126d6e7695`.
- Credenciales reales de Agora y Winerim cargadas en la fila de conexión. No se documentan tokens en archivos de sesión.
- Estado operativo dejado a propósito en modo seguro:
  - `enabled=false`.
  - `write_mode=XML_IMPORT`.
  - `catalog_sync_enabled=true`.
  - `require_manual_review_before_push=true`.
  - `auto_push_on_create=false`, `auto_push_on_update=false`, `auto_push_verified_ready=false`.
  - `write_bottle=true`, `write_glass=true`; `MAGNUM` se incluye por validación backend cuando hay precio.
- Pruebas realizadas:
  - `agora-proxy` action `test`: correcto.
  - `winerim-proxy fetch-catalog`: 378 vinos leídos/enriquecidos sin fallos de detalle.
  - Verificación directa Winerim `GET /api/v2/stock/wine/{wineId}`: devuelve stockIds por variante.
  - Backfill directo, solo metadatos, de stockIds en `winerim_wines`: 372 botellas, 49 copas y 7 magnums con stockId; no se escribieron cantidades de stock.
  - `agora-proxy sync-master-data`: correcto; 177 productos, 4 IVAs, 3 price lists, 2 preparation types, 6 preparation orders, 1 almacén, 3 sale centers.
  - `discover-catalog` con filtros legacy `Articles/Products/Catalog`: falla con HTTP 500 porque Agora declara esos tipos no válidos para export; se conserva `export-master` como fuente.
  - `find-last-business-day` 30 días: no hay `Invoices` cerradas detectadas.
- Configuración de escritura preparada, sin activar import real:
  - IVA por defecto `3` (`Reducido`, 10%).
  - Preparation type `1` (`BARRA`).
  - Preparation order `6` (`BEBIDAS`).
  - Almacén `1` (`Almacén General`).
  - Sale centers seleccionados `1`, `2`, `3` (`Barra`, `Sala`, `Terraza`).
  - `auto_create_families=true` porque Agora devuelve 0 familias en master data.
- Preview XML seguro:
  - Muestra de 3 vinos: genera 4 productos, 2 familias nuevas, 12 precios; sin llamada a `/api/import/`.
  - Preview global: 378 vinos, 428 productos generables, 6 familias nuevas, 1.284 precios, 0 IDs de producto duplicados.
  - Formatos válidos esperados: 372 botellas + 49 copas + 7 magnums.
  - Invalidaciones esperadas: vinos sin precio de magnum, sin servicio por copa o sin precio de botella.
- Importación real de catálogo Winerim en Agora:
  - Creadas 8 familias dedicadas: `TINTOS WINERIM`, `BLANCOS WINERIM`, `ROSADOS WINERIM`, `ESPUMOSOS WINERIM`, `DULCE WINERIM`, `FORTIFICADOS WINERIM`, `COPAS WINERIM`, `MAGNUM WINERIM`.
  - Importados/verificados 428 productos WINERIM:
    - 372 botellas.
    - 49 copas.
    - 7 magnums.
  - Distribución final en Agora:
    - `TINTOS WINERIM`: 185.
    - `BLANCOS WINERIM`: 89.
    - `ROSADOS WINERIM`: 10.
    - `ESPUMOSOS WINERIM`: 41.
    - `DULCE WINERIM`: 16.
    - `FORTIFICADOS WINERIM`: 31.
    - `COPAS WINERIM`: 49.
    - `MAGNUM WINERIM`: 7.
  - Total final en Agora tras `sync-master-data`: 605 productos = 177 preexistentes + 428 WINERIM.
  - `provider_capabilities` corregido tras verificación real: `can_write_products=YES`, `readiness_status=READY`, `write_mode=XML_IMPORT`.
  - Los 177 productos preexistentes no se han ocultado porque no hay familias antiguas de vino ni productos de vino detectados fuera de las familias WINERIM. Los candidatos por texto eran falsos positivos (`tinto limón`, `copa cerveza`, infusiones/licores).
  - 12 botellas duplicadas de nombre en Winerim fueron importadas con sufijo corto visible en Agora para evitar el `HTTP 500` por nombre duplicado de Agora: ejemplo `B Alión 276`. El catálogo local Winerim se restauró con sus nombres originales tras la importación temporal.
- Estado tras activación automática:
  - Las migraciones P0 y funciones actuales ya están desplegadas en Lovable Cloud.
  - Cienvinos queda activo desde cursor `2026-05-27`.
  - Cienvinos no tiene facturas cerradas en la prueba read-only de 30 días; falta una venta/cierre real con productos WINERIM para validar deducción de stock por variante.
  - El siguiente `winerim-proxy fetch-catalog` debe confirmar que el proxy desplegado ya captura `erpStock.id` sin backfill manual.
- Rollback documentado en `ROLLBACK_CIENVINOS_AGORA_2026-05-27.md`.

### Revisión flota Agora — 2026-05-27 / actualizada 2026-05-28
- Las migraciones P0 y las funciones actuales ya están aplicadas/redeployadas en Lovable Cloud.
- El dispatcher Agora no permite activar solo catálogo: `enabled=true` incluye `catalog`, `sales-stock` y `outbound-queue`. Cienvinos y Baco ya están activos por instrucción operativa; el riesgo se controla con cursor `2026-05-27`, cola vacía y monitorización del primer cierre nuevo.
- Cienvinos:
  - El catálogo Winerim ya está importado y verificado en Agora: 428 productos en 8 familias WINERIM.
  - StockIds por variante ya cacheados: 372 botella, 49 copa, 7 magnum.
  - Se detectaron 75 tareas `AGORA_XML_UPSERT_PRODUCT` en `QUEUED` creadas antes de la importación real. Todas correspondían a botellas ya marcadas `PUSHED` en `winerim_push_tracking`; se cerraron como `SUCCESS` para evitar reintentos/duplicados al activar el automático.
  - Cola actual Cienvinos: 75 `SUCCESS`, 0 pendientes.
  - Desambiguación automática de nombres duplicados codificada localmente:
    - Nueva utilidad `supabase/functions/_shared/agoraProductNaming.ts`.
    - `generateImportXml` mantiene nombres únicos intactos, conserva el nombre al actualizar el mismo `Product Id` y añade sufijo corto determinista a duplicados reales (`... 276`, etc.).
    - Tests añadidos en `src/test/agoraProductNaming.test.ts`.
    - Validación local: `npm test -- --run src/test/agoraProductNaming.test.ts src/test/stockSyncUtils.test.ts` pasa (12 tests), `npx tsc --noEmit` pasa, lint acotado de los archivos nuevos pasa, parse TypeScript de `agora-proxy` pasa, `npm run build` pasa con los warnings conocidos de Browserslist/bundle grande.
    - `agora-proxy` actualizado ya está desplegado en Lovable Cloud.
- Sa Vida:
  - Credenciales Agora y token Winerim actualizados en Lovable Cloud con los valores facilitados por el usuario. No se documentan secretos.
  - El host responde, pero los endpoints Agora devuelven `501`:
    - `/api/export-master/?filter=Products`
    - `/api/export-master/?filter=Families`
    - `/api/export/?business-day=2026-05-26&filter=Invoices`
    - `/api/export/tickets/`
  - `agora-proxy test` devuelve `success=false`, status `501`.
  - `sync-master-data` falla con `Agora responded 501 on core export`.
  - Se marcó `provider_capabilities` de Sa Vida como `can_write_products=UNKNOWN`, `readiness_status=NOT_CONNECTED`, `write_mode=NONE` para no presentarla como lista mientras el POS no exponga API.
  - Sa Vida sigue teniendo backlog operativo: tareas `QUEUED`/`FAILED`/`BLOCKED`, 1.392 vinos cacheados y 0 stockIds por variante. No conviene reactivar escrituras hasta que Agora responda 200 y se haga backfill de stockIds.
- Kava, Luruna y Sa Pedrera:
  - Los endpoints Agora respondieron correctamente en la revisión de flota.
  - Breakers antiguos ya caducados y contadores de fallos obsoletos fueron limpiados: `consecutive_failures=0`, `circuit_breaker_paused_until=null`, `circuit_breaker_reason=null`.
- Snapshot operativo tras la revisión:
  - Katsu Izakaya: enabled, breaker limpio, master fresh; 94 vinos Winerim, 0 stockIds; capability sigue `UNKNOWN/NOT_CONNECTED`.
  - Kava: enabled, breaker limpio, master fresh; 210 vinos, 0 stockIds; capability `READY/XML_IMPORT`; quedan tareas residuales (`QUEUED`/`BLOCKED`/1 `RUNNING` observado durante procesamiento).
  - La Candela de Triana: enabled, breaker limpio, master fresh; 77 vinos, 0 stockIds; capability `UNKNOWN/NOT_CONNECTED`.
  - Luruna: enabled, breaker limpio, master fresh; 125 vinos, 0 stockIds; capability `READY/XML_IMPORT`; quedan 5 tareas `QUEUED`.
  - Sa Pedrera: enabled, breaker limpio, master fresh; 403 vinos, 0 stockIds; capability `READY/XML_IMPORT`; quedan 5 tareas `FAILED`.
  - New Location: disabled, URL inválida heredada (`ttp://...`), sin master data ni vinos; candidato claro a limpieza manual si el usuario confirma.

### Integración Agora Baco Getafe — 2026-05-27
- Cliente: `Baco Getafe`.
- Conexión creada en Lovable Cloud con `connection_id=32f46d47-3984-413a-8c18-b5502418dadc`.
- Credenciales reales de Agora y Winerim cargadas en la fila de conexión. No se documentan tokens en archivos de sesión.
- Estado operativo inicial dejado en modo seguro (2026-05-27):
  - `enabled=false`.
  - `write_mode=XML_IMPORT`.
  - `catalog_sync_enabled=true`.
  - `require_manual_review_before_push=true`.
  - `auto_push_on_create=false`, `auto_push_on_update=false`, `auto_push_verified_ready=false`.
  - `selected_sale_center_ids=["1","2","3"]` (`Cafet.`, `Restaurante`, `Terraza`); se excluyen `Personal` y `MUS`.
- Pruebas de alcance:
  - `agora-proxy` action `test`: correcto.
  - `/api/export-master/?filter=Products`: HTTP 200, ~4,77 MB.
  - `/api/export-master/?filter=Families,Vats,PriceLists,PreparationTypes,PreparationOrders,Warehouses`: HTTP 200.
  - `/api/export/?business-day=2026-05-27&filter=Invoices`: HTTP 200.
  - `/api/export/tickets/`: HTTP 200. Hipótesis: este Agora sí expone tickets, aunque el automático global sigue en flujo post-cierre por seguridad.
- Winerim:
  - 95 vinos leídos/enriquecidos.
  - 94 `READY`, 1 sin stock/precio exportable.
  - Exportables detectados por preview: 82 botellas, 21 copas, 15 magnums.
  - Backfill de stockIds desde `raw_payload.prices[].erpStock.id`: 83 botella, 21 copa, 19 magnum. No se escribieron cantidades de stock.
- Master data Agora:
  - 48 familias tras crear familias WINERIM.
  - 3.903 productos tras importación.
  - 4 IVAs, 3 price lists, 2 preparation types, 5 preparation orders, 1 almacén, 5 sale centers.
  - Configuración usada: IVA `3` (`Reducido`, 10%), preparation type `1` (`Barra`), preparation order `1` (`Bebidas`), warehouse `1` (`Almacén General`).
- Familias WINERIM creadas y visibles:
  - `900157` `TINTOS WINERIM`: 48 productos.
  - `904241` `BLANCOS WINERIM`: 20 productos.
  - `903516` `ROSADOS WINERIM`: 2 productos.
  - `908875` `ESPUMOSOS WINERIM`: 11 productos.
  - `903925` `DULCE WINERIM`: 1 producto.
  - `908182` `FORTIFICADOS WINERIM`: 0 productos por ahora.
  - `901954` `COPAS WINERIM`: 21 productos.
  - `904289` `MAGNUM WINERIM`: 15 productos.
- Importación real de catálogo Winerim en Agora:
  - Primer `xml-import` global devolvió HTTP `546` por timeout de runtime, pero el XML sí se aplicó en Agora.
  - Verificación posterior directa sobre `export-master` confirmó 118/118 productos esperados presentes.
  - Verificación estricta: 0 productos faltantes, 0 productos con fallos de IVA/preparación/precios/visibilidad.
  - Todos los productos Winerim importados tienen precios en price lists `1`, `2`, `3`, `VatId=3`, `PreparationTypeId=1`, `PreparationOrderId=1`, `UseAsDirectSale=true`, `SaleableAsMain=true`.
  - Se corrigió el tracking local tras el timeout: `winerim_push_tracking` queda con 82 `BOTTLE:PUSHED`, 21 `GLASS:PUSHED`, 15 `MAGNUM:PUSHED`; formatos no exportables quedan `NOT_PUSHED`.
  - `product_mappings` queda con 118 mappings `CONFIRMED` y sin mappings falsos para formatos no exportables.
  - `provider_capabilities` marcado `can_write_products=YES`, `readiness_status=READY`, `write_mode=XML_IMPORT`.
- Validación read-only post-redeploy:
  - `find-last-business-day` 7 días devuelve días cerrados de `2026-05-27` a `2026-05-22`.
  - `fetch-day` de `2026-05-27` devuelve 86 eventos, 436 líneas y 95 candidatas a vino, pero 0 líneas resueltas contra productos WINERIM. No se ejecutó `save-sales` porque no aportaría una validación real de stock Winerim.
- Duplicados:
  - Preview inicial detectó dos nombres duplicados que Agora habría rechazado: `M Alión` y `B Villacardiel`.
  - Se desambiguaron temporalmente en la caché local para importar como `M Alión 054` y `B Villacardiel 977`.
  - Los nombres Winerim locales se restauraron a `Alión` y `Villacardiel`; los productos Agora conservan el sufijo visible.
- Legacy ocultado:
  - Familias legacy ocultas (`ShowInPos=false`): `VINO` (`2`), `FINOS` (`4`), `ROSADOS` (`5`), `TINTOS` (`6`), `CHAMPAGNE` (`7`), `BLANCOS` (`29`).
  - 348 productos legacy de esas familias quedaron no vendibles (`UseAsDirectSale=false`, `SaleableAsMain=false`).
  - Verificación final: 0 productos legacy siguen visibles/vendibles.
- Revisión por reporte visual del cliente — 2026-05-28:
  - Imagen recibida: tablet con familias `TINTOS WINERIM`, `COPAS WINERIM`, `ROSADOS WINERIM`, `DULCE WINERIM`, `BLANCOS WINERIM`, `MAGNUM WINERIM`, etc., y botones nuevos tipo `B Altún Crianza`, `B Villacardiel`, `B Muga Crianza`.
  - Vídeo recibido: pantalla Agora con familia legacy `VINO` y botones antiguos tipo `TAMARAL CRIANZA`, `ARROCAL TINTO FINO`, `ALTUN (RIOJA)`, `JOSE PARIENTE`, `CIRCE`. En master data esos productos ya estaban no vendibles, pero varias familias legacy seguían con `ShowInPos=true`.
  - Corrección aplicada en Lovable Cloud: forzar `ShowInPos=false` en familias legacy `VINO`, `FINOS`, `ROSADOS`, `TINTOS`, `CHAMPAGNE`, `BLANCOS`; forzar `ShowInPos=true` en las 8 familias `... WINERIM`.
  - Verificación posterior: 48 familias, 3.903 productos; las 6 familias legacy están ocultas, las 8 familias WINERIM visibles, 348 productos legacy siguen no vendibles y 0 productos legacy quedan vendibles.
  - Ejemplos de naming actual:
    - Legacy `ALTUN` / `ALTUN COPA` → Winerim `B Altún Crianza` y `C Altún Crianza`.
    - Legacy `ARROCAL TINTO FINO` / `ARROCAL SELECCION` → Winerim `B Arrocal`, `C Arrocal`, `B Arrocal Selección`.
    - Legacy `JOSE PARIENTE` / `JOSE PARIENTE COPA` → Winerim `B José Pariente Verdejo` y `C José Pariente Verdejo`.
    - Duplicados Winerim: `Alión` conserva `B Alión`, `M Alión` y `M Alión 054`; `Villacardiel` conserva `B Villacardiel` y `B Villacardiel 977`.
- Rollback documentado en `ROLLBACK_BACO_GETAFE_AGORA_2026-05-27.md`.
- Estado tras activación automática:
  - Baco queda activo desde cursor `2026-05-27`.
  - El cierre `2026-05-27` tenía 0 líneas resueltas contra productos WINERIM; falta validar el primer cierre nuevo con venta WINERIM real.
  - `auto_push_on_update=false` hasta implementar detección diferencial de cambios reales de catálogo.

### Reparación flota Agora stock/mappings — 2026-05-28 08:51 CEST

#### Hechos
- Se hizo una reparación controlada de datos en Lovable Cloud sin ningún `PUT` de stock a Winerim:
  - 1.881 pares `connection_id` + `winerim_wine_id` verificados con `GET /api/v2/stock/wine/{wineId}`.
  - 1.598 lecturas correctas, 283 terminales (`wine not found`, `not accessible` o variante inexistente), 0 errores transitorios.
  - 1.359 filas de `winerim_wines` actualizadas con stockIds reales: 1.345 botella, 197 copa, 19 magnum.
  - 1.197 `product_mappings` obsoletos marcados como `REJECTED` con `last_sync_error=terminal_stock_mapping_rejected...`.
  - 224 filas de `winerim_push_tracking` marcadas como `FAILED` para que el runtime antiguo no vuelva a resolver productos terminales mientras se despliega el hotfix.
  - 144 `sales_line_items` históricos limpiados (`mapped=false`, `winerim_product_id=null`) porque apuntaban a mappings ya rechazados.
  - 367 logs terminales de `stock_sync_log` pasaron de `FAILED` a `BLOCKED` con prefijo `BLOCKED_TERMINAL`.
- Backups locales sin secretos:
  - `.codex-backups/agora-terminal-mapping-repair-2026-05-28T06-32-11-676Z.json`
  - `.codex-backups/agora-terminal-sales-log-cleanup-2026-05-28T06-49-37-524Z.json`
- Auditoría posterior:
  - `stock_sync_log` últimos 24h: `FAILED=0`, `BLOCKED=364`.
  - `sales_line_items` todavía apuntando a mappings rechazados: 0.
  - Todos los mappings `CONFIRMED` restantes tienen el stockId requerido por su formato (`missingNeededStockId=0`) en Baco, Cienvinos, Katsu, Kava, La Candela, Luruna, Sa Pedrera y Sa Vida.
- Estado por conexión tras la reparación:
  - Baco Getafe: 95 vinos, 94 `READY`, 118 mappings `CONFIRMED`, 0 rechazados, 0 stockIds faltantes para mappings, 0 tareas abiertas, sin breaker.
  - Restaurante Cienvinos Ecija: 378 vinos, 373 `READY`, 428 mappings `CONFIRMED`, 0 rechazados, 0 stockIds faltantes para mappings, sin breaker. El runtime antiguo volvió a generar 82 tareas de update con `_trigger_source=MANUAL`; se marcaron `SUCCESS` solo tras comprobar que todos los formatos ya estaban `PUSHED/VERIFIED`. Estado final: 0 tareas abiertas.
  - Katsu Izakaya: 64 vinos objetivo revisados; 40 mappings `CONFIRMED`, 28 `REJECTED`, 0 stockIds faltantes para mappings, sin cola abierta.
  - Kava: 255 mappings `CONFIRMED`, 12 `REJECTED`, 0 stockIds faltantes para mappings. Quedan tareas outbound (`203 QUEUED`, `7 FAILED`, `9 BLOCKED`) y breaker antiguo visible.
  - La Candela de Triana: 77 mappings `CONFIRMED`, 1 `REJECTED`, 0 stockIds faltantes para mappings.
  - Luruna: 124 mappings `CONFIRMED`, 1 `REJECTED`, 0 stockIds faltantes para mappings. Queda backlog outbound (`117 QUEUED`, `10 FAILED`, `58 BLOCKED`) y breaker antiguo visible.
  - Sa Pedrera: 463 mappings `CONFIRMED`, 291 `REJECTED`, 0 stockIds faltantes para mappings. Queda backlog outbound grande (`201 RUNNING`, `294 FAILED`, `111 BLOCKED`) y breaker `POS_OVERLOADED`.
  - Sa Vida: 1.205 mappings `CONFIRMED`, 866 `REJECTED`, 0 stockIds faltantes para mappings confirmados. Sigue `NOT_CONNECTED/NONE`, con API Agora HTTP 501 y backlog muy grande (`1044 QUEUED`, `3322 FAILED`, `1861 BLOCKED`).
- Cambios de código preparados y validados localmente:
  - `agora-proxy`: los fallos terminales de stock (`FAILED` o `BLOCKED`) se consideran no reintentables durante 24h para no crear logs repetidos; las resoluciones de venta respetan `product_mappings.REJECTED` incluso si existe `winerim_push_tracking` histórico.
  - `winerim-proxy`: el enriquecimiento de catálogo persiste `bottle_stock_id`, `glass_stock_id`, `magnum_stock_id`; el auto-push de `UPDATE` solo se invoca si la conexión tiene `auto_push_on_update=true`.
  - `_shared/stockSyncUtils.ts`: clasificador `isTerminalStockSyncError`.
  - Validación: parse TypeScript de edge functions OK, `npm test -- --run src/test/stockSyncUtils.test.ts` OK (8 tests), `npx tsc --noEmit` OK, `npm run build` OK con warnings conocidos de Browserslist/bundle grande.

#### Decisiones
- Los mappings que Winerim confirma como inaccesibles o sin variante de stock se marcan `REJECTED`; no se borran para conservar trazabilidad y permitir rollback.
- Los fallos de stock terminales históricos se marcan `BLOCKED_TERMINAL`, no `FAILED`, porque no son reintentos recuperables.
- `winerim_push_tracking` no puede tener prioridad absoluta sobre `product_mappings`: un mapping `REJECTED` debe bloquear la resolución de ventas aunque el producto se hubiese importado en Agora en el pasado.
- No se tocó stock real: toda la reparación fue lectura de Winerim + metadatos locales de mapping/stockId.

#### Hipótesis / riesgos
- El runtime antiguo de Lovable Cloud sigue ejecutándose: `auto-sync-sales` responde "No pending days to sync" pero no actualiza `last_sync_at` (`redeployLikely=false` en prueba posterior al push de los hotfixes; último commit documentado `dbb0c30`). Los hotfixes están en GitHub, pero falta redeploy efectivo de Edge Functions.
- Sa Vida no puede declararse lista desde middleware: el servidor responde, pero la API REST Agora devuelve HTTP 501. El bloqueo requiere corrección externa de POS/puerto/módulo.
- Kava, Luruna y Sa Pedrera tienen stockIds/mappings corregidos, pero todavía arrastran backlog outbound y breakers/residuos de cola que deben limpiarse después del redeploy para no mezclar deuda antigua con fallos nuevos.

#### Tareas pendientes inmediatas
- Publicar hotfix actual en GitHub y confirmar redeploy de `agora-proxy` y `winerim-proxy` en Lovable Cloud.
- Tras redeploy, volver a probar Baco/Cienvinos: `auto-sync-sales` sin días pendientes debe actualizar `last_sync_at`.
- Drenar o bloquear de forma controlada las colas outbound antiguas de Kava, Luruna, Sa Pedrera y Sa Vida según estado real de cada POS.
- Ejecutar un ciclo manual `auto-sync-sales` en Baco y Cienvinos después del redeploy para confirmar que `last_sync_at` se actualiza sin días pendientes y que no se recrean updates masivos.

## Hipótesis abiertas
- Resiliencia extendida cubre el caso de saturación si el cliente reabre el problema. Falta validar en producción real con BDP/Revo/Toast/Numier/ICG (todavía sin clientes activos saturando).
- 7 días sin incidente Agora aún por confirmar (llevamos ~1 día).
- La doble rama `auto-sync-sales` puede explicar discrepancias entre intención de near-real-time y comportamiento real D-1: la rama intradía está inalcanzable.
- La guía Agora usa el atributo `Order` para ordenación de productos; el XML generado actualmente usa `SortOrder`. Es probable que Agora ignore ese campo, pero debe validarse en una conexión de prueba antes de tocar catálogo productivo.
- La documentación Winerim v2 puede estar por delante o detrás del despliegue productivo real; especialmente `PUT /stock/bulk` debe probarse con token real antes de migrar el cron de stock.
- `PUT /stock/bulk` sigue sin activarse en automático hasta comprobar con token real que producción devuelve JSON y `errors[]` como indica la documentación.
- `Order` vs `SortOrder` en XML Agora sigue pendiente de prueba controlada.
- Cienvinos parece tener Agora con `export-master` moderno y sin catálogo legacy por filtros `export`; comportamiento similar al caso Kava, pero todavía no hay ventas cerradas para validar `Invoices`.
- El IVA 10%, preparation `BARRA/BEBIDAS`, almacén general y sale centers Barra/Sala/Terraza son la mejor configuración inicial observada desde master data, pendiente de confirmación operativa del cliente si quisieran publicar solo en una sala/tarifa.
- Agora rechaza productos con nombres duplicados aunque tengan `Id` distinto; en Cienvinos se resolvió manualmente para 12 botellas duplicadas con sufijo corto. La desambiguación ya está codificada y desplegada en `generateImportXml`.
- Sa Vida parece tener el módulo/API REST de Agora no disponible en el puerto facilitado, o una versión de Agora que no expone esos endpoints. El servidor responde, así que la hipótesis principal no es red caída sino API no habilitada, puerto/base URL incorrecto o versión no compatible.
- Todas las instalaciones Agora existentes salvo Cienvinos tienen 0 stockIds por variante en `winerim_wines`. Mientras no se haga backfill/re-sync con el `winerim-proxy` actualizado, el stock variant-aware puede depender de fallback runtime y no está preparado con la misma seguridad que Cienvinos.
- Baco Getafe expone `/api/export/tickets/` además de `Invoices`; podría soportar visibilidad intradía en una fase futura, pero no se activa ahora porque la política global Agora sigue priorizando días cerrados e idempotencia de stock.

## Riesgos / pendientes
- Los proxies aplicados solo tienen el guard de breaker, NO usan aún `createResilientFetch` en sus llamadas internas. Próxima iteración: reemplazar `fetch(...)` por la versión throttle dentro de cada proxy.
- Toast tiene su propio breaker alternativo en `provider_config.circuit_breaker` — coexiste con el global. Decidir si unificar.
- Los fixes P0 detectados por auditoría afectan stock, colas y seguridad. Deben aplicarse por lotes pequeños con pruebas/regresiones específicas, no como refactor masivo.
- La documentación Winerim v2 añade oportunidades de rendimiento (`wines/bulk`, `stock/bulk`), pero activarlas sin validar formato real de respuesta y manejo de éxitos parciales puede dejar stocks a medio sincronizar.
- Orden de despliegue recomendado: migraciones primero, edge functions después. Si se invierte el orden, las funciones pueden no encontrar columnas/RPC nuevas.
- Cienvinos ya está activo; riesgo pendiente: primer cierre nuevo con producto WINERIM debe confirmar stock idempotente por variante.
- Sa Vida no debe tratarse como lista ni reintentar importaciones masivas hasta que Agora devuelva 200 en `export-master`/`Invoices`. Forzar escrituras ahora solo aumentaría cola fallida y ruido de breaker.
- Baco Getafe ya está activo; riesgo pendiente: primer cierre nuevo con producto WINERIM debe confirmar stock idempotente por variante.
