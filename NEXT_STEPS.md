# NEXT_STEPS

> Tareas pendientes priorizadas. Al retomar: leer este archivo + `CURRENT_STATE.md`.

## P0 — Integración Agora Cienvinos Ecija
- [x] Crear conexión en Lovable Cloud con credenciales reales y dejarla deshabilitada.
- [x] Probar alcance/credenciales Agora con `agora-proxy test`.
- [x] Sincronizar catálogo Winerim: 378 vinos leídos.
- [x] Backfill seguro de stockIds por variante desde Winerim: 372 botellas, 49 copas, 7 magnums.
- [x] Sincronizar master data Agora: 177 productos, 4 IVAs, 3 price lists, 1 almacén, 3 sale centers.
- [x] Configurar escritura inicial reversible: IVA 10%, `BARRA/BEBIDAS`, almacén general, Barra/Sala/Terraza, familias automáticas.
- [x] Ejecutar preview XML de muestra y preview global sin escribir en Agora.
- [x] Documentar rollback en `ROLLBACK_CIENVINOS_AGORA_2026-05-27.md`.
- [x] Crear familias dedicadas WINERIM en Agora y guardar mapping por tipo/formato.
- [x] Importar catálogo Winerim completo en Agora: 428 productos verificados.
- [x] Confirmar que no hay productos/familias legacy de vino fuera de WINERIM que ocultar.
- [x] Resolver 12 nombres duplicados de Winerim con sufijo corto en Agora.
- [x] Marcar capacidad de escritura Agora como verificada (`can_write_products=YES`, `readiness_status=READY`).
- [x] Cerrar 75 tareas `AGORA_XML_UPSERT_PRODUCT` supersedidas por la importación verificada para dejar la cola sin pendientes.
- [x] Codificar desambiguación automática de nombres duplicados en `generateImportXml` antes de activar auto-push/actualizaciones automáticas de catálogo.
- [x] Aplicar migraciones P0 en Lovable Cloud antes de activar automático: `20260526090000_stock_sync_variant_idempotency.sql` y `20260526091000_user_roles_has_role.sql`.
- [x] Desplegar edge functions actuales después de migraciones, especialmente `agora-proxy`, `winerim-proxy` y `agora-cron-dispatcher`.
- [ ] Confirmar tras despliegue que un preview XML con vinos duplicados genera sufijos deterministas y que Agora no devuelve HTTP 500 por nombre duplicado.
- [ ] Repetir `winerim-proxy fetch-catalog` tras despliegue y confirmar que el proxy ya captura `bottle/glass/magnum_stock_id` sin backfill manual.
- [x] Verificar post-write en Agora: familias creadas, productos visibles, precios en Barra/Sala/Terraza, IVA y preparation correctos.
- [ ] Ejecutar venta/cierre de prueba con producto WINERIM o esperar primer día cerrado con líneas resueltas; validar `save-sales` + `syncStockForDay` con `stock_sync_log.variant`, `stock_id`, `idempotency_key` y respuesta Winerim `previousStock/newStock`.
- [ ] Reejecutar el mismo día y confirmar que no hay doble deducción.
- [x] Activar `enabled=true` por instrucción operativa del usuario, con cursor inicial `last_business_day_synced=2026-05-27` para evitar reescaneos históricos.
- [x] Resolver el `Last Sync Never` operativo: `auto-sync-sales` comprobado manualmente sin días pendientes y `last_sync_at` actualizado tras chequeo real.
- [x] Drenar cola de actualización reaparecida: tareas Cienvinos `AGORA_XML_UPSERT_PRODUCT` terminan en 0 abiertas y 0 fallos.
- [ ] Monitorizar el primer cierre nuevo con productos WINERIM; validar `stock_sync_log.variant`, `stock_id`, `idempotency_key` y respuesta Winerim `previousStock/newStock`.
- [ ] Si el cliente no quiere mantener vinos en los 3 sale centers, ajustar `selected_sale_center_ids` antes de futuras actualizaciones masivas.

## P0 — Revisión flota Agora 2026-05-27
- [x] Actualizar credenciales Sa Vida en Lovable Cloud sin documentar secretos.
- [x] Probar Sa Vida con `agora-proxy test` y `sync-master-data`: endpoints Agora devuelven HTTP `501`.
- [x] Marcar Sa Vida como `UNKNOWN/NOT_CONNECTED/NONE` en `provider_capabilities` para no mostrarla lista.
- [x] Resetear breakers obsoletos de Kava, Luruna y Sa Pedrera tras comprobar endpoints operativos.
- [ ] Pedir a Sa Vida/Agora confirmación de módulo REST habilitado, URL base/puerto correctos y versión compatible con `/api/export-master` + `/api/export`.
- [ ] Reprobar Sa Vida cuando el POS responda 200: `test`, `sync-master-data`, `find-last-business-day`, preview XML y backfill de stockIds antes de cualquier write masivo.
- [x] Hacer backfill/re-sync de stockIds por variante para Katsu, Kava, La Candela, Luruna, Sa Pedrera y Sa Vida con script controlado: 1.881 pares conexión/vino revisados, 1.359 filas actualizadas, 0 errores transitorios.
- [x] Reparar fallos actuales de `stock_sync_log` antes de declarar la flota Agora sana:
  - Sa Vida/Sa Pedrera/Kava/Katsu/La Candela/Luruna: mappings inaccesibles o sin variante marcados `REJECTED`; logs terminales recientes marcados `BLOCKED_TERMINAL`.
  - Auditoría posterior: `FAILED` últimos 24h = 0; mappings confirmados con stockId requerido faltante = 0.
- [x] Añadir guard anti-spam para fallos terminales de stock (`wine not found`, `variant not found`) sin avanzar cursor ni crear logs repetidos cada ciclo.
- [ ] Publicar y confirmar redeploy de los hotfixes de `agora-proxy`/`winerim-proxy` que respetan mappings `REJECTED` y `auto_push_on_update=false`.
- [ ] Decidir si Sa Vida debe pausarse/deshabilitarse hasta resolver HTTP 501/API REST y mappings, porque hoy aparece `enabled=true` aunque las capacidades están `NOT_CONNECTED`.
- [ ] Revisar tareas residuales por instalación tras redeploy:
  - Cienvinos: el runtime antiguo generó 82 updates `MANUAL`; ya se marcaron `SUCCESS` tras verificar que estaban publicados. Vigilar que no reaparezcan hasta redeploy.
  - Kava: `203 QUEUED`, `7 FAILED`, `9 BLOCKED`.
  - Luruna: `117 QUEUED`, `10 FAILED`, `58 BLOCKED`.
  - Sa Pedrera: `201 RUNNING`, `294 FAILED`, `111 BLOCKED`.
  - Sa Vida: backlog grande (`1044 QUEUED`, `3322 FAILED`, `1861 BLOCKED`), no procesar hasta resolver HTTP 501.
- [ ] Decidir limpieza de la conexión `New Location` deshabilitada con URL inválida.
- [ ] Revisar por qué Katsu y La Candela tienen tracking verificado pero `provider_capabilities` en `UNKNOWN/NOT_CONNECTED`; marcar `READY` solo tras verificación de escritura actual.

## P0 — Integración Agora Baco Getafe
- [x] Crear conexión en Lovable Cloud con credenciales reales y dejarla deshabilitada.
- [x] Probar alcance/credenciales Agora con `agora-proxy test`.
- [x] Confirmar endpoints Agora: `Products`, core master, `Invoices` y `Tickets` responden HTTP 200.
- [x] Sincronizar catálogo Winerim: 95 vinos leídos/enriquecidos.
- [x] Backfill seguro de stockIds por variante desde payload Winerim: 83 botellas, 21 copas, 19 magnums.
- [x] Sincronizar master data Agora: 40 familias iniciales, 3.785 productos iniciales, 4 IVAs, 3 price lists, 1 almacén, 5 sale centers.
- [x] Configurar escritura reversible: IVA 10%, `Barra/Bebidas`, almacén general, sale centers `Cafet.`, `Restaurante`, `Terraza`.
- [x] Crear familias dedicadas WINERIM y guardar mappings.
- [x] Ejecutar preview XML global: 118 productos exportables, 0 IDs duplicados tras desambiguación, 82 botellas, 21 copas, 15 magnums.
- [x] Importar catálogo Winerim en Agora y verificar post-write: 118/118 productos presentes, precios en listas 1/2/3, IVA/preparación correctos.
- [x] Corregir tracking/mappings tras timeout de importación: 118 mappings confirmados, formatos no exportables como `NOT_PUSHED`.
- [x] Ocultar familias legacy `VINO`, `FINOS`, `ROSADOS`, `TINTOS`, `CHAMPAGNE`, `BLANCOS`.
- [x] Ocultar 348 productos legacy de vino; verificación final 0 legacy visible/vendible.
- [x] Revisar reporte visual del cliente: el vídeo mostraba familias legacy aún visibles aunque productos no vendibles; se reforzó `ShowInPos=false` en legacy y `ShowInPos=true` en familias `... WINERIM`.
- [x] Corregir reporte de duplicado visual: 118/118 productos Winerim quedan con `UseAsDirectSale=false` para no salir como botones raíz y `SaleableAsMain=true` para seguir vendibles dentro de familias WINERIM; verificado `directRootButtons=0`, `notSaleableAsMain=0`.
- [x] Revisar reporte `Tamaral Crianza copas`: no existe copa de `Tamaral`/Crianza en Winerim; sí existe `C Tamaral Roble (RIBERA)` y `C Tamaral Verdejo` en `COPAS WINERIM`.
- [ ] Si Baco decide reactivar Winerim más adelante, confirmar primero si quieren que Winerim cree/active variante copa para `Tamaral`/Crianza o si `C Tamaral Roble (RIBERA)` era el producto correcto.
- [x] Marcar capacidad de escritura Agora como verificada (`can_write_products=YES`, `readiness_status=READY`).
- [x] Documentar rollback en `ROLLBACK_BACO_GETAFE_AGORA_2026-05-27.md`.
- [x] Aplicar migraciones P0 en Lovable Cloud antes de activar automático: `20260526090000_stock_sync_variant_idempotency.sql` y `20260526091000_user_roles_has_role.sql`.
- [x] Desplegar edge functions actuales después de migraciones, especialmente `agora-proxy`, `winerim-proxy` y `agora-cron-dispatcher`.
- [x] Validar post-redeploy en modo lectura: Baco tiene días cerrados, pero el cierre `2026-05-27` devuelve 0 líneas resueltas contra productos WINERIM; no sirve todavía como prueba real de stock.
- [ ] Validar con el cliente si los vinos deben publicarse también en `MUS` o `Personal`; por ahora quedan excluidos.
- [ ] Ejecutar venta/cierre de prueba con producto WINERIM resuelto; validar `save-sales` + `syncStockForDay` con `stock_sync_log.variant`, `stock_id`, `idempotency_key`.
- [ ] Evaluar en una fase posterior si Baco puede usar `Tickets` intradía con feature flag por conexión; no activar globalmente.
- [x] Activar `enabled=true` por instrucción operativa del usuario, con cursor inicial `last_business_day_synced=2026-05-27` para evitar reescaneos históricos legacy.
- [x] Resolver el `Last Sync Never` operativo: `auto-sync-sales` comprobado manualmente sin días pendientes y `last_sync_at` actualizado tras chequeo real.
- [x] Restaurar `provider_capabilities.can_write_products=YES` tras detectar degradación visual a `UNKNOWN`.
- [x] Revertir Baco a legacy por petición del usuario (2026-05-29): familias/productos Winerim ocultos, legacy restaurado y automatización Winerim apagada.
- [x] Verificar rollback contra Agora: 118 productos Winerim existentes pero 0 visibles/vendibles; 6 familias legacy visibles; 249 productos legacy activos vendibles; 99 productos legacy borrados no reactivados.
- [x] Verificar rollback en Lovable Cloud: `enabled=false`, `catalog_sync_enabled=false`, `write_mode=NONE`, `auto_push_on_create=false`, `auto_push_on_update=false`, `auto_push_verified_ready=false`.
- [ ] Si se decide reactivar Baco con Winerim, hacerlo como nuevo piloto controlado: restaurar visibilidad Winerim desde backup, ocultar legacy, activar conexión y validar una venta/cierre real antes de darlo por automático.

## P0 — Front Agora audit 2026-05-26
- [x] Corregir navegación del wizard: `handleNext` permite llegar al paso 14 `Go Live` (`Math.min(14, s + 1)`).
- [ ] Añadir prueba/render smoke para navegación 13→14.
- [x] Resolver el riesgo de `Save to DB`: el guardado manual sincroniza stock y no actualiza `last_business_day_synced` si Winerim falla.
- [x] Corregir `AgoraTodaysSalesStock` para aceptar `SUCCESS` como estado sincronizado y mostrar `variant`, `stock_id`, `previousStock/newStock` cuando existan.
- [x] Corregir `SyncMonitor` para mostrar la ubicación en cada fila de `Stock Sync` y no confundir fallos de Sa Vida/Sa Pedrera/Kava con Baco/Cienvinos.
- [x] Corregir visualización de conexiones sin `last_sync_at`: si hay cursor diario, muestra `Checked through <fecha>` en vez de `Never`.
- [x] Revisar el cálculo de stock del panel de hoy: ya no mezcla botella/copa/magnum en un “stock antes” calculado; muestra stock por variante desde log o stock global como referencia.
- [x] Ajustar copy de Sales & Mapping / Today: indica días cerrados/post-cierre y evita prometer “today/15 min” como tiempo real.
- [x] Definir soporte MAGNUM en UI de catálogo: preview/push/backfill principales envían `MAGNUM` y backend valida elegibilidad.
- [x] Normalizar booleanos de master data en `AgoraFamilyVisibilityPanel` usando helper tipo `asBool(value, true)` para que `ShowInPos` ausente/null no se marque como oculto.
- [x] Bloquear en `AgoraProductVisibilityPanel` que un producto quede visible si su familia está oculta.
- [x] Añadir confirmación a acciones individuales de “Archivar familia + productos” y corregir el texto que habla de mover a `ARCHIVO WINERIM`.
- [x] En `AgoraManualMatchPanel`, permitir elegir/derivar `formatType` (`BOTTLE`/`GLASS`/`MAGNUM`) en mapping manual.
- [x] Evitar conexiones basura en test: la fila temporal nace deshabilitada y se elimina si el test falla.
- [x] Añadir test unitario para decisión de cursor: stock OK avanza, stock FAILED o token ausente no avanza.
- [x] Añadir test unitario para re-guardar un día ya sincronizado: la clave de grupo `sales_event_id + winerim_product_id + variant` es estable aunque cambie el `sales_line_item_id`.
- [ ] Añadir test/integración mock de `agora-proxy.save-sales` completo con cliente DB/fetch simulado.
- [ ] Añadir test/integración mock de `syncStockForDay`: al re-guardar un día ya `SUCCESS`, debe saltar el grupo y no hacer nuevo PUT.

## P0 — Auditoría Codex 2026-05-26
- [x] Unificar las dos ramas `auto-sync-sales` de `agora-proxy`: se eliminó la rama intradía inalcanzable y se conservó D-1/post-cierre.
- [x] Hacer `stock_sync_log` variant-aware: añadidos `variant`, `stock_id`, `idempotency_key`, índice parcial y compatibilidad con logs legacy.
- [x] Añadir claim/lock atómico para deducciones de stock y colas outbound antes de ejecutar writes externos; colas Agora/Revo usan `claim_outbound_tasks(...)` con fallback.
- [x] Desactivar o refactorizar `restore-glass-overdiscount`: queda dry-run por defecto y solo escribe con `allowLegacyFractionalRestore=true`.
- [x] Cambiar `sync-master-data` para que cualquier lectura de `Products` use `fetchAgoraProductsXmlCached` (con `forceRefresh` solo si se justifica).
- [x] Normalizar aliases de variantes Winerim también en `winerim-proxy` (`copa/glass`, `botella/bottle`, `magnum`) para capturar precio y `erpStock.id` aunque la API devuelva nombres en inglés.
- [x] Validar si `GET /api/v2/stock/{stockId}` existe realmente; decisión defensiva: se eliminó la dependencia para baseline y se usa `GET /stock/wine/{wineId}`.
- [x] Corregir `package-lock.json` para que `npm ci` pase en local/CI.
- [ ] Eliminar `.env` de artefactos/repositorio si está versionado y rotar secretos si los valores del ZIP eran reales. (`.gitignore` ya ignora `.env` y `.env.*`.)
- [x] Implementar base `user_roles` + `has_role() SECURITY DEFINER` sin reemplazar todavía policies `Allow all`.
- [ ] Reemplazar policies `Allow all` por RLS multi-tenant cuando exista modelo de usuarios/roles confirmado.
- [ ] Revisar migraciones con datos operativos de clientes y separar schema/data fixes para evitar mutaciones inesperadas al recrear entornos.
- [x] Corregir bug de incremento de `attempts` en `revo-proxy`.
- [ ] Añadir prueba de regresión específica para el contador `attempts` de Revo.
- [ ] Validar contra Agora si `SortOrder` debe ser `Order`; cambiar solo tras prueba de import XML en conexión controlada.
- [x] Crear tests mínimos de utilidades variant-aware, idempotency key, group key y decisión de cursor.
- [ ] Crear tests de integración/mock para deducción completa, reintentos, doble venta copa+botella del mismo vino, `auto-sync-sales` D-1/intradía, y cache obligatoria de `Products`.
- [ ] Definir estrategia gradual para lint: bloquear errores nuevos y corregir primero hooks/dependencias, `no-explicit-any` en shared/proxies críticos y warnings de Fast Refresh.

## P0 — Despliegue seguro post-cambios
- [x] Publicar cambios P0 en el repo oficial GitHub (`main`, commit `5ecee98`) para que Lovable tenga código, migraciones, tests y rollback.
- [x] Confirmar tras el push que `.env` no se modificó ni se volvió a copiar desde la auditoría.
- [x] Validar en copia limpia antes del push: install, tests unitarios, TypeScript, build, lint acotado y parse TS de Edge Functions críticas.
- [x] Conseguir sesión Lovable Cloud autenticada en Chrome externo para operar el panel Cloud.
- [x] Aplicar primero migraciones `20260526090000_stock_sync_variant_idempotency.sql` y `20260526091000_user_roles_has_role.sql` en Lovable Cloud.
- [x] Desplegar edge functions después de las migraciones.
- [x] Confirmar contra backend real que existen `stock_sync_log.variant`, `stock_sync_log.stock_id`, `stock_sync_log.idempotency_key`, tabla `user_roles` y función `has_role()`.
- [x] Confirmar `claim_outbound_tasks(...)` con firma `p_task_types TEXT[]` usando conexión fake y sin reclamar tareas reales.
- [x] Revertir en fuente los cambios generados por Lovable en `src/integrations/supabase/types.ts` y `AgoraTodaysSalesStock`, conservando el redeploy ya aplicado en Cloud.
- [x] Confirmar que Cienvinos y Baco seguían `enabled=false` tras el redeploy, antes de la activación operativa posterior.
- [x] Activar Cienvinos y Baco: `enabled=true`, `auto_push_verified_ready=true`, `auto_push_on_create=true`, `auto_push_on_update=false`, `last_business_day_synced=2026-05-27`.
- [x] Ejecutar dispatcher manual `sales-stock` por conexión: ambos jobs responden OK, sin breaker, sin preflight fallido y sin días pendientes.
- [x] Procesar las 374 tareas `AGORA_XML_UPSERT_PRODUCT` de actualización que aparecieron para Cienvinos tras los lotes de catálogo/enriquecimiento; resultado final 374 `SUCCESS`, 0 tareas abiertas.
- [x] Restaurar/confirmar `provider_capabilities.can_write_products=YES`, `readiness_status=READY`, `write_mode=XML_IMPORT` en Cienvinos y Baco.
- [x] Corregir `process-xml-outbound-queue` para no dejar tareas `RUNNING` al agotarse el presupuesto temporal.
- [x] Corregir `sync-master-data` para no degradar `can_write_products=YES` a `UNKNOWN` tras una importación XML verificada.
- [x] Cambiar auto-queue de vinos recién `READY` para pasar por `evaluate-auto-push` y respetar gates automáticos.
- [x] Reparar en datos Lovable Cloud los mappings/stockIds antiguos de flota Agora sin tocar stock real: 1.359 filas de `winerim_wines` actualizadas, 1.197 mappings rechazados, 367 logs terminales bloqueados.
- [x] Validar tras reparación que `stock_sync_log` tiene `FAILED=0` en últimas 24h y que no quedan líneas históricas apuntando a mappings rechazados.
- [ ] Confirmar en Lovable Cloud que `agora-proxy` y `winerim-proxy` quedaron redeployados con los hotfixes de cola/capacidades/terminal-stock.
- [ ] Confirmar en Lovable Cloud que el nuevo cambio de `auto-sync-sales` queda desplegado: una conexión sin días pendientes debe actualizar `last_sync_at`.
- [x] Reestablecer capacidades verificadas tras la reparación (`Baco`, `Cienvinos`, `Kava`, `Luruna`, `Sa Pedrera`) a `can_write_products=YES`, `readiness_status=READY`, `write_mode=XML_IMPORT`.
- [ ] Tras redeploy, confirmar que esas capacidades no se degradan en el siguiente `sync-master-data`.
- [ ] Confirmar en preview que `SyncMonitor > Stock Sync` muestra columna Location.
- [ ] Confirmar redeploy de `agora-proxy` con `generateImportXml` emitiendo `UseAsDirectSale=false` / `SaleableAsMain=true`.
- [ ] Tras confirmar redeploy, vigilar Cienvinos durante un ciclo de cron de catálogo y comprobar que no se reencolan updates masivos mientras `auto_push_on_update=false`.
- [ ] Ejecutar una venta de prueba copa+botella en conexión controlada y verificar `stock_sync_log.variant`, `stock_id`, `idempotency_key`, `winerim_response.previousStock/newStock`.
- [ ] Reejecutar el mismo día de ventas y confirmar que `skipped` aumenta sin nuevo PUT a Winerim.
- [ ] Ejecutar `save-sales` manual en conexión controlada y confirmar que devuelve `cursorAdvanced=true` solo con `stockSync.failed=0`.
- [ ] Simular fallo Winerim/token ausente en conexión de prueba y confirmar que `last_business_day_synced` no avanza.
- [ ] Confirmar que el catch-up de `auto-sync-sales` rescata días guardados recientes con stock pendiente sin llamadas PUT nuevas para líneas ya `SUCCESS`.
- [ ] Revisar que `restore-glass-overdiscount` con `apply=true` devuelve `LEGACY_RESTORE_DISABLED` si no se pasa `allowLegacyFractionalRestore=true`.
- [ ] Vigilar 24h `stock_sync_log` por `FAILED` nuevos y `outbound_tasks` por tareas `RUNNING` antiguas.
- [ ] Implementar auto-update diferencial de catálogo antes de poner `auto_push_on_update=true` en Cienvinos/Baco.

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

## P1 — Winerim API v2
- [ ] Probar `POST /api/v2/wines/bulk` con token real y, si devuelve JSON correcto, usarlo para enriquecer lotes de hasta 100 vinos en vez de hacer detalle uno a uno.
- [ ] Probar `PUT /api/v2/stock/bulk` con token real y payload pequeño; confirmar que no devuelve HTML/login y que `errors[]` reporta éxitos parciales como indica la documentación.
- [ ] Si `stock/bulk` queda validado, migrar `syncStockForDay` a chunks de 100 con manejo por item, conservando fallback a PUT individual por feature flag.
- [ ] Capturar `erpStock.identifier` por variante y decidir si mapearlo como SKU/EAN/código externo en Agora.

## P1 — Panel salud en otros wizards
- [ ] Montar `<ConnectionHealthPanel connectionId={...} />` en BdpWizard, RevoWizard, ToastWizard, NumierWizard, IcgWizard, CloverWizard, SimphonyWizard, SquareWizard, CassaWizard, TcposWizard, HioposWizard, TouchBistroWizard.

## P2 — Mejoras
- [ ] Métricas históricas (tabla `proxy_metrics`) en lugar de depender de logs.
- [ ] Alertas automáticas cuando una conexión queda en breaker >2h.
- [ ] Vista "fleet status" en `/integrations` con un `ConnectionHealthPanel` por cada conexión activa.

## Bloqueos / esperando
- Cienvinos: activo en automático desde cursor `2026-05-27`; falta validar primer cierre nuevo con producto WINERIM resuelto.
- Cienvinos: falta confirmación operativa de si los vinos deben mantenerse publicados en Barra, Sala y Terraza o solo en un subconjunto.
- Cienvinos: tras la reparación, el runtime antiguo dejó 82 updates abiertos; ya se marcaron `SUCCESS` al estar publicados/verificados. Esperar redeploy del hotfix `auto_push_on_update=false` y vigilar que no reaparezcan.
- Baco Getafe: revertido a legacy el 2026-05-29; integración Winerim desactivada en Lovable Cloud y oculta en Agora. Cualquier reactivación Winerim requiere nuevo piloto controlado.
- Sa Vida: credenciales cargadas, pero Agora responde HTTP `501` en catálogo y ventas. Esperando corrección externa de API REST/puerto/versión antes de procesar cola o escrituras.
- Lovable Cloud: reparación de stock/mappings aplicada; bloqueo restante: publicar/redeployar hotfixes actuales, drenar colas residuales antiguas, validar el primer descuento de stock WINERIM real y desarrollar auto-update diferencial de catálogo antes de activar `auto_push_on_update`.

## Notas
- Cron `rescue-zombie-outbound-tasks` corre cada 10 min.
- El módulo compartido vive en `supabase/functions/_shared/resilience.ts`. Importar con ruta relativa `../_shared/resilience.ts`.
- Toast tiene su propio breaker en `provider_config.circuit_breaker` — el global lo respeta porque actualiza `pos_connections.circuit_breaker_paused_until`. Convivencia OK pero no ideal.
