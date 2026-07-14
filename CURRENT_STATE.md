# CURRENT_STATE

> Estado vivo del proyecto. Actualizar en cada sesión (y durante si hay cambios significativos).

_Última actualización: 2026-07-14 12:53 CEST_

## Hechos (flujo tSpoonLab/Holded y legacy PurOsushi — 2026-07-14 12:39 CEST)

- Se concreto el flujo solicitado:
  - ventas cerradas Agora -> Holded;
  - pedidos de compra, albaranes, almacenes e inventario/stock desde tSpoonLab;
  - Holded no sera fuente de stock.
- Se verifico en documentacion oficial que tSpoonLab expone pedidos/albaranes de compra pendientes o por rango, almacenes e inventarios, y que Holded API v2 permite crear recibos de venta con permisos configurables por token.
- Se creo `docs/integrations/TSPOONLAB_HOLDED_CLIENT_REQUIREMENTS.md` con los accesos y decisiones que deben pedirse al cliente.
- La base implementada sigue siendo read-only: faltan endpoints de pedidos/stock en el proxy tSpoonLab y `dry-run`/escritura idempotente de recibos en Holded.
- Se detecto que PurOsushi tenia el legacy ocultado de forma reversible el `2026-07-14`; existe snapshot completo de familias y flags de producto para restaurarlo exactamente.
- Se amplio de forma compatible `set-product-visibility` para admitir restauracion exacta de `UseAsDirectSale` y `SaleableAsMain`, manteniendo el parametro anterior `visible`.
- `agora-proxy` se desplego desde `main` commit `72ffcc9` y se valido el nuevo branch exacto en runtime.
- Se restauro el legacy de PurOsushi desde el snapshot:
  - 13 familias procesadas, 11 visibles como antes;
  - 402 productos procesados, 306 vendibles como antes;
  - `0` familias omitidas y `0` productos omitidos;
  - auditoria posterior: `0` diferencias de familia y `0` diferencias de flags de producto.
- `provider_config.legacy_visibility_policy` quedo en `VISIBLE_DURING_PILOT`; se conservaron la instantanea original y el registro de ocultacion para rollback.

### Decision

- Mantener el legacy de PurOsushi visible durante el piloto; los flags exactos ya fueron restaurados y el snapshot se conserva para un rollback posterior.
- El piloto Holded usara preferentemente un recibo de venta diario en borrador, desglosado por IVA y forma de pago, sin mover inventario.
- El piloto tSpoonLab sera solo lectura y no marcara pedidos/albaranes como procesados.

## Hechos (Tintorera · auditoria previa a activacion — 2026-07-14 12:36 CEST)

- Se revalido la conexion Tintorera (`1efe95c0-5fb7-404f-9947-416eed598a46`) en Lovable Cloud:
  - `enabled=false`;
  - `sync_mode=PULL_ONLY`;
  - `write_mode=NONE`;
  - frecuencia prevista de 5 minutos;
  - auto-push de altas/cambios y escritura de catalogo apagados;
  - legacy visible;
  - sin sincronizaciones previas ni cola ejecutada.
- El token Winerim responde HTTP `200` y expone 302 vinos, todos activos y con algun precio:
  - 190 tintos, 67 blancos, 27 espumosos, 10 postre/dulces, 6 rosados y 2 fortificados;
  - 278 precios de botella, 13 de copa, 15 de magnum, 5 de botella pequena, 4 de media botella y 3 de botella tienda.
- `tintorera.dyndns.org` resuelve a `88.17.22.193`, pero TCP `8984` termina en timeout desde la red local de diagnostico y desde Lovable Cloud/backend.
- Las sondas `/api/`, Families y Products no obtuvieron respuesta. No se ha escrito en Agora ni se ha alterado el legacy.
- Se creo `docs/integrations/TINTORERA_AGORA_READINESS_2026-07-14.md` con diagnostico, checklist SAT, activacion controlada y rollback.

### Decision

- Mantener Tintorera bloqueado en modo seguro hasta recuperar lectura de Agora y completar una auditoria read-only.
- Tras recuperar conectividad: snapshot de legacy, familias Winerim con legacy visible, pruebas de botella/copa, alta, cambio de precio y ventas antes de activar automatismos.
- No mapear automaticamente botella pequena, media botella o botella tienda a botella estandar sin acordar la semantica de cada formato.

### Bloqueo

- SAT/cliente debe revisar servidor encendido, Modulo de Servicios de Integracion, API HTTP, escucha en `8984`, IP local fija/reserva DHCP, NAT, firewall y DDNS.

## Hechos (tSpoonLab + Holded + brief partner Agora — 2026-07-14 12:12 CEST)

- Se revisó documentación oficial actual de:
  - tSpoonLab REST API Developers, integración TPV, menús/agrupaciones, recetas/platos e integración contable;
  - Holded API v2 y generación/uso de API Token.
- Se implementó una base nueva, aislada y solo lectura:
  - `_shared/tspoonlab/client.ts`;
  - `tspoonlab-proxy/index.ts`;
  - `_shared/holded/client.ts`;
  - `holded-proxy/index.ts`.
- tSpoonLab soporta en esta fase login documentado por `username/password`, header `rememberme`, contexto `order`/`recipe` y lectura de centros, menús, recetas, platos y albaranes de venta.
- Holded soporta API v2 con Bearer token y lectura de productos, facturas, contactos y almacenes con cursor.
- Ambos proxies leen `req.json()` una sola vez, exigen HTTPS, usan timeout/reintento/circuit breaker por conexión, no exponen credenciales y no contienen acciones de escritura.
- Se añadió `docs/integrations/TSPOONLAB_HOLDED_ARCHITECTURE.md` con fuentes de verdad, flujos, idempotencia, reversión y plan de piloto.
- Se generó y revisó visualmente `output/pdf/Winerim_Agora_brief_partner_v6_2026-07-14.pdf`:
  - 7 páginas A4;
  - catálogo, ventas, stock, tickets abiertos, menús/armonías, tSpoonLab, Holded, seguridad y piloto.
- Validación local:
  - `31/31` tests OK;
  - TypeScript OK;
  - bundles de ambos proxies OK;
  - build frontend OK;
  - `git diff --check` OK;
  - PDF renderizado e inspeccionado sin solapes ni páginas vacías.

### Decisiones

- No desplegar ni activar escrituras tSpoonLab/Holded sin credenciales de piloto y decisiones de propiedad del dato.
- tSpoonLab será fuente de composición/escandallo, no fuente maestra del PVP de vino.
- Holded será destino contable, no fuente de la venta ni del stock operativo de vino.
- Una venta de menú/armonía debe guardar la composición versionada aplicable a esa venta antes de generar consumos Winerim.

### Hipótesis por validar

- Agora puede aportar un identificador estable por documento/línea y el código padre/modificador necesario para resolver selecciones de menú.
- El cliente puede proporcionar un usuario técnico tSpoonLab limitado al centro de coste y libro correctos.
- Holded API v2 expone en la cuenta piloto las series, impuestos, almacenes y documentos que finalmente se decidan.

### Pendiente inmediato

- Obtener credenciales de piloto tSpoonLab y Holded y ejecutar solo `test`/lecturas.
- Confirmar con Agora cómo exporta menús, armonías, modificadores y cancelaciones.
- Diseñar/persistir claves únicas para consumos compuestos y documentos Holded antes de añadir escrituras.
- Hacer `dry-run` y canary; no marcar documentos tSpoonLab como contabilizados hasta persistir el ID confirmado de Holded.

## Hechos (Sa Pedrera · deploy cancelaciones de tickets abiertos — 2026-07-13 15:12 CEST)

- `agora-proxy` se redeployó en Lovable Cloud desde GitHub `main` commit `82c9d89` (`Handle cancelled Agora open tickets`).
- Lovable Cloud validó en runtime que están presentes:
  - `open_tickets_stock_current_day_only`;
  - `open_tickets_restore_stale_previous_days_enabled`;
  - modo `open_ticket_cancellation_restore`.
- Validación post-deploy en Sa Pedrera (`sync-open-tickets`) respondió HTTP `200`:
  - `ticketCount=9`;
  - `savedEvents=9`;
  - `savedLines=94`;
  - `resolvedLines=11`;
  - `unresolvedLines=25`;
  - `stockDeferredLines=11`;
  - `staleDayStockSkippedLines=0`;
  - `stockSync={ synced:0, skipped:0, failed:0 }`;
  - `staleOpenTicketRestore={ checkedEvents:3, disabledEvents:2, restored:2, skipped:0, failed:0 }`.
- Verificación directa posterior:
  - `E510-Izar-Leku Brut Vintage` (`winerim_id=9902`, `stockId=10529`) sigue en `stock=1`;
  - no hubo nuevas escrituras de stock para `E510` después de la compensación manual/idempotente de las `12:56:57 UTC`;
  - la ejecución post-deploy restauró otros dos tickets antiguos/stale:
    - `B R601-Alba Rosé [botella]`: `quantity=-2`, `newStock=4`;
    - `B E504-Llopart Brut Nature Reserva [botella]`: `quantity=-1`, `newStock=5`.

### Pendiente inmediato

- Observar Sa Pedrera durante el siguiente servicio:
  - ventas abiertas del día actual deben quedar capturadas y diferidas si no superan la edad mínima;
  - si se cancela un ticket antiguo, debe restaurarse una sola vez;
  - `Invoices` debe seguir reconciliando definitivamente.

## Hechos (Sa Pedrera · cancelación de ticket abierto `E510` implementada — 2026-07-13 14:57 CEST)

- El usuario confirmó que la venta de `E510-Izar-Leku Brut Vintage` fue cancelada.
- Se corrigió el caso puntual:
  - Winerim stockId `10529` vuelve a `stock=1`;
  - `winerim_wines.stock_quantity` queda en `1`;
  - se insertó una fila compensatoria en `stock_sync_log` con `quantity=-1`, `status=SUCCESS` y modo `open_ticket_cancellation_restore`;
  - el evento `OpenTicket` antiguo quedó marcado con `_stock_sync_eligible=false`, `_open_ticket_cancelled_or_stale=true` y `_open_ticket_reversal_restored_qty=1`.
- Se implementó localmente en `supabase/functions/agora-proxy/index.ts` la protección general:
  - por defecto, los tickets abiertos con `BusinessDay` anterior al día operativo actual no mutan stock (`open_tickets_stock_current_day_only`);
  - cuando un `OpenTicket` antiguo ya no aparece en la sonda actual y no está cubierto por una factura cerrada definitiva, el proxy puede restaurar la diferencia con una fila negativa idempotente (`open_ticket_cancellation_restore`);
  - las facturas cerradas (`Invoices`) siguen siendo la reconciliación definitiva;
  - los logs negativos se tienen en cuenta para no bloquear futuras reconciliaciones por “cantidad ya sincronizada” inflada.
- Validación local:
  - `npx tsc --noEmit --pretty false` OK;
  - bundle esbuild de `agora-proxy` OK;
  - comprobación estática dirigida OK;
  - `git diff --check` OK.
- Vitest se intentó con timeout externo de `30s` sobre `src/test/agoraOpenTicketsStatic.test.ts`, pero volvió a quedarse sin salida y se abortó con `SIGKILL` controlado para no dejar procesos bloqueados.

### Estado

- Desplegado y validado en Lovable Cloud el `2026-07-13 15:12 CEST`.

## Hechos (Sa Pedrera · caso `E510-Izar-Leku` en ticket abierto cancelado — 2026-07-13 14:21 CEST)

- Audio del cliente transcrito localmente:
  - el sábado hizo una venta ficticia de `Izar Leku`, código `E510`;
  - solo tenía `1` botella;
  - dejó la mesa abierta sin cerrar/Z;
  - hoy canceló/cerró la mesa;
  - ahora ve el vino con stock `0` y no visible en la carta/tablet Winerim.
- Se localizó el caso exacto:
  - conexión `Sa Pedrera`: `e2f6ce27-0e94-444f-9d64-09ba425a2b83`;
  - vino Winerim `9902`, `E510-Izar-Leku Brut Vintage`;
  - producto Agora botella `509902`, familia `ESPUMOSOS WINERIM`;
  - mapping confirmado y tracking `BOTTLE=VERIFIED`;
  - Winerim cache actual: activo, precio botella `74`, `stockActive=true`, `stock_quantity=0`, `bottle_stock_id=10529`.
- La venta entró como `OpenTicket`, no como cierre diario:
  - `provider_doc_id=open_ticket:9a5f0b9b-6fea-4df2-bddc-2cc2d073fbad`;
  - `business_day=2026-07-11`;
  - línea original de Agora con `CreationDate=2026-07-11T14:11:38`;
  - usuario Agora `Alai`, sala `Terraza`;
  - línea `B E510-Izar-Leku Brut Vintage`, cantidad `1`, total `74`.
- El stock sync se ejecutó el `2026-07-13 12:20 CEST`:
  - `stock_sync_log.status=SUCCESS`;
  - modo `intraday_day_total_delta`;
  - `desiredQty=1`, `newStock=0`;
  - fallback `sales/import` respondió `skipped=1`, por lo que Winerim ya consideraba esa venta/historial idempotente.
- La sonda actual `probe-open-tickets` devuelve `6` tickets del business day `2026-07-13`; el ticket antiguo de `2026-07-11` ya no aparece como abierto.
- Revisión de alcance:
  - hoy hay `8` eventos `OpenTicket` en Sa Pedrera;
  - solo `1` tiene business day antiguo (`2026-07-11`), y es el caso de `E510`.
- El producto Winerim en Agora sigue publicado/vendible:
  - master data cache `2026-07-13T12:15:07Z`;
  - `509902` está en `ESPUMOSOS WINERIM`, `SaleableAsMain=true`, `UseAsDirectSale=false`;
  - el legacy `Izar-Leku` está no vendible (`SaleableAsMain=false`, `UseAsDirectSale=false`).

### Diagnóstico

- No parece un fallo de catálogo Winerim -> Agora: el botón Winerim de Agora sigue existiendo y está vendible dentro de su familia.
- El problema viene del piloto de tickets abiertos: se descontó una venta tentativa de una mesa abierta antigua, y al cancelarse/cerrarse después, el middleware no revirtió automáticamente el stock.
- Al quedar Winerim con stock `0`, la carta/editor Winerim deja de mostrar el vino como disponible.

### Pendiente inmediato

- Decidir corrección puntual con el cliente/equipo:
  - si la venta fue ficticia y cancelada, reponer `E510` a `1` unidad en Winerim;
  - si quieren que vuelva a estar visible en carta, confirmar que Winerim vuelve a exponerlo tras reponer stock.
- Ajustar el piloto Sa Pedrera antes de seguir descontando tickets abiertos antiguos:
  - opción segura: no mutar stock desde `OpenTicket` cuyo `BusinessDay` sea anterior al día operativo actual;
  - mantener `Invoices` como reconciliación definitiva;
  - valorar captura de tickets abiertos solo como observación hasta tener reversión de cancelaciones.

## Hechos (post-migración `provider_sold_at` + catálogo diferencial — 2026-07-13 13:51 CEST)

- El usuario confirmó que la migración está aplicada y `agora-proxy` redeployado.
- Validación viva de esquema:
  - `sales_line_items.provider_sold_at` existe;
  - `sales_line_items.provider_sold_at_source` existe.
- Ya hay líneas nuevas con hora real de Agora:
  - `provider_sold_at_source="line.CreationDate"`;
  - ejemplos vivos del `2026-07-13` en `Restaurante Cienvinos Ecija` y `Restaurante Triana`.
- El Bejeque quedó validado por el usuario con `queued=0` y `update_skipped:no_agora_changes` en las 4 catas.
- Se drenaron colas activas reales con IDs vivos:
  - `Katsu Izakaya`: `3/3` tareas procesadas OK, cola final `0`;
  - `Restaurante Cienvinos Ecija`: `1/1` tarea procesada OK, cola final `0`.
- Se limpió el breaker residual caducado de `Katsu Izakaya` tras confirmar `test=true` y cola `0`.
- Se actualizó manualmente `last_catalog_sync_at` en conexiones cuyo catálogo completo se validó pero `winerim-proxy` no persistió el timestamp:
  - `Katsu Izakaya`;
  - `Luruna`;
  - `Chiquilla`;
  - además ya se había corregido `Restaurante Triana`, `Cienvinos`, `Casa Nene`, `Kava` y `Sa Pedrera` durante la tanda.
- Se ejecutó `winerim-proxy/fetch-catalog` controlado en conexiones con escritura activa y `auto_push_verified_ready=true`:
  - `Katsu Izakaya`: `85/85` vinos procesados, catálogo completo, `80` candidatos de update revisados, cola final `0`, fallos nuevos `0`.
  - `Restaurante Cienvinos Ecija`: `457` vinos listados, primer lote `200`, `54` candidatos de update; `53` saltaron por `update_skipped:no_agora_changes` y `1` update real se procesó OK; cola final `0`.
  - `Casa Nene`: `313` vinos listados, primer lote `200`, `no_catalog_changes_detected`, cola final `0`.
  - `Kava`: `208` vinos listados, primer lote `200`, `7` candidatos de update; todos `update_skipped:no_agora_changes`, cola final `0`.
  - `Luruna`: `138/138` vinos procesados, `4` candidatos de update, cola final `0`.
  - `Sa Pedrera`: `468` vinos listados, primer lote `200`, `22` candidatos de update; todos `update_skipped:no_agora_changes`, cola final `0`. Mantiene deuda histórica (`1255` outbound fallidos/bloqueados y `115` stock pendiente/fallido), pero no se crearon fallos nuevos.
  - `Restaurante Qtomas`: `1393` vinos listados, primer lote `200` correcto; al continuar enriquecimiento, Agora dejó de responder a `/api/import/` con `No route to host`, abrió breaker `POS_DOWN` hasta `2026-07-13T13:05:09Z` y quedaron `60` tareas `QUEUED` diferidas hasta el fin del breaker.
  - `Chiquilla`: `69/69` vinos procesados, `26` candidatos de update, cola final `0`; mantiene `3` fallos outbound históricos.
  - `Restaurante Triana`: `107/107` vinos procesados, `30` candidatos de update; todos `update_skipped:no_agora_changes`, cola final `0`.
- Evidencia de ventas/stock recientes desde middleware:
  - `El Bejeque`: stock `SUCCESS` hoy con botella y copa.
  - `Katsu Izakaya`: stock `SUCCESS` hoy con botella y copas; varias copas usan `sales/import` cuando corresponde.
  - `Kava`: stock `SUCCESS` hoy con botella y copas; copas con `sales/import`.
  - `Casa Nene`: stock `SUCCESS` hoy; al menos una línea usa `sales/import`.
  - `Cienvinos Ecija`: ventas de `2026-07-13` y stock `SUCCESS` hoy; copas y botellas con `sales/import` cuando corresponde.
  - `Sa Pedrera`: ventas de `2026-07-13` y stock `SUCCESS` hoy.
  - `Qtomas`: ventas de `2026-07-13` y stock `SUCCESS` hoy.
  - `Restaurante Triana`: ventas de `2026-07-13` con `provider_sold_at`, pero sin `stock_sync_log` todavía porque no se observaron líneas de vino mapeadas en la muestra.
- Bloqueos vivos:
  - `Restaurante Jardi`: sigue bloqueado por red (`No route to host` contra DDNS/puerto `8984`).
  - `El Higuerón`: Agora responde `401`; Winerim OK, pero falta clave API HTTP válida o permiso API correcto.
  - `O Bistro`: timeout desde Lovable Cloud/backend; la IP recibida es privada y no sirve desde backend.
  - `Tintorera`: timeout desde Lovable Cloud/backend.
  - `Saddle`: timeout desde Lovable Cloud/backend en sonda corta; está read-only.
  - `Taberna de Elia`: Agora responde OK y ventas llegan, pero no hay catálogo Winerim publicado (`verified=0`, `auto_push_*` apagado, `ready=false`) por la decisión previa de no volcar directo sin validar estructura legacy.
  - `Sa Vida`: Agora responde OK y ventas llegan; `auto_push_verified_ready=false`, aunque hay mucho tracking verificado. Mantiene deuda histórica de stock de mayo por intentos de stock negativo. No se activó `ready` para evitar publicar muchos `NOT_PUSHED` sin prueba controlada.

### Decisiones / criterio operativo

- El flujo correcto para probar catálogo/precios es `winerim-proxy/fetch-catalog`; `agora-proxy` no tiene acción `fetch-catalog`.
- Las conexiones `READY` pueden mantener `auto_push_on_update=true`: el guard diferencial evita reimportar cuando Agora ya coincide con Winerim.
- No activar `auto_push_verified_ready` en `Sa Vida` sin una sonda controlada más amplia o autorización expresa, porque existen `NOT_PUSHED` y podría publicar muchos formatos de golpe.
- No activar Taberna de Elia en modo Winerim automático hasta resolver la decisión comercial/operativa sobre mantener estructura legacy por regiones o publicar familias Winerim dedicadas.

### Pendiente inmediato

- Repetir `fetch-catalog` o esperar los lotes encadenados para catálogos grandes (`Cienvinos`, `Casa Nene`, `Kava`, `Sa Pedrera`, `Qtomas`) y confirmar que el último lote actualiza `last_catalog_sync_at`.
- Resolver por conexión:
  - `Jardi`: SAT/cliente debe arreglar DDNS/router/firewall/servidor.
  - `Higuerón`: pedir clave API HTTP válida; el error es `401`.
  - `O Bistro`: pedir URL pública/DDNS o túnel, no IP privada `192.168.x.x`.
  - `Tintorera` y `Saddle`: confirmar conectividad externa.
  - `Taberna de Elia`: decidir si se publican familias Winerim dedicadas sin ocultar legacy o si se hace matching legacy.
  - `Sa Vida`: decidir activación controlada de `auto_push_verified_ready`.

## Hechos (post-deploy Agora + cola viva — 2026-07-13 13:05 CEST)

- Se comprobó el estado después del despliegue manual indicado por el usuario.
- La base viva aún no tiene las columnas `sales_line_items.provider_sold_at` y `sales_line_items.provider_sold_at_source`: la API devuelve `42703 column sales_line_items.provider_sold_at does not exist`.
- El `agora-proxy` que estaba en GitHub antes de esta sesión no contenía los cambios locales de:
  - hora real de venta por línea (`provider_sold_at`);
  - `sales/import` cuando la variante tiene `stockActive=false`;
  - guard diferencial `update_skipped:no_agora_changes` para no reencolar `AUTO_UPDATE` si Agora ya coincide con Winerim.
- Se creó y subió a GitHub `main` el commit `5b5fcdb` (`Fix Agora sales timing and update idempotency`) con:
  - `supabase/functions/agora-proxy/index.ts`;
  - migración `20260713073627_add_agora_provider_sold_at_to_sales_lines.sql`.
- Validación local disponible:
  - `npx tsc --noEmit --pretty false` OK;
  - bundle esbuild de `agora-proxy` OK;
  - `git diff --check` OK.
- La suite Vitest se quedó colgada incluso ejecutando archivos individuales; se abortó para no bloquear la operación. No se observaron errores de compilación TypeScript ni de bundle.
- Foto viva de los 8 prioritarios tras el despliegue manual anterior:
  - `El Bejeque`: test OK, `0` tareas activas, `2` outbound fallidos históricos, `0` stock pendiente/fallido.
  - `Katsu Izakaya`: test OK, `73` tareas activas `AUTO_UPDATE`, `0` stock pendiente/fallido.
  - `Restaurante Cienvinos Ecija`: test OK, `4` tareas activas, `0` stock pendiente/fallido.
  - `Casa Nene`: test OK, `0` tareas activas, `0` stock pendiente/fallido.
  - `Kava`: test OK, `16` tareas activas, `26` stock pendiente/fallido histórico.
  - `Restaurante Jardi`: test falla por red (`No route to host` contra DDNS/puerto `8984`), `0` tareas activas.
  - `Luruna`: test OK, `0` tareas activas, `2` stock pendiente/fallido histórico.
  - `Sa Pedrera`: test OK, `0` tareas activas, `1255` outbound fallidos/bloqueados históricos y `115` stock pendiente/fallido histórico.
- Foto viva de las conexiones que el usuario pidió llevar al 100%:
  - `Taberna de Elia`: test OK, ventas guardadas, sin colas/fallos, pero auto-push create/update apagados y `ready=false`.
  - `O Bistro`: conexión desactivada/read-only (`write_mode=NONE`), sin ventas; test desde backend no concluyente.
  - `Tintorera`: conexión desactivada/read-only (`write_mode=NONE`), sin ventas; test desde backend no concluyente.
  - `El Higuerón`: conexión desactivada/read-only; Winerim OK en auditoría previa, Agora devuelve `401`.
  - `Restaurante Qtomas`: test OK, create automático activo, open tickets activo, sin colas/fallos; `auto_push_on_update=false`.
  - `Chiquilla`: test OK, create automático activo, open tickets activo, `3` outbound fallidos históricos; `auto_push_on_update=false`.
  - `Restaurante Triana`: test OK, create automático activo, open tickets activo, sin colas/fallos; `auto_push_on_update=false`.
  - `Restaurante Jardi`: bloqueado por conectividad externa.
  - `Sa Vida`: test OK y ventas guardadas, pero `ready=false` y `177` stock pendiente/fallido histórico.

### Decisiones / criterio operativo

- No declarar cambios de precio automáticos al 100% hasta que Lovable Cloud tenga aplicado el commit `5b5fcdb` y la migración de `provider_sold_at`.
- No lanzar `fetch-catalog` masivo con `auto_push_on_update=true` hasta que una sonda `evaluate-auto-push UPDATE` sobre producto verificado devuelva `update_skipped:no_agora_changes`.
- Para conexiones con stock Winerim desactivado, el criterio operativo sigue siendo registrar venta con `POST /api/v2/sales/import` sin descontar stock.

### Pendiente inmediato

- Aplicar en Lovable Cloud la migración `20260713073627_add_agora_provider_sold_at_to_sales_lines.sql`.
- Redeploy de `agora-proxy` desde GitHub `main` commit `5b5fcdb`.
- Repetir sonda controlada en `El Bejeque`:
  - esperado: `queued=0`, `update_skipped:no_agora_changes`;
  - si pasa, drenar y revisar Katsu/Cienvinos/Kava.
- Repetir auditoría por conexión para `Taberna de Elia`, `O Bistro`, `Tintorera`, `El Higuerón`, `Qtomas`, `Chiquilla`, `Triana`, `Jardi` y `Sa Vida`.

## Hechos (Winerim ERP · historial visible por restaurante — 2026-07-13 05:05 CEST)

## Hechos (Winerim ERP · historial visible por restaurante — 2026-07-13 05:05 CEST)

- Se entró en Mantalak/Admin → `Cartas` y después en `/erp/{menuId}/sales` para revisar el historial visible en Winerim, restaurante por restaurante.
- Criterio usado:
  - si la venta muestra etiqueta `TPV`, se considera evidencia visible de POS → Winerim;
  - si la venta aparece sin `TPV`, no se cuenta como evidencia visible de integración POS aunque haya historial de ventas;
  - horas `00:00` o `02:00` apuntan a importación por cierre/reconciliación, no a tiempo real;
  - horas reales de servicio (`08:xx`, `18:xx`, `19:xx`, etc.) pueden indicar intradía/open tickets, pero hay que confirmar contra logs cuando Lovable Cloud/backend responda.
- Evidencia visible de TPV con horas de servicio:
  - `Casa Nene` (`menuId=871`): última fecha visible `11 Julio 2026`, TPV a `08:52`, `08:51`, `06:35`.
  - `Sa Pedrera` (`menuId=80`): última fecha visible `11 Julio 2026`, TPV a `08:55`, `08:52`, `08:51`, `08:50`, etc.
  - `Restaurante Jardi` (`menuId=942`): última fecha visible `11 Julio 2026`, TPV a `08:55`.
- Evidencia visible de TPV, pero no tiempo real claro:
  - `El Bejeque` (`menuId=282`): ventas TPV solo hasta `11 Julio 2026 02:00`.
  - `Katsu Izakaya` (`menuId=1019`): ventas TPV visibles hasta `09 Julio 2026 00:00`; había otra carta `1020` vacía.
  - `Kava` (`menuId=563`): TPV visible hasta `09 Julio 2026`, principalmente `02:00/02:05`.
  - `Chiquilla` (`menuId=140`): TPV visible hasta `11 Julio 2026 02:00`.
  - `Cienvinos Ecija` (`menuId=861`): TPV visible hasta `10 Julio 2026`, con mezcla `02:00/00:00`.
  - `Luruna` (`menuId=587`): TPV visible hasta `09 Julio 2026 00:00`.
- Historial visible, pero sin etiqueta `TPV` en la pantalla revisada:
  - `Sa Vida` (`menuId=568`): ventas hasta `12 Julio 2026 00:00`, sin etiqueta TPV.
  - `PurOsushi` (`menuId=758`): ventas hasta `04 Julio 2026`, sin etiqueta TPV.
  - `O Bistro` exacto (`menuId=931`): ventas hasta `12 Julio 2026 00:00`, sin etiqueta TPV.
  - `Taberna de Elia` (`menuId=657`): ventas hasta `01 Julio 2026 00:00`, sin etiqueta TPV.
  - `El Higuerón` (`menuId=1089`): ventas visibles `09 Julio 2026 18:13`, sin etiqueta TPV.
  - `Qtomas` (`menuId=310`): ventas visibles hasta `10 Julio 2026 00:00`, sin etiqueta TPV.
  - `Don Quijote Marbella` (`menuId=839`), `Faena Restaurante` (`menuId=442`) y otros con ventas visibles sin etiqueta TPV.
- Sin ventas visibles o sin evidencia útil en el historial:
  - `Don Bernardo Ponzano` (`menuId=809`): `0,00 €`.
  - `Don Bernardo Santander / Beher` (`menuId=218`): `0,00 €`.
  - `La Candela de Triana` (`menuId=956`): `0,00 €`.
  - `Restaurante Triana` (`menuId=896`): `0,00 €`.
  - `Saddle` (`menuId=1216`): `0,00 €`.
  - `Tintorera` (`menuId=893`): `0,00 €`.
  - `Baco Getafe` (`menuId=394`): tiene ventas visibles y alguna evidencia TPV histórica, pero la última fecha visible (`01 Julio 2026`) no muestra TPV en el primer bloque y la integración está desactivada/legacy.
- Búsquedas no concluyentes:
  - `Abadía Yuste`: no aparece como carta exacta `Abadía Yuste`/`Yuste`/`Vettonia`; no se atribuye a otras Abadías.
  - `De la O`: la búsqueda devuelve múltiples cartas no concluyentes; no se atribuye a una sin confirmación.

### Diagnóstico

- `El Bejeque` no está demostrando tiempo real en Winerim: el ERP solo muestra TPV hasta `11 Julio 2026 02:00`.
- `Katsu Izakaya` sí muestra ventas TPV, pero no recientes ni intradía: último visible `09 Julio 2026 00:00`.
- `Casa Nene`, `Sa Pedrera` y `Jardi` son las únicas con evidencia visual de TPV en horario de servicio en esta revisión.
- Varios restaurantes tienen ventas en Winerim, pero sin etiqueta `TPV`; no se puede afirmar que esas ventas vengan del middleware sin cruzarlas con logs cuando Lovable Cloud/backend responda.

### Pendiente inmediato

- Cruzar esta foto ERP con `sales_events`, `stock_sync_log`, `winerim_response.salesImport`, `connection_alerts` y `outbound_tasks` cuando Lovable Cloud/backend deje de devolver `522`.
- Revisar por qué conexiones con piloto open tickets documentado (`El Bejeque`, `Katsu`, `Kava`, `Chiquilla`, `Cienvinos`, `Luruna`) no muestran ventas intradía recientes en ERP.

## Hechos (8 Agora prioritarios · catálogo y cambios de precio — 2026-07-13 11:45 CEST)

- Se revisaron los 8 Agora pedidos: `El Bejeque`, `Katsu Izakaya`, `Restaurante Cienvinos Ecija`, `Casa Nene`, `Kava`, `Restaurante Jardi`, `Luruna` y `Sa Pedrera`.
- Se limpió la cola operativa tras la revisión:
  - `El Bejeque`: `0` tareas activas / `0` fallos nuevos del día.
  - `Katsu Izakaya`: se drenó una tanda de `AUTO_UPDATE`; quedó en `0` tareas activas / `0` fallos nuevos del día.
  - `Restaurante Cienvinos Ecija`: `0` tareas activas / `0` fallos nuevos del día.
  - `Casa Nene`: `0` tareas activas / `0` fallos nuevos del día.
  - `Kava`: `0` tareas activas / `0` fallos nuevos del día.
  - `Luruna`: `0` tareas activas / `0` fallos nuevos del día.
  - `Sa Pedrera`: se drenó la cola pendiente; quedó en `0` tareas activas / `0` fallos nuevos del día.
  - `Restaurante Jardi`: `0` tareas activas, pero la sonda viva sigue bloqueada por red (`NETWORK_UNREACHABLE / No route to host` contra el DDNS/puerto `8984`).
- Se corrigieron mappings que causaban `404 Wine not found/not accessible` en Winerim:
  - `Casa Nene`: mappings confirmados contra vinos inactivos/no accesibles pasados a `REJECTED`.
  - `Kava`: vinos inactivos ocultados en Agora y mappings antiguos pasados a `REJECTED`.
  - `Luruna`: vino inactivo ocultado en Agora y mappings antiguos pasados a `REJECTED`.
- Se activó `auto_push_on_update=true` en las 7 conexiones alcanzables para preparar cambios de precio, pero la sonda real mostró que el runtime desplegado todavía no contiene el guard diferencial `update_skipped:no_agora_changes`.
- Consecuencia operativa observada: con el runtime actual, `AUTO_UPDATE` puede reencolar productos ya verificados aunque no haya cambio real de precio/catálogo. Se implementó localmente el guard diferencial en `supabase/functions/agora-proxy/index.ts`, pero queda pendiente su despliegue en Lovable Cloud.
- Validación local del código:
  - `npx tsc --noEmit --pretty false` OK.
  - bundle esbuild de `agora-proxy` OK.
  - `git diff --check` OK.

### Decisiones / criterio operativo

- No volver a lanzar pruebas masivas de `fetch-catalog`/`AUTO_UPDATE` hasta desplegar el guard diferencial de `agora-proxy`; hacerlo ahora puede reabrir colas sin cambios reales.
- Tratar `Restaurante Jardi` como bloqueo externo de conectividad: no se puede dejar al 100% desde middleware mientras Lovable Cloud/backend no alcance el servidor Agora.
- Las altas nuevas (`auto_push_on_create`) quedan preparadas en las conexiones alcanzables; los cambios de precio requieren el redeploy del guard para quedar automáticos sin ruido.

### Pendiente inmediato

- Desplegar `agora-proxy` desde el repo local actual en Lovable Cloud.
- Tras el redeploy, repetir una sonda controlada `evaluate-auto-push` `UPDATE` sobre un vino ya verificado: debe devolver `update_skipped:no_agora_changes` y no crear `outbound_tasks`.
- Repetir auditoría de los 8 tras el redeploy y declarar conexión por conexión:
  - alta nueva Winerim -> Agora OK;
  - cambio de precio Winerim -> Agora OK;
  - cola `0`;
  - ventas/historial sin fallos recientes.

## Hechos (status global conexiones · 2026-07-13 04:18 CEST)

- Se solicitó un estado de **todas** las conexiones.
- La lectura viva de `pos_connections` vía Lovable Cloud/backend no está disponible en este momento: la API REST devuelve HTTP `522` (`Connection timed out`).
- No se hicieron escrituras ni cambios operativos en conexiones.
- El status preparado para la sesión se basa en:
  - la documentación operativa vigente de `CURRENT_STATE.md`;
  - auditorías directas recientes contra APIs Agora/Winerim documentadas;
  - decisiones previas registradas en `DECISIONS_LOG.md`.
- La foto debe tratarse como **provisional hasta reintentar contra Lovable Cloud/backend** cuando deje de devolver `522`.

### Pendiente inmediato

- Reintentar una consulta viva de `pos_connections`, `sales_events`, `stock_sync_log`, `outbound_tasks`, `winerim_push_tracking` y `connection_alerts` cuando Lovable Cloud/backend responda.
- Emitir entonces un status vivo con timestamps reales de última venta, último descuento, cola abierta y alertas por conexión.

## Hechos (Sync Monitor vacío · 2026-07-13 10:18 CEST)

- Se revisó por qué `/sync-monitor` aparece vacío.
- El `Sync Monitor` no tiene una fuente especial de Agora: lee directamente `pos_connections`, `sales_events`, `stock_sync_log` y `outbound_tasks`.
- Sondas REST con la misma clave pública del frontend:
  - `pos_connections`: timeout de 20s / HTTP `000` sin bytes;
  - `sales_events`: HTTP `522`;
  - `stock_sync_log`: HTTP `522`;
  - `outbound_tasks`: HTTP `522`.
- El error `522` indica timeout de conexión entre Cloudflare y el origen del backend. No significa que Agora no tenga datos ni que las integraciones hayan desaparecido.
- Se detectó un bug de UI: `SyncMonitor.tsx` ignoraba `connRes.error`, `eventsRes.error`, `logsRes.error` y `outboundRes.error`, usaba `data || []` y mostraba estados vacíos como si no hubiera conexiones.
- Se corrigió localmente `src/pages/SyncMonitor.tsx` para:
  - conservar datos previos si una query falla;
  - mostrar una alerta visible con el error real;
  - no mostrar mensajes falsos tipo “No connections found” cuando hay fallo de carga;
  - mantener timestamp de la última carga correcta.
- Validación local: `npx tsc --noEmit` OK.

### Decisiones

- Tratar pantallas vacías del monitor como fallo de carga hasta confirmar que las queries responden `200`.
- No diagnosticar Agora desde `/sync-monitor` mientras Lovable Cloud/backend devuelva `522`; para casos urgentes usar auditoría directa contra APIs Agora/Winerim.

### Tareas pendientes

- Desplegar el fix de UI de `SyncMonitor.tsx`.
- Revisar Lovable Cloud/backend: si el `522` persiste, escalar como incidencia de infraestructura/capacidad antes de seguir usando el monitor como fuente de verdad.

## Hechos (El Bejeque e Higuerón · auditoría directa — 2026-07-11 11:12 CEST)

- Lovable Cloud/backend sigue con timeouts/HTTP `522` en lecturas REST/Edge Functions, por lo que esta auditoría se hizo en modo directo contra APIs externas de Ágora y Winerim, sin escrituras.
- `El Bejeque`:
  - Ágora responde correctamente con la clave API HTTP:
    - `GET /api/export-master/?filter=Families`: HTTP `200`;
    - `GET /api/export-master/?filter=Products`: HTTP `200`;
    - `GET /api/export/?business-day=2026-07-10&filter=Invoices`: HTTP `200` (`12` facturas);
    - `GET /api/export/tickets/`: HTTP `200` (`0` tickets abiertos en el momento de la sonda).
  - Winerim responde correctamente:
    - catálogo listado: `73` vinos;
    - detalle enriquecido: `73/73` OK;
    - formatos activos con precio esperados: `98`.
  - Cruce Winerim activo/con precio -> Ágora:
    - faltantes en Ágora: `0`;
    - familia incorrecta: `0`;
    - productos no vendibles por `SaleableAsMain=false`: `0` en los `98` formatos esperados.
  - Las familias Winerim están visibles en Ágora:
    - `TINTOS WINERIM`: `39` productos, `39` vendibles;
    - `BLANCOS WINERIM`: `16` productos, `14` vendibles;
    - `ROSADOS WINERIM`: `3` productos, `3` vendibles;
    - `ESPUMOSOS WINERIM`: `8` productos, `8` vendibles;
    - `DULCE WINERIM`: `6` productos, `6` vendibles;
    - `FORTIFICADOS WINERIM`: `2` productos, `2` vendibles;
    - `MAGNUM WINERIM`: `6` productos, `6` vendibles;
    - `COPAS WINERIM`: `21` productos, `20` vendibles.
  - Los productos Winerim están publicados como `UseAsDirectSale=false` y `SaleableAsMain=true`, que es el patrón correcto para vender dentro de familia sin generar botones raíz sueltos.
  - Legacy visible de vino: `0` familias. Las familias legacy `VINOS`, `BLANCOS`, `TINTOS`, `ESPUMOSO`, `POSTRE`, `FORTIFICADO`, `ROSADO` siguen ocultas.
  - Productos legacy de esas familias: `8` restos detectados, todos no vendibles (`UseAsDirectSale=false`, `SaleableAsMain=false`).
  - Hay `3` productos extra dentro de familias Winerim que ya no forman parte del set Winerim activo/con precio actual, pero están no vendibles:
    - `B Cloe` en `BLANCOS WINERIM`;
    - `B Juan Escudero Marmajuelo` en `BLANCOS WINERIM`;
    - `C Cloe` en `COPAS WINERIM`.
- `El Higuerón`:
  - Winerim API responde correctamente con el token facilitado (`GET /api/v2/wines?page=1&limit=5`: HTTP `200`).
  - Ágora devuelve HTTP `401` con la clave facilitada en todos los endpoints probados:
    - `GET /api/export-master/?filter=Families`;
    - `GET /api/export-master/?filter=Products`;
    - `GET /api/export/?business-day=2026-07-10&filter=Invoices`;
    - `GET /api/export/tickets/`.

### Decisiones / criterio operativo

- Tratar `El Bejeque` como catálogo Winerim publicado correctamente: todo lo activo/con precio de Winerim está en Ágora, dentro de familias Winerim y vendible dentro de familia.
- No tocar los `3` extras de Bejeque en esta sesión porque ya están no vendibles y no afectan a sala. Se revisarán por middleware cuando Lovable Cloud/backend vuelva a responder y pueda refrescar `sync-master-data`.
- Tratar `El Higuerón` como bloqueado por Ágora/API HTTP, no por Winerim. El siguiente paso es pedir al SAT/cliente una clave API HTTP literal válida y confirmar que el módulo API HTTP está activo.

### Pendiente inmediato

- `El Bejeque`: cuando Lovable Cloud/backend responda, ejecutar `sync-master-data` para actualizar caché interna después de la ocultación legacy y confirmar que los `3` extras quedan también documentados como no vendibles.
- `El Bejeque`: pedir al cliente una venta real desde una familia Winerim y comprobar que llega a historial/stock Winerim.
- `El Higuerón`: no publicar familias Winerim ni activar ventas hasta resolver el `401` de Ágora.

## Hechos (Agora open tickets + copas por precio Winerim — 2026-07-11 08:15 CEST)

- Se confirmo una contradiccion importante: los cambios de piloto `probe-open-tickets` / `sync-open-tickets` existian en una copia local no trackeada (`bridge-to-winerim-audit`), pero no en el repositorio GitHub que Lovable Cloud despliega (`goiko111/bridge-to-winerim`).
- Se corrigio el repositorio oficial en `/Users/GOIKO/Documents/Playground/bridge-to-winerim-github`.
- Commits subidos a GitHub `main`:
  - `a932bdb` (`Add Agora open tickets pilot`);
  - `97eadf5` (`Document Agora open tickets deployment state`).
- `agora-proxy` incorpora:
  - accion `probe-open-tickets` solo lectura contra `/api/export/tickets/`;
  - accion `sync-open-tickets` protegida por `provider_config.open_tickets_sync_enabled`;
  - descuento de stock desde tickets abiertos solo si `provider_config.open_tickets_stock_sync_enabled=true`;
  - retardo configurable `provider_config.open_tickets_min_line_age_minutes` para no descontar lineas recien tocadas en mesa abierta;
  - persistencia de `last_open_tickets_sync` en `provider_config` para auditoria.
- `agora-cron-dispatcher` incorpora llamada a `sync-open-tickets` dentro del job `sales-stock` solo si la conexion tiene `provider_config.open_tickets_sync_enabled=true`.
- Se relajo la regla de publicacion de copas: para formato `GLASS` ya no es bloqueo duro `serve_by_glass=true`; basta con que Winerim tenga `glass_sale_price>0`. Si el boolean antiguo no viene activo se deja warning `serve_by_glass_not_enabled_but_glass_price_present`.
- Se mantiene la regla de ocultacion/retiro: una copa sin precio de copa en Winerim se considera no publicable y puede ocultarse si antes estaba en Agora.
- Se anadio test estatico `src/test/agoraOpenTicketsStatic.test.ts` para comprobar que el repo real contiene los handlers, flags y guards criticos.
- Validacion local:
  - `npm ci` OK;
  - `npm test -- --pool=forks --maxWorkers=1 --minWorkers=1 --reporter=dot` OK (`5` archivos, `22` tests);
  - `npx tsc --noEmit --pretty false` OK;
  - bundle esbuild de `agora-proxy` OK;
  - bundle esbuild de `agora-cron-dispatcher` OK;
  - `git diff --check` OK.

### Riesgos / rollback

- El piloto de tickets abiertos queda apagado por defecto. Sin flags en `provider_config`, `sync-open-tickets` devuelve `open_tickets_sync_disabled` y no escribe stock.
- Activar `open_tickets_stock_sync_enabled=true` en una conexion debe hacerse solo tras probar `probe-open-tickets` y revisar que las lineas abiertas traen IDs de producto mapeables.
- Rollback tecnico: revertir el commit de esta sesion en GitHub y redesplegar `agora-proxy` + `agora-cron-dispatcher`. Como los flags quedan apagados por defecto, tambien se puede rollback operativo desactivando `provider_config.open_tickets_sync_enabled`.
- Para Sa Pedrera, el cambio de copas corrige el caso de vinos con precio de copa en Winerim pero sin `serve_by_glass=true`; no elimina la necesidad de verificar visualmente que el producto aparece en `COPAS WINERIM` o la familia dedicada acordada.

### Pendiente inmediato

- Pedir redeploy en Lovable Cloud de `agora-proxy` y `agora-cron-dispatcher` desde `main`.
- Tras redeploy, ejecutar:
  - `probe-open-tickets` en Sa Pedrera;
  - `sync-open-tickets` con flags apagados para confirmar `open_tickets_sync_disabled`;
  - activar primero solo `open_tickets_sync_enabled=true` y validar captura sin stock;
  - activar `open_tickets_stock_sync_enabled=true` solo cuando la captura sea correcta.
- Repetir sonda de `evaluate-auto-push` para el vino de copa que no subia y confirmar que ya no aparece `glass_skipped:serve_by_glass_not_enabled`.

## Hechos (Flota Agora · auditoria y backfill historial 0->0 — 2026-06-26 12:38 CEST)

- Se ejecuto una nueva auditoria viva de las `12` conexiones Agora y se documento `AGORA_FLEET_AUDIT_2026-06-26_1238.md`.
- La auditoria de POS/Agora fue observacional:
  - no se ejecuto `fetch-catalog` masivo;
  - no se reintento `outbound_tasks`;
  - no se escribio en Agora.
- Se aplico el mismo criterio de Cienvinos a toda la flota para ventas ya marcadas `stock_sync_log.SUCCESS` con `previousStock === newStock`:
  - se uso `POST /api/v2/sales/import`;
  - no se modifico stock;
  - se usaron `orderId` deterministas;
  - se anotaron las filas corregidas con `winerim_response.salesImportBackfill`.
- Backfill completado:
  - `Casa Nene`: `10` filas anotadas, `7` importadas y `1` skipped idempotente;
  - `Katsu Izakaya`: `1` fila historica importada; ahora `3/6` `SUCCESS` tienen historial importado cuando eran `0->0`;
  - `Kava`: `29` filas anotadas, `14` grupos importados;
  - `Restaurante Jardi`: `9` filas anotadas, `9` grupos importados;
  - `Restaurante Cienvinos Ecija`: sin pendientes nuevos; ya estaba completo;
  - `Sa Pedrera`: `69/90` `SUCCESS` ya tienen `salesImportBackfill`; quedan `19` filas `0->0` sin backfill porque Winerim ya no expone la misma variante o devuelve `404`.
- Sa Pedrera:
  - se recuperaron `2` grupos con stockId actual de la misma variante:
    - `C E508- Cygnus Sador Brut Nature Reserva [copa]`: `330722 -> 340357`;
    - `C B321- EL Perro Verde [copa]`: `327364 -> 340370`.
  - no se forzaron conversiones de variante, por ejemplo copas donde Winerim solo expone botella.
- Estado operativo resumido tras auditoria:
  - `OPERATIVA`: `Katsu Izakaya`, `Restaurante Cienvinos Ecija`;
  - `OPERATIVA PARCIAL`: `Casa Nene`, `Kava`, `Restaurante Jardi`;
  - `NO DESCUENTA`: `La Candela de Triana`, `Luruna` (ventas llegan, pero `mapped=0` y `stock_sync_log=0`);
  - `DEUDA ALTA`: `Sa Pedrera` (sonda OK, catalogo completo, pero cursor atrasado, stock failures y cola masiva);
  - `BLOQUEADA`: `Sa Vida` (sonda `401`);
  - `READ_ONLY/LEGACY`: `Baco Getafe`, `Don Bernardo Ponzano`, `Don Bernardo Santander`.

### Hipotesis / riesgos flota Agora 2026-06-26 12:38

- El fallback `sales/import` ya se observa en runtime en ventas nuevas de `Katsu`, por lo que la Edge Function desplegada parece contener el cambio; aun falta validar venta nueva en Cienvinos especificamente.
- `La Candela` y `Luruna` probablemente siguen vendiendo desde legacy o familias sin mapping Winerim.
- `Sa Pedrera` no debe recibir retries masivos: los `19` pendientes requieren decision de negocio/variante, no fuerza tecnica.
- `Sa Vida` no debe procesar cola hasta corregir el `401` de Agora.

## Hechos (Cienvinos · ventas Winerim con stock 0 — 2026-06-26 11:58 CEST)

- Se reviso `Restaurante Cienvinos Ecija` contra Lovable Cloud y API Winerim v2 sin imprimir tokens.
- Conexion `21ee3345-1090-4e83-94f2-43126d6e7695`:
  - `enabled=true`;
  - `write_mode=XML_IMPORT`;
  - `last_sync_at=2026-06-26T09:50:25.025+00:00`;
  - `last_business_day_synced=2026-06-25`;
  - tiene token Winerim configurado.
- Desde `2026-06-20`, Cienvinos tiene `34` filas `stock_sync_log.SUCCESS` y `0` `FAILED/BLOCKED/PENDING` en stock.
- Muestra reciente:
  - `C Cordon Rouge Brut [copa]`, wineId `239982`, stockId `316850`, `previousStock=0`, `newStock=0`, `soldQty=2`;
  - `B Ermita del Monte [botella]`, wineId `239324`, stockId `274678`, `previousStock=0`, `newStock=0`, `soldQty=3`;
  - `C Ramon Bilbao [copa]`, wineId `242177`, stockId `277879`, `previousStock=0`, `newStock=0`, `soldQty=4`.
- Verificacion API Winerim del ejemplo `C Cordon Rouge Brut [copa]`:
  - `GET /api/v2/stock/wine/239982` responde HTTP 200;
  - variante `copa` stockId `316850` tiene `stock=0` y `stockActive=false`.
- Diagnostico:
  - Agora -> Lovable Cloud funciona para estas ventas;
  - mapping POS -> Winerim funciona para estas lineas;
  - la llamada actual a Winerim aceptaba el `PUT /stock/{stockId}`, pero al ser `0 -> 0` no habia bajada real de stock que Winerim pudiera reflejar como descuento/historial.
- Cambio aplicado en codigo:
  - `agora-proxy` ahora llama a `POST /api/v2/sales/import` solo cuando el stock no se mueve (`previousStock === newStock`);
  - la importacion usa `orderId` determinista para idempotencia y no modifica stock;
  - se aplica en cierre diario, intradia incremental e intradia por total diario;
  - si el stock baja de verdad, no se llama a `sales/import` para evitar duplicar historial.
- Validacion local:
  - `npm test -- --run` OK (`19` tests);
  - `npm run build` OK;
  - bundle/parse de `supabase/functions/agora-proxy/index.ts` OK.
- Backfill ejecutado el `2026-06-26 12:09 CEST` para Cienvinos:
  - se importaron por `POST /api/v2/sales/import` las `34` lineas ya sincronizadas con `previousStock=0` y `newStock=0`;
  - total importado: `40` unidades;
  - dia de negocio: `2026-06-24`;
  - respuesta Winerim: `imported=34`, `skipped=0`, `failed=0`;
  - se anoto cada fila original de `stock_sync_log` con `winerim_response.salesImportBackfill`;
  - verificacion idempotente posterior: misma tanda devuelve `imported=0`, `skipped=34`, `failed=0`.
- Verificacion visual en Winerim admin/editor:
  - se entro como admin y se impersono `cienvinosecija` (`menu/861`);
  - en `ERP > Historial` (`/erp/861/sales`) aparecen las ventas TPV importadas;
  - la vista muestra `40` unidades y `236,50 €`, coincidiendo con el backfill;
  - ejemplos visibles: `Cordon Rouge Brut` `2 uds`, `Ermita del Monte` en botella, `Ramon Bilbao` en copa y `Convento San Francisco Primer Año` en copa.

### Hipotesis / riesgos Cienvinos

- El editor de Winerim no mostraba esas ventas porque Winerim documenta que `PUT /stock/{stockId}` registra venta al bajar stock, pero aqui no habia bajada (`0 -> 0`).
- El historico identificado de Cienvinos ya queda importado sin tocar stock y aparece visualmente en `ERP > Historial`; falta confirmacion del cliente/equipo si quieren validar desde su propia sesion.
- Para ventas futuras con stock `0`, falta desplegar `agora-proxy` en Lovable Cloud; el backfill manual solo cubre las `34` lineas actuales.
- Antes de confirmar cierre completo, falta desplegar `agora-proxy` y ejecutar una venta real o reproceso controlado de Cienvinos.

## Hechos (Flota Agora · auditoria viva — 2026-06-26 11:35 CEST)

- Se ejecuto auditoria viva de las `12` conexiones Agora registradas en Lovable Cloud.
- Se documento el informe operativo `AGORA_FLEET_AUDIT_2026-06-26.md`.
- La auditoria reviso:
  - sonda viva `agora-proxy` action `test`;
  - `pos_connections`;
  - ultimas ventas en `sales_events`;
  - lineas mapeadas en `sales_line_items`;
  - descuentos Winerim en `stock_sync_log`;
  - publicaciones Winerim -> Agora en `winerim_push_tracking`;
  - cola `outbound_tasks`;
  - alertas persistentes `connection_alerts`.
- Resultado por conexion:
  - `Casa Nene`: sonda OK, ventas hasta `2026-06-25`, `84` descuentos `SUCCESS` en 14 dias, catalogo `307/307`; queda `1` tarea `FAILED`.
  - `Katsu Izakaya`: sonda OK, ventas Winerim reales ya descontando el `2026-06-26`; `6 SUCCESS` y `1 FAILED` en 14 dias; catalogo `137/137`; sin cola abierta.
  - `Kava`: sonda OK, ventas/stock recientes OK (`45 SUCCESS`), catalogo `204/221`; mantiene `7 FAILED / 9 BLOCKED` en cola.
  - `La Candela de Triana`: sonda OK y ventas hasta `2026-06-25`, pero `mapped=0` y `stock_sync_log=0`; no esta descontando stock.
  - `Luruna`: sonda OK y ventas hasta `2026-06-25`, pero `mapped=0` en 14 dias y sin stock reciente; mantiene `10 FAILED / 58 BLOCKED`.
  - `Restaurante Cienvinos Ecija`: sonda OK, ventas hasta `2026-06-25`, `34 SUCCESS`, catalogo `499/499`; mantiene `3 FAILED / 7 BLOCKED`.
  - `Restaurante Jardi`: sonda OK (conectividad recuperada), ventas hasta `2026-06-25`, `22 SUCCESS`, catalogo `173/180`; quedan `3 FAILED` y faltan `7` formatos de copa.
  - `Sa Pedrera`: sonda OK, catalogo `470/470`, pero cursor `last_business_day_synced=2026-06-17`, cola masiva `310 FAILED / 12556 BLOCKED` y `36 FAILED` de stock en 14 dias.
  - `Sa Vida`: sonda actual devuelve `401 Agora responded 401`; no hay ventas 7d ni stock reciente; no reintentar cola hasta corregir token/API.
  - `Baco Getafe`: read-only/legacy, sonda OK, no automatico.
  - `Don Bernardo Ponzano` y `Don Bernardo Santander`: read-only onboarding, sonda OK, historico analitico sin stock.
- Hallazgo nuevo Katsu:
  - `C Saiaz Rosado [copa]` fallo el `2026-06-26` porque Winerim responde `404` para wineId `272890`;
  - en cache Winerim el vino esta `is_active=false`, tracking `BOTTLE/GLASS` esta `HIDDEN`, pero `product_mappings` seguia `CONFIRMED`.
- Hallazgo nuevo Sa Pedrera:
  - `C B310- Albenc [copa]` falla repetidamente;
  - el vino `284166` esta activo, pero `serve_by_glass=false`;
  - tracking `GLASS` esta `HIDDEN`, pero `product_mappings` seguia `CONFIRMED`.
- Cambio aplicado en codigo:
  - `buildSalesResolutionMap()` ahora no usa el fallback de `product_mappings.CONFIRMED` si el mismo producto existe en `winerim_push_tracking` pero no esta `VERIFIED`/`PUSHED`;
  - objetivo: evitar que formatos ocultos (`HIDDEN`) sigan resolviendo ventas como descontables.
- Validacion local:
  - `npm test -- --run` OK (`18` tests);
  - `npm run build` OK;
  - bundle/parse de `supabase/functions/agora-proxy/index.ts` OK.

### Hipotesis / riesgos 2026-06-26

- `La Candela` y `Luruna` probablemente venden desde legacy o familias sin resolucion Winerim, aunque el catalogo Winerim este publicado.
- `Katsu Saiaz Rosado` y `Sa Pedrera B310 Albenc copa` eran sintomas del mismo problema: tracking oculto, pero mapping confirmado aun resolvia ventas.
- El guard aplicado evita nuevos mapeos por productos ocultos tras deploy, pero ventas ya guardadas/mapeadas antes del deploy pueden conservar su estado historico.
- `auto_push_on_update` sigue siendo seguro solo donde no se observe bucle; en Katsu, Cienvinos y Jardi permanece apagado por seguridad hasta corregir idempotencia de updates existentes.

## Hechos (Katsu Izakaya · puesta en marcha automática — 2026-06-25 17:29 CEST)

- Se reviso Katsu contra Lovable Cloud en modo solo lectura.
- Conexion `Katsu Izakaya` (`982f1e63-5f15-48b8-b35f-037eafd4593e`) sigue activa:
  - `enabled=true`;
  - `catalog_sync_enabled=true`;
  - `write_mode=XML_IMPORT`;
  - `auto_push_on_create=true`;
  - `auto_push_on_update=false`;
  - `auto_push_verified_ready=true`;
  - `auto_push_glass=true`;
  - `write_glass=true`;
  - `provider_config.intraday_sales_sync_enabled=true`;
  - `provider_config.sales_timezone=Europe/Madrid`;
  - `provider_config.family_structure_mode=WINERIM_DEDICATED_FAMILIES`.
- Estado operativo vivo:
  - ventas importadas hasta `last_business_day_synced=2026-06-24`;
  - ultimo `last_sync_at=2026-06-25T15:25:10.905Z`;
  - `last_catalog_sync_at=2026-06-25T15:28:59.643Z`;
  - `0` tareas abiertas (`QUEUED/RUNNING/FAILED/BLOCKED`);
  - alerta previa de `outbound_queue` resuelta por monitor a `2026-06-25T15:29:06.158Z`;
  - `product_mappings`: `145 CONFIRMED`, `19 REJECTED`;
  - `winerim_push_tracking`: `137 VERIFIED`, `19 FAILED`, `8 HIDDEN`.
- Estructura visual viva en Agora:
  - raiz `33` `VINOS`, visible, sin productos directos vendibles;
  - raiz `37` `Copas de Vino`, visible, sin productos directos vendibles;
  - hijos de `VINOS`: `TINTOS WINERIM`, `BLANCOS WINERIM`, `ROSADOS WINERIM`, `ESPUMOSOS WINERIM`, `FORTIFICADOS WINERIM`, `DULCE WINERIM`, `MAGNUM WINERIM`;
  - hijo de `Copas de Vino`: `COPAS WINERIM`;
  - productos Winerim siguen con `UseAsDirectSale=false`; se venden entrando en su familia/subfamilia, no como botones raiz.
- Puesta en marcha catalogo:
  - se probo `winerim-proxy/fetch-catalog` con `auto_push_on_update=true`;
  - Winerim devolvio `70` vinos, `0` altas nuevas y `68` updates;
  - se encolaron `68` updates y se drenaron solo para Katsu;
  - verificacion final: `0 QUEUED / 0 RUNNING / 0 FAILED / 0 BLOCKED`.
  - el cron de catalogo volvio a encolar otra tanda `AUTO_UPDATE`, confirmando que el flag `auto_push_on_update=true` aun puede generar bucle de updates repetidos en Katsu;
  - por seguridad, se dejo `auto_push_on_update=false` de nuevo tras aplicar y drenar las tandas actuales;
  - las altas nuevas siguen automaticas (`auto_push_on_create=true`) y las ventas intradia quedan activas.
- Puesta en marcha intradia:
  - `sync-intraday-sales` manual sin `force` ya funciona porque el flag esta activo;
  - dispatcher `sales-stock` limitado a Katsu invoco `auto-sync-sales` + `sync-intraday-sales`, ambas OK;
  - en el dia `2026-06-25` Agora devolvio `8` facturas / `58` lineas, pero `resolvedLines=0`, por lo que no habia venta Winerim intradia que descontar en ese momento.
- Stock reciente:
  - `4` descuentos `SUCCESS` en la ultima muestra, todos de variante `copa`;
  - ejemplos: `C Lawson's Dry Hills Gewürztraminer [copa]` y `C Sarmentero Vendimia Seleccionada [copa]`;
  - el unico `FAILED` visible en la muestra es historico (`2026-05-20`) y corresponde a la antigua logica fraccional (`quantity=0.2`), no al flujo variant-aware actual.
- Se documenta esta estructura en `provider_config.katsu_family_structure` para soporte/rollback.

### Riesgos / tareas Katsu

- No tocar IDs, mappings ni stock para resolver futuros ajustes visuales; la estructura actual ya esta viva.
- Antes de declarar Katsu como validado por completo con intradia, falta que el cliente venda un vino Winerim hoy desde `VINOS` o `Copas de Vino` y verificar que el siguiente ciclo corto genera `stock_sync_log.SUCCESS`.
- No reactivar `auto_push_on_update=true` hasta corregir la idempotencia de updates repetidos; si un precio/nombre urgente cambia en Winerim, publicar ese update de forma controlada/manual.
- El clasificador `isWineCandidate()` sigue inflando comida/bebida como candidato vino en Katsu; no afecta al descuento si no hay mapping Winerim, pero debe corregirse para que las metricas de no-mapeados no generen ruido.

## Hechos (Sistema de monitorizacion y alertas email — 2026-06-25)

- Se implemento una primera version del sistema persistente de monitorizacion de conexiones:
  - migracion `supabase/migrations/20260625044943_connection_health_monitor.sql`;
  - nueva Edge Function `supabase/functions/connection-health-monitor/index.ts`;
  - actualizacion de la interfaz `src/pages/Alerts.tsx`;
  - contador lateral actualizado en `src/components/Layout.tsx`.
- Nuevas tablas previstas:
  - `connection_health_checks`: historico de checks por conexion;
  - `connection_alerts`: incidencias persistentes `OPEN` / `ACKED` / `RESOLVED`;
  - `connection_notification_contacts`: emails de cliente/SAT por conexion.
- La funcion `connection-health-monitor` es observacional:
  - no descuenta stock;
  - no refresca ventas;
  - no procesa cola;
  - no modifica productos en Agora;
  - no reintenta tareas;
  - solo registra checks, abre/cierra alertas y envia emails si hay proveedor configurado.
- Para Agora, la sonda usa `GET /api/export-master/?filter=Families` con `Api-Token` y timeout de `5s`; no toca `/api/export-master/?filter=Products`, respetando la regla de cache obligatoria para Products.
- Alertas que detecta esta primera version:
  - conectividad/DNS/puerto caido (`connectivity`);
  - token/API rechazado (`auth`);
  - error API Agora (`api_error`);
  - circuit breaker abierto (`breaker_open`);
  - ventas sin avanzar (`sales_stale`);
  - cola outbound con tareas recientes fallidas/bloqueadas o demasiado antiguas (`outbound_attention`);
  - fallos recientes de descuento de stock (`stock_failed`).
- Emails:
  - soporta Resend mediante secretos `RESEND_API_KEY` y `ALERT_EMAIL_FROM`;
  - destinatarios internos desde `ALERT_INTERNAL_EMAILS` / `MONITOR_INTERNAL_EMAILS` / `INTERNAL_ALERT_EMAILS`;
  - destinatarios cliente desde `connection_notification_contacts` o `provider_config.alert_client_emails`;
  - umbrales configurables: `ALERT_INTERNAL_AFTER_OCCURRENCES`, `ALERT_CLIENT_AFTER_OCCURRENCES`, `ALERT_CLIENT_AFTER_MINUTES`.
- La interfaz `/alerts` muestra:
  - resumen de criticos/errores/warnings/ultimo check;
  - incidencias persistentes abiertas;
  - historico de health checks;
  - senales legacy de stock/outbound como respaldo;
  - boton manual `Run Monitor`.
- Validacion local:
  - bundle/parse Edge Function con esbuild + `node --check` OK;
  - `npm run build` OK;
  - `npm test` OK (`18` tests).
- GitHub / Lovable Cloud:
  - commit `f4f90f2` (`Add persistent connection health alerts`) subido a `main`;
  - commit `1067ecc` (`Document health monitor deployment status`) subido a `main`;
  - Lovable Cloud aplico la migracion `20260625044943_connection_health_monitor.sql`;
  - Lovable Cloud desplego la Edge Function `connection-health-monitor`.
- Lovable Cloud genero ademas la migracion `20260625071127_29af3b55-ae05-4175-a786-5d0b54aa740e.sql` con el mismo DDL ya presente en la migracion canonica.
- Esa migracion generada queda en el repo como no-op documentado para representar el id remoto sin duplicar triggers ni recrear objetos en entornos nuevos.
- Verificacion post-despliegue:
  - `connection_alerts` responde HTTP 200 por Data API;
  - `connection_health_checks` responde HTTP 200 por Data API;
  - `connection_notification_contacts` responde HTTP 200 por Data API y esta vacia;
  - `connection-health-monitor` responde HTTP 200 con `dryRun=true`, `sendEmails=false`, `notifyClients=false`.
- Primer run real sin emails:
  - `9` checks insertados;
  - `6` alertas `OPEN`;
  - `0` emails enviados.
- Alertas abiertas iniciales:
  - `Sa Vida`: `auth` critical (`Agora responde 401`);
  - `Sa Pedrera`: `sales_stale`, `outbound_queue`, `stock_sync`;
  - `Restaurante Cienvinos Ecija`: `outbound_queue`;
  - `Katsu Izakaya`: `outbound_queue`.
- Seguridad cron/email desplegada:
  - migracion `20260625072756_secure_connection_health_monitor_cron.sql` aplicada en Lovable Cloud;
  - Edge Function `connection-health-monitor` redeployada;
  - `connection-health-monitor` solo acepta `sendEmails=true` / `notifyClients=true` si recibe header `X-Monitor-Secret` y coincide con `MONITOR_CRON_SECRET`;
  - el boton manual `/alerts > Run Monitor` queda como ejecucion sin emails (`sendEmails=false`, `notifyClients=false`);
  - nueva funcion SQL `invoke_connection_health_monitor_secure(fn_url, bearer_key, monitor_secret, notify_clients)`;
  - prueba negativa externa OK: sin `X-Monitor-Secret`, `sendEmails=true` devuelve HTTP 403 `MONITOR_SECRET_REQUIRED`;
  - prueba externa OK: `dryRun=true`, `sendEmails=false`, `notifyClients=false` devuelve HTTP 200 y revisa `9` conexiones.
- Lovable Cloud genero ademas la migracion `20260625073417_a9f5092e-e4f6-49fa-a9ee-1f7fbe353f8d.sql` con el mismo DDL del helper seguro.
- Esa migracion generada queda en el repo como no-op documentado; la migracion canonica es `20260625072756_secure_connection_health_monitor_cron.sql`.
- Pendiente actual:
  - no hay secretos email configurados (`RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_INTERNAL_EMAILS`);
  - no hay `MONITOR_CRON_SECRET` configurado;
  - no hay contactos cliente/SAT en `connection_notification_contacts`;
  - cron cada 10 minutos queda pendiente hasta configurar secretos email + `MONITOR_CRON_SECRET`.

### Hipotesis / riesgos monitorizacion

- Si `RESEND_API_KEY` o `ALERT_EMAIL_FROM` no estan configurados, las alertas se registraran pero el envio quedara con `EMAIL_NOT_CONFIGURED`.
- Si se activan emails a cliente sin contactos por conexion, solo habra aviso interno; los clientes/SAT requieren filas en `connection_notification_contacts` o `provider_config.alert_client_emails`.
- La sonda de familias cada 10 minutos es ligera, pero aun asi debe mantenerse fuera de `Products` para evitar repetir el incidente Luruna.
- No activar un cron basado en invocacion publica/anonima de la Edge Function. El cron debe usar `X-Monitor-Secret` con `MONITOR_CRON_SECRET`; para el bearer HTTP basta una publishable/anon key porque el envio queda protegido por el secreto propio del monitor.
- Rollback seguro:
  - pausar/eliminar el cron que invoque `connection-health-monitor`;
  - no tocar tablas operativas de ventas/stock/catalogo;
  - opcionalmente ocultar la UI retirando las consultas a `connection_alerts`/`connection_health_checks`.

## Hechos (Flota Agora · auditoria operativa — 2026-06-25)

- Se auditaron las `12` conexiones Agora registradas en Lovable Cloud mediante:
  - lectura de `pos_connections`, `sales_events`, `sales_line_items`, `stock_sync_log`, `product_mappings`, `winerim_push_tracking`, `provider_capabilities`;
  - sonda viva `agora-proxy` action `test` por conexion.
- Sonda viva OK:
  - `Baco Getafe`;
  - `Don Bernardo Ponzano`;
  - `Don Bernardo Santander`;
  - `Katsu Izakaya`;
  - `Kava`;
  - `La Candela de Triana`;
  - `Luruna`;
  - `Restaurante Cienvinos Ecija`;
  - `Sa Pedrera`.
- Sonda viva con incidencia:
  - `Casa Nene`: `NETWORK_UNREACHABLE / No route to the Agora server`;
  - `Restaurante Jardi`: `NETWORK_UNREACHABLE / No route to the Agora server`;
  - `Sa Vida`: Agora responde `401`.
- Estado por conexion:
  - `Baco Getafe`: apagado (`enabled=false`, `write_mode=NONE`), revertido a legacy. Ultimo dia sincronizado `2026-05-28`. No es automatico actualmente.
  - `Casa Nene`: activo en configuracion, catalogo automatico ON, pero Agora no es alcanzable ahora mismo. Ultimo dia de ventas guardado `2026-06-24`; `intraday_sales_sync_enabled=false` tras la incidencia de idempotencia intradia. Stock reciente: `39 SUCCESS` y `3 BLOCKED` documentados como duplicados bloqueados.
  - `Don Bernardo Ponzano`: read-only onboarding (`enabled=false`, `write_mode=NONE`), historico analitico cargado hasta `2026-06-22`, sin stock ni mappings. Sonda Agora OK.
  - `Don Bernardo Santander`: read-only onboarding (`enabled=false`, `write_mode=NONE`), historico analitico cargado hasta `2026-06-22`, sin stock ni mappings. Sonda Agora OK.
  - `Katsu Izakaya`: activo definitivo con familias Winerim dedicadas, venta D-1 hasta `2026-06-24`, stock reciente `4 SUCCESS`, sin errores recientes de stock. Hay `4` tareas `BLOCKED` abiertas y `auto_push_on_update=false`, aunque `auto_push_on_create=true`.
  - `Kava`: activo, sonda OK, ventas hasta `2026-06-24`, stock reciente `14 SUCCESS`, sin errores recientes. Mantiene deuda historica `7 FAILED / 9 BLOCKED` en outbound y stock historico `13 FAILED / 26 BLOCKED`.
  - `La Candela de Triana`: activo, sonda OK, ventas hasta `2026-06-24`, pero `mappedCount=0` y `stock_sync_log=0`; no esta descontando stock Winerim aunque lee ventas.
  - `Luruna`: activo, sonda OK, ventas hasta `2026-06-24`, pero no hay stock reciente desde `2026-06-08`; mantiene deuda outbound historica `10 FAILED / 58 BLOCKED` y `winerim_push_tracking.QUEUED=5`.
  - `Restaurante Cienvinos Ecija`: activo, sonda OK, ventas hasta `2026-06-24`, stock reciente `34 SUCCESS`. Mantiene deuda outbound `3 FAILED / 7 BLOCKED`; `auto_push_on_update=false`.
  - `Restaurante Jardi`: activo en configuracion, pero sonda viva falla `NETWORK_UNREACHABLE`; ultimo dia guardado `2026-06-23`, stock reciente `14 SUCCESS`, outbound `3 FAILED`. No refrescar ni reintentar hasta recuperar ruta/DDNS/puerto.
  - `Sa Pedrera`: activo, sonda OK, familias Winerim dedicadas, orden comercial activo, pero `last_business_day_synced=2026-06-17` y hay deuda muy grande en outbound (`QUEUED/RUNNING/BLOCKED/FAILED`). Stock reciente mezcla `62 SUCCESS` y `22 FAILED`, con fallo repetido `Variant 'copa' not found for wine 284166` (`C B310- Albenc [copa]`).
  - `Sa Vida`: activo en configuracion, pero sonda viva devuelve `401`; ventas no avanzan desde `2026-05-03`. No reintentar cola hasta corregir token/API. Mantiene deuda outbound historica grande y stock historico con `177 FAILED / 263 BLOCKED`.

### Hipotesis / riesgos Flota Agora

- `Casa Nene` y `Jardi` probablemente tienen problema de router/firewall/DDNS o puerto externo; el backend no puede alcanzar Agora aunque la configuracion exista.
- `Sa Vida` ya no parece un problema de modulo 501, sino de autenticacion/API token (`401`) en la sonda viva actual.
- `La Candela` y `Luruna` leen ventas, pero no hay prueba reciente de descuento Winerim; puede faltar venta desde botones/mappings Winerim o resolucion de lineas.
- `Sa Pedrera` esta operativa a nivel de catalogo/sonda, pero no debe recibir retries masivos hasta clasificar la deuda y corregir la variante inexistente de `B310 Albenc`.

## Hechos (Protocolo checklist Agora — 2026-06-25)

- Se creo el documento operativo `AGORA_INTEGRATION_CHECKLIST.md`.
- El checklist define estados formales por integracion:
  - `READ_ONLY_AUDIT`;
  - `CATALOG_PILOT`;
  - `SALES_VALIDATION`;
  - `LIVE_AUTOMATIC`;
  - `PAUSED`;
  - `LEGACY_ONLY`.
- El checklist separa:
  - obligatorios para alta;
  - obligatorios antes de escribir;
  - obligatorios para catalogo Winerim -> Agora;
  - obligatorios para ventas Agora -> Winerim;
  - obligatorios antes de `LIVE_AUTOMATIC`;
  - opcionales segun cliente;
  - bloqueantes.
- Criterio principal: ninguna integracion debe marcarse como `LIVE_AUTOMATIC` si no tiene al menos una venta real mapeada con `stock_sync_log.SUCCESS` para los formatos que vaya a usar.

## Hechos (Casa Nene · checklist individual — 2026-06-25)

- Se creo `AGORA_CHECKLIST_CASA_NENE_2026-06-25.md`.
- Estado asignado: `PAUSED`.
- Motivo:
  - sonda viva contra Agora falla `NETWORK_UNREACHABLE / No route to host`;
  - `intraday_sales_sync_enabled=false` tras la validacion de idempotencia intradia del `2026-06-24`.
- Fortalezas confirmadas:
  - conexion configurada con `enabled=true`, `catalog_sync_enabled=true`, `write_mode=XML_IMPORT`;
  - catalogo cacheado: `309` vinos, `307` activos;
  - mappings `CONFIRMED=309`;
  - tracking `VERIFIED=307`;
  - `0 QUEUED / 0 RUNNING`;
  - ventas reales de botella detectadas y `stock_sync_log.SUCCESS` historico para botella.
- Bloqueantes para `LIVE_AUTOMATIC`:
  - recuperar conectividad publica/DDNS/puerto Agora;
  - validar parche intradia por total diario sin doble descuento;
  - reactivar intradia solo tras prueba segura;
  - confirmar una nueva venta real con `sales_line_items.mapped=true` y `stock_sync_log.SUCCESS`.

## Hechos (Casa Nene · consulta ventas noche 2026-06-24 — 2026-06-25)

- Se consultaron las ventas guardadas en Lovable Cloud para Casa Nene (`connection_id=e3cb6dbb-3474-4926-b740-706fbd0ef7e0`) del business day `2026-06-24`.
- La lectura viva contra Agora por `fetch-day` fallo con `502 NETWORK_UNREACHABLE`: `No route to host` contra `http://casanene.ddns.net:8984/api/export/?business-day=2026-06-24&filter=Invoices`.
- Por tanto, el resumen disponible se basa solo en datos ya guardados en Lovable Cloud; no confirma si existen ventas posteriores en el POS que no hayan entrado.
- En Lovable Cloud hay `57` eventos brutos de ese dia, pero `29` facturas canonicas con `provider_doc_id` numerico tras filtrar duplicados/imports previos.
- Rango guardado:
  - primera factura: `18391` a las `13:59:48`, `8,60 EUR`;
  - ultima factura: `18419` a las `18:25:15`, `20,50 EUR`.
- Total canonico guardado del dia: `1.909,50 EUR`.
- No hay facturas guardadas despues de las `19:00` ni despues de las `20:00`.
- Franja guardada desde las `17:00`: `6` facturas, `399,30 EUR`, docs `18414` a `18419`.

### Riesgo / tarea Casa Nene

- Si el cliente tuvo servicio de noche despues de las `19:00`, esas ventas no estan actualmente en Lovable Cloud y primero hay que recuperar conectividad publica/DDNS/puerto Agora antes de refrescar o descontar nada.

## Hechos (Sa Pedrera — productos inactivos impresos en factura — 2026-06-23)

- El cliente Sa Pedrera reporta que, cuando durante el servicio vende la última botella de un vino y lo desactiva en Winerim para que no se pueda volver a pedir, el ticket/factura de una mesa abierta imprime el producto con prefijo `[INACTIVO]`.
- Evidencia recibida: factura proforma del `2026-06-23 21:35` con línea de vino `"[INACTIVO] B 55-Lapo a"`.
- Transcripción de audios:
  - "cuando quito un vino en mitad del servicio [...] después en el ticket del cliente me aparece como inactivo";
  - "este vino aparece como cobrado en la factura [...] lo que pasa que aparece con ese encabezamiento de inactivo".
- Diagnóstico: la venta se cobra correctamente; el problema es de nombre visible impreso en documentos de Agora.
- Causa localizada en `supabase/functions/agora-proxy/index.ts`: la tarea `AGORA_HIDE_PRODUCT` renombraba el producto a `[INACTIVO] ${wineName}` al ocultarlo.
- Cambio aplicado en código: `AGORA_HIDE_PRODUCT` preserva ahora el `<Product>` completo leído desde `/api/export-master/?filter=Products` vía `fetchAgoraProductsXmlCached` y solo fuerza `UseAsDirectSale=false` + `SaleableAsMain=false`.
- Si el producto ya venía con prefijo `[INACTIVO]`, el nuevo flujo lo limpia al reimportarlo oculto.
- Fallback conservador si el producto no aparece en master data: se mantiene el nombre Winerim sin prefijo `[INACTIVO]`.
- Validación local:
  - `npm ci --ignore-scripts --no-audit --no-fund` OK.
  - `node node_modules/esbuild/bin/esbuild supabase/functions/agora-proxy/index.ts --bundle --platform=neutral --format=esm --outfile=/tmp/agora-proxy-check.js` OK.
  - `node --check /tmp/agora-proxy-check.js` OK.
- Commit publicado en `main`: `5871e02` (`Hide inactive Agora products without renaming`).
- Limpieza controlada aplicada directamente en Agora Sa Pedrera:
  - dry-run live: `37` productos con prefijo `[INACTIVO]`, todos ya no vendibles (`UseAsDirectSale=false`, `SaleableAsMain=false`);
  - import XML aplicado con HTTP 200;
  - verificación live post-import: `prefixedCount=0`;
  - se refrescó `sync-master-data` en Lovable Cloud y el snapshot `products_summary_json` quedó con `1378` productos y `prefixedCount=0`.
- Pendiente operativo: confirmar redeploy automático de Lovable Cloud con el commit `5871e02` y validar en ticket/factura de prueba.

## Hechos (Don Bernardo Ponzano/Santander · Agora read-only + historico analitico — 2026-06-23)

- Se crearon dos conexiones Agora en Lovable Cloud en modo solo lectura:
  - Don Bernardo Ponzano: `a700d425-9194-4758-95ff-7fee86419e14`;
  - Don Bernardo Santander: `79280cb8-0fe7-4a57-93a4-04172205ac70`.
- No se versionaron ni documentaron tokens.
- Ambas conexiones quedaron con:
  - `enabled=false`;
  - `catalog_sync_enabled=false`;
  - `write_mode=NONE`;
  - `auto_push_on_create=false`;
  - `auto_push_on_update=false`;
  - `auto_push_verified_ready=false`;
  - `provider_config.read_only_onboarding=true`;
  - `provider_config.stock_sync_start_date=2026-06-23`.
- `test` Agora OK en ambos.
- `Invoices` OK en ambos:
  - Ponzano: ventas cerradas hasta `2026-06-22`, `342` facturas en los ultimos 14 dias;
  - Santander: ventas cerradas hasta `2026-06-22`, `1.158` facturas en los ultimos 14 dias.
- `sync-master-data` OK en ambos, sin escrituras POS:
  - Ponzano: `150` familias, `139` visibles, `1.832` productos, `1.813` vendibles, `3` listas de precio, `8` centros de venta;
  - Santander: `126` familias, `122` visibles, `1.569` productos, `1.550` vendibles, `2` listas de precio, `8` centros de venta.
- `winerim-proxy fetch-catalog` OK con flags de auto-push apagados:
  - Ponzano: `95` vinos Winerim, `95` activos con precio, `93` con botella, `35` con copa, `0` magnum;
  - Santander: `147` vinos Winerim, `147` activos con precio, `144` con botella, `48` con copa, `0` magnum.
- Se hizo pre-match preliminar Winerim vs Agora:
  - Ponzano: `58/95` matches exactos seguros (`61,1%`), `37` sin match claro;
  - Santander: `42/147` matches exactos seguros (`28,6%`), `105` sin match claro.
- Se importo historico de ventas como analitica, sin stock, desde `2026-03-23` hasta `2026-06-23`:
  - Ponzano: `93` dias escaneados, `92` con ventas, `3.400` facturas, `11.797` lineas, `3.720` lineas candidatas vino, `0` errores;
  - Santander: `93` dias escaneados, `92` con ventas, `6.883` facturas, `22.351` lineas, `6.909` lineas candidatas vino, `0` errores.
- El historico se guardo con:
  - `raw_json._winerim_import_mode="historical_analytics"`;
  - `raw_json._stock_sync_eligible=false`;
  - `sales_line_items.mapped=false`;
  - `sales_line_items.winerim_product_id=null`.
- Verificacion post-import:
  - `stock_sync_log` nuevo para estas conexiones: `0`;
  - muestras de eventos devuelven `historical_analytics` y `stockEligible=false`;
  - `sales_line_items mapped=true limit 1`: `[]` en ambos.
- Informe especifico: `DON_BERNARDO_READONLY_AUDIT_2026-06-23.md`.

### Incidencia / correccion Don Bernardo

- La accion historica `sync-master-data` del runtime actual promociono temporalmente `write_mode` de `NONE` a `XML_IMPORT` al detectar master data.
- No escribio en Agora ni creo cola, pero no era correcto para onboarding read-only.
- Se reseteo inmediatamente Ponzano y Santander a `write_mode=NONE`.
- Se subio commit `d9aae7f` con:
  - action `backfill-sales-analytics` para futuros historicos analiticos sin stock;
  - guard de stock por `provider_config.stock_sync_start_date`;
  - exclusiones de stock para eventos `historical_analytics`;
  - proteccion para que `sync-master-data` no promocione `write_mode` si `read_only_onboarding=true`.
- Ultima sonda tras push: Lovable Cloud seguia devolviendo `Unknown action` para `backfill-sales-analytics`; el backfill de Don Bernardo se hizo directamente por REST con lineas no mapeadas como medida conservadora.

### Decisiones / criterio operativo Don Bernardo

- Mantener Ponzano y Santander en read-only hasta revisar matching/familias con cliente/SAT.
- No activar auto-push, no ocultar legacy y no sincronizar stock historico.
- Tratar el historico importado como analitica/matching, no como historial Winerim ni como deduccion de stock.
- Para cualquier go-live de stock, empezar desde `2026-06-23` o fecha posterior explicita y solo tras mappings aprobados.

### Riesgos / tareas Don Bernardo

- Confirmar redeploy de Lovable Cloud con commit `d9aae7f`; mientras no este desplegado, no usar `backfill-sales-analytics` desde la funcion.
- Revisar no-match:
  - Ponzano: `37`;
  - Santander: `105`.
- Confirmar con cliente donde deben caer nuevos vinos de Winerim:
  - conservar estructura actual;
  - usar familias Winerim dedicadas;
  - o enrutar por reglas a familias existentes.
- Aclarar si `Vinos Barra` representa copas u operativa especial.
- Aclarar si las familias `BEBIDAS > BOTELLAS...` son operativas o residuales.
- Si se cancela el onboarding, rollback sin impacto POS:
  - mantener/desactivar conexiones;
  - borrar `sales_events` de cada connection/rango (`sales_line_items` cae por cascade);
  - no hay stock que revertir (`stock_sync_log=0`).

## Hechos (Estudio Resto / La Refineria · API precheck — 2026-06-22)

- El SAT de Estudio Informatico envio documentacion `Api Resto` v1 para una API interna local.
- Documento recibido: `/Users/GOIKO/Downloads/api-resto-doc.md`.
- La documentacion trae credenciales en claro; no se repiten ni se versionan.
- Endpoints documentados:
  - `POST /api/token`: obtiene JWT Bearer;
  - `GET /api/restaurantRequest/stock-items`: consulta items de stock;
  - `GET /api/restaurantRequest/menu`: consulta menu/carta.
- La URL de ejemplo es privada/local (`192.168.x.x`) con HTTPS y puerto `9998`, por lo que el backend no podria acceder directamente sin tunel/VPN/IP publica/conector local.
- El alcance actual es solo lectura de menu y stock agregado. No hay endpoints documentados de ventas cerradas ni escritura de productos/precios.
- Informe especifico: `ESTUDIO_RESTO_API_PRECHECK_2026-06-22.md`.

### Decisiones / criterio operativo Estudio Resto

- Tratar Estudio Resto como viable parcial, no como integracion completa lista.
- No prometer Winerim -> POS hasta que exista endpoint de crear/actualizar productos/precios.
- No prometer ventas/historial/stock idempotente hasta que exista endpoint de ventas cerradas con lineas e IDs estables.

### Riesgos / tareas Estudio Resto

- Resolver conectividad segura desde backend a una API local.
- Pedir respuesta real de login, expiracion de JWT y codigos de error.
- Pedir endpoint de ventas cerradas por fecha de negocio.
- Pedir endpoint de escritura de menu/productos si el cliente quiere automatizar altas y precios desde Winerim.

## Hechos (Katsu Izakaya · activación definitiva Winerim en Agora — 2026-06-19)

- Katsu Izakaya queda activado en modo definitivo con familias Winerim dedicadas.
- Conexion: `982f1e63-5f15-48b8-b35f-037eafd4593e`.
- Se refresco master data Agora y catalogo Winerim antes de escribir.
- Se importo por XML separado por formato para evitar mappings falsos:
  - `64` botellas;
  - `65` copas;
  - `2` magnums.
- Verificacion viva tras import:
  - `131/131` formatos Winerim esperados existen en Agora;
  - `131/131` estan vendibles;
  - `0` faltantes;
  - `0` productos Winerim como boton raiz;
  - reparto por familia:
    - `BLANCOS WINERIM`: `29`;
    - `COPAS WINERIM`: `65`;
    - `TINTOS WINERIM`: `16`;
    - `FORTIFICADOS WINERIM`: `4`;
    - `DULCE WINERIM`: `4`;
    - `ESPUMOSOS WINERIM`: `8`;
    - `ROSADOS WINERIM`: `3`;
    - `MAGNUM WINERIM`: `2`.
- Flags/configuracion viva:
  - `enabled=true`;
  - `catalog_sync_enabled=true`;
  - `write_mode=XML_IMPORT`;
  - `auto_push_on_create=true`;
  - `auto_push_on_update=true`;
  - `auto_push_verified_ready=true`;
  - `auto_push_glass=true`;
  - `write_glass=true`;
  - `provider_config.family_structure_mode=WINERIM_DEDICATED_FAMILIES`.
- Legacy de vino:
  - familias legacy objetivo: `11`, `33`, `37`;
  - productos legacy no Winerim detectados: `198`;
  - productos legacy vendibles tras ocultacion: `0`;
  - productos legacy como boton directo tras ocultacion: `0`;
  - no se borro nada, la ocultacion es reversible.
- Catalogo automatico post-activacion:
  - `winerim-proxy fetch-catalog` completo leyo `67` vinos y `67/67` detalles;
  - `newWines=0`, `changedWines=65`;
  - el auto-push genero updates diferenciales y la cola XML se dreno correctamente;
  - estado final de cola Katsu: `0 QUEUED / 0 RUNNING / 0 FAILED / 0 BLOCKED`.
- Ventas:
  - Agora responde y el cursor esta en `last_business_day_synced=2026-06-18`;
  - las ventas historicas anteriores a esta activacion siguen viniendo de botones legacy y no sirven como prueba de stock Winerim;
  - queda pendiente validar una venta real posterior desde boton Winerim con `sales_line_items.mapped=true` y `stock_sync_log.SUCCESS`.
- Artefactos:
  - `KATSU_DEFINITIVE_ACTIVATION_2026-06-19.md`;
  - `KATSU_LEGACY_HIDE_SNAPSHOT_2026-06-19.json`;
  - `KATSU_LEGACY_HIDE_APPLIED_2026-06-19.json`;
  - `KATSU_ACTIVATION_VERIFY_2026-06-19.json`;
  - `KATSU_FETCH_CATALOG_POST_ACTIVATION_2026-06-19.json`;
  - `KATSU_PROCESS_QUEUE_DRAIN_FINAL_2026-06-19.json`.

### Decisiones / criterio operativo Katsu

- Katsu queda como instalacion Winerim dedicada, no como instalacion legacy/match parcial.
- El legacy queda oculto reversible, no borrado.
- No sincronizar stock historico de ventas legacy: solo validar y operar con ventas futuras desde productos Winerim.
- Si hay que volver atras, primero pausar auto-push y restaurar flags/productos desde `KATSU_LEGACY_HIDE_SNAPSHOT_2026-06-19.json`.

### Riesgos / tareas Katsu

- Validar en tablet que las familias Winerim se ven en orden correcto.
- Hacer venta real de prueba de botella y copa Winerim, cerrar jornada y confirmar:
  - linea mapeada;
  - stock descontado por variante;
  - `stock_sync_log.SUCCESS`.
- Vigilar el siguiente ciclo de catalogo: no debe dejar cola abierta ni reimportar masivo salvo cambios reales de Winerim.

## Hechos (flota Agora · monitorizacion tras Katsu — 2026-06-19)

- Informe: `AGORA_FLEET_STATUS_2026-06-19.md`.
- Auditoria viva en Lovable Cloud:
  - `Baco Getafe`: apagado/revertido a legacy, cola limpia.
  - `Casa Nene`: activo, Agora responde, cursor `2026-06-18`, stock reciente `66 SUCCESS`, queda `1 FAILED` por inspeccionar.
  - `Katsu Izakaya`: activo definitivo Winerim, cursor `2026-06-18`, cola limpia.
  - `Kava`: activo, Agora responde, cursor `2026-06-18`, stock reciente `77 SUCCESS / 23 BLOCKED`, deuda `7 FAILED / 9 BLOCKED`.
  - `La Candela de Triana`: activo, Agora responde, cursor `2026-06-18`, cola limpia, sin stock reciente en la muestra.
  - `Luruna`: activo, Agora responde, cursor `2026-06-18`, stock reciente `9 SUCCESS`, deuda `10 FAILED / 58 BLOCKED`.
  - `Restaurante Cienvinos Ecija`: activo en configuracion, pero test actual termina en timeout; cola `131 QUEUED / 4 BLOCKED`.
  - `Restaurante Jardi`: activo en configuracion, pero test actual falla `502 No route to the Agora server`; cola `1 QUEUED / 3 FAILED`.
  - `Sa Pedrera`: activo, Agora responde, cursor `2026-06-17`, stock reciente `87 SUCCESS / 13 FAILED`, deuda historica grande `FAILED/BLOCKED`.
  - `Sa Vida`: activo en configuracion, pero Agora devuelve `501`; no reintentar cola hasta que el modulo/API responda.

### Decisiones / criterio operativo flota

- No drenar colas de `Jardi`, `Cienvinos` ni `Sa Vida` mientras el test Agora falle.
- No limpiar deuda `FAILED/BLOCKED` en bloque: clasificar por conexion y tipo de tarea.
- En conexiones sanas con cola historica (`Kava`, `Luruna`, `Sa Pedrera`, `Casa Nene`), actuar sobre errores concretos, no sobre todo el backlog.

## Hechos (Katsu Izakaya · auditoría solo lectura Winerim vs Agora — 2026-06-17)

- Se hizo auditoría solo lectura para Katsu Izakaya:
  - Agora `export-master` (`Families`, `Products`);
  - Agora `Invoices` de días cerrados recientes;
  - Winerim API v2 (`/wines` y detalles individuales);
  - tablas Lovable Cloud de mappings, tracking, cola, ventas y stock.
- No se ejecutó import XML, no se encoló nada, no se guardaron ventas, no se descontó stock y no se cambió ningún flag.
- Informe específico: `KATSU_READONLY_AGORA_WINERIM_AUDIT_2026-06-17.md`.
- CSVs de revisión:
  - `KATSU_WINERIM_EXPECTED_POLICY_TO_AGORA_2026-06-17.csv`;
  - `KATSU_AGORA_WINERIM_PRODUCTS_2026-06-17.csv`;
  - `KATSU_AGORA_WINERIM_NOT_EXPECTED_2026-06-17.csv`;
  - `KATSU_LEGACY_TO_WINERIM_LIVE_MATCH_2026-06-17.csv`;
  - `KATSU_AGORA_FAMILY_STRUCTURE_2026-06-17.csv`.

### Resultado de conexión y catálogo

- Katsu responde correctamente:
  - `Families`: OK;
  - `Products`: OK;
  - `Invoices`: OK para días cerrados con actividad.
- Configuración viva:
  - `enabled=true`;
  - `catalog_sync_enabled=true`;
  - `write_mode=XML_IMPORT`;
  - `auto_push_on_create=true`;
  - `auto_push_on_update=true`;
  - `auto_push_verified_ready=false`;
  - `auto_push_bottle=true`;
  - `auto_push_glass=false`;
  - `write_bottle=true`;
  - `write_glass=false`;
  - breaker limpio y cola abierta `0`.
- Agora actual:
  - `42` familias;
  - `11` familias visibles;
  - `1.212` productos;
  - `771` productos vendibles;
  - `0` productos como botón raíz;
  - `8` familias Winerim visibles;
  - `85` productos Winerim detectados por familia/mapping/tracking;
  - `62` productos Winerim vendibles;
  - `0` productos Winerim como botón raíz.
- Winerim API v2 actual:
  - `67` vinos vivos;
  - `67` activos;
  - `64` con precio de botella;
  - `64` con precio de copa;
  - `2` con precio de magnum;
  - `0` fallos de detalle.

### Cobertura según política actual de Katsu

- Como `auto_push_glass=false` y `write_glass=false`, las copas con precio no se cuentan como faltantes.
- Formatos Winerim esperados en Agora por la política actual:
  - `64` botellas;
  - `2` magnums;
  - total `66`.
- Cobertura:
  - `52` formatos están presentes, visibles y vendibles;
  - `3` existen y son vendibles, pero están en familia legacy oculta `VINOS`;
  - `11` botellas activas con precio faltan en Agora.
- Faltantes:
  - `277094` `Abad Dom Bueno Rosado`;
  - `277100` `Finca Martelo Reserva`;
  - `277148` `Luis XIV Ánforas`;
  - `275753` `Château Cristi Chardonnay`;
  - `277143` `Biu Blanc`;
  - `277144` `Private Collection Chardonnay`;
  - `277146` `Lawson's Dry Hills Riesling`;
  - `277149` `Chablis 1er Cru 'Fourchaume'`;
  - `277151` `Chablis 1er Cru 'Vaulorent'`;
  - `277153` `Malagousia`;
  - `277154` `Lawson's Dry Hills Gewürztraminer`.
- Presentes pero en familia oculta:
  - `272870` `Dulas Rosé`;
  - `272890` `Saiaz Rosado`;
  - `272845` `Abad Dom Bueno Godello Esencia`.

### Legacy, copas y stock

- Familias legacy de vino detectadas por heurística: `5`.
- Productos legacy reales:
  - `239` productos;
  - `225` vendibles;
  - `0` visibles+vendibles porque las familias legacy están ocultas.
- Pre-match legacy contra Winerim vivo:
  - `26` match;
  - `8` review;
  - `205` no-match.
- Hay `30` productos Winerim/no esperados por la política actual:
  - `27` por mapping rechazado o vino antiguo ya no accesible en Winerim;
  - `3` copas Winerim confirmadas aunque `auto_push_glass=false`.
- Dos copas confirmadas siguen visibles en `COPAS WINERIM`:
  - `972883` `C Majuelo del Chiviritero La Seca`;
  - `975433` `C Forster Pechstein Riesling GG Dry`.
- Ventas/stock desde `2026-06-01` en Lovable Cloud:
  - `283` documentos guardados;
  - `2.554` líneas;
  - `0` líneas mapeadas;
  - `0` entradas en `stock_sync_log`.
- Conclusión operativa: Katsu lee ventas, pero no se puede declarar stock automático correcto hasta resolver mappings y validar una venta/cierre real con producto Winerim.

### Decisión / criterio operativo

- Katsu queda documentado como conectado para lectura y catálogo parcial, pero no como instalación “perfecta” para stock.
- No activar `auto_push_verified_ready=true` ni hacer import masivo hasta validar que el runtime diferencial está desplegado y que `fetch-catalog` no genera cola masiva.
- El siguiente paso debe ser dry-run controlado para:
  - publicar los `11` faltantes;
  - mover/republicar los `3` que están en `VINOS` oculta hacia familias Winerim;
  - decidir explícitamente la política de copas.

### Riesgos / hipótesis

- Los `11` faltantes pueden deberse a `auto_push_verified_ready=false`; activar sin comprobar diferencial puede reimportar más de lo necesario.
- Las `3` copas confirmadas contradicen la política actual de `auto_push_glass=false`; pueden ser residuo histórico o decisión operativa previa.
- El contador de `is_wine_candidate` sigue contaminado por clasificación y no representa por sí solo vinos reales pendientes.
- Un producto vendido desde legacy oculto o desde un botón no mapeado no descontará stock en Winerim.

## Hechos (Jardí Parets · Winerim vs Agora pre-check — 2026-06-17)

- Se hizo auditoría solo lectura para Jardí Parets:
  - Agora `export-master` (`Families`, `Products`);
  - Winerim API v2 (`/wines` y detalles individuales);
  - ventas cerradas recientes por `Invoices`.
- No se ejecutó import XML, no se guardaron ventas, no se descontó stock, no se movió cursor y no se cambiaron flags.
- Informe específico: `JARDI_WINERIM_AGORA_MATCH_PRECHECK_2026-06-17.md`.
- CSVs de revisión:
  - `JARDI_WINERIM_PUBLISHED_PRODUCTS_2026-06-17.csv`;
  - `JARDI_LEGACY_TO_WINERIM_PUBLISHED_MATCH_2026-06-17.csv`;
  - `JARDI_WINERIM_PUBLISHED_TO_LEGACY_MATCH_2026-06-17.csv`.

### Resultado de catálogo

- Agora actual:
  - `61` familias;
  - `57` familias visibles;
  - `695` productos;
  - `695` productos vendibles.
- Familias Winerim:
  - `8/8` visibles;
  - `168` productos Winerim publicados;
  - `168/168` vendibles;
  - `0` productos Winerim como botón raíz.
- Winerim actual:
  - `174` vinos activos;
  - `168` formatos publicables con precio soportado (`166` botellas, `1` copa, `1` magnum);
  - `6` fichas activas sin precio/formato soportado (`Vega Sicilia Único`), no publicadas como Winerim.
- Cobertura Winerim -> Agora:
  - `168/168` formatos Winerim publicables están arriba en Agora dentro de familias `... WINERIM`.

### Validación con Excel Winerim del cliente

- El usuario aportó `Jardi export_17-06-2026_11-44-46.xlsx`.
- Se cruzó el Excel contra Agora vivo en modo solo lectura.
- Informe específico: `JARDI_EXCEL_AGORA_CROSSCHECK_2026-06-17.md`.
- Resultado del Excel:
  - `221` filas;
  - `174` activas;
  - `47` inactivas;
  - `168` formatos publicables soportados (`166` botellas, `1` copa, `1` magnum).
- Cruce Excel -> Agora:
  - `168/168` formatos esperados están publicados y vendibles;
  - faltantes `0`;
  - Winerim publicados en Agora sin justificar por Excel `0`.
- Los `6` activos sin precio/formato soportado son fichas de `Vega Sicilia Único`; no deben aparecer como Winerim en Agora mientras sigan sin precio soportado.
- Nota: `B PSI 705` se validó como producto correcto del Winerim `269705` (`PSI`), con sufijo de desambiguación por nombres duplicados en el Excel.

### Resultado legacy

- Legacy de vino sigue visible y vendible:
  - `VI NEGRE`: `208` productos vendibles contando subfamilias;
  - `VI BLANC`: `43`;
  - `VI ROSAT`: `9`;
  - `CAVA`: `19`;
  - `CHAMPAGNE`: `2`;
  - total legacy vino vendible: `281`.
- Match legacy -> Winerim publicado:
  - `103` match seguro;
  - `15` review;
  - `163` sin match fiable.
- Match Winerim publicado -> legacy:
  - `117` match seguro;
  - `8` review;
  - `43` sin match fiable.

### Ventas cerradas

- Lectura `Invoices` reciente OK:
  - `2026-06-16`: `8` facturas, `97` líneas;
  - `2026-06-15`: `4` facturas, `42` líneas;
  - `2026-06-13`: `8` facturas, `121` líneas;
  - `2026-06-12`: `12` facturas, `103` líneas;
  - `2026-06-11`: `15` facturas, `154` líneas;
  - `2026-06-10`: `5` facturas, `32` líneas.

### Decisión / criterio operativo

- Jardí no debe ocultar legacy en bloque todavía: hay `163` productos legacy vendibles sin equivalente Winerim fiable.
- Lo que hoy está en Winerim con precio soportado sí está publicado en Agora.
- El CSV de legacy debe usarse para decidir ocultación por fases: `MATCH` primero si el cliente valida, `REVIEW` manual, `NO_MATCH` no tocar sin autorización.

### Riesgos / hipótesis

- Mantener legacy + Winerim visibles puede generar duplicados visuales en los `103` matches seguros.
- Ocultar legacy sin revisión puede quitar vinos que el cliente todavía usa y que no están en Winerim.
- Este cruce confirma catálogo/nombre, no confirma por sí solo `product_mappings` en Lovable Cloud para descuento de stock legacy.
- `auto_push_on_update=false` sigue siendo una limitación viva en Jardí: altas nuevas pueden subir, pero cambios de precio/update no deben prometerse hasta resolver el falso update recurrente de `Dulce de Invierno`.

## Hechos (Winerim Excel vs Agora · pre-match El Bejeque y Taberna de Elia — 2026-06-17)

- Se parsearon los Excel Winerim facilitados por el usuario:
  - `Bejeque export_17-06-2026_11-03-52.xlsx`;
  - `Taberna de Eliaq export_17-06-2026_11-02-14.xlsx`.
- Se cruzaron contra el catálogo Agora leído en modo solo lectura por `export-master`.
- Informe específico: `WINERIM_AGORA_MATCH_PRECHECK_2026-06-17.md`.
- Artefacto local de cálculo: `/tmp/winerim_agora_match_2026-06-17.json`.

### El Bejeque

- Winerim:
  - `75` filas;
  - `72` activas;
  - `3` inactivas;
  - `72` operativas (`Activo=true` + al menos un precio);
  - `0` activas sin precio;
  - `3` inactivas con precio.
- Formatos operativos con precio:
  - botella `70`;
  - copa `21`;
  - magnum `6`;
  - botella pequeña `1`.
- Agora en familias de vino legacy: `86` productos, `52` vendibles, todas las familias de vino detectadas están ocultas.
- Match sobre `72` vinos operativos:
  - `54` match automático seguro (`75.0%`);
  - `9` review (`12.5%`);
  - `9` sin match (`12.5%`);
  - cobertura potencial si se aceptan reviews: `63/72` (`87.5%`).
- Por tipo operativo:
  - tinto: `32/40` match seguro;
  - blanco: `11/16`;
  - espumoso: `5/5`;
  - fortificado: `2/2`;
  - postre: `2/6`;
  - rosado: `2/3`.

### Taberna de Elia

- Winerim:
  - `484` filas;
  - `374` activas;
  - `110` inactivas;
  - `373` operativas (`Activo=true` + al menos un precio);
  - `1` activa sin precio (`Prima`, tinto);
  - `105` inactivas con precio.
- Formatos operativos con precio:
  - botella `343`;
  - copa `49`;
  - magnum `10`;
  - botella pequeña `10`;
  - benjamin `1`;
  - media botella `8`.
- Agora en familias de vino seleccionadas: `1.061` productos, `603` vendibles.
- Match sobre `373` vinos operativos:
  - `176` match automático seguro (`47.2%`);
  - `96` review (`25.7%`);
  - `101` sin match (`27.1%`);
  - cobertura potencial si se aceptan reviews: `272/373` (`72.9%`);
  - `62` matches seguros tienen duplicidad/ambigüedad de producto en Agora y deben revisarse antes de confirmar mapping.
- Por tipo operativo:
  - tinto: `125/203` match seguro;
  - blanco: `31/94`;
  - espumoso: `4/32`;
  - fortificado: `13/26`;
  - postre: `3/16`;
  - rosado: `0/2`.

### Decisiones / criterio operativo

- Para este pre-match, “operativo Winerim” significa `Activo=true` y al menos un formato con precio.
- No se cuenta `Review` como match automático; requiere revisión humana para evitar mappings incorrectos.
- Taberna de Elia no debe ir a volcado directo: requiere fase de matching legacy/revisión de duplicados antes de cualquier publicación u ocultación.

### Tareas pendientes inmediatas

- Preparar, si se necesita, Excel de revisión con columnas Winerim, mejor candidato Agora, score, familia Agora y estado (`MATCH`, `REVIEW`, `NO_MATCH`).
- El Bejeque: revisar los `9` no-match y `9` review antes de decidir si se reutiliza legacy o se crean familias Winerim dedicadas.
- Taberna de Elia: revisar prioritariamente los `62` matches con duplicidad, los `96` review y el producto directo genérico `Botella de Vino`.

## Hechos (Agora · pre-onboarding El Bejeque y Taberna de Elia — 2026-06-17)

- Se hizo auditoría solo lectura, sin crear conexiones, sin importar XML y sin tocar stock, para:
  - `El Bejeque`;
  - `Taberna de Elia`.
- Informe específico: `AGORA_PRE_ONBOARDING_AUDIT_2026-06-17.md`.
- Artefactos locales de apoyo, no necesarios para producción:
  - `/tmp/agora_readonly_audit_2026-06-17.json`;
  - `/tmp/el_bejeque_agora_structure_2026-06-17.json`;
  - `/tmp/taberna_elia_agora_structure_2026-06-17.json`.

### El Bejeque

- Base URL validada: `https://elbejeque.infogral.es`.
- `export-master` funciona para `Families`, `Products`, `Vats`, `PriceLists`, `PreparationTypes`, `PreparationOrders`, `Warehouses` y `SaleCenters`.
- `SalePoints` devuelve HTTP `500`.
- `/api/` devuelve HTTP `404`, pero no bloquea porque los endpoints reales de exportación sí funcionan.
- `Invoices` funciona por días cerrados: el día `2026-06-10` devolvió `3` facturas y `34` líneas.
- `Tickets`, `Orders`, `OpenInvoices` y `Receipts` devuelven HTTP `500`; no hay señal de tiempo real por API.
- Catálogo: `28` familias, `277` productos, `191` productos vendibles, `0` productos direct-sale y `10` productos sin familia.
- Familias de vino legacy detectadas:
  - `14` `TINTOS`: `48` productos, `34` vendibles, familia oculta;
  - `15` `BLANCOS`: `21` productos, `10` vendibles, familia oculta;
  - `16` `ROSADO`: `4` productos, `3` vendibles, familia oculta;
  - `17` `ESPUMOSO`: `6` productos, `3` vendibles, familia oculta;
  - `18` `FORTIFICADO`: `1` producto, `0` vendibles, familia oculta;
  - `19` `POSTRE`: `6` productos, `2` vendibles, familia oculta.
- Solo aparece como visible la familia `28` `ARROCENADO EN CASA`; la visibilidad actual de familias es anómala y requiere confirmación con cliente/SAT antes de subir Winerim.
- No hay familias `WINERIM`.

### Taberna de Elia

- Base URL validada: `https://elia.tpvrent.net`.
- `export-master` funciona para `Families`, `Products`, `Vats`, `PriceLists`, `PreparationTypes`, `PreparationOrders`, `Warehouses` y `SaleCenters`.
- `SalePoints` devuelve HTTP `500`.
- `/api/` devuelve HTTP `404`, pero no bloquea porque los endpoints reales de exportación sí funcionan.
- `Invoices` funciona por días cerrados: `2026-06-16` devolvió `8` facturas y `86` líneas; `2026-06-10` devolvió `32` facturas.
- `Tickets`, `Orders`, `OpenInvoices` y `Receipts` devuelven HTTP `500`; no hay señal de tiempo real por API.
- Catálogo: `117` familias, `67` visibles, `20` subfamilias, `2.940` productos, `2.118` productos vendibles, `8` direct-sale y `321` productos sin familia.
- Estructura de vino principal:
  - raíz visible `47` `Bodega`, con subfamilias visibles por denominación/región;
  - subfamilias visibles: `Ribera del Duero`, `Rioja`, `Toro`, `Castilla y León`, `Madrid`, `Otras Denominaciones`, `Magnum y Medias Botellas`, `Blancos`, `Espumosos`, `Otros Vinos`, `Tintos franceses`, `frances blanco`, `Priorato`, `Jumilla`, `D.O. Ribera Sacra`;
  - raíz visible `16` `Vinos` con `45` productos;
  - raíz visible `64` `Vermuth y Vinos de jerez`.
- Hay familias legacy ocultas de vino (`Blancos nacionales`, `Cavas`, `Champagne`, `Jerez`, `Ribera del Duero`, `Rioja`, `Tintos Franceses`, etc.).
- Existe producto directo genérico `Botella de Vino`; no es mapeable a stock Winerim sin cambio operativo o regla específica.
- No hay familias `WINERIM`.

### Firesoft / BDP

- Firesoft: no se localizó API pública; viabilidad pendiente de que Pascual/Firesoft confirme API REST, export programable, acceso a base de datos o ficheros de intercambio. La web pública confirma TPV hostelería, comanderos/monitor de cocina y control de stock, pero no documentación técnica de integración.
- BDP NET: viable si se activa Weblink REST API y plantilla de exportación. Fuentes públicas de integradores describen activación de `Servicio Web`, pestaña `Weblink Rest API`, puerto, login, usuario/clave y código de exportación.

### Decisiones

- No crear aún `pos_connections` para El Bejeque ni Taberna de Elia.
- No subir catálogo Winerim ni ocultar legacy hasta validar visualmente la estructura actual con cada cliente/SAT.
- Para ambos Agoras, asumir inicialmente flujo de ventas D-1/post-cierre por `Invoices`, no tiempo real.

### Hipótesis / riesgos

- El Bejeque puede tener una configuración de pantalla distinta a lo que expone `ShowInPos`, o estar usando una capa/cache/terminal no obvia; no tocar visibilidad hasta confirmarlo.
- Taberna de Elia parece tener una pantalla de vino muy trabajada por `Bodega` y regiones; reemplazarla de golpe por familias Winerim puede romper memoria visual de sala.
- `SalePoints` HTTP `500` en ambos no bloquea lectura/escritura básica, pero puede limitar configuración fina por punto de venta.
- Productos genéricos como `Botella de Vino` no pueden descontar stock de un vino concreto salvo que se elimine su uso o se añada selección/mapping operativo.

### Tareas pendientes inmediatas

- Enviar al usuario resumen operativo y borradores de correo para Firesoft y BDP.
- El Bejeque: preguntar por qué las familias de vino están ocultas en Agora y si quieren crear familias Winerim dedicadas o reutilizar legacy.
- Taberna de Elia: confirmar si desean conservar estructura `Bodega` por regiones mediante matching, o piloto con familias Winerim dedicadas.
- Firesoft: pedir documentación técnica, método de autenticación, endpoints/export de ventas, catálogo, stock y escritura de artículos/precios.
- BDP: pedir activación Weblink REST API, URL/puerto, usuario/clave, código de plantilla de exportación y confirmación de endpoints de alta/actualización de artículos.

## Hechos (Agora · orden comercial automático por código — 2026-06-17)

- Nueva necesidad confirmada por Sa Pedrera: las familias Winerim deben respetar el orden numérico que el cliente mantiene en Winerim (`T499` antes de `T501`, `E516` en su posición de espumosos, `D701-D710` en dulces, etc.).
- Cambio añadido en `supabase/functions/agora-proxy/index.ts`:
  - modo configurable `provider_config.agora_product_sort_mode="COMMERCIAL_CODE_NUMERIC"`;
  - orden de prefijos configurable con `provider_config.agora_product_sort_prefix_order`, por defecto `T`, `B`, `R`, `E`, `D`, `G`, `MAGNUM`;
  - orden de prefijos por familia configurable con `provider_config.agora_product_sort_prefix_order_by_family`;
  - familias objetivo configurables con `provider_config.agora_product_sort_family_ids`;
  - nuevo action `reorder-products-by-commercial-code`;
  - el action lee `Families` y `Products` vivos de Agora, agrupa productos por familia y reescribe solo `Order`;
  - conserva completo el XML original de cada `<Product>`: no cambia `Id`, `Name`, `ButtonText`, precios, `FamilyId`, preparación, visibilidad ni stock;
  - devuelve `rollbackXml` con el estado anterior de `Order`.
- El generador XML normal (`generateImportXml`) también respeta el orden por código cuando el modo está activo, para previews/imports multi-producto.
- El procesador de cola `process-xml-outbound-queue` queda conectado al orden automático:
  - `process-xml-outbound-task` devuelve `affectedFamilyIds` tras un import correcto;
  - al final del batch, si la conexión tiene `COMMERCIAL_CODE_NUMERIC`, la cola invoca una única reordenación de las familias afectadas;
  - esto cubre el caso operativo de un vino nuevo subido a Winerim que entra como producto individual en Agora.
- Sa Pedrera conserva la regla especial ya validada para `DULCES WINERIM`: los `D###` usan IDs deterministas `903xxx` porque esa pantalla se validó como dependiente de `Product.Id` además de `Order`.
- `MAGNUM WINERIM` debe ordenar `MAGNUM###` antes de otros prefijos aunque el orden global ponga `R` antes que `MAGNUM`; queda soportado por prioridad por familia.
- Hallazgo durante la aplicación: `SortOrder` no es atributo persistente/exportado por Agora para productos; el atributo real para orden de pantalla es `Order`.
- Sa Pedrera quedó configurada en Lovable Cloud con:
  - `agora_product_sort_mode="COMMERCIAL_CODE_NUMERIC"`;
  - `agora_product_sort_prefix_order=["T","B","R","E","D","G","MAGNUM"]`;
  - `agora_product_sort_prefix_order_by_family={"904289":["MAGNUM","T","B","R","E","D","G"]}`;
  - `agora_product_sort_family_ids=["900157","904241","903516","908875","908182","904289","901954","903925"]`.
- Se aplicó reordenación directa por XML en Sa Pedrera, porque Lovable Cloud todavía respondía `Unknown action` para `reorder-products-by-commercial-code` tras el push.
- Artefactos guardados:
  - `SA_PEDRERA_COMMERCIAL_CODE_REORDER_2026-06-17.md`;
  - `SA_PEDRERA_COMMERCIAL_CODE_REORDER_DRY_RUN_2026-06-17.json`;
  - `SA_PEDRERA_COMMERCIAL_CODE_REORDER_APPLIED_2026-06-17.json`.
- Resultado aplicado:
  - import Agora HTTP `200`;
  - `321` productos cambiaron de `Order`;
  - verificación viva posterior: `438/438` productos revisados con `Order` esperado;
  - `0` fallos de verificación.
- Resumen por familia aplicado:
  - `BLANCOS WINERIM`: `108` productos, `107` con código, `1` sin código (`Benje Blanco`), `101` cambios;
  - `ROSADOS WINERIM`: `8` productos, `0` cambios;
  - `TINTOS WINERIM`: `212` productos, `208` con código, `4` sin código, `131` cambios;
  - `ESPUMOSOS WINERIM`: `52` productos, `52` cambios;
  - `FORTIFICADOS WINERIM`: `1` producto, `0` cambios;
  - `MAGNUM WINERIM`: `30` productos, `10` cambios, `MAGNUM 1` queda primero y `R605` queda al final;
  - `COPAS WINERIM`: `16` productos, `16` cambios;
  - `DULCES WINERIM`: `11` productos, `11` cambios.
- Se sincronizó el clon limpio de GitHub con los cambios recientes locales antes de añadir esta mejora, para no perder:
  - regla `AUTO_PRICE_REMOVED`;
  - limpieza de breaker residual caducado;
  - documentación viva de Sa Pedrera.

### Validación
- `npx -y esbuild@0.21.5 supabase/functions/agora-proxy/index.ts --bundle --format=esm --platform=neutral --external:https://* --external:../_shared/* --outfile=/tmp/agora-proxy-clean-check.js`: OK.
- `git diff --check`: OK.
- Sonda Lovable Cloud posterior al push: `Unknown action`, por tanto el runtime vivo aún no había redeployado la nueva acción en el momento de aplicar.
- Verificación directa Agora post-apply: `438/438` productos con `Order` esperado.
- No hay `deno` local para `deno check`; la validación completa de Edge Function debe confirmarse tras redeploy en Lovable Cloud/CI o con entorno Deno disponible.

### Decisiones
- No recrear productos ni cambiar IDs para ordenar Sa Pedrera. El orden se aplica primero por `Order`, preservando mappings, tracking e histórico.
- Hacer la funcionalidad configurable por conexión, no hardcodeada solo para Sa Pedrera.
- Mantener rollback reversible mediante `rollbackXml` y configuración en `provider_config`.

### Hipótesis
- En la mayoría de pantallas Agora, `Order` debería bastar para el orden visual dentro de familia.
- En pantallas que ignoren `Order` y ordenen por `Product.Id`, hará falta una estrategia específica por familia; `DULCES WINERIM` ya la tiene con IDs `903xxx`.

### Riesgos / rollback
- Riesgo visual: alguna tablet puede mantener caché o ignorar `Order` hasta recargar sesión/pantalla.
- Riesgo operativo bajo: el action no cambia precios, familias, preparación ni visibilidad; si el import falla, no debería dejar productos a medias.
- Rollback técnico: importar el `rollbackXml` devuelto por `reorder-products-by-commercial-code` o desactivar `provider_config.agora_product_sort_mode`.
- Rollback de código: revertir el bloque `COMMERCIAL_CODE_NUMERIC` y el action `reorder-products-by-commercial-code`.

### Tareas pendientes inmediatas
- Confirmar redeploy de Lovable Cloud con la nueva acción `reorder-products-by-commercial-code` y la cola automática por `Order`.
- Pedir validación visual al cliente tras refrescar/cerrar sesión en tablet: especialmente `TINTOS WINERIM`, `ESPUMOSOS WINERIM`, `MAGNUM WINERIM`, `DULCES WINERIM` y `COPAS WINERIM`.
- Probar caso futuro controlado (`T499` antes de `T501`) cuando Lovable Cloud ya tenga redeployado el código; debe publicarse y reordenarse automáticamente tras la cola.
- Si alguna familia no respeta `Order` visualmente pese a estar persistido, aislarla y decidir si necesita IDs deterministas como `DULCES WINERIM`.

## Hechos (Agora · regla de precio obligatorio Winerim — 2026-06-17)

- Regla de negocio confirmada por el usuario: si un vino no tiene precio en Winerim, no debe aparecer operativo en Agora hasta que tenga precio en Winerim.
- Comportamiento ya existente:
  - un vino nuevo sin precio de botella no pasa `validateWineForAgora(..., "BOTTLE")`;
  - una copa sin `serve_by_glass=true` o sin precio de copa no pasa validación de `GLASS`;
  - un magnum sin precio de magnum no pasa validación de `MAGNUM`;
  - por tanto, vinos/formatos nuevos sin precio no se crean en Agora.
- Cambio añadido en `supabase/functions/agora-proxy/index.ts`:
  - se añadió `isFormatUnavailableForAgora(wine, formatType)`;
  - en `evaluate-auto-push`, si un formato ya publicado (`VERIFIED`/`PUSHED`) deja de tener precio válido en Winerim, se encola `AGORA_HIDE_PRODUCT`;
  - la tarea usa `_trigger_source="AUTO_PRICE_REMOVED"`;
  - se actualiza `winerim_push_tracking.sync_status="HIDDEN"` para el formato afectado;
  - si más adelante el precio vuelve a Winerim, ese formato deja de estar `VERIFIED/PUSHED` y puede volver a encolarse/publicarse por el flujo normal.
- La regla se aplica por formato:
  - botella sin precio de botella: ocultar/no crear botella;
  - copa sin precio de copa o sin `serve_by_glass`: ocultar/no crear copa;
  - magnum sin precio de magnum: ocultar/no crear magnum.
- Stock `0` sigue sin bloquear publicación; precio y activación son las señales de visibilidad operativa, no cantidad de stock.

### Validación
- Revisión de código: `validateWineForAgora` ya bloquea formatos nuevos sin precio.
- Se revisó el bloque `evaluate-auto-push` y se añadió ocultación automática para formatos publicados que pierden precio.
- No se pudo ejecutar `tsc`/Git diff de forma fiable en esta copia temporal: la metadata `.git` aparece incompleta y el paquete local `typescript` no incluye `bin/tsc` ni `lib/tsc.js`; queda pendiente validar en copia limpia/CI antes de deploy.

### Decisiones
- La ausencia de precio en Winerim equivale a “no vender/no mostrar operativo en Agora” para ese formato.
- No mezclar stock con visibilidad: stock `0` puede seguir visible; precio ausente no.
- Mantener rollback vía ocultación reversible, no borrado de productos.

### Riesgos / rollback
- Riesgo si se despliega sin validación limpia: error TS/Deno no detectado localmente por la copia temporal incompleta. Mitigación: validar en Lovable Cloud/CI o copia limpia antes de redeploy.
- Riesgo operativo: si un cliente quita precios temporalmente en Winerim, esos productos se ocultarán en Agora hasta que vuelvan a tener precio.
- Rollback: revertir el bloque `AUTO_PRICE_REMOVED` y volver a la regla anterior, donde un producto ya publicado no se ocultaba por pérdida de precio.

### Tareas pendientes inmediatas
- Validar en copia limpia/CI y desplegar `agora-proxy` actualizado.
- Probar con sonda controlada: un vino publicado con precio eliminado debe devolver/encolar ocultación; al restaurar precio debe volver a publicarse.
- Comunicar al equipo: “Activo + precio = aparece; activo sin precio = no aparece; desactivado = oculto; stock 0 = puede aparecer”.

## Hechos (Sa Pedrera · prevención de breaker residual en cola outbound — 2026-06-16)

- Estado vivo de Sa Pedrera tras revisar `E516`/`E520`:
  - `enabled=true`;
  - `catalog_sync_enabled=true`;
  - `auto_push_on_create=true`;
  - `auto_push_on_update=true`;
  - `auto_push_bottle=true`;
  - `auto_push_glass=true`;
  - `auto_push_verified_ready=true`;
  - `circuit_breaker_paused_until=null`;
  - `circuit_breaker_reason=null`;
  - `consecutive_failures=0`;
  - cola abierta Winerim→Agora: `0` tareas `AGORA_XML_UPSERT_PRODUCT`;
  - cola abierta total: `0`.
- Se corrigió en código `supabase/functions/agora-proxy/index.ts` el caso de breaker residual caducado:
  - si `circuit_breaker_paused_until` existe pero ya está vencido;
  - y `consecutive_failures >= 10`;
  - el procesador limpia `consecutive_failures`, `circuit_breaker_paused_until` y `circuit_breaker_reason` antes de evaluar si debe cortar la cola.
- Esto evita que la función quede en estado intermedio: pausa caducada pero contador todavía a `10`, que era lo que impedía procesar tareas nuevas aunque Agora ya respondiera.

### Validación
- Sonda viva de estado Sa Pedrera: breaker limpio y cola abierta `0`.
- `npx tsc --noEmit`: OK.
- `git diff --check`: OK.
- No hay `deno` local disponible para `deno check` de la Edge Function.

### Decisiones
- Mantener el flujo normal: los vinos nuevos de Winerim deben entrar por `fetch-catalog` → `evaluate-auto-push` → `outbound_tasks` → `process-xml-outbound-queue`, no por imports manuales ad hoc.
- La corrección de breaker residual debe desplegarse/confirmarse en Lovable Cloud antes de considerarla protección productiva completa.

### Riesgos / rollback
- La corrección solo actúa cuando la pausa ya está vencida; si Agora está realmente caído y el breaker sigue vigente, mantiene el comportamiento seguro de no procesar.
- Riesgo restante normal: si Agora no responde, devuelve errores de import o una ficha Winerim no tiene precio/formato válido, el vino puede quedar en cola o saltado con motivo explícito.

### Tareas pendientes inmediatas
- Confirmar redeploy de `agora-proxy` en Lovable Cloud.
- Añadir alerta/monitor para `AGORA_XML_UPSERT_PRODUCT` en `QUEUED` más de `10-15` minutos en conexiones activas.
- Clasificar fallos históricos/recientes de Sa Pedrera que no afectaban a `E516`/`E520`.

## Hechos (Sa Pedrera · E516 publicado tras desbloquear breaker residual — 2026-06-16)

- Cliente reportó que `E516 - Hermós Brut Nature` no aparecía en Agora.
- Diagnóstico:
  - Winerim cacheado en Lovable Cloud sí tenía el vino:
    - `winerim_id=287386`;
    - nombre `E516 - Hermós Brut Nature`;
    - `wine_type=espumoso`;
    - `is_active=true`;
    - `bottle_sale_price=70`;
    - `bottle_stock_id=330981`;
    - sin copa/magnum.
  - Agora XML no lo devolvía inicialmente.
  - `evaluate-auto-push` con `forceEvaluate:true` indicó `already_pending_task`.
  - La tarea existía como `AGORA_XML_UPSERT_PRODUCT`, `AUTO_CREATE`, `BOTTLE`, `QUEUED`, `attempts=0`, creada el `2026-06-16T08:10:46Z`.
  - El dispatcher no procesaba porque `consecutive_failures=10` seguía activo aunque `circuit_breaker_paused_until` estaba caducado.
- Se validó conectividad real de Agora leyendo `Families` y `Products` por XML antes de resetear el breaker.
- Se reseteó el breaker residual de Sa Pedrera:
  - `consecutive_failures=0`;
  - `circuit_breaker_paused_until=null`;
  - `circuit_breaker_reason=null`.
- Se lanzó `agora-cron-dispatcher` con `job=outbound-queue` limitado a Sa Pedrera.
- Resultado de la tanda:
  - `processed=28`;
  - `succeeded=15`;
  - `failed=13`;
  - `remaining=33`;
  - `breakerTripped=false`.
- Verificación específica de `E516`:
  - `winerim_push_tracking`: `BOTTLE`, `agora_product_id=787386`, `sync_status=VERIFIED`, `last_error=null`;
  - `product_mappings`: `provider_product_id=787386`, `provider_product_name="B E516 - Hermós Brut Nature"`, `status=CONFIRMED`, `format_type=BOTTLE`;
  - Agora XML: producto `787386`, `Name="B E516 - Hermós Brut Nature"`, `ButtonText="B E516 - Hermós Brut"`, `FamilyId=908875`, familia `ESPUMOSOS WINERIM`, `ShowInPos=true`, `SaleableAsMain=true`, `UseAsDirectSale=false`.
- Tras la corrección, la cola abierta de Sa Pedrera ya no contiene `E516`; solo queda `1` tarea `QUEUED` antigua de tipo `AGORA_HIDE_PRODUCT` para otro vino (`winerim_id=44833`).
- Segunda comprobación solicitada por cliente: `E520 -Philippe Pacalet Bulles Extra Brut`.
  - Winerim cacheado:
    - `winerim_id=287118`;
    - `wine_type=espumoso`;
    - `is_active=true`;
    - `bottle_sale_price=114`;
    - `bottle_stock_id=330719`.
  - Tracking:
    - `BOTTLE`;
    - `agora_product_id=787118`;
    - `sync_status=VERIFIED`;
    - `last_error=null`;
    - `pushed_at=2026-06-16T10:30:58.849Z`.
  - Mapping:
    - `provider_product_id=787118`;
    - `provider_product_name="B E520 -Philippe Pacalet Bulles Extra Brut"`;
    - `status=CONFIRMED`;
    - `format_type=BOTTLE`.
  - Agora XML:
    - producto `787118`;
    - familia `ESPUMOSOS WINERIM` (`908875`);
    - `ShowInPos=true`;
    - `SaleableAsMain=true`;
    - `UseAsDirectSale=false`;
    - `ButtonText="B E520 -Philippe Pac"`.
  - No hay tareas abiertas ni fallidas relacionadas con `E520`.
  - Existe un legacy antiguo `philippe Pacalet Bulles` (`1177480`) en `Champagnes`, pero queda oculto/no vendible tras la ocultación legacy; el producto operativo es el Winerim `787118`.

### Decisiones
- Se reseteó el breaker solo después de una sonda sana de Agora, no a ciegas.
- No se forzó un import manual especial para `E516`; se dejó pasar por la cola normal para preservar idempotencia, tracking y mapping.

### Riesgos / rollback
- El producto ya existe en Agora y está verificado; si el cliente no lo ve en tablet, lo más probable es caché/recarga de pantalla.
- Quedan `13` fallos de la tanda procesada que no bloquean `E516`, pero conviene clasificarlos antes de prometer que todos los cambios pendientes de Sa Pedrera están limpios.
- Rollback de `E516`: ocultar producto Agora `787386` y ajustar tracking/mapping solo si el cliente confirma que no debía publicarse.

### Tareas pendientes inmediatas
- Pedir al cliente que refresque/cierre sesión en Agora y busque `E516` dentro de `ESPUMOSOS WINERIM`.
- Pedir al cliente que busque también `E520` dentro de `ESPUMOSOS WINERIM`; no debe buscarse en la familia legacy `Champagnes`.
- Clasificar los `13` fallos de la tanda de outbound de Sa Pedrera.
- Revisar la tarea `AGORA_HIDE_PRODUCT` restante (`winerim_id=44833`) antes de reintentar/limpiar.

## Hechos (Sa Pedrera · ocultación reversible de legacy Agora — 2026-06-16)

- Se aplicó ocultación reversible del legacy de vino de Sa Pedrera en Agora, sin borrar productos, mappings ni tracking.
- Snapshot dry-run previo: `SA_PEDRERA_LEGACY_HIDE_DRY_RUN_2026-06-16.json`.
- Snapshot aplicado / rollback: `SA_PEDRERA_LEGACY_HIDE_APPLIED_2026-06-16.json`.
- Informe operativo: `SA_PEDRERA_LEGACY_HIDE_2026-06-16.md`.
- Alcance aplicado:
  - `28` familias legacy de vino ocultadas (`ShowInPos=false`);
  - `521` productos legacy dentro de esas familias con `SaleableAsMain=false` y `UseAsDirectSale=false`;
  - `0` familias legacy visibles tras verificación viva;
  - `0` productos legacy activos/vendibles tras verificación viva.
- No se tocaron familias de comida, `Carta`, ni familias `... WINERIM`.
- Las familias Winerim siguen visibles y con productos:
  - `DULCES WINERIM`: `11`;
  - `TINTOS WINERIM`: `203`;
  - `BLANCOS WINERIM`: `99`;
  - `ROSADOS WINERIM`: `8`;
  - `MAGNUM WINERIM`: `29`;
  - `FORTIFICADOS WINERIM`: `1`;
  - `ESPUMOSOS WINERIM`: `46`;
  - `COPAS WINERIM`: `15`.
- Flags actuales Sa Pedrera confirmados vivos:
  - `enabled=true`;
  - `catalog_sync_enabled=true`;
  - `auto_push_on_create=true`;
  - `auto_push_on_update=true`;
  - `auto_push_verified_ready=true`.
- Última tanda documentada como `AUTO_CREATE` real de Sa Pedrera:
  - `105908` — `Egly-Ouriet 'Les Prémices'` → Agora `605908`, botella, precio `118.00`;
  - `175356` — `T213-Saint-Émilion Grand Cru` → Agora `675356`, botella, precio `75.00`;
  - `205597` — `B437- Château Beauregard` → Agora `705597`, botella, precio `65.00`.
- Si el cliente añade o activa ahora un vino válido en Winerim, el flujo automático debería publicarlo en Agora en el siguiente ciclo de catálogo; ventana operativa esperada: unos `5` minutos, dejando `5-10` minutos si acaba de pasar el ciclo o hay enriquecimiento/cola.

### Validación
- `node --check scripts/sa-pedrera-hide-legacy.mjs`: OK.
- Dry-run: `families=28`, `visibleFamilies=28`, `products=521`, `saleableProducts=498`.
- Apply real:
  - `5` tandas de import Agora (`120 + 120 + 120 + 120 + 41` productos);
  - verificación interna OK: `hiddenFamilies=28`, `disabledProducts=521`;
  - `sync-master-data` ejecutado OK.
- Verificación independiente post-write:
  - `legacyVisibleFamilies=0`;
  - `legacyActiveProducts=0`;
  - `8` familias Winerim visibles.

### Decisiones
- Ocultar legacy como rollback reversible, no borrar productos ni mappings.
- Mantener automatismos Winerim → Agora activos en Sa Pedrera.
- Separar comunicación de altas nuevas (`AUTO_CREATE`) de verificaciones/updates posteriores para no confundir “vino nuevo” con “producto ya existente actualizado”.

### Riesgos / rollback
- Riesgo principal: cache visual de tablet o layout Agora puede tardar en refrescar o requerir recarga/cierre de sesión.
- Rollback: importar los `xmlBefore` del snapshot `SA_PEDRERA_LEGACY_HIDE_APPLIED_2026-06-16.json` restaurando `ShowInPos`, `SaleableAsMain` y `UseAsDirectSale`.
- No revertir tocando `product_mappings`, `winerim_push_tracking` ni ventas; la operación fue puramente visual/vendibilidad POS.

### Tareas pendientes inmediatas
- Pedir validación visual al cliente: legacy de vino ya no aparece y familias Winerim siguen correctas.
- Hacer venta real de prueba de una botella Winerim y una copa Winerim; validar `sales_line_items.mapped=true` y `stock_sync_log.SUCCESS`.
- Monitorizar próximo ciclo de catálogo para confirmar que no aparece cola masiva y que solo suben cambios reales.

## Hechos (Cloudflare onboarding · hardening UI/Worker y runbooks — 2026-06-16)

- Se extrajo la maquina de estados de `onboarding_requests` a `src/lib/onboardingRequest.ts`.
- Worker y UI usan ahora la misma fuente de verdad:
  - `isOnboardingRequestStatus`;
  - `canTransitionOnboardingRequestStatus`;
  - `ALLOWED_ONBOARDING_STATUS_TRANSITIONS`.
- La pantalla `/onboarding/requests` ya no ofrece acciones de estado que el Worker rechazaria, por ejemplo saltos hacia `CONVERTED` desde estados de prueba.
- Se corrigio CORS del Worker para permitir `PATCH`:
  - antes: `GET,POST,OPTIONS`;
  - ahora: `GET,POST,PATCH,OPTIONS`.
- Se amplio `scripts/verify-cloudflare-staging.sh` para validar preflight `POST` y `PATCH`.
- Se anadio `scripts/check-cloudflare-readiness.sh` y el comando `npm run cf:readiness:staging`.
- `cf:readiness:staging` es read-only y distingue:
  - Worker `workers.dev` operativo;
  - custom domain API pendiente;
  - Pages staging pendiente;
  - CORS `POST/PATCH` listo.
- Se reemplazo el README generico por un README real del proyecto con reglas duras, comandos, validacion y gates de activacion.
- Nuevos runbooks:
  - `cloudflare/README.md`;
  - `cloudflare/access/README.md`;
  - `cloudflare/secrets/README.md`.
- Se actualizo `cloudflare/dns-access/README.md` para incluir la validacion `PATCH` y los checklists nuevos.
- Worker staging redeployado:
  - URL temporal: `https://winerim-middleware-api-staging.gugocreative.workers.dev`;
  - Version ID: `6af1c6ed-fc3a-4d29-aa55-84cb81fbe915`;
  - `ONBOARDING_REQUESTS_ENABLED=false` se mantiene;
  - `CF_ACCESS_AUD`/`CF_ACCESS_TEAM_DOMAIN` siguen sin configurar.

### Validación
- `npm run test -- src/test/onboardingRequest.test.ts src/test/middlewareWorker.test.ts`: OK, `20` tests.
- `npm run test`: OK, `51` tests.
- `npx tsc --noEmit`: OK.
- `npx eslint src/lib/onboardingRequest.ts src/pages/OnboardingRequests.tsx cloudflare/workers/middleware-api/src/index.ts src/test/onboardingRequest.test.ts src/test/middlewareWorker.test.ts`: OK.
- `npm run build`: OK; warning conocido de chunk grande.
- `npx --yes wrangler deploy --config wrangler.middleware.toml --env staging --dry-run`: OK.
- Deploy real staging OK.
- `npm run cf:api:verify:staging`: OK contra staging desplegado; confirma health, validacion REVO incompleta, CORS `POST/PATCH` y storage apagado.
- `npm run cf:readiness:staging`: OK con `0` fallos y `3` pendientes esperados:
  - `api-staging.middleware.winerim.wine` no resuelve todavia;
  - CORS por custom API domain pendiente por el mismo DNS;
  - `staging.middleware.winerim.wine`/Pages no esta desplegado todavia.
- Verificacion visual local con Vite `8084` y Worker `8787`:
  - `/onboarding/requests` renderiza;
  - muestra la navegacion `Requests`;
  - informa "La bandeja de solicitudes todavia no esta activada en este entorno.";
  - no quedan procesos locales vivos.
- `git diff --check`: OK.

### Decisiones
- La maquina de estados debe mantenerse compartida entre UI y Worker para evitar divergencias operativas.
- No crear Cloudflare Pages publico ni activar storage de solicitudes hasta que Access este configurado.
- No crear Secrets Store real todavia; queda documentado como opcion, pero la decision de almacenamiento de tokens sigue pendiente.
- Mantener `workers.dev` como endpoint de smoke mientras `api-staging.middleware.winerim.wine` no resuelva.

### Riesgos / rollback
- Riesgo si se activa storage antes de Access: solicitudes privadas podrian quedar expuestas. Mitigacion: `ONBOARDING_REQUESTS_ENABLED=false`.
- Riesgo si Pages se publica sin Access: el onboarding comercial quedaria visible. Mitigacion: no desplegar Pages hasta crear politica Access.
- Rollback inmediato del bloque Worker: volver a version anterior o dejar `ONBOARDING_REQUESTS_ENABLED=false`; no hay escrituras POS/Winerim ni cambios en `pos_connections`.

## Hechos (Cloudflare onboarding · máquina de estados segura — 2026-06-16)

- Se añadieron transiciones explícitas para `onboarding_requests`.
- `PATCH /api/onboarding/requests/:id` ahora:
  - lee primero el estado actual;
  - bloquea saltos inseguros como `TESTED -> CONVERTED`;
  - devuelve `INVALID_STATUS_TRANSITION` con HTTP 409 si el salto no esta permitido;
  - conserva el principio de no crear `pos_connections` ni disparar automatismos.
- Transiciones clave:
  - `READY_FOR_TECHNICAL_REVIEW -> TECHNICAL_REVIEW/APPROVED/REJECTED/CANCELED`;
  - `APPROVED -> CONVERTED/CANCELED/TECHNICAL_REVIEW`;
  - `CONVERTED` no permite salida automatica.
- Worker staging redeployado:
  - Version ID: `bdcb9972-4631-4249-9887-57da3cb39dc0`;
  - `ONBOARDING_REQUESTS_ENABLED=false` se mantiene.

### Validación
- `npm run test -- src/test/middlewareWorker.test.ts`: OK, `14` tests.
- `npm run test`: OK, `50` tests.
- `npx tsc --noEmit`: OK.
- `npx eslint` en Worker/test tocados: OK.
- `npx --yes wrangler deploy --config wrangler.middleware.toml --env staging --dry-run`: OK.
- Deploy real staging OK.
- `npm run cf:api:verify:staging`: OK.

### Decisiones
- `CONVERTED` queda como estado terminal manual hasta implementar conversion auditada a `pos_connections`.
- No permitir saltos directos a `CONVERTED` desde estados de prueba/revision.
- Mantener la revision como control humano, no como activacion automatica.

## Hechos (Cloudflare Access JWT en Worker — 2026-06-16)

- Se preparo validacion firmada de Cloudflare Access para rutas privadas del Worker.
- Nuevas variables opcionales:
  - `CF_ACCESS_AUD`: Audience Tag de la app Access;
  - `CF_ACCESS_TEAM_DOMAIN`: dominio Access del equipo, por ejemplo `https://winerim.cloudflareaccess.com`.
- Si `CF_ACCESS_AUD` esta configurado:
  - el Worker exige `CF-Access-Jwt-Assertion`;
  - descarga claves publicas desde `{CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  - valida `aud`, `exp`, `kid`, algoritmo `RS256` y firma;
  - extrae `email` del payload validado;
  - si falla, devuelve `ACCESS_IDENTITY_REQUIRED` y no toca storage.
- Si `CF_ACCESS_AUD` no esta configurado, se conserva el modo anterior: usar `CF-Access-Authenticated-User-Email` cuando storage este activo.
- CORS actualizado para permitir `CF-Access-Jwt-Assertion`.
- Worker staging redeployado:
  - Version ID: `f980c8ec-6cc7-4355-9f3c-38f3affa4aad`;
  - `ONBOARDING_REQUESTS_ENABLED=false` se mantiene;
  - `CF_ACCESS_AUD`/`CF_ACCESS_TEAM_DOMAIN` aun no configurados.

### Validación
- `npm run test -- src/test/middlewareWorker.test.ts`: OK, `13` tests.
- `npm run test -- src/test/middlewareWorker.test.ts src/test/onboardingRequest.test.ts src/test/middlewareOnboarding.test.ts`: OK, `26` tests.
- `npm run test`: OK, `49` tests.
- `npx tsc --noEmit`: OK.
- `npm run build`: OK; warning conocido de chunk grande.
- `npx --yes wrangler deploy --config wrangler.middleware.toml --env staging --dry-run`: OK.
- `npx eslint` en archivos tocados/JWT: OK.
- `npm run cf:api:verify:staging`: OK contra Worker desplegado.

### Decisiones
- Mantener `CF_ACCESS_AUD` desconfigurado hasta que exista la app Access real; asi no se bloquean rutas de test actuales.
- Cuando se active storage de solicitudes, usar preferentemente validacion JWT, no solo header de email.
- No activar `ONBOARDING_REQUESTS_ENABLED=true` hasta tener DNS/API Access + `CF_ACCESS_AUD` + storage staging listos.

### Tareas pendientes inmediatas
- Crear app Access para API staging y obtener Audience Tag.
- Configurar `CF_ACCESS_AUD` y `CF_ACCESS_TEAM_DOMAIN` solo en staging.
- Reejecutar smoke test y prueba real de `/onboarding/requests` con Access.

## Hechos (Cloudflare onboarding · revisión técnica y deploy staging — 2026-06-16)

- Se amplio el control plane Cloudflare con bandeja de revisión:
  - nuevo endpoint `GET /api/onboarding/requests`;
  - nuevo endpoint `PATCH /api/onboarding/requests/:id` para cambiar estado de la solicitud;
  - nueva pantalla `/onboarding/requests`;
  - navegación lateral a `Requests`.
- La revisión permite ver solicitudes y mover estados (`TECHNICAL_REVIEW`, `APPROVED`, `REJECTED`, etc.), pero no convierte solicitudes en `pos_connections` ni ejecuta ninguna escritura externa.
- El Worker staging fue desplegado en Cloudflare:
  - URL temporal: `https://winerim-middleware-api-staging.gugocreative.workers.dev`;
  - Version ID: `cc726f8e-1047-4888-a8f0-0760a9290f57`;
  - `ONBOARDING_REQUESTS_ENABLED=false`;
  - `ONBOARDING_REQUESTS_REQUIRE_ACCESS_EMAIL=true`.
- Se anadio script repetible:
  - `npm run cf:api:verify:staging`;
  - valida `health`, payload incompleto, CORS y que storage sigue apagado.
- Probes reales contra staging:
  - `GET /health` OK;
  - `POST /api/onboarding/test` con REVO incompleto devuelve `VALIDATION_FAILED`;
  - `GET/POST /api/onboarding/requests` devuelven `REQUEST_STORAGE_DISABLED`;
  - preflight CORS para `https://staging.middleware.winerim.wine` OK.
- `api-staging.middleware.winerim.wine` sigue sin resolver DNS (`Could not resolve host`), aunque la ruta Worker esta declarada.

### Validación adicional
- `npm run test -- src/test/middlewareWorker.test.ts src/test/onboardingRequest.test.ts src/test/middlewareOnboarding.test.ts`: OK, `24` tests.
- `npm run test`: OK, `47` tests.
- `npx tsc --noEmit`: OK.
- `npm run build`: OK; queda warning conocido de chunk grande.
- `npx --yes wrangler deploy --config wrangler.middleware.toml --env staging --dry-run`: OK.
- `npx eslint` en archivos tocados: OK.
- Verificacion local HTTP:
  - Vite `http://127.0.0.1:8084/onboarding` sirve HTML;
  - Worker local `http://127.0.0.1:8787/health` OK;
  - `GET /api/onboarding/requests` local devuelve `REQUEST_STORAGE_DISABLED`.
- No se pudo hacer captura visual automatizada: no habia herramienta Browser expuesta y Playwright no esta instalado en el proyecto.

### Decisiones
- La pantalla `/onboarding/requests` forma parte del control plane, pero depende del mismo flag de storage; sin Access + secrets sigue sin datos.
- Los cambios de estado de solicitud no crean conexiones ni disparan automatismos. La conversion a cliente real queda como paso tecnico separado.
- Mantener `api-staging.middleware.winerim.wine` bloqueado hasta crear DNS/custom domain de Cloudflare; usar `workers.dev` para smoke tests.

### Tareas pendientes inmediatas
- Crear DNS/custom domain para `api-staging.middleware.winerim.wine`.
- Desplegar Pages staging protegido por Access.
- Aplicar migracion `onboarding_requests` solo en staging y configurar `LOVABLE_CLOUD_REST_URL` + `LOVABLE_CLOUD_SERVICE_KEY` como secret/var.
- Probar `Enviar a revisión` y `/onboarding/requests` con storage real en staging.

## Hechos (Cloudflare onboarding · bandeja de solicitudes segura — 2026-06-16)

- Se continuo la migracion del control plane fuera de Lovable Cloud con una pieza no destructiva:
  - nuevo endpoint Worker `POST /api/onboarding/requests`;
  - boton UI `Enviar a revisión` en `/onboarding`;
  - redaccion de valores secretos conocidos antes de construir payloads de solicitud;
  - documentacion de storage en `cloudflare/onboarding-storage/README.md`.
- El endpoint queda apagado por defecto en todos los entornos mediante `ONBOARDING_REQUESTS_ENABLED=false`.
- Si se activa, exige identidad de Cloudflare Access por `CF-Access-Authenticated-User-Email`, salvo override explicito `ONBOARDING_REQUESTS_REQUIRE_ACCESS_EMAIL=false`.
- La ruta de guardado no llama al POS ni a Winerim, no crea `pos_connections`, no activa escrituras y no oculta legacy.
- La fila preparada para `onboarding_requests` contiene solo:
  - metadata sanitizada;
  - semaforos sin `technicalDetail`;
  - resumen de prueba;
  - `secret_refs={}` por ahora.
- Variables necesarias para activar guardado real:
  - `LOVABLE_CLOUD_REST_URL`;
  - `LOVABLE_CLOUD_SERVICE_KEY` como secret del Worker;
  - Access activo para el dominio/API.

### Validación
- `npx tsc --noEmit`: OK.
- `npm run test -- src/test/middlewareWorker.test.ts src/test/onboardingRequest.test.ts src/test/middlewareOnboarding.test.ts`: OK, `21` tests.
- `npm run test`: OK, `44` tests.
- `npm run build`: OK; queda warning conocido de chunk grande.
- `npx --yes wrangler deploy --config wrangler.middleware.toml --env staging --dry-run`: OK; confirma que staging mantiene `ONBOARDING_REQUESTS_ENABLED=false`.
- `npx eslint` en archivos tocados: OK.
- `npm run lint` global sigue fallando por deuda heredada (`839` errores / `85` warnings, sobre todo `no-explicit-any` en componentes/proxies antiguos); no atribuible a esta pieza.

### Decisiones
- Implementar la bandeja de solicitudes antes de tener storage de secretos, pero mantenerla desactivada por flag hasta configurar Access + secrets.
- No guardar tokens ni referencias a tokens en la primera version; `secret_refs` queda vacio hasta decidir secret storage real.
- No convertir solicitudes en conexiones automaticamente: la conversion sigue requiriendo revision tecnica, dry-run y rollback.

### Riesgos / rollback
- Riesgo principal si se activa sin Access: el endpoint podria aceptar solicitudes anonimas. Mitigacion: `ONBOARDING_REQUESTS_REQUIRE_ACCESS_EMAIL=true` por defecto y storage apagado.
- Riesgo si se configura mal `LOVABLE_CLOUD_REST_URL`/service key: la UI mostrara fallo de envio, pero no toca POS ni Winerim.
- Rollback inmediato: mantener o devolver `ONBOARDING_REQUESTS_ENABLED=false`; el boton UI queda sin efecto operativo y solo informa que la bandeja no esta activada.

### Tareas pendientes inmediatas
- Configurar Cloudflare Access en staging y comprobar que `CF-Access-Authenticated-User-Email` llega al Worker.
- Aplicar `20260615073500_onboarding_requests.sql` solo en Postgres staging.
- Configurar `LOVABLE_CLOUD_REST_URL` y `LOVABLE_CLOUD_SERVICE_KEY` como secret/var de staging.
- Probar `Enviar a revisión` con una instalación Agora de pruebas antes de usarlo con comerciales.

## Hechos (REVO · solicitud API Tigre / Grupo Costeño — 2026-06-16)

- El SAT/distribuidor REVO (MRM Solutions) indica que no puede emitir ni tramitar directamente las llamadas/API por nosotros.
- Documentación oficial REVO XEF: la API externa requiere headers `tenant`, `Authorization: Bearer <token>` y `client-token`/Integrator Token.
- Si Winerim ya tiene `client-token` como partner, para un cliente concreto normalmente basta con que el cliente facilite/autorice:
  - `tenant` / account username;
  - access token Bearer generado en la cuenta REVO del cliente (`Account management` → `Tokens`);
  - confirmación de si opera con REVO Master y qué cuentas/locales entran en alcance.
- El formulario oficial de API Request se mantiene como vía para obtener/renovar/habilitar el `client-token` de integrador o para registrar/autorizarnos si REVO lo exige para ese cliente, no necesariamente como requisito repetido si ya somos partner con token vigente.
- El SAT pide que les indiquemos el correo usado si hacemos solicitud/formulario, para poder hacer seguimiento desde su lado.

### Decisión operativa
- Primero confirmar internamente si Winerim ya tiene `client-token`/Integrator Token vigente de partner.
- Si lo tenemos, pedir al cliente/SAT `tenant` + access token de la cuenta y usar nuestro `client-token`.
- Si no lo tenemos o REVO exige registro para Tigre, completar el API Request form desde un correo controlado por Winerim y comunicar ese correo al SAT para seguimiento.

### Riesgos
- Si se intenta depender del distribuidor para generar credenciales, el alta queda bloqueada porque ellos declaran no tener capacidad para hacerlo.
- Si se pide `client-token` al cliente, mezclamos responsabilidades: ese token es de integrador/partner, no del restaurante.
- Si usamos un `client-token` caducado/no habilitado para catálogo/reportes, la prueba fallará aunque `tenant` y access token sean correctos.
- Si REVO requiere aprobación del cliente final, puede haber demora aunque Winerim ya sea partner.

### Tareas pendientes inmediatas
- Confirmar si Winerim dispone ya de `client-token`/Integrator Token REVO partner.
- Pedir al cliente/SAT `tenant` y access token generado en la cuenta REVO de Tigre, además de confirmar REVO Master/cuentas hijas si aplica.
- Pedir a Toni el enlace exacto del formulario solo si necesitamos obtener/renovar/habilitar `client-token` o registrar la integración para seguimiento.
- Cuando REVO entregue credenciales, probarlas primero en `/onboarding` REVO y después en `revo-proxy` antes de activar escritura.

## Hechos (Jardí familias vino Agora — 2026-06-15)

- Se refresco `sync-master-data` de Jardí en modo lectura:
  - `61` familias totales en Agora;
  - `695` productos totales.
- Conteo de familias de vino:
  - `5` familias legacy raiz de vino: `VI NEGRE`, `VI ROSAT`, `VI BLANC`, `CAVA`, `CHAMPAGNE`;
  - `27` subfamilias legacy de vino, todas bajo `VI NEGRE`;
  - `8` familias Winerim raiz: `TINTOS WINERIM`, `COPAS WINERIM`, `ROSADOS WINERIM`, `DULCE WINERIM`, `BLANCOS WINERIM`, `MAGNUM WINERIM`, `FORTIFICADOS WINERIM`, `ESPUMOSOS WINERIM`;
  - `0` subfamilias Winerim.
- Total nodos de vino si se cuentan familias + subfamilias + Winerim: `40`.
- Nota: se excluye `BODEGA` del conteo de vino porque en Jardí agrupa licores/destilados, no solo vino.

## Hechos (Katsu Izakaya estructura familias Agora — 2026-06-15)

- Se refresco `sync-master-data` de Katsu en modo lectura:
  - `42` familias;
  - `1212` productos;
  - `last_business_day_synced=2026-06-13`;
  - `auto_push_verified_ready=false`;
  - no se escribieron productos, mappings ni stock.
- Agora no devuelve subfamilias reales en esta foto: las `42` familias aparecen como familias raiz (`ParentFamilyId` vacio).
- Familias de vino legacy:
  - `VINOS` id `33`, oculta, `109` productos directos, `106` vendibles, `101` legacy reales y `8` generados Winerim;
  - `VINOS POR COPAS` id `37`, oculta, `93` productos directos, `82` vendibles, `89` legacy reales y `4` generados Winerim;
  - `VINOS` id `11`, oculta, sin productos.
- Familias Winerim visibles:
  - `TINTOS WINERIM`: `24` productos, `14` vendibles;
  - `BLANCOS WINERIM`: `26` productos, `20` vendibles;
  - `ROSADOS WINERIM`: `1` producto, `0` vendibles;
  - `ESPUMOSOS WINERIM`: `11` productos, `8` vendibles;
  - `DULCE WINERIM`: `6` productos, `4` vendibles;
  - `FORTIFICADOS WINERIM`: `4` productos, `4` vendibles;
  - `COPAS WINERIM`: `3` productos, `2` vendibles;
  - `MAGNUM WINERIM`: `2` productos, `2` vendibles.
- Ficheros generados:
  - `KATSU_AGORA_FAMILY_STRUCTURE_2026-06-15.md`;
  - `KATSU_AGORA_FAMILY_STRUCTURE_2026-06-15_families.csv`;
  - `KATSU_AGORA_FAMILY_STRUCTURE_2026-06-15_products.csv`.

## Hechos (Katsu + Jardí export read-only — 2026-06-15)

### Katsu Izakaya — foto actual
- Se refresco `sync-master-data` de Katsu en lectura:
  - `42` familias;
  - `1212` productos;
  - `provider_capabilities=READY`;
  - `can_read_sales=true`;
  - `can_read_catalog=true`;
  - `can_write_products=YES`;
  - sin circuit breaker.
- Familias legacy de vino en Agora:
  - `VINOS` id `33`, oculta, `109` productos (`101` legacy reales + `8` generados Winerim);
  - `VINOS POR COPAS` id `37`, oculta, `93` productos (`89` legacy reales + `4` generados Winerim);
  - `VINOS` id `11`, oculta, `0` productos.
- Total productos dentro de familias legacy de vino:
  - `202`;
  - `190` legacy reales;
  - `12` generados Winerim dentro de familias legacy.
- Catalogo Winerim cacheado en Katsu:
  - `95` vinos;
  - `66` activos;
  - `64` botellas publicables;
  - `65` copas publicables;
  - `2` magnum publicables.
- Productos Winerim en familias `... WINERIM`:
  - `77` productos;
  - `54` vendibles como main.
- Mappings actuales:
  - `85` total;
  - `58 CONFIRMED`;
  - `27 REJECTED`;
  - por formato: `53` botellas confirmadas, `3` copas confirmadas, `2` magnum confirmados, `26` botellas rejected, `1` copa rejected.
- Pendiente de matching legacy segun dry-run:
  - `28` productos legacy auto-confirmables sin duplicado;
  - `26` matches fuertes pero con riesgo de duplicar vino/formato ya confirmado;
  - `63` requieren revision manual;
  - `73` sin match fiable o sin stockId de variante.
- Impacto sobre ventas Katsu ya guardadas:
  - `299` lineas reales de vino sin resolver;
  - `40` productos unicos;
  - `20` productos seguros cubririan `218/299` lineas;
  - `18` productos requieren revision y cubren `77` lineas;
  - `2` productos sin match cubren `4` lineas.

### Jardí Parets — export ventas 2 meses sin stock
- Se exportaron ventas de `2026-04-15` a `2026-06-15` incluido usando solo `agora-proxy.fetch-day`.
- Garantias de la exportacion:
  - no se uso `save-sales`;
  - no se escribio en `sales_events`;
  - no se escribio en `sales_line_items`;
  - no se llamo a Winerim stock;
  - no se movio `last_business_day_synced`.
- Totales exportados:
  - `62` dias revisados;
  - `52` dias con facturas;
  - `449` facturas;
  - `4459` lineas;
  - `180` productos unicos;
  - importe total `60206.55`;
  - `0` errores.
- Vino real por familias de vino, excluyendo `BODEGA` porque agrupa licores/destilados:
  - `37` productos de vino vendidos;
  - `97` lineas;
  - importe `2581.95`.
- Ficheros generados:
  - `JARDI_SALES_EXPORT_2026-04-15_2026-06-15.md`;
  - `JARDI_SALES_EXPORT_2026-04-15_2026-06-15_lines.csv`;
  - `JARDI_SALES_EXPORT_2026-04-15_2026-06-15_products.csv`;
  - `JARDI_SALES_EXPORT_2026-04-15_2026-06-15_daily.csv`;
  - `JARDI_SALES_EXPORT_2026-04-15_2026-06-15_wine_products.csv`.
- Verificacion posterior de Jardí:
  - `last_business_day_synced` sigue en `2026-06-13`;
  - `sales_events` sigue en `209` filas;
  - `stock_sync_log` sigue en `0`;
  - cola abierta `QUEUED/RUNNING/FAILED/BLOCKED=0`.
- Confirmacion catalogo Jardí:
  - todas las variantes Winerim publicables estan arriba en Agora:
    - `166` botellas;
    - `1` copa;
    - `1` magnum.
  - familias Winerim visibles:
    - `TINTOS WINERIM` `129`;
    - `BLANCOS WINERIM` `19`;
    - `ROSADOS WINERIM` `7`;
    - `ESPUMOSOS WINERIM` `11`;
    - `COPAS WINERIM` `1`;
    - `MAGNUM WINERIM` `1`;
    - `DULCE WINERIM` `0`;
    - `FORTIFICADOS WINERIM` `0`.

### Decisiones
- Para Jardí, usar export local read-only para analisis historico de dos meses, no `save-sales`, porque el objetivo era ver ventas sin riesgo de descuento ni movimiento de cursor.
- Para Katsu, mantener pendiente el matching legacy por fases; no insertar mappings en bloque hasta corregir/revisar los casos de duplicado y el mapping sospechoso `972845`.

### Pendientes
- Katsu: preparar lote fase 1 con los `20` productos seguros que cubririan `218` lineas y validarlo antes de insertar mappings.
- Katsu: revisar/bloquear mapping `972845` antes de cualquier fase.
- Jardí: si se quiere que estas ventas historicas aparezcan dentro del monitor, crear un import read-only especifico que no toque stock ni cursor; no usar `save-sales` a pelo.

## Hechos (Restaurante Jardi / El Jardí Parets Agora — activación controlada 2026-06-15)

### Estado final de conexión
- Conexion encontrada en Lovable Cloud:
  - `location_name=Restaurante Jardi`;
  - `base_url=http://eljardiparets.ddns.net:8984`;
  - `enabled=true`;
  - `catalog_sync_enabled=true`;
  - `sync_mode=BIDIRECTIONAL`;
  - `write_mode=XML_IMPORT`;
  - `auto_push_on_create=true`;
  - `auto_push_on_update=false`;
  - `auto_push_verified_ready=true`;
  - `require_manual_review_before_push=true`;
  - `last_business_day_synced=2026-06-13`;
  - `last_sync_at=2026-06-15T09:35:06Z`;
  - sin circuit breaker abierto y sin cola abierta (`QUEUED/RUNNING/FAILED/BLOCKED=0`).

### Pruebas realizadas
- `agora-proxy` / `test`: OK.
- `agora-proxy` / `find-last-business-day` con `daysBack=14`:
  - `11` dias con ventas;
  - `92` facturas encontradas;
  - ultimo dia cerrado detectado: `2026-06-13`.
- `agora-proxy` / `sync-master-data` antes de publicar: OK.
  - `53` familias legacy;
  - `527` productos legacy;
  - `4` IVAs;
  - `1` lista de precios;
  - `1` almacen;
  - `6` sale centers;
  - `2` preparation types;
  - `5` preparation orders;
  - sin warnings de truncado.
- `agora-proxy` / `fetch-day` para `2026-06-13`: OK.
  - `8` eventos/facturas en la respuesta;
  - familias detectadas incluyen `CAVA`, `VI BLANC`, `BEGUDES`, `PER COMENÇAR`, `POSTRES`, etc.
- `winerim-proxy` / `fetch-catalog` modo `start`, primera tanda:
  - Winerim token OK;
  - `174` vinos leidos;
  - `25/25` detalles enriquecidos;
  - `25` candidatos nuevos detectados;
  - no se crearon partes de auto-push porque los flags estan apagados.
- Enriquecimiento completo posterior:
  - `149/149` detalles restantes enriquecidos;
  - `0` fallos Winerim;
  - cache completa de `174` vinos activos.
- Cache Winerim tras enriquecer:
  - `174` vinos activos;
  - `166` botellas publicables (`bottle_sale_price` + `bottle_stock_id`);
  - `1` copa publicable (`Dulce de Invierno`, `glass_stock_id=312405`, PVP copa `6.5`);
  - `1` magnum publicable (`PSI`, `magnum_stock_id=303734`, PVP magnum `68`);
  - `8` vinos activos sin botella publicable por faltar precio/stock de botella.

### Publicación Winerim en Agora
- Defaults de escritura configurados:
  - IVA `3` / `10%`;
  - preparation type/order `1/1` (`Beguda/Beguda`);
  - warehouse `1` (`Magatzem General`);
  - sale centers `1..6` (`MENJADOR`, `CELLER`, `JARDI`, `BAR`, `TERRASSA BAR`, `EMPORTAR`);
  - `auto_create_families=true`;
  - `write_bottle=true`;
  - `write_glass=true`.
- Familias Winerim creadas/reutilizadas en Agora:
  - `900157` `TINTOS WINERIM`;
  - `901954` `COPAS WINERIM`;
  - `903516` `ROSADOS WINERIM`;
  - `903925` `DULCE WINERIM`;
  - `904241` `BLANCOS WINERIM`;
  - `904289` `MAGNUM WINERIM`;
  - `908182` `FORTIFICADOS WINERIM`;
  - `908875` `ESPUMOSOS WINERIM`.
- Dry-run botellas:
  - `166` productos;
  - `129` tintos, `19` blancos, `7` rosados, `11` espumosos;
  - `0` validaciones invalidas;
  - `UseAsDirectSale=false`;
  - `SaleableAsMain=true`;
  - preparation completa;
  - sin nombres duplicados.
- Dry-run copa/magnum:
  - `C Dulce de Invierno` -> `COPAS WINERIM`;
  - `M PSI` -> `MAGNUM WINERIM`;
  - `0` validaciones invalidas.
- Import real:
  - primer bloque `40/40` OK;
  - segundo bloque `40/40` OK;
  - tercer bloque inicial devolvio HTTP `500` desde Agora sin aplicar productos;
  - tras refrescar master data, los `86` restantes entraron en un bloque y verificaron `86/86` OK;
  - copa `1/1` OK;
  - magnum `1/1` OK.
- Estado final tras `sync-master-data`:
  - `61` familias;
  - `695` productos;
  - `168` productos Winerim publicados y confirmados:
    - `TINTOS WINERIM`: `129`;
    - `BLANCOS WINERIM`: `19`;
    - `ROSADOS WINERIM`: `7`;
    - `ESPUMOSOS WINERIM`: `11`;
    - `COPAS WINERIM`: `1`;
    - `MAGNUM WINERIM`: `1`;
    - `DULCE WINERIM`: `0`;
    - `FORTIFICADOS WINERIM`: `0`.
- `product_mappings`:
  - `BOTTLE:CONFIRMED=166`;
  - `GLASS:CONFIRMED=1`;
  - `MAGNUM:CONFIRMED=1`.
- `winerim_push_tracking`:
  - `BOTTLE:PUSHED=166`;
  - `MAGNUM:PUSHED=1`;
  - tras auto-update inicial de `Dulce de Invierno`, la copa queda `GLASS:VERIFIED=1`.
- `provider_capabilities` queda `READY`, `can_read_sales=true`, `can_read_catalog=true`, `can_write_products=YES`, `write_endpoint=/api/import/`.

### Estado legacy / pantalla actual Agora
- Legacy NO se ha ocultado ni borrado.
- Siguen visibles las familias legacy principales:
  - `42` `VI NEGRE`;
  - `29` `VI ROSAT`;
  - `30` `VI BLANC`;
  - `31` `CAVA`;
  - `32` `CHAMPAGNE`.
- Antes de publicar habia `283` productos legacy de vino dentro de familias; se mantienen como rollback visual/operativo.

### Ventas y stock
- `auto-sync-sales` manual ejecutado despues de activar:
  - `25` dias cerrados sincronizados;
  - dias `2026-05-16` a `2026-06-13` con huecos naturales de dias sin facturas;
  - `209` documentos/facturas guardados;
  - `2155` lineas guardadas;
  - `resolvedLines=0`;
  - `unresolvedLines=477`;
  - `stockSync=null`.
- Interpretacion: las ventas historicas eran de productos legacy, no de los productos Winerim recien creados; por eso no se descuenta stock historico. A partir de ventas futuras sobre botones Winerim, el mapping existe y el flujo podra descontar stock por variante.

### Anomalias / riesgos detectados
- `detect-capabilities` devuelve `canWrite=NO` porque prueba endpoints REST antiguos (`/api/import/articles`, `/api/products`, etc.) y no valida el flujo XML real usado por el middleware.
- Esa misma accion deja `provider_capabilities.can_read_catalog=false` si `connection.catalog_endpoint` esta vacio, aunque `sync-master-data` acaba de leer `export-master` correctamente.
- En Jardí ya no debe usarse `detect-capabilities` como veredicto porque el flujo real XML esta probado y `provider_capabilities` quedo corregido por `xml-import`.
- Tras activar `auto_push_on_update`, `winerim-proxy fetch-catalog` detecta repetidamente `Dulce de Invierno` como `changedWines=1` y encola/ejecuta un update `GLASS` aunque la ficha queda verificada. Para evitar ruido periodico, se deja `auto_push_on_update=false`.
- El clasificador de ventas marca algunos platos por rango de precio como candidatos de vino (`NEEDS_REVIEW`), igual que en Katsu; no afecta a stock si no hay mapping, pero ensucia monitor.

### Rollback documentado
- Rollback de automatismos si el cliente reporta problema:
  - poner `enabled=false`;
  - poner `catalog_sync_enabled=false`;
  - poner `auto_push_on_create=false`;
  - mantener `auto_push_on_update=false`;
  - opcionalmente poner `auto_push_verified_ready=false`.
- Rollback visual sin borrar nada:
  - usar `set-family-visibility` para `ShowInPos=false` en las familias Winerim `900157`, `901954`, `903516`, `903925`, `904241`, `904289`, `908182`, `908875`.
  - No borrar productos; el legacy sigue visible y vendible.
- Rollback de datos no recomendado:
  - no borrar `product_mappings` ni `winerim_push_tracking` salvo que se vaya a rehacer la instalacion; si se borran, se pierde idempotencia y trazabilidad de lo publicado.

### Decisiones
- Activar Jardí en modo controlado con legacy visible.
- Activar altas automaticas (`auto_push_on_create=true`) porque la publicacion inicial y `forceEvaluate` validaron `wouldQueue=0` para productos ya publicados.
- Mantener actualizaciones automaticas apagadas (`auto_push_on_update=false`) hasta corregir el falso/repetido update de vino solo-copa `Dulce de Invierno`.
- No ocultar legacy hasta validacion visual del cliente.

### Tareas pendientes inmediatas
- Corregir/evitar `detect-capabilities` para Agora XML: debe basarse en `sync-master-data` / `preview-xml` y no en endpoints REST inexistentes.
- Corregir bucle/ruido de `auto_push_on_update` para vinos con copa publicable pero sin botella publicable (`Dulce de Invierno`, `winerim_id=271458`).
- Validacion visual con cliente:
  - familias Winerim visibles;
  - legacy visible;
  - productos Winerim dentro de familia, sin raiz directa.
- Validar primera venta real Winerim:
  - `sales_line_items.mapped=true`;
  - `stock_sync_log.status=SUCCESS`;
  - `variant` correcto (`BOTTLE`, `GLASS` o `MAGNUM`);
  - `stock_id` correcto;
  - idempotencia al reintentar.

## Hechos (migración Cloudflare middleware.winerim.wine — 2026-06-12)

### Scaffold Cloudflare creado
- Se inicia la migración controlada del middleware hacia Cloudflare, sin tocar producción actual en Lovable Cloud.
- Dominio objetivo documentado: `middleware.winerim.wine`.
- API objetivo documentada: `api.middleware.winerim.wine`.
- Archivo de arquitectura/rollback creado: `CLOUDFLARE_MIDDLEWARE_MIGRATION_2026-06-12.md`.
- Worker inicial creado en `cloudflare/workers/middleware-api/src/index.ts`.
- Configuración Wrangler creada en `wrangler.middleware.toml`.
- Scripts añadidos:
  - `cf:api:dev`;
  - `cf:api:deploy:staging`;
  - `cf:api:deploy:production`.

### API inicial no destructiva
- Endpoint `GET /health`.
- Endpoint `POST /api/onboarding/test`.
- `POST /api/onboarding/test`:
  - lee el body una sola vez;
  - soporta CORS con credenciales para que la UI pueda funcionar detras de Cloudflare Access cuando se configure;
  - valida campos mínimos;
  - normaliza URL POS con `http://` si falta;
  - prueba token Winerim;
  - prueba alcance básico de Agora;
  - prueba REVO con `tenant`, `Authorization: Bearer <access-token>` y `client-token`;
  - no guarda tokens;
  - no crea conexiones;
  - no escribe productos;
  - no oculta legacy;
  - devuelve semáforos y `readyForTechnicalReview`.

### Interfaz comercial inicial
- Nueva ruta frontend `/onboarding`.
- Nueva página `src/pages/CommercialOnboarding.tsx`.
- Nueva utilidad pura `src/lib/middlewareOnboarding.ts`.
- Nueva utilidad pura `src/lib/middlewareApiUrl.ts` para resolver la API del middleware desde env/hostname.
- Nueva utilidad pura `src/lib/onboardingRequest.ts` para preparar payloads sanitizados de solicitudes.
- Nuevo test `src/test/middlewareOnboarding.test.ts`.
- Nuevo test `src/test/middlewareWorker.test.ts` para health, validacion sin llamadas externas y REVO sin fuga de tokens.
- Nuevo test `src/test/onboardingRequest.test.ts` para comprobar que los payloads de solicitud no filtran secretos.
- Nuevo documento Cloudflare Pages: `cloudflare/pages/README.md`.
- Nuevo ejemplo de entorno sin secretos: `cloudflare/pages/env.example`.
- Nuevo runbook DNS/Access: `cloudflare/dns-access/README.md`.
- Nuevo documento de persistencia onboarding: `cloudflare/onboarding-storage/README.md`.
- Nueva migracion preparada: `supabase/migrations/20260615073500_onboarding_requests.sql`.
- Nuevos archivos Pages:
  - `public/_redirects` para fallback SPA (`/onboarding` directo);
  - `public/_headers` con cabeceras defensivas basicas.
- La pantalla está orientada a equipo comercial:
  - POS;
  - restaurante;
  - URL POS / base API;
  - token POS;
  - campos específicos REVO (`tenant`, access token, client-token);
  - token Winerim;
  - botón `Probar`;
  - semáforos de estado;
  - sin colas, XML, stockIds, logs crudos ni configuración avanzada.
- La ruta se añadió al menú lateral como `Onboarding`.

### Validación local
- La migración se reconcilió en copia limpia del repo oficial `main` (`2bad270ccb4ce8cfa7ef530fbe37f61de1d0c6ca`) para no pisar estado vivo reciente.
- Rama limpia temporal: `/tmp/bridge-to-winerim-cloudflare-check`, branch `codex/cloudflare-middleware-onboarding`.
- Commit local y remoto: `f1709ce` (`Add Cloudflare onboarding staging scaffold`).
- Rama subida a GitHub: `origin/codex/cloudflare-middleware-onboarding`.
- PR draft abierto para revisión sin mergear a `main`: `https://github.com/goiko111/bridge-to-winerim/pull/1`.
- Validación en rama limpia:
  - `npm ci --ignore-scripts --no-audit --no-fund` OK.
  - `npm test -- --run src/test/onboardingRequest.test.ts src/test/middlewareApiUrl.test.ts src/test/middlewareOnboarding.test.ts src/test/middlewareWorker.test.ts src/test/agoraProductNaming.test.ts src/test/stockSyncUtils.test.ts` OK: `35` tests.
  - `npx tsc --noEmit` OK.
  - `npm run build` OK con warnings conocidos de Browserslist y chunk >500 kB.
  - Worker bundle OK con `esbuild`.
  - Vite local en rama limpia responde HTTP 200 en `/onboarding`.
  - Browser check: `/onboarding` renderiza; al seleccionar REVO aparecen Base API, Tenant, Access Token, Client Token y Webhook Secret.
- Validación local 2026-06-13:
  - Vite levantado en `http://127.0.0.1:8084/onboarding`.
  - Worker local levantado en `http://127.0.0.1:8787`.
  - `GET /health` local OK con CORS `Access-Control-Allow-Origin: http://127.0.0.1:8084`.
  - `OPTIONS /api/onboarding/test` local OK.
  - `POST /api/onboarding/test` con payload REVO incompleto devuelve solo validaciones, sin llamadas externas.
  - `wrangler.middleware.toml` usa `compatibility_date = "2026-05-03"` porque `wrangler 4.86.0` no arranca localmente con `2026-06-12`.
- Resolver API frontend:
  - si `VITE_MIDDLEWARE_API_URL` existe, se usa;
  - si el host es `staging.middleware.winerim.wine`, usa `https://api-staging.middleware.winerim.wine`;
  - si el host es `middleware.winerim.wine`, usa `https://api.middleware.winerim.wine`;
  - fallback local: `http://127.0.0.1:8787`.
- Smoke local 2026-06-15 tras resolver API:
  - Vite OK en `http://127.0.0.1:8084/onboarding`.
  - Worker local OK en `http://127.0.0.1:8787/health`.
  - `POST /api/onboarding/test` con Agora incompleto devuelve validaciones esperadas.
- Persistencia onboarding preparada 2026-06-15:
  - tabla `onboarding_requests` versionada, pero no aplicada a produccion;
  - RLS habilitada sin politicas abiertas;
  - checks para bloquear claves JSON con `token`, `secret`, `password`, `credential` o `api_key` en payloads sanitizados, gates, resumen y referencias de secretos;
  - checks de forma JSON: metadata/resumen/referencias como objetos y gates como array;
  - la UI/Worker aun no escriben en la tabla.
- `cloudflare/workers/middleware-api/src/index.ts` bundlea correctamente con `esbuild` en la copia de trabajo original.
- `src/pages/CommercialOnboarding.tsx`, `src/lib/middlewareOnboarding.ts` y `src/test/middlewareOnboarding.test.ts` transpilan correctamente con `esbuild` sin bundlear dependencias.
- Prueba directa sobre la utilidad compilada:
  - `eljardiparets.ddns.net:8984/` normaliza a `http://eljardiparets.ddns.net:8984`;
  - REVO sin URL explícita usa `https://revoxef.works/api/external`;
  - REVO exige `revoTenant` y `revoClientToken`;
  - validación mínima correcta;
  - `isReadyForTechnicalReview` devuelve `true` si input/Winerim/POS están en `pass/warn`.
- Prueba directa del Worker compilado con `fetch` simulado:
  - Winerim se prueba con `GET /api/v2/wines?page=1&limit=1`;
  - REVO se prueba con `GET /api/external/v2/paymentMethods`;
  - la respuesta pública no devuelve access token, client-token ni token Winerim.
- Validaciones no completadas en la copia original:
  - `npm test -- --run src/test/middlewareOnboarding.test.ts`, `npm run build`, `npx tsc --noEmit --project tsconfig.app.json` y `npx eslint ...` se quedaron colgados y se mataron para no dejar procesos vivos.
  - `vite` arranca en local y abre puerto, pero `curl` a `/onboarding` queda esperando sin recibir respuesta.
  - `npx wrangler --version` y `npx wrangler whoami` se quedaron esperando sin salida; no hay despliegue Cloudflare desde esta copia local.

### Cloudflare staging
- `npx --yes wrangler --version` funciona en la rama limpia: `4.86.0`.
- `npx --yes wrangler whoami` confirma sesión Cloudflare con permisos de Workers/Pages.
- `wrangler deploy --config wrangler.middleware.toml --env staging --dry-run` OK.
- Worker staging desplegado:
  - Servicio: `winerim-middleware-api-staging`.
  - Version ID actual: `be75ce4a-5948-4b3b-8a0d-d69a7ab192df`.
  - Version ID anterior: `da36b3d3-f429-45c0-b5fe-964ac098802e`.
  - URL funcional: `https://winerim-middleware-api-staging.gugocreative.workers.dev`.
  - Ruta declarada por Wrangler: `api-staging.middleware.winerim.wine/*`.
- `GET /health` OK en `workers.dev`.
- `POST /api/onboarding/test` con payload REVO incompleto devuelve validación correcta y no llama a servicios externos.
- Redeploy staging 2026-06-13 tras ajustar `compatibility_date`; `GET /health` sigue OK.
- Bloqueo actual: `api-staging.middleware.winerim.wine` no resuelve DNS (`Could not resolve host`), aunque la ruta Worker quedó declarada. Falta crear/apuntar el registro DNS proxied o Custom Domain para ese host desde Cloudflare Dashboard/API.
- No se ha desplegado Cloudflare Pages todavía; se pospone hasta configurar Access o confirmar exposición controlada.
- Proyectos Pages existentes vistos en la cuenta Cloudflare: `winerim-help`, `spiritsrim`, `winerim-informes`; no existe aún proyecto Pages para el middleware.
- No se ha tocado `main` ni producción de Lovable Cloud durante esta continuación.
- Se investigó CLI/API disponible para DNS/Access: Wrangler no ofrece una operación directa segura para crear el DNS staging desde este entorno. Queda documentado el proceso de Dashboard/Custom Domain.
- No se ha añadido CSP estricta todavía porque puede romper estilos/componentes hasta auditar el frontend completo.
- Revisión CLI Cloudflare 2026-06-15:
  - Wrangler expone `pages` y `secrets-store` (`open beta`);
  - no se ha encontrado un comando Wrangler directo para configurar Cloudflare Access/DNS de forma segura desde este entorno;
  - no se ha creado proyecto Pages ni Secrets Store nuevo;
  - se mantiene el bloqueo: no desplegar Pages pública ni guardar secretos reales hasta cerrar Access y modelo de secret storage.
- Access-ready CORS preparado en código 2026-06-15:
  - Worker acepta `ALLOWED_ORIGINS` multi-origen y mantiene `ALLOWED_ORIGIN` como compatibilidad;
  - respuestas/preflight incluyen `Access-Control-Allow-Credentials: true` y `Vary: Origin`;
  - `Access-Control-Allow-Headers` permite `CF-Access-Client-Id` y `CF-Access-Client-Secret`;
  - `/onboarding` llama a la API con `credentials: "include"`;
  - Worker staging redeployado con Version ID `be75ce4a-5948-4b3b-8a0d-d69a7ab192df`;
  - validado en `workers.dev`: `GET /health`, `OPTIONS /api/onboarding/test`, `POST /api/onboarding/test` incompleto y origen no permitido no reflejado;
  - no equivale a autenticación propia: falta configurar Cloudflare Access en Dashboard.

### Decisiones
- No migrar clientes ni crons todavía: Cloudflare empieza como control plane y staging/canary.
- Mantener Lovable Cloud como producción actual hasta validar Cloudflare con staging y canary.
- La primera API Cloudflare solo puede probar; cualquier escritura queda bloqueada hasta revisión técnica, dry-run y rollback.
- Postgres gestionado seguirá siendo la base principal objetivo; Cloudflare D1 no se usa para el core transaccional del middleware.
- Desplegar solo Worker staging, no producción, y mantener Pages pendiente hasta proteger la UI con Cloudflare Access.
- Usar temporalmente `https://winerim-middleware-api-staging.gugocreative.workers.dev` para pruebas de API staging hasta resolver DNS de `api-staging.middleware.winerim.wine`.
- Mantener el PR como draft hasta resolver DNS/Access y validar el flujo de onboarding con al menos una conexión de prueba.
- Mantener `compatibility_date=2026-05-03` hasta actualizar Wrangler o confirmar que Cloudflare soporta una fecha posterior también en local.

### Hipótesis / Riesgos
- HIPÓTESIS SUJETA A VALIDACIÓN: Cloudflare Workers + Queues + Cron + Durable Objects cubren bien el runtime de 100 clientes si el diseño mantiene rate limit/circuit breaker por `connection_id`.
- Riesgo mitigado: el probe REVO `/resources` se sustituyó por `paymentMethods` con headers oficiales; falta validarlo con un tenant real.
- Riesgo: el Worker no debe loggear tokens ni devolverlos en respuestas; las salidas actuales están sanitizadas.

### Tareas pendientes
- Crear DNS proxied para `api-staging.middleware.winerim.wine` o configurar Custom Domain equivalente para el Worker.
- Levantar Cloudflare Access para `middleware.winerim.wine`.
- Crear Pages staging:
  - `staging.middleware.winerim.wine`;
  - Cloudflare Access obligatorio antes de exponerlo al equipo.
- Configurar variables/secrets por entorno.
- Añadir persistencia segura de solicitudes de integración tras resolver diseño de Postgres/staging.
- Portar primero Agora completo en modo lectura y dry-run.

## Hechos (Katsu Izakaya matching legacy dry-run — 2026-06-15)

### Auditoria read-only contra TPV actual
- Se reviso Katsu Izakaya contra Lovable Cloud y la cache actual de Agora sin escrituras.
- Conexion Katsu:
  - `enabled=true`;
  - `can_read_catalog=true`;
  - `can_read_sales=true`;
  - `can_write_products=YES`;
  - `write_mode=XML_IMPORT`;
  - `readiness_status=READY`;
  - sin circuit breaker abierto.
- Cache Agora actual:
  - `1212` productos;
  - `42` familias;
  - master fetched/updated el `2026-06-15`.
- Familias legacy de vino detectadas:
  - `VINOS` id `33`, oculta;
  - `VINOS POR COPAS` id `37`, oculta;
  - `VINOS` id `11`, oculta.
- Dentro de esas familias legacy hay `202` productos:
  - `190` parecen legacy real por ID Agora bajo;
  - `12` parecen productos generados por Winerim que quedaron en familias legacy.
- Catalogo Winerim cacheado Katsu:
  - `95` vinos;
  - `64` con stockId botella;
  - `65` con stockId copa;
  - `2` con stockId magnum.
- Mappings actuales:
  - `85` total;
  - `58 CONFIRMED`;
  - `27 REJECTED`;
  - todos con `match_method=XML_IMPORT`.

### Resultado del dry-run de matching
- Sobre `190` productos legacy reales de `VINOS` / `VINOS POR COPAS`:
  - `28` auto-confirmables sin duplicar vino/formato ya confirmado;
  - `26` con match fuerte pero riesgo de duplicar un producto Winerim ya confirmado para el mismo vino/formato;
  - `63` requieren revision manual;
  - `73` sin match fiable o sin stockId de variante.
- En ventas reales de familias de vino:
  - `299` lineas de venta de vino siguen sin resolver;
  - `40` productos unicos;
  - `20` productos con match fuerte y stockId valido cubririan `218/299` lineas;
  - `18` productos cubririan `77` lineas, pero requieren revision;
  - `2` productos cubren `4` lineas sin match fiable.
- Ejemplos seguros relevantes:
  - `C. LIRONDO` -> Winerim `Lirondo`, copa, stockId `318055`;
  - `C. SARMENTERO ROBLE` -> Winerim `Sarmentero Roble`, copa, stockId `319446`;
  - `C. SARMENTERO VENDIMIA SELECCIONADA` -> Winerim `Sarmentero Vendimia Seleccionada`, copa, stockId `318065`;
  - `C. ABAD DOM BUENO GODELLO ESENCIA` -> Winerim `Abad Dom Bueno Godello Esencia`, copa, stockId `317350`.
- Caso que requiere bloqueo/revision antes de aplicar nada:
  - producto Agora `972845` se llama actualmente `C. SAN SALVADOR GODELLO`, pero tiene mapping `CONFIRMED` a Winerim `272845` (`Abad Dom Bueno Godello Esencia`).

### Hallazgo adicional: monitor inflado por clasificacion
- Katsu tiene `wine_family_rules` explicitas marcando `CARTA`, `KATSU LIQUIDO`, `SAKE BAR` y `CAFÉ . TÉS` como no-vino.
- Aun asi, ventas de comida/bebida no-vino aparecen como `is_wine_candidate=true`.
- Causa tecnica probable: `isWineCandidate()` ignora las reglas recibidas y usa `DEFAULT_CONFIG`; ademas trata `NEEDS_REVIEW` como candidato operativo.
- Esto infla el contador de lineas no mapeadas y ensucia el monitor, aunque no implica por si solo descuento de stock incorrecto.
- Informe detallado creado: `KATSU_LEGACY_MATCH_DRY_RUN_2026-06-15.md`.

#### Decisiones
- No aplicar mappings en Katsu en bloque ni escribir en Agora durante esta auditoria.
- Tratar Katsu como candidato a matching legacy por fases: primero arreglar clasificacion/ruido, despues corregir el mapping desalineado y finalmente insertar solo matches seguros.

#### Riesgos
- Un mapping legacy equivocado descontaria stock del vino incorrecto.
- Resolver ventas historicas y sincronizar stock retroactivo puede descontar de golpe ventas antiguas; debe decidirse si se corrige historico o solo ventas futuras.
- Cambiar la clasificacion global de candidatos de vino puede afectar otras conexiones Agora; requiere pruebas dirigidas.

#### Tareas pendientes inmediatas
- Corregir clasificacion para respetar familias no-vino explicitas y no contar `NEEDS_REVIEW` como candidato operativo salvo regla explicita.
- Revisar/bloquear el mapping `972845` antes de aplicar mappings nuevos.
- Preparar fase 1 de `LEGACY_SAFE_MATCH` para los `20` productos vendidos con match fuerte y stockId valido.
- Despues de aplicar fase 1, ejecutar `resolve-sales` y validar una venta real con `stock_sync_log.SUCCESS`.

## Hechos (qué está desplegado y verificado)

### Sa Pedrera primer ciclo auto-create real verificado — 2026-06-10 14:20 CEST
- Tras la reactivacion de `auto_push_on_create/update`, el siguiente ciclo de catalogo genero una tanda pequeña y no masiva: `3` tareas `AUTO_CREATE`.
- Vinos detectados:
  - `105908` — `Egly-Ouriet 'Les Prémices'`, botella, producto Agora `605908`, precio `118.00`.
  - `175356` — `T213-Saint-Émilion Grand Cru`, botella, producto Agora `675356`, precio `75.00`.
  - `205597` — `B437- Château Beauregard`, botella, producto Agora `705597`, precio `65.00`.
- Se proceso la cola controlada con `agora-proxy/process-xml-outbound-queue`:
  - `processed=3`.
  - `succeeded=3`.
  - `failed=0`.
  - `remaining=0`.
  - `breakerTripped=false`.
- Verificacion posterior:
  - Tareas activas Sa Pedrera: `0 QUEUED / 0 RUNNING`.
  - `winerim_push_tracking` queda `VERIFIED` para los 3 vinos/formato botella.
  - `product_mappings` queda `CONFIRMED` para los 3 vinos/formato botella.
- Se limpio un error antiguo/stale en `product_mappings` de `205597` (`terminal_stock_mapping_rejected: Winerim stock/wine/205597 returned 404`) porque el vino ahora tiene `bottle_stock_id=236115`, se publico correctamente y el mapping quedo confirmado.

#### Decisiones
- Mantener el automatico activo: la primera tanda real fue pequeña, esperada y verificada sin fallos.

#### Riesgos
- Si aparecen nuevas tandas, distinguir cambios reales de Winerim frente a ruido por cache; no cerrar ni bloquear automaticamente sin revisar.

#### Tareas pendientes inmediatas
- Seguir vigilando el siguiente cron de catalogo, especialmente que no reaparezca una tanda masiva.
- Probar venta real de alguno de estos productos o de botella/copa Winerim y validar stock.

### Sa Pedrera tanda `AUTO_UPDATE` posterior drenada — 2026-06-10 14:23 CEST
- Tras la primera tanda `AUTO_CREATE`, aparecio una tanda posterior de `AUTO_UPDATE` no masiva.
- Durante la revision se observaron tareas para vinos como `R602-Izadi Larrosa`, `T 75-Tobía Selección de Autor`, `G803-Sa Cudia Oxidativo`, `E527-Delamotte Brut`, `T104-Viña Tondonia Reserva`, `T1 - Iamontanum Garnacha`, `E502-Rimarts Brut Nature Reserva 24`, `T89-Roda Reserva`, etc.
- El procesador automatico avanzo la cola sin intervencion manual adicional:
  - La cola paso de `QUEUED/RUNNING` a `0` activa.
  - Comprobacion final: `0 QUEUED / 0 RUNNING`.
- No hay fallos nuevos asociados a esta activacion:
  - Ultimos `FAILED` de Sa Pedrera son historicos, anteriores a esta sesion (`2026-06-05` o antes).
  - Los `BLOCKED` recientes son las sondas controladas de `249018` bloqueadas antes del redeploy validado.

#### Decisiones
- Mantener automatico activo y dejar que el dispatcher procese tandas pequeñas de `AUTO_UPDATE`, vigilando que no se conviertan en cola masiva.

#### Riesgos
- Quedan errores historicos de `AUTO_DEACTIVATION` y deuda antigua de cola; no mezclarlos con el nuevo automatico correcto.

#### Tareas pendientes inmediatas
- Revisar mañana si han aparecido nuevos `FAILED/BLOCKED` posteriores al `2026-06-10 14:23 CEST`.
- Probar ventas reales para validar stock, que es independiente de la publicacion visual.

### Sa Pedrera auto-push reactivado tras redeploy validado — 2026-06-10 14:15 CEST
- Lovable Cloud confirmo que `agora-proxy` y `winerim-proxy` ya corren la ultima version de `main`.
- Lovable Cloud valido dry-run con `forceEvaluate:true` sobre el vino `249018`:
  - `queued=0`.
  - `wouldQueue=0`.
  - `create_skipped:formats_already_verified`.
  - Sin escrituras.
- Se ejecuto `winerim-proxy` / `fetch-catalog` con los flags de Sa Pedrera todavia apagados:
  - `success=true`, `totalWines=401`.
  - Primer lote: `newWines=0`, `changedWines=24`.
  - `autoPushResult.differential=true`, `createCandidates=0`, `updateCandidates=24`, `parts=[]`.
  - No se crearon tareas porque `auto_push_on_create=false` y `auto_push_on_update=false`.
- Se espero a que terminara/estabilizara la cadena de refresco:
  - `417` filas Winerim tocadas desde el inicio.
  - Ultimo `updated_at` estable observado: `2026-06-10T12:11:26.742133+00:00`.
  - Cola durante y despues del refresco: `0 QUEUED / 0 RUNNING`.
- Se activaron flags finales de Sa Pedrera:
  - `auto_push_on_create=true`.
  - `auto_push_on_update=true`.
  - `auto_push_verified_ready=true`.
- Sonda normal post-activacion, sin `forceEvaluate`, sobre `249018`:
  - `queued=0`, `wouldQueue=0`, `skipped=1`.
  - `skippedReasons` incluye `create_skipped:formats_already_verified`.
  - No creo tareas.
- Vigilancia posterior durante ~1 minuto:
  - Flags encendidos.
  - Tareas activas finales: `0 QUEUED / 0 RUNNING`.
  - Sin nuevos movimientos de cache.
- Informe detallado: `SA_PEDRERA_AUTO_PUSH_REACTIVATED_2026-06-10.md`.

#### Decisiones
- Reactivar el automatico de catalogo Winerim -> Agora para Sa Pedrera tras confirmar runtime actualizado, diferencial activo y guard anti-duplicados.

#### Riesgos
- El proximo cron puede crear tareas legitimas si Winerim tiene cambios reales; hay que vigilar que no aparezca una tanda masiva inesperada.
- Esto no resuelve mappings legacy pendientes/rechazados: las ventas de legacy sin mapping confirmado siguen sin poder descontar stock Winerim.

#### Tareas pendientes inmediatas
- Monitorizar el siguiente ciclo de catalogo Sa Pedrera.
- Probar una venta real de botella y copa Winerim y validar `sales_line_items.mapped=true` + `stock_sync_log.SUCCESS`.

### Sa Pedrera auto-push sigue pausado por deploy pendiente — 2026-06-10 12:39 CEST
- Se intento cerrar el siguiente paso seguro de Sa Pedrera: reactivar `auto_push_on_create/update` solo despues de confirmar que Lovable Cloud ejecuta la guarda `create_skipped:formats_already_verified`.
- Se hizo push a GitHub del commit `ae9850c` (`Trigger Sa Pedrera auto-push guard redeploy`) con marcadores de deploy en `agora-proxy` y `winerim-proxy`; no cambia logica de negocio.
- Prueba live repetida contra Lovable Cloud:
  - Accion: `agora-proxy` / `evaluate-auto-push`.
  - Vino ya verificado usado como sonda: `249018` (`T220- Elio Grasso Barbera d'Alba Vigna Martina`).
  - Esperado: `queued=0` + `create_skipped:formats_already_verified`.
  - Observado: el runtime vivo todavia devuelve `queued=1`, `_trigger_source=AUTO_CREATE`; por tanto Lovable Cloud sigue ejecutando version antigua de `agora-proxy`.
- Seguridad aplicada:
  - Los flags quedaron restaurados en Sa Pedrera: `auto_push_on_create=false`, `auto_push_on_update=false`, `auto_push_verified_ready=true`.
  - Tareas activas finales: `0 QUEUED / 0 RUNNING`.
  - Las tareas de sonda quedaron `BLOCKED` y no deben reintentarse:
    - `b69fc6ed-c54e-4837-aff4-6d21e546db61`.
    - `de8375c7-f155-41bd-b6cf-63cdc9c5df3a`.
    - `36b92b57-e448-4f3e-8810-14ba0e625d81`.
- La CLI local no puede desplegar Edge Functions porque no hay token de deploy (`SUPABASE_ACCESS_TOKEN`) disponible en el entorno.
- Informe detallado: `SA_PEDRERA_AUTO_PUSH_REDEPLOY_BLOCK_2026-06-10.md`.

#### Decisiones
- No reactivar el auto-push de catalogo de Sa Pedrera hasta que Lovable Cloud redepliegue `agora-proxy` y `winerim-proxy` y la sonda live salte los formatos ya verificados.

#### Riesgos
- Mientras los flags esten apagados, nuevas altas o cambios de precio/nombre en Winerim no subiran automaticamente a Agora para Sa Pedrera.
- Reactivarlos ahora recrearia tareas `AUTO_CREATE` sobre vinos ya publicados y podria tocar Agora innecesariamente.

#### Tareas pendientes inmediatas
- Redesplegar en Lovable Cloud `agora-proxy` y `winerim-proxy`.
- Repetir la sonda `evaluate-auto-push` con el vino `249018`.
- Solo si devuelve `create_skipped:formats_already_verified`, probar `winerim-proxy fetch-catalog` y reactivar `auto_push_on_create/update`.

### Casa Nene integración Agora completa — 2026-06-08 13:23 CEST
- Se creó la conexión `Casa Nene` en Lovable Cloud (`e3cb6dbb-3474-4926-b740-706fbd0ef7e0`) usando la URL externa `http://casanene.ddns.net:8984/`. La IP local `192.168.1.131` queda solo como referencia del cliente.
- No se documentan tokens; quedaron configurados en Lovable Cloud.
- Verificación Agora:
  - Web/version OK: HTTP 200, Agora `7.9.0`.
  - `export-master Families` OK: HTTP 200.
  - `export-master Products` OK: HTTP 200.
  - `Invoices` para `2026-06-07` OK: HTTP 200 con `<Export />`.
- Verificación Winerim API v2: token OK; catálogo accesible.
- Master data inicial Casa Nene:
  - `22` familias, `304` productos, `4` IVAs, `1` price list, `3` preparation types, `4` preparation orders, `1` warehouse, `3` sale centers.
  - Defaults configurados: IVA `3`/10%, preparación `1/1` (`Barra/Bebidas`), almacén `1`, sale centers `1,2,3`.
- Catálogo Winerim cacheado:
  - `292` vinos activos.
  - `277` botellas exportables.
  - `15` magnums exportables.
  - `0` copas exportables; Winerim no expone copas activas/preciadas en esta carta.
- Se crearon y verificaron las familias Winerim dedicadas:
  - `TINTOS WINERIM`, `BLANCOS WINERIM`, `ESPUMOSOS WINERIM`, `FORTIFICADOS WINERIM`, `DULCE WINERIM`, `ROSADOS WINERIM`, `MAGNUM WINERIM`, `COPAS WINERIM`.
- Importación Winerim -> Agora:
  - `277/277` botellas verificadas.
  - `15/15` magnums verificados.
  - Total final: `292` productos Winerim visibles/vendibles dentro de familias Winerim.
  - `UseAsDirectSale=true` en productos Winerim: `0`.
  - Productos Winerim no vendibles: `0`.
  - `product_mappings`: `277` `CONFIRMED:BOTTLE:XML_IMPORT` + `15` `CONFIRMED:MAGNUM:XML_IMPORT`.
  - `winerim_push_tracking`: `277` `VERIFIED:BOTTLE` + `15` `VERIFIED:MAGNUM`.
- Legacy de vino ocultado sin borrar:
  - Familias ocultas: `5 VINO`, `6 ESPUMOSO`, `7 BLANCO`, `8 TINTO`, `9 DULCES`, `13 VINO FUERA DE CARTA`.
  - `148` productos legacy de vino quedaron con `UseAsDirectSale=false` y `SaleableAsMain=false`.
  - Verificación final: `0` familias legacy de vino visibles y `0` productos legacy de vino visibles/vendibles.
- Automatización activada:
  - `enabled=true`, `catalog_sync_enabled=true`, `write_mode=XML_IMPORT`.
  - `auto_push_on_create=true`, `auto_push_on_update=true`, `auto_push_verified_ready=true`.
  - Cursor inicial `last_business_day_synced=2026-06-07` para evitar reabrir ventas históricas legacy.
  - `provider_capabilities`: `READY/XML_IMPORT/YES`.
  - `auto-sync-sales` manual OK.
  - `fetch-catalog` posterior devuelve `no_catalog_changes_detected`.
  - Cola abierta Casa Nene: `0 QUEUED`, `0 RUNNING`, `0 FAILED`, `0 BLOCKED`.
- Documento de detalle y rollback: `CASA_NENE_AGORA_INTEGRATION_2026-06-08.md`.

### Sa Pedrera matching por código exacto — 2026-06-04 12:20 CEST
- El usuario aporta nueva captura de Winerim y Agora; se confirma que Winerim usa códigos comerciales al inicio del nombre (`G801`, `G802`, `G803`, `T31`, `B303`, etc.).
- Lectura visual de la captura Agora:
  - Arriba siguen apareciendo productos legacy sin código (`Victorino`, `Pintia`, `El Nogal`, `Dominio del Aguila`, `Alión`, `garmon`, etc.).
  - Abajo aparecen productos Winerim publicados con código/formato (`B T31-Semele`, `B T42-Tomás Postigo`, `B T41-Abadía Retuert`, `B T43-Mauro`, etc.).
- Dry-run read-only contra Lovable Cloud usando cache `agora_master_data.fetched_at=2026-06-04T10:15:07.846Z`:
  - Productos de vino visibles: `872`.
  - Legacy visible: `479`.
  - Winerim publicado visible: `393`.
  - Winerim visible con código extraíble: `390`.
  - Winerim visible sin código extraíble: `3` (`B Doña Palaueta`, `B Moscatel de la Marina`, `C Moscatel de la Marina`).
  - Legacy visible con código extraíble: `1`.
  - Match legacy exacto por código: `T1-Iamontanum Garnacha` -> `T1 - Iamontanum Garnacha - Isla de Menorca`.
  - Conflictos de código detectados: `0`.
- Diagnóstico actualizado:
  - El código exacto es la mejor señal cuando existe, y debe tener prioridad sobre fuzzy.
  - En Sa Pedrera, los códigos visibles en la captura pertenecen casi todos a los productos Winerim ya publicados, no al legacy antiguo.
  - Por tanto, el problema principal no es que el matching por código falle; es que conviven legacy sin código y Winerim codificado.
  - Informe completo: `SA_PEDRERA_CODE_MATCH_DRY_RUN_2026-06-04.md`.
- Cambio de código preparado:
  - Nuevo helper `supabase/functions/_shared/productCodeMatching.ts`.
  - `winerim-proxy` prioriza `CODE_EXACT` cuando el nombre POS contiene código comercial (`B T31-...`, `G801-...`, etc.).
  - Si un código existe varias veces en Winerim, devuelve `CODE_AMBIGUOUS` con score no auto-confirmable.
  - Tests añadidos para evitar falsos positivos como `Magnum 4 Kilos` -> `MAGNUM4` o `As 2 Ladeiras` -> `AS2`.
- Verificación local:
  - `npm test`: 18 tests OK.
  - `npm run build`: OK; solo warning existente de chunk grande/Browserslist.

### Sa Pedrera legacy vs Winerim / explicación de duplicados visuales — 2026-06-04 11:47 CEST
- El usuario comparte audio/comentario del cliente sobre Sa Pedrera: preguntan cómo estaban los nombres legacy en Agora, cómo están colocados y por qué aparecen vinos Winerim si debería haber matching.
- No hay transcripción local disponible del `.opus` en el entorno; se trabaja con datos de Lovable Cloud y cache Agora.
- Estado de configuración:
  - `Sa Pedrera` está en `family_structure_mode=LEGACY_REGION_ROUTING`.
  - Tiene `26` reglas de routing por familia legacy/regional.
  - Las familias `... WINERIM` dedicadas no son la estructura visual principal; la estructura visible es legacy/regional.
  - Master data cacheada usada: `agora_master_data.fetched_at=2026-06-04T09:40:07.818Z`.
- Familias de vino visibles en la cache:
  - Raíz/primer nivel: `Vinos Por Copas`, `Generosos`, `Espumosos`, `Vinos Blancos`, `Vinos Rosados`, `Vinos Tintos`, `Vino Dulce`, `MAGNUMS`.
  - Subfamilias tintos: `T Baleares`, `T Cataluña`, `T Ribera C.Leon`, `T Atlanticos`, `T Rioja Navarra`, `T Otras Zonas`, `T Internacionales`.
  - Subfamilias blancos: `B Baleares`, `B Cataluña`, `B Rueda`, `B Rioja Navarra`, `B Galicia`, `B Internacionales`.
  - Subfamilias espumosos/copas: `E Españoles`, `Champagnes`, `Copas Tinto`, `Copas Blanco`, `Copas Rosado`.
- Lectura cacheada:
  - `familiesTotal=72`, `visibleWineFamilies=26`.
  - `productsTotal=1252`, `saleableProducts=1175`, `wineLikeSaleable=870`.
  - Dentro de productos de vino vendibles detectados: `385` vienen de publicación Winerim (`winerim_push_tracking`), `92` son legacy con mapping `CONFIRMED`, `393` son legacy sin mapping confirmado o rechazados/pendientes.
  - Mappings totales en la conexión: `CONFIRMED=501`, `PENDING=20`, `REJECTED=291`.
- Foto directa adicional en Lovable Cloud:
  - `winerim_push_tracking` total Sa Pedrera: `417` filas; estados `VERIFIED=393`, `HIDDEN=17`, `FAILED=5`, `QUEUED=1`, `NOT_PUSHED=1`.
  - Publicado/verificado Winerim por formato: `BOTTLE=352`, `MAGNUM=25`, `GLASS=16`.
  - `product_mappings` total Sa Pedrera: `812` filas; estados `CONFIRMED=501`, `REJECTED=291`, `PENDING=20`.
  - Métodos de mappings confirmados: `XML_IMPORT=408`, `FUZZY=55`, `LEGACY_SAFE_MATCH=38`.
  - Matiz crítico: `XML_IMPORT` representa productos Winerim creados/importados en Agora; no equivale a legacy del cliente. Para decidir ocultaciones hay que mirar legacy real (`LEGACY_SAFE_MATCH` y `FUZZY` revisado), no el total `CONFIRMED`.
  - Informe completo guardado en `SA_PEDRERA_MAPPING_UPLOAD_REPORT_2026-06-04.md`.
- Ejemplos de naming/colocación legacy vs Winerim:
  - Legacy `Rock Angel` en `Vinos Rosados`, mapeado a Winerim `R607-Rock Angel Rosé`; también existe producto Winerim publicado `B R607-Rock Angel Rosé` en `Vinos Rosados`. Esto produce duplicado visual.
  - Legacy `Binitord Blanc` en `Vinos Blancos > B Baleares`; existen productos Winerim publicados `B B303-Binitord Blanc` en `B Baleares` y `C B303-Binitord Blanc` en `Vinos Por Copas > Copas Blanco`.
  - Legacy `Magnum Viña Sastre` en `MAGNUMS`; existe Winerim publicado `M MAGNUM 16 - Viña Sastre Crianza` en `MAGNUMS`.
  - Legacy `Rioja Bordón crianza` en `MAGNUMS`; existe Winerim publicado `M Magnum 34 - Bordón Crianza 1998` en `MAGNUMS`.
  - Legacy `Charles Heidsieck-Rosé` en `Espumosos > Champagnes`; existe Winerim publicado `B E533-Charles Heidsieck Reserve Rosé` en `Champagnes`.
  - Legacy `Nounat` en `Vinos Blancos > B Baleares`; existe Winerim publicado `B B304-Nounat` en `B Baleares`.
  - Legacy `MACAN` y `macan clasico` en `Vinos Tintos > T Rioja Navarra` están mapeados a Winerim `T99-Macán` y `T87-Macán Clásico`.
- Diagnóstico:
  - El matching y la publicación Winerim son dos mecanismos distintos.
  - `product_mappings` sirve para que una venta de un producto legacy descuente stock en Winerim.
  - `winerim_push_tracking` representa productos creados/publicados desde Winerim en Agora.
  - En Sa Pedrera se aplicó una mezcla: conservar estructura legacy/regional y publicar productos Winerim dentro de esas familias. Por eso aparecen vinos con nombres Winerim aunque exista matching parcial.
  - Si el cliente esperaba “no crear botones Winerim si existe un legacy mapeado”, la configuración actual no cumple esa expectativa al 100%; hay que pasar a política `legacy-first`: ocultar Winerim publicado cuando ya hay legacy `CONFIRMED` para el mismo vino/formato, y conservar Winerim solo para vinos/formato sin legacy seguro.
  - No debe aplicarse ocultación masiva sobre los `92` duplicados probables sin revisar calidad del mapping: hay matches `FUZZY` antiguos sospechosos (`Martini Blanco -> Izadi Blanco`, `PSI Dominio De pingus -> Dominio de Calogía`, etc.) que podrían provocar ventas descontando el vino equivocado o esconder el botón bueno.
- Estado API vivo en el momento de la revisión:
  - `http://sapedreradespujol.ddns.net:8984/` y `/version/` responden HTTP 200 (`AGORA_VERSION='8.7.4'`).
  - `GET /api/export-master/?filter=Families` y `Products` devuelven HTTP 501: `El módulo de servicios de integración no está habilitado.`
  - Esto impide confirmar XML vivo en ese instante; la explicación visual anterior se basa en cache Lovable Cloud de `2026-06-04T09:40:07.818Z`.

### Sa Vida recheck profundo tras aviso de API habilitada — 2026-06-04 10:58 CEST
- El usuario indica que desde Sa Vida/instalador afirman que el API HTTP está habilitada y que se acaban de conectar.
- Revisión directa externa desde el middleware:
  - `GET http://80.32.137.41:8984/`: HTTP 200, carga Administración Agora.
  - `GET /version/`: HTTP 200, `AGORA_VERSION='8.7.4'`.
  - `GET /installation-type/`: HTTP 200, `INSTALLATION_TYPE=2`.
  - `GET /api/`: HTTP 404 `NotFound`.
  - `GET /api/export-master/?filter=Families`: HTTP 501.
  - `GET /api/export-master?filter=Families`: HTTP 501.
  - `GET /api/export-master/?filter=Products`: HTTP 501.
  - `GET /api/export/?business-day=2026-06-03&filter=Invoices`: HTTP 501.
  - `GET /api/export?business-day=2026-06-03&filter=Invoices`: HTTP 501.
  - `GET /api/export/tickets/`: HTTP 501.
  - `GET /api/import/`: HTTP 501.
  - Última prueba puntual: `2026-06-04T08:58:33Z`, HTTP 501.
- Revisión de autenticación/rutas:
  - La guía oficial local de Agora confirma que el servidor HTTP es el mismo que Administración (`http://SERVIDOR:8984/`) y que debe usarse cabecera `Api-Token`.
  - Se probaron variantes con/sin barra final, `Accept: application/xml`, `Accept: */*`, `Authorization: Bearer`, `X-API-Key` y token por query param (`api-token`, `Api-Token`, `token`, `apikey`, `apiKey`, `api_key`).
  - Resultado: siempre HTTP 501 con `statusText=La integración a través del API HTTP no está habilitada.`
  - Como también devuelve 501 sin token, el fallo ocurre antes de validar credenciales; no es problema de token.
- Comparación con instalaciones sanas usando el mismo método:
  - `Kava`, `Restaurante Cienvinos Ecija` y `Baco Getafe` devuelven HTTP 200/XML en `export-master Families` y `export Invoices`.
  - Por tanto la forma de llamada del middleware es válida.
- Revisión de puertos públicos probables:
  - Solo `80.32.137.41:8984` responde con Agora.
  - Puertos probados sin API accesible: `80`, `443`, `8080`, `8081`, `8888`, `8980`-`8983`, `8985`-`8990`, `9984`.
- Estado Lovable Cloud:
  - Conexión `Sa Vida` mantiene `base_url=http://80.32.137.41:8984/`, `enabled=true`, `write_mode=XML_IMPORT`, `last_business_day_synced=2026-05-03`.
  - `provider_capabilities`: `NOT_CONNECTED/NONE/UNKNOWN`.
  - Backlog actual: `QUEUED=1055`, `RUNNING=0`, `FAILED=3322`, `BLOCKED=1861`.
  - `agora-proxy test`, `test-catalog-endpoint Families`, `test-catalog-endpoint Products` siguen devolviendo 501.
- Diagnóstico:
  - No es fallo de Lovable Cloud, ni de cabecera, ni de token, ni de slash final, ni de orden de query params, ni de puerto alternativo típico.
  - La explicación más probable es una de estas:
    1. Se habilitó `Servicios de Integración`, pero no la opción específica `API HTTP` con token en el servicio expuesto.
    2. Se habilitó en otra instancia/PC de Agora distinta a la que publica `80.32.137.41:8984`.
    3. El servicio de Administración/API de Agora no se reinició o no recargó la configuración tras activar el módulo.
    4. El port forwarding público apunta a una instancia distinta de la que revisó el instalador.
- Prueba mínima que debe ejecutar el instalador en el propio PC de Sa Vida y desde fuera:
  - Local: `curl -i -H 'Api-Token: <token>' -H 'Accept: application/xml' 'http://localhost:8984/api/export-master/?filter=Families'`.
  - Externa: `curl -i -H 'Api-Token: <token>' -H 'Accept: application/xml' 'http://80.32.137.41:8984/api/export-master/?filter=Families'`.
  - Ambas deben devolver HTTP 200 con XML. Si local devuelve 200 pero externa 501, el router/NAT apunta a otro servicio. Si local también devuelve 501, el API HTTP no está activo en esa instancia.

### Reparación controlada y auditoría final Agora — 2026-06-04 10:50 CEST
- Se corrigió `Restaurante Cienvinos Ecija` con cambio mínimo y reversible:
  - Acción usada: `agora-proxy` / `set-family-visibility`.
  - Familias Winerim activadas en Agora (`ShowInPos=true`): `900157` `TINTOS WINERIM`, `901954` `COPAS WINERIM`, `903516` `ROSADOS WINERIM`, `903925` `DULCE WINERIM`, `904241` `BLANCOS WINERIM`, `904289` `MAGNUM WINERIM`, `908182` `FORTIFICADOS WINERIM`, `908875` `ESPUMOSOS WINERIM`.
  - Verificación posterior contra XML vivo: `8/8` familias Winerim visibles, `428` productos Winerim detectados, `direct=0`, `notMain=0`, `prepMismatch=0`.
  - Se refrescó `agora_master_data` para Cienvinos: `families=8`, `products=605`, `vats=4`, `priceLists=3`, `prepTypes=2`, `prepOrders=6`, `warehouses=1`, `saleCenters=3`.
  - No se tocaron precios, productos, IVA, preparación, stock, tokens ni credenciales.
- Se limpiaron señales internas obsoletas tras comprobar endpoints Agora HTTP 200:
  - Reset de breaker/campos de fallo en `Kava`, `Luruna`, `Restaurante Cienvinos Ecija` y `Sa Pedrera`: `consecutive_failures=0`, `circuit_breaker_paused_until=null`, `circuit_breaker_reason=null`.
  - `provider_capabilities` marcadas `READY/XML_IMPORT/YES` para `Katsu`, `Kava`, `La Candela`, `Luruna`, `Cienvinos` y `Sa Pedrera`.
  - `Sa Vida` no se reseteó porque sigue devolviendo HTTP 501 en API Agora.
  - `Baco Getafe` se mantiene en rollback legacy (`enabled=false`, `write_mode=NONE`, capacidades no operativas).
- Recuento final de cola abierta por conexión:
  - `Baco Getafe`: `QUEUED=0`, `RUNNING=0`, `FAILED=0`, `BLOCKED=0`.
  - `Katsu Izakaya`: `QUEUED=0`, `RUNNING=0`, `FAILED=0`, `BLOCKED=0`.
  - `Kava`: `QUEUED=0`, `RUNNING=0`, `FAILED=7`, `BLOCKED=9` (deuda histórica antigua; sin tareas activas).
  - `La Candela de Triana`: `QUEUED=0`, `RUNNING=0`, `FAILED=0`, `BLOCKED=0`.
  - `Luruna`: `QUEUED=0`, `RUNNING=0`, `FAILED=10`, `BLOCKED=58` (deuda histórica antigua; sin tareas activas).
  - `Restaurante Cienvinos Ecija`: `QUEUED=0`, `RUNNING=0`, `FAILED=0`, `BLOCKED=0`.
  - `Sa Pedrera`: `QUEUED=0`, `RUNNING=0`, `FAILED=294`, `BLOCKED=142`.
  - `Sa Vida`: `QUEUED=1055`, `RUNNING=0`, `FAILED=3322`, `BLOCKED=1861`; no procesar hasta que Agora deje de responder 501.
- En `Sa Pedrera` se bloqueó una única tarea abierta `AGORA_HIDE_PRODUCT` (`D715-Pancaliente`) en vez de reintentar:
  - Motivo: estaba en `QUEUED`, llevaba `attempts=2/3` y Agora devolvía error de clave duplicada al intentar importar `[INACTIVO] D715-Pancaliente`.
  - Acción: `status=BLOCKED` con `blocked_reason=MANUAL_REVIEW_REQUIRED_2026_06_04`.
  - Razón operativa: `Sa Pedrera` está en modo híbrido/legacy-preservation; reintentar una ocultación automática podía alterar el layout legacy sin revisión.
- Foto final de salud funcional:
  - `Katsu`: catálogo y ventas D-1 activos; sin cola abierta; falta venta real reciente de copa/botella Winerim para probar descuento.
  - `Kava`: catálogo y ventas activos; stock reciente probado en `copa` y `botella`; sin cola activa, solo deuda histórica.
  - `La Candela`: catálogo y ventas activos; sin cola abierta; falta venta real reciente de producto Winerim que genere stock.
  - `Luruna`: catálogo y ventas activos; stock reciente probado solo en `botella`; sin cola activa, solo deuda histórica.
  - `Cienvinos`: catálogo Winerim visible y limpio; sin cola abierta; falta primer cierre nuevo con producto Winerim para probar ventas/stock.
  - `Sa Pedrera`: modo híbrido operativo; stock reciente probado en `botella`; legacy visible por diseño y mappings todavía parciales.
  - `Baco`: legacy operativo por rollback; no automático Winerim.
  - `Sa Vida`: no operativa para middleware por HTTP 501 externo.
- Rollback documentado para esta sesión:
  - Cienvinos: volver a llamar `set-family-visibility` con los 8 IDs anteriores y `showInPos=false`.
  - Breakers: si fuese necesario revertir la señal visual, restaurar manualmente el estado previo solo en Lovable Cloud; no afecta a Agora ni a Winerim.
  - Sa Pedrera: la tarea bloqueada puede devolverse a `QUEUED` si se decide ocultar ese producto tras revisión, pero no debe reintentarse sin resolver el duplicado Agora.

### Sa Vida módulo API indicado como activado / revalidación — 2026-06-04 10:02 CEST
- El usuario confirma que el módulo está activado y reindica:
  - Base URL: `http://80.32.137.41:8984`.
  - API token Agora: coincide con el valor ya guardado en Lovable Cloud. No se documenta el token.
- Revalidación directa read-only contra Agora:
  - `GET /`: HTTP 200, carga la web de Agora.
  - `GET /version/`: HTTP 200, `AGORA_VERSION='8.7.4'`.
  - `GET /installation-type/`: HTTP 200, `INSTALLATION_TYPE=2`.
  - `GET /api/`: HTTP 404 `NotFound`.
  - `GET /api/export-master/?filter=Families`: HTTP 501.
  - `GET /api/export-master/?filter=Products`: HTTP 501.
  - `GET /api/export/?filter=Invoices&business-day=2026-06-03`: HTTP 501.
  - `GET /api/export/?business-day=2026-06-03&filter=Invoices`: HTTP 501.
  - `GET /api/export/tickets/`: HTTP 501.
  - El mismo `501` aparece también sin token, por lo que no es un rechazo por API key.
- Mensaje exacto de Agora en `statusText`: `La integración a través del API HTTP no está habilitada.`
- Estado Lovable Cloud leído en la misma revalidación:
  - `Sa Vida` tiene `base_url=http://80.32.137.41:8984/`, `enabled=true`, `write_mode=XML_IMPORT`.
  - `last_business_day_synced=2026-05-03`.
  - Breaker/fallos históricos: `consecutive_failures=10`, `circuit_breaker_reason=Auto-paused: 10 consecutive task failures.`
- Conclusión: sigue bloqueado fuera del middleware. La red/IP y token son correctos, pero el servidor Agora de Sa Vida aún responde como si la integración API HTTP no estuviera habilitada en esa instalación o no se hubiese aplicado/reiniciado correctamente. No se debe procesar cola, catálogo ni stock de Sa Vida hasta que `export-master` e `Invoices` devuelvan HTTP 200.

### Auditoría viva de integraciones Agora — 2026-06-04 09:42 CEST
- Alcance auditado:
  - Lovable Cloud contiene `8` conexiones POS registradas y todas son `provider=agora`. No hay conexiones productivas vivas de BDP/Revo/Toast/Numier/Clover/Simphony/Square/TCPOS/Cassa/HIOPOS/TouchBistro que se puedan declarar operativas; esos providers existen en código/wizards, pero no tienen filas productivas auditables en esta revisión.
  - La auditoría fue read-only: se leyeron tablas de Lovable Cloud, cache/master data y endpoints Agora; no se escribieron productos, familias, stock, colas ni credenciales.
  - La consulta amplia de `outbound_tasks` abiertas canceló por timeout SQL (`57014 canceling statement`). Conclusión de proceso: las colas necesitan métricas/indexación o vista agregada para auditoría fiable sin depender de consultas pesadas.
- Conectividad Agora viva:
  - `Katsu Izakaya`, `Kava`, `La Candela de Triana`, `Luruna`, `Restaurante Cienvinos Ecija` y `Sa Pedrera` responden HTTP 200 en catálogo (`Families`/`Products`) y en endpoint de facturas del cursor cuando hay datos o `{}` cuando no los hay.
  - `Baco Getafe` responde HTTP 200 en catálogo/facturas, pero está desactivado por rollback legacy (`enabled=false`, `write_mode=NONE`).
  - `Sa Vida` responde HTTP 200 en raíz web, pero `Families`, `Products` e `Invoices` devuelven HTTP 501. Sigue no operativa para middleware aunque el servidor esté encendido.
- Automatización de catálogo Winerim -> Agora:
  - No se puede afirmar que "cualquier cambio en Winerim se refleja automáticamente en Agora" para toda la flota.
  - `auto_push_verified_ready=false` sigue pausado en `Katsu`, `Kava`, `La Candela`, `Luruna` y `Sa Pedrera`; esto protege de reimportaciones masivas hasta confirmar redeploy diferencial real de `winerim-proxy`.
  - `Cienvinos` tiene `auto_push_verified_ready=true` y `auto_push_on_create=true`, pero `auto_push_on_update=false`; por tanto altas nuevas pueden estar habilitadas, pero cambios de precio/nombre no se deben prometer como automáticos hasta activar update diferencial.
  - `Baco` está en rollback legacy y no forma parte del flujo automático Winerim.
  - `Sa Vida` no puede publicar catálogo mientras Agora devuelva 501.
- Estado visual/catálogo vivo por conexión:
  - `Katsu Izakaya`: 8 familias Winerim visibles; 85 productos detectados en familias Winerim; 0 botones raíz Winerim; 27 productos Winerim no vendibles como main, probablemente inactivos/no exportables y requieren revisión antes de contarlos como fallo.
  - `Kava`: 8/9 familias Winerim visibles (`POSTRE WINERIM` oculta); 233 productos Winerim; 0 botones raíz; 10 productos no vendibles. Queda una familia legacy `Vinos` visible, pero sin productos vendibles detectados.
  - `La Candela de Triana`: 8 familias Winerim visibles; 79 productos Winerim; 0 botones raíz; 1 producto no vendible; legacy de vino no visible.
  - `Luruna`: 8 familias Winerim visibles; 126 productos Winerim; 0 botones raíz; 2 productos no vendibles. Queda familia legacy `Vinos` visible, pero sin productos vendibles detectados.
  - `Restaurante Cienvinos Ecija`: 8 familias Winerim existen pero las 8 están `ShowInPos=false`; 428 productos Winerim están `SaleableAsMain=true` y sin botones raíz, pero al estar las familias ocultas el cliente puede no localizarlos por navegación visual. Esto requiere reparación controlada de visibilidad de familias.
  - `Sa Pedrera`: por diseño operativo mantiene legacy visual/regional. Las 8 familias `... WINERIM` están ocultas y la venta visible ocurre en familias legacy/regionales; se detectan 12 familias legacy de vino visibles y 68 productos legacy vendibles en ellas. Es híbrida, no una instalación "solo Winerim".
  - `Baco Getafe`: rollback confirmado; 8 familias Winerim ocultas, 118 productos Winerim no vendibles y 191 productos legacy de vino vendibles en familias legacy visibles. No está en automático Winerim.
  - `Sa Vida`: sin auditoría viva de catálogo por HTTP 501.
- Ventas POS -> Lovable Cloud / stock Winerim:
  - El cron está vivo: `last_sync_at` se actualizó el 2026-06-04 en las conexiones activas, incluso cuando no hay días nuevos o stock resuelto.
  - `Katsu`: `last_business_day_synced=2026-06-03`, 56 ventas guardadas en últimos 7 días; sin stock Winerim reciente y la muestra de líneas tenía candidatos de vino no mapeados. No declarar stock automático probado.
  - `Kava`: `last_business_day_synced=2026-06-03`, ventas guardadas y stock real reciente: últimos 7 días `SUCCESS=27` (`17` copa, `10` botella). Es la instalación más probada para copas/botellas, aunque conserva bloqueos terminales antiguos de vino inexistente.
  - `La Candela`: `last_business_day_synced=2026-06-03`, 512 ventas guardadas en últimos 7 días; `stock_sync_log` no tiene descuentos en 30 días. Puede ser ausencia de venta Winerim resuelta, pero no está probado el descuento.
  - `Luruna`: `last_business_day_synced=2026-06-03`, 405 ventas guardadas en últimos 7 días; stock reciente solo `1` botella `SUCCESS`, sin prueba reciente de copa.
  - `Cienvinos`: `last_business_day_synced=2026-05-27`, sin ventas ni stock en 30 días; falta primer cierre real con producto Winerim.
  - `Sa Pedrera`: `last_business_day_synced=2026-06-02`, 19 ventas guardadas en últimos 7 días; últimos 7 días `5` botellas `SUCCESS`, sin copa reciente. Existen 78 bloqueos terminales históricos de copa (`Variant 'copa' not found`) y mappings vivos `CONFIRMED=76`, `PENDING=20`, `REJECTED=58`; lo confirmado puede descontar, lo pendiente/rechazado no.
  - `Baco`: tiene 41 descuentos `SUCCESS` en la ventana de 7 días de auditoría, pero son históricos del periodo anterior/al rollback; hoy `enabled=false` y no debe comunicarse como automático Winerim.
  - `Sa Vida`: sin ventas nuevas ni stock reciente; no operativa por API 501.
- Historial de ventas Winerim:
  - Se mantiene la decisión previa: el middleware guarda histórico canónico en Lovable Cloud y descuenta stock Winerim por `PUT /api/v2/stock/{stockId}`.
  - No hay código que haga POST de una venta a Winerim; por tanto no se debe prometer "Historial de ventas de Winerim" como hecho hasta validarlo en la UI/API de Winerim.

## Hipótesis / riesgos abiertos
- Casa Nene: falta validar una venta real cerrada con botella o magnum Winerim para confirmar `sales_events`, `stock_sync_log` y descuento en Winerim en producción.
- Casa Nene: si el cliente quiere copas, debe activar/preciar variantes de copa en Winerim; hoy no se han publicado copas porque Winerim no las expone.
- `Katsu`, `La Candela`, `Luruna` y `Cienvinos`: siguen necesitando venta/cierre real de copa y botella Winerim para afirmar que el descuento de stock funciona en todas las variantes.
- `Sa Pedrera`: la cola activa está saneada, pero los `FAILED/BLOCKED` históricos requieren revisión por lotes; cerrarlos en masa sin mirar podría ocultar mappings legacy todavía relevantes.
- `Kava` y `Luruna`: la deuda histórica `FAILED/BLOCKED` no impide el funcionamiento actual, pero ensucia monitorización y conviene clasificarla cuando haya una ventana de mantenimiento.
- `Cienvinos`: la ocultación de las 8 familias Winerim quedó reparada el 2026-06-04; queda validar con primer uso/cierre real del cliente que la navegación visual en tablets es correcta.
- `Katsu`, `La Candela` y `Luruna`: que haya ventas guardadas sin stock Winerim no prueba fallo por sí solo; puede significar que no se vendieron productos mapeados Winerim. Requiere venta de prueba por conexión.
- `Kava`, `Luruna`, `Cienvinos` y `Sa Pedrera`: los breakers obsoletos se resetearon tras sonda controlada el 2026-06-04; queda vigilar que no se reabran por deuda histórica.
- `Sa Pedrera`: la convivencia legacy + Winerim es necesaria para mantener organización regional, pero cualquier legacy sin mapping `CONFIRMED` no descuenta en Winerim; un mapping erróneo descontaría el vino equivocado.

### Casa Nene intradía Agora — 2026-06-24

#### Hechos
- Cliente reporta 3 botellas de `Valbuxan` vendidas al mediodía y no visibles todavía en Winerim.
- Diagnóstico vivo de Casa Nene (`e3cb6dbb-3474-4926-b740-706fbd0ef7e0`):
  - Agora responde y `fetch-day` de `2026-06-24` devuelve 28 facturas.
  - En esas facturas aparecen 3 botellas de `B Valbuxan Tinto Lexitimo` (`ProductId=742252`) en `TINTOS WINERIM`.
  - Mapping confirmado contra Winerim `242252`, variante `BOTTLE`; stockId botella `277954`.
  - También aparece 1 botella resuelta de `B Pazo de Señorans` (`ProductId=757281`) contra Winerim `257281`, stockId `295343`.
- Causa principal: el automático actual procesa ventas por día cerrado (`D-1`); no estaba activo un polling intradía de facturas del día en curso.
- Se ejecutó una intervención manual controlada:
  - Guardadas 28 facturas / 185 líneas de `2026-06-24` en Lovable Cloud.
  - Descontado Winerim: `Valbuxan Tinto Lexitimo` stock botella `7 -> 4` y `Pazo de Señorans` `202 -> 201`.
  - Se corrigió inmediatamente una primera lectura parcial de Valbuxan que habría dejado stock `5`; la corrección dejó auditoría con `manual_intraday_correction` y cantidad `0`, sin afectar la idempotencia futura.
  - Revisión posterior: deltas pendientes `0`; no hay más stock que descontar para esas ventas.
  - Cursor protegido: `last_business_day_synced` sigue en `2026-06-23`; no se marcó el día actual como cerrado.
- Código preparado:
  - Nueva acción `sync-intraday-sales` en `agora-proxy`.
  - Nuevo modo incremental de stock: compara cantidades deseadas por `(sales_event_id, winerim_product_id, variant)` contra `stock_sync_log.SUCCESS` y solo descuenta el delta.
  - `agora-cron-dispatcher` invoca `sync-intraday-sales` en job `sales-stock` solo si `provider_config.intraday_sales_sync_enabled=true`.
  - Casa Nene tiene `intraday_sales_sync_enabled=true` e intervalo documentado de 5 minutos.
- Validación local del parche:
  - `npx esbuild` de `agora-proxy` OK.
  - `npx esbuild` de `agora-cron-dispatcher` OK.
  - `npm run build` OK.
- Validación runtime antes de este commit: el deploy manual anterior aún devolvía `Unknown action` para `sync-intraday-sales`, por lo que no incluía el parche nuevo.
- Validación post-deploy del primer parche:
  - `sync-intraday-sales` ya existía, pero el primer diseño incremental comparaba por `sales_event_id`.
  - Como las ventas manuales previas habían quedado con IDs de evento antiguos y el runtime reimportó el día con IDs de documento distintos, el test generó logs duplicados.
  - Mitigación aplicada inmediatamente:
    - `provider_config.intraday_sales_sync_enabled=false` en Casa Nene para cortar el polling intradía.
    - Restaurado `Pazo de Señorans` stockId `295343` de `192 -> 193` porque el test duplicó una deducción real `193 -> 192`.
    - Los 3 logs duplicados del test (`Pazo` + 2 `Valbuxan`) quedaron en `BLOCKED` con razón explícita.
    - `Valbuxan` no se restauró porque el PUT duplicado registró `previousStock=0` y `newStock=0`; no hubo decremento adicional atribuible a ese test.
  - Nuevo parche preparado: intradía compara total diario por `(winerim_product_id, variant)` contra cantidad `SUCCESS` ya descontada en el mismo business day, y solo aplica el delta positivo.

#### Decisiones
- Activar intradía primero solo en Casa Nene mediante flag por conexión.
- No adelantar cursor diario con ventas intradía; el cierre D-1 sigue siendo el mecanismo de consolidación.
- No hacer descuentos "por línea recién importada" sin comparar contra `stock_sync_log`: el flujo intradía debe ser delta-idempotente para no duplicar stock.
- La reactivación de Casa Nene queda bloqueada hasta desplegar y validar el parche por total diario.

#### Riesgos
- Si Agora modifica una factura ya importada, el modo incremental descuenta incrementos positivos; no intenta devolver stock si una línea se reduce o anula. Las anulaciones requieren política separada.
- El polling intradía depende de `Invoices`; si una instalación Agora no expone facturas hasta cierre, no tendrá tiempo real aunque el flag exista.
- Hasta redeploy efectivo del parche por total diario, Casa Nene queda corregida/pausada manualmente pero no automatizada cada 5 minutos.

#### Tareas pendientes inmediatas
- Redeployar `agora-proxy` desde el parche por total diario.
- Tras redeploy, invocar `sync-intraday-sales` para Casa Nene con el flag todavía apagado y `force=true`; debe devolver `synced=0`, `failed=0` y no hacer PUT a Winerim.
- Solo si esa prueba es limpia, reactivar `intraday_sales_sync_enabled=true` en Casa Nene.
- En el siguiente servicio, verificar que una nueva venta Winerim aparece en Lovable Cloud y descuenta stock Winerim sin esperar al cierre del día.
- `Baco`: el rollback legacy está aplicado; si el cliente vuelve a pedir Winerim automático, hay que tratarlo como reactivación planificada con validación visual, no como "ya funcionando".

### Sa Vida nueva IP / revalidación Agora — 2026-06-02 10:39 CEST
- El usuario indicó nueva IP para Sa Vida: `80.32.137.41:8984`, manteniendo contraseña/API token Agora y token Winerim.
- En Lovable Cloud, `Sa Vida` ya tenía guardada esa base URL (`http://80.32.137.41:8984`); se normalizó a `http://80.32.137.41:8984/`.
- No se tocaron credenciales ni token Winerim.
- Pruebas contra Edge Function `agora-proxy`:
  - `test`: HTTP 200 del proxy, pero Agora respondió `501` (`Agora responded 501`).
  - `test-catalog-endpoint Products`: `success=false`, `status=501`.
  - `test-catalog-endpoint Families`: `success=false`, `status=501`.
  - `find-last-business-day` 10 días: `daysWithSales=[]`, `totalInvoicesFound=0`, `lastClosedDay=null`.
- Estado Lovable Cloud tras la prueba:
  - `enabled=true`, `write_mode=XML_IMPORT`, pero capacidades `provider_capabilities`: `readiness_status=NOT_CONNECTED`, `write_mode=NONE`, `can_write_products=UNKNOWN`.
  - `circuit_breaker_paused_until` está en fecha pasada, pero `consecutive_failures=10`; no se reseteó porque el POS sigue respondiendo 501.
- Conclusión operativa: Sa Vida sigue NO operativa. Esta IP/puerto no expone la API REST Agora necesaria (`/api/` y `/api/export-master`), o el módulo REST sigue no habilitado. No procesar cola, catálogo ni stock hasta que Agora devuelva 200 en `Products/Families`.
- Detalle exacto de fallo verificado contra Agora:
  - `GET /` devuelve `200 OK` y carga la web `Administrar Ágora`; por tanto IP/puerto/ruta de red llegan al servidor correcto.
  - `GET /api/` devuelve `404 NotFound` sin cuerpo.
  - `GET /api/export/?filter=Products`, `GET /api/export/?filter=Families`, `GET /api/export-master/?filter=Products`, `GET /api/export-master/?filter=Families`, `GET /api/export/?business-day=2026-06-01&filter=Invoices` y `GET /api/export/tickets/` devuelven `501`.
  - El `statusText` exacto de Agora para esos `501` es: `La integración a través del API HTTP no está habilitada.`
  - El cuerpo de respuesta viene vacío (`bodyLength=0`), sin JSON/XML.
  - `GET /version/` devuelve `AGORA_VERSION = '8.7.4'` y `ENABLE_POS_CONNECTION_CHECK = true`.
  - `GET /installation-type/` devuelve `INSTALLATION_TYPE = 2`.
  - El mismo `501` aparece con token correcto, sin token y con token incorrecto; por tanto no es un problema de credenciales/API key, porque Agora rechaza antes de validar token.
  - Conclusión técnica afinada: no es un problema de IP/puerto abierto ni de token; es configuración/licencia/activación de API HTTP en Agora.

### Clarificación estado Agora por conexión — 2026-06-01 11:55 CEST
- No todas las integraciones Agora están "igual" ni se deben comunicar como "perfectas" en bloque:
  - `Katsu Izakaya`: activa; `last_business_day_synced=2026-05-30`, que coincide con el último día con ventas encontrado en la sonda de 10 días. Sin stock logs recientes de productos Winerim.
  - `Kava`: activa; `last_business_day_synced=2026-05-30`, coincide con último día con ventas. Tiene descuentos de stock reales (`copa` y `botella`) y legacy directo residual ya oculto.
  - `La Candela de Triana`: activa; `last_business_day_synced=2026-05-31`. La sonda viva de último día abortó por timeout en esta comprobación, pero el cursor está actualizado a día cerrado reciente.
  - `Luruna`: activa; `last_business_day_synced=2026-05-31`. La sonda detectó ventas en `2026-06-01`; al ser el día en curso no se trata todavía como cierre ordinario D-1.
  - `Restaurante Cienvinos Ecija`: activa; `last_business_day_synced=2026-05-27`; sonda de 10 días sin facturas y lecturas vivas de master data intermitentes por timeout/abort.
  - `Sa Pedrera`: activa; `last_business_day_synced=2026-05-30`, coincide con último día con ventas encontrado en la sonda de 10 días.
  - `Baco Getafe`: desactivada por rollback legacy (`enabled=false`, `write_mode=NONE`).
  - `Sa Vida`: no operativa; cursor antiguo (`2026-05-03`) y API Agora sigue pendiente de resolver.
- `Sa Pedrera` mantiene legacy visible por diseño operativo:
  - Familias legacy/regionales visibles incluyen `Vinos Por Copas`, `Espumosos`, `Vinos Blancos`, `Vinos Rosados`, `Vinos Tintos`, `Vino Dulce`, `T Ribera C.Leon`, `T Rioja Navarra`, `B Rioja Navarra`, `Copas Tinto`, `Copas Blanco`, `Copas Rosado`, `Copas Cava`, entre otras.
  - Hay `231` productos legacy vendibles dentro de esas familias; no hay productos de vino como botón directo raíz (`directWineLikeProducts=[]`).
  - Los productos Winerim se han enrutado a esas familias para conservar la organización regional del cliente, no a familias `... WINERIM` separadas.
- Matching Sa Pedrera:
  - `product_mappings` confirmados: `417` botella, `21` copa, `25` magnum.
  - Rechazados/bloqueados: `273` copa, `13` botella, `5` magnum; se tratan como productos legacy o variantes/vinos no válidos para Winerim y no deben forzar descuento.
  - Pendientes: `20` botella.
  - Tracking publicado/verificado: `352` botella, `16` copa, `25` magnum.
  - StockIds de vinos activos con precio: botella `359/359`, copa `19/19`, magnum `26/26`; faltantes `0` por formato activo/preciado.
  - Desde 2026-05-26: stock Winerim con éxito en `14` botellas, `15` copas y `3` logs legacy sin variante; hay `78` bloqueos terminales de copa de `COPA B304-Nounat [copa]` porque Winerim no expone variante `copa` para ese vino. No son fallos reintentables.

### Dry-run matching legacy Sa Pedrera — 2026-06-01 12:16 CEST
- Se hizo una pasada solo lectura sobre `230` productos legacy vendibles en familias de vino de Sa Pedrera.
- Resultado:
  - `120` legacy ya tienen mapping `CONFIRMED`; una venta por esos productos puede resolver contra Winerim y descontar stock si el formato/stockId existe.
  - `13` están `PENDING`; no deben considerarse seguros hasta confirmación manual.
  - `1` está `REJECTED`.
  - `96` no tienen fila de mapping.
  - De esos `96`, el dry-run detecta `40` candidatos fuertes con variante Winerim válida; podrían confirmarse en un lote seguro tras revisar muestras.
  - `35` tienen candidato de vino, pero falta variante/stockId para el formato inferido (muchos son copas vendidas desde familia no-copa o magnums sin variante); no se deben confirmar hasta corregir Winerim o reclasificar formato.
  - `21` quedan débiles/ambiguos y requieren revisión manual.
- Riesgo operativo: cualquier legacy no `CONFIRMED` vendido en Agora puede no descontar stock en Winerim. Confirmar un mapping incorrecto es peor: descontaría stock del vino equivocado.
- Recomendación operativa: aplicar primero solo los `40` candidatos fuertes con variante válida, después revisar `PENDING` y ambiguos con el cliente/listado, y dejar bloqueados los casos sin variante Winerim.

### Aplicación fase 1 matching legacy Sa Pedrera — 2026-06-01 12:46 CEST
- Se aplicó un lote conservador de `38` mappings legacy en Sa Pedrera con `status=CONFIRMED` y `match_method=LEGACY_SAFE_MATCH`.
  - Formatos insertados: `31` botella, `3` copa, `4` magnum.
  - Backup local previo: `.codex-backups/sa-pedrera-legacy-safe-match-2026-06-01T10-45-00-262Z.json`.
- Se excluyeron explícitamente `3` candidatos del dry-run por riesgo de match incorrecto:
  - `328` / `Roda`: ambiguo entre referencias Roda.
  - `589` / `Tokaji Aszú 6 Puttonyos`: Winerim solo exponía `Tokaji Aszú 3 Puttonyos`.
  - `707` / `Magnum Marques de Murrieta`: candidato automático apuntaba a `Capellanía`, riesgo de vino/formato incorrecto.
- Se corrigieron manualmente antes de insertar:
  - `338` / `MACAN` -> `T99-Macán` (no `Macán Clásico`).
  - `529` / `Alba` -> `R601-Alba Rosé` por estar en familia `Vinos Rosados`.
- Verificación posterior:
  - Productos legacy vendibles analizados: `230`.
  - Legacy confirmados por formato: `136` botella, `18` copa, `4` magnum (`158` confirmados total).
  - Pendientes: `13` botella.
  - Rechazados: `1` botella.
  - Sin mapping restante: `58`.
  - Dentro de los no mapeados quedan `3` candidatos fuertes con variante válida, pero son los excluidos por ambigüedad anterior; `34` tienen candidato pero falta variante/stockId; `21` siguen débiles/ambiguos.
- Rollback de esta fase: eliminar las filas `product_mappings` con `connection_id=Sa Pedrera` y `match_method=LEGACY_SAFE_MATCH` creadas en esta fase, usando el backup local como listado de IDs/productos.

### Auditoría copas y legacy Agora — 2026-06-01 11:40 CEST
- Se revisó Lovable Cloud para distinguir entre:
  - conexiones con copa técnicamente preparada (`glass_stock_id` cacheado y mapping confirmado);
  - conexiones con ventas reales de copa ya descontadas en `stock_sync_log`;
  - conexiones con productos/familias legacy de vino todavía visibles en Agora.
- Estado de copas:
  - `Kava`: copas confirmadas y probadas con ventas reales recientes (`30` descuentos `SUCCESS` de variante `copa` desde 2026-05-26; sin problemas recientes de copa).
  - `Sa Pedrera`: copas confirmadas funcionan para productos válidos (`15` descuentos `SUCCESS`), pero existen `78` bloqueos históricos de productos legacy/rechazados, por ejemplo copa de vino sin variante `copa` en Winerim. No declarar "todas las copas" como sanas hasta limpiar/aceptar esos legacy.
  - `Baco Getafe`: hubo `37` descuentos `SUCCESS` de copa antes del rollback, pero hoy la conexión está desactivada (`enabled=false`, `write_mode=NONE`) y no forma parte del automático Winerim.
  - `Katsu Izakaya`, `La Candela de Triana`, `Luruna` y `Restaurante Cienvinos Ecija`: las copas activas tienen `glass_stock_id` cacheado; falta venta/cierre real reciente de copa para demostrar descuento automático en producción.
  - `Sa Vida`: no se considera sana. Aunque hay éxitos históricos de copa, también hay bloqueos y el POS sigue devolviendo HTTP 501 en catálogo/ventas.
- Estado legacy visible en Agora:
  - `Baco Getafe`: legacy visible por decisión de rollback. Familias legacy visibles: `VINO`, `FINOS`, `CHAMPAGNE`, `ROSADOS`, `TINTOS`, `BLANCOS`; Winerim está deshabilitado operativamente.
  - `Sa Pedrera`: conserva legacy visible por decisión operativa/regional. Familias legacy visibles: `Vinos Por Copas`, `Generosos`, `Vinos Blancos`, `Vinos Rosados`, `Vinos Tintos`, `Vino Dulce`, `T Ribera C.Leon`, `T Rioja Navarra`, `B Rueda`, `B Rioja Navarra`, `B Galicia`, `Copas Tinto`, `Copas Blanco`, `Copas Rosado`. Hay coexistencia con productos Winerim en esas familias.
  - `Kava`: sin familias legacy de vino visibles. Se detectó y ocultó sin borrar un producto directo no-Winerim dentro de familia Winerim (`1000011` / `EL LANCE`), porque existe producto Winerim confirmado para `El Lance 7 Fuentes` (`provider_product_id=755694`).
  - `Luruna`: sin familias legacy de vino visibles. Se detectaron y ocultaron sin borrar tres productos directos no-Winerim con nombre de vino/copa: `1164074` / `COPA ONDALAN TINTO`, `1164081` / `VIUDA DE CLICQUOT ROSADO`, `1164082` / `COPA VIÑA SASTRE CRZ`.
  - `Katsu Izakaya` y `La Candela de Triana`: sin familias legacy de vino visibles ni productos directos legacy detectados en esta auditoría.
  - `Cienvinos`: la lectura XML viva de esta auditoría devolvió error transitorio y el reintento `sync-master-data` terminó en `AbortError`. La cache de Lovable Cloud de 2026-06-01 08:55 CEST no muestra esos productos legacy residuales, pero conviene repetir comprobación viva cuando el POS responda estable.
- Verificación posterior de los residuos ocultados:
  - `Kava` producto `1000011`: `SaleableAsMain=false`, `UseAsDirectSale=false`.
  - `Luruna` productos `1164074`, `1164081`, `1164082`: `SaleableAsMain=false`, `UseAsDirectSale=false`.
- Rollback de esta mini-limpieza: volver a llamar `agora-proxy set-product-visibility` con `visible=true` para esos IDs concretos, sin tocar familias ni borrar productos.

### Auditoría automática Agora + reparación Cienvinos — 2026-06-01 09:45 CEST
- Se verificó contra Lovable Cloud y XML vivo de Agora que el `agora-proxy` desplegado ya genera `UseAsDirectSale=false`, `SaleableAsMain=true` y pareja de preparación correcta en `preview-xml`.
- Se detectó que `winerim-proxy` desplegado en Lovable Cloud todavía NO contiene el cambio diferencial de auto-push:
  - Prueba real `fetch-catalog` en Katsu devolvió `autoPushResult.reason=auto_push_not_verified_no_manual_import_success_yet`, señal del runtime anterior.
  - El commit `a180c6c` (`Make Winerim catalog auto-push differential`) ya está en GitHub `main`, pero falta redeploy efectivo en Lovable Cloud.
- Por seguridad, siguen pausados `auto_push_verified_ready=false` en Katsu, Kava, La Candela, Luruna y Sa Pedrera. No se deben reactivar hasta confirmar que `winerim-proxy fetch-catalog` devuelve `autoPushResult.reason=no_catalog_changes_detected` o `autoPushResult.differential=true`.
- Se reparó Cienvinos en Agora, sin borrar productos:
  - Backup previo: `.codex-backups/agora-direct-visibility-repair-2026-06-01T07-37-55-705Z.json`.
  - 428 productos Winerim publicados pasaron de botón raíz a producto vendible dentro de familia (`direct=0`, `notMain=0`, `mismatchPrep=0`).
  - Se refrescó `agora_master_data` de Cienvinos (`products=605`, `families=8`).
- Se repararon también desalineaciones residuales:
  - Katsu: 1 producto verificado corregido; verificación final `activeTracked=58`, `direct=0`, `notMain=0`, `mismatchPrep=0`.
  - Sa Pedrera: 1 producto verificado corregido; verificación final `activeTracked=392`, `direct=0`, `notMain=0`, `mismatchPrep=0`.
- Se cerraron como `SUCCESS` tareas antiguas `AGORA_XML_UPSERT_PRODUCT` supersedidas por la reparación viva:
  - Cienvinos: 85 cerradas; abiertas finales `0`.
  - Kava: 27 cerradas; abiertas finales `0`.
  - Luruna: 13 cerradas; abiertas finales `0`.
  - Sa Pedrera: 62 cerradas; abiertas finales `0`.
- Foto operativa de catálogo publicado:
  - Baco Getafe: rollback legacy, `enabled=false`, `write_mode=NONE`, Winerim activo publicado `0`.
  - Cienvinos: `activeTracked=428`, `direct=0`, `notMain=0`, `mismatchPrep=0`; `auto_push_verified_ready=true`, pero `auto_push_on_update=false` hasta redeploy diferencial.
  - Katsu: `activeTracked=58`, `direct=0`, `notMain=0`, `mismatchPrep=0`; últimos verificados: `6º Elemento`, `Lienzo Chardonnay Fermentado en Barrica`, `Sarmentero Roble`, `Tarima Blanco`, `Majuelo El Espejo la Seca`.
  - Kava: `activeTracked=223`, `direct=0`, `notMain=0`, `mismatchPrep=0`; últimos verificados: `Deutzerhof Spätburgunder Troken`, `Tement Kalk & Kreide Sauvignon Blanc`, `Francois Carillon Bourgogne Côte d'Or Pinot Noir`, `Zieregg Sauvignon Blanc`, `De La Riva Macharnudo Blanco`.
  - La Candela: `activeTracked=61`, `direct=0`, `notMain=0`, `mismatchPrep=0`; últimos verificados: `Valdehermoso Joven`, `Viña Calera`, `Valduero 2 Maderas`, `Tarsus Crianza`, `S4MGO`.
  - Luruna: `activeTracked=124`, `direct=0`, `notMain=0`, `mismatchPrep=0`; últimos verificados: `Culmen Reserva` magnum, `El Perro Verde` magnum, `Txakolí Uno`, `Txakoli Aitaren`, `Taittinger Brut Réserve`.
  - Sa Pedrera: `activeTracked=392`, `direct=0`, `notMain=0`, `mismatchPrep=0`; últimos verificados: `B303-Binitord Blanc` copa, `Magnum 34 - Bordón Crianza 1998`, `MAGNUM 16 - Viña Sastre Crianza`, `E533-Charles Heidsieck Reserve Rosé`, `R607-Rock Angel Rosé`.
  - Sa Vida: sigue no operativa para catálogo vivo (`Products` devuelve HTTP 501), `auto_push_verified_ready=false`, 1000 tareas antiguas abiertas; no procesar hasta resolver API/puerto/versión.
- Ventas/stock últimos 7 días:
  - Kava: `stock_sync_log SUCCESS=53`, `BLOCKED=26`, `FAILED=0`.
  - Luruna: `SUCCESS=1`, `FAILED=0`.
  - Sa Pedrera: `SUCCESS=32`, `BLOCKED=78`, `FAILED=0`.
  - Baco: `SUCCESS=41` histórico antes del rollback; hoy Winerim está desactivado.
  - Katsu y La Candela guardan ventas/cursor, pero no muestran stock `SUCCESS` en últimos 7 días; falta validar con venta real resuelta contra producto Winerim.
- El middleware actual NO llama a un endpoint específico de "ventas" de Winerim; la API local documentada solo expone stock (`PUT /api/v2/stock/{stockId}` y `PUT /api/v2/stock/bulk`). Hecho confirmado en `/Users/GOIKO/Downloads/API_TOKEN_V2_DOCUMENTATION.html`.
  - Hecho operativo garantizado: se guardan ventas en Lovable Cloud (`sales_events`/`sales_line_items`) y se descuenta stock Winerim por variante en `stock_sync_log`.
  - Hipótesis a validar con Winerim: si su UI de "Historial de ventas" muestra esos movimientos de stock o si requiere un endpoint adicional no documentado.

### Reparación visual/preparación Agora — Katsu, Kava, La Candela, Luruna y Sa Pedrera — 2026-06-01 07:12 CEST
- Se revisaron los vídeos/comentarios de Sa Pedrera: el problema visible era que productos Winerim aparecían como botones directos en el frontal y mezclaban la pantalla; el problema operativo probable de "no llega a barra" era que muchos productos Winerim tenían `PreparationTypeId`/`PreparationOrderId` vacíos.
- Backup operativo previo creado antes de escribir en Agora: `.codex-backups/agora-five-visual-prep-before-2026-06-01T04-54-51-409Z.json`.
- Se aplicó reparación directa en Agora, sin borrar productos ni histórico:
  - `UseAsDirectSale=false` para que no salgan como botones raíz.
  - `SaleableAsMain=true` para productos activos vendibles dentro de familia.
  - `PreparationTypeId`/`PreparationOrderId` configurados: Katsu `1/1`, Kava `1/1`, La Candela `1/5`, Luruna `1/1`, Sa Pedrera `1/1`.
  - Sa Pedrera se reubicó en familias legacy visibles por región/tipo (`T Rioja Navarra`, `T Ribera C.Leon`, `B Galicia`, `Champagnes`, `MAGNUMS`, etc.) en vez de dejar los vinos bajo las familias `... WINERIM` ocultas.
- Verificación final contra XML vivo de Agora tras cerrar la carrera de auto-update:
  - Katsu Izakaya: 85 productos Winerim detectados, 57 activos; `activeDirect=0`, `activeNotMain=0`, `activeMissingPrep=0`, `familyBlank=0`, cola abierta `AGORA_XML_UPSERT_PRODUCT=0`.
  - Kava: 232 detectados, 223 activos; `activeDirect=0`, `activeNotMain=0`, `activeMissingPrep=0`, `familyBlank=0`, cola abierta `0`.
  - La Candela de Triana: 79 detectados, 78 activos; `activeDirect=0`, `activeNotMain=0`, `activeMissingPrep=0`, `familyBlank=0`, cola abierta `0`.
  - Luruna: 125 detectados, 124 activos; `activeDirect=0`, `activeNotMain=0`, `activeMissingPrep=0`, `familyBlank=0`, cola abierta `0`.
  - Sa Pedrera: 416 detectados, 392 activos; `activeDirect=0`, `activeNotMain=0`, `activeMissingPrep=0`, `familyBlank=0`, cola abierta `0`.
- Se refrescó `agora_master_data` en Lovable Cloud para las cinco conexiones tras la reparación (`sync-master-data` OK en todas).
- Se actualizó configuración local de conexión para futuro:
  - `write_mode=XML_IMPORT`.
  - `default_preparation_type_id/default_preparation_order_id` informados según cada instalación.
  - `provider_capabilities` marcadas `READY/XML_IMPORT/YES` tras import real con HTTP 200.
  - Katsu queda con `auto_push_glass=false` para no crear copas masivas de golpe mientras su `write_glass` sigue false.
- Importante: `auto_push_verified_ready=false` quedó pausado temporalmente en Katsu, Kava, La Candela, Luruna y Sa Pedrera.
  - Razón: después de activar el automático, Lovable Cloud generó tareas `AUTO_UPDATE` con la Edge Function todavía desplegada en versión antigua; el `preview-xml` de Lovable Cloud seguía generando `UseAsDirectSale="true"` a `2026-06-01T05:13Z`.
  - Se cerraron como `SUCCESS` las tareas `AUTO_UPDATE` creadas en esa carrera tras aplicar la reparación por lote y verificar XML vivo.
  - El código corregido está subido a GitHub `main` en commit `81c7dbb` (`Fix Agora visual routing and preparation repair`), pero falta confirmar redeploy efectivo de Lovable Cloud antes de reactivar `auto_push_verified_ready`.
- Validación local del cambio de código:
  - `npm run build` pasa; solo warnings conocidos de Browserslist desactualizado y bundle grande.

### Hipótesis abiertas — 2026-06-01
- Si Lovable Cloud no redeploya el commit `81c7dbb`, reactivar `auto_push_verified_ready` puede reintroducir botones raíz porque el runtime actual aún genera `UseAsDirectSale=true`.
- Los productos Winerim reparados ya deberían llegar a barra al tener pareja de preparación; queda pendiente validación real en tablets/impresoras de barra tras refrescar/cerrar y abrir comandera.
- En Sa Pedrera, la reorganización regional usa reglas deterministas por `wine_type`, `country` y `region` de Winerim. Puede requerir ajuste fino si el cliente espera una región legacy distinta para algún vino concreto.

### Checklist operativo integraciones — 2026-06-01 06:26 CEST
- Se generó el informe de auditoría read-only `INTEGRATIONS_CHECKLIST_2026-06-01.md` con estado por conexión/proveedor, sin documentar credenciales.
- Lovable Cloud contiene 8 conexiones productivas registradas y todas son `agora`; no hay conexiones productivas registradas para BDP, Revo, Toast, Numier, Clover, Simphony, ICG, HIOPOS, TCPOS, Square, Cassa ni TouchBistro.
- Estado global actual:
  - 7 conexiones Agora activas.
  - 1 conexión deshabilitada: `Baco Getafe` por rollback legacy.
  - `export-master Families` responde HTTP 200 en Baco, Katsu, Kava, La Candela, Luruna, Cienvinos y Sa Pedrera.
  - `Sa Vida` sigue devolviendo HTTP 501 en `export-master Families`; debe tratarse como no operativa.
  - `stock_sync_log` no tiene fallos nuevos en 24h ni en 7 días; los `FAILED` restantes son históricos.
  - Cola outbound abierta global: `QUEUED=1870`, `FAILED=3633`, `BLOCKED=2063`, `RUNNING=0`.
- Hallazgos por conexión:
  - `Baco Getafe`: rollback correcto, Winerim deshabilitado; no reactivar sin nuevo piloto.
  - `Cienvinos`: activa y POS responde, pero sin ventas guardadas y con 85 tareas `QUEUED`.
  - `Katsu` y `La Candela`: ventas entran, pero `provider_capabilities` aparece `NOT_CONNECTED/NONE`; falta validar escritura/stock real.
  - `Kava`, `Luruna` y `Sa Pedrera`: ventas/stock tienen éxitos recientes, pero mantienen colas históricas abiertas y mappings pendientes/rechazados.
  - `Sa Vida`: activa en tabla pero bloqueada operativamente por HTTP 501 y cola muy grande; no procesar hasta resolver API REST/puerto/versión.

### Rollback Baco Getafe a legacy Agora — 2026-05-29 11:37 CEST
- A petición del usuario, se revirtió operativamente la integración Winerim de `Baco Getafe` y se dejó el TPV en modo legacy. Este estado sustituye al estado anterior donde Baco estaba activo con familias `... WINERIM`.
- No se borraron productos ni familias en Agora; todo se hizo por visibilidad/vendibilidad para conservar histórico y permitir volver atrás.
- Copias locales de seguridad creadas antes de los cambios:
  - `.codex-backups/baco-rollback-winerim-to-legacy-before-2026-05-29T08-31-53-116Z.json`.
  - `.codex-backups/baco-legacy-normalize-before-2026-05-29T08-44-26-592Z.json`.
  - `.codex-backups/baco-fix-legacy-frontal-before-2026-05-29T09-34-07-292Z.json`.
- Tras el primer rollback, el cliente confirmó que el estado no coincidía con el legacy real: los vinos no debían salir como botones sueltos en el frontal, sino dentro de la categoría `VINO`. Se corrigió usando `UseAsDirectSale=false` para productos legacy de vino.
- Resultado verificado contra Agora:
  - 118 productos Winerim siguen existiendo, pero 0 quedan visibles/vendibles.
  - 8 familias Winerim quedan ocultas (`TINTOS/BLANCOS/ROSADOS/ESPUMOSOS/DULCE/FORTIFICADOS/COPAS/MAGNUM WINERIM`).
  - 6 familias legacy quedan visibles y ordenadas bajo `VINO`: `FINOS`, `ROSADOS`, `TINTOS`, `CHAMPAGNE` y `BLANCOS` tienen `ParentFamilyId=2`; `VINO` queda como categoría raíz.
  - 348 productos legacy revisados: 0 quedan con `UseAsDirectSale=true`, por lo que no salen como botones directos en el frontal.
  - 195 productos legacy quedan vendibles dentro de su familia (`SaleableAsMain=true`) al estar en la lista legacy de rollback y no tener `DeletionDate`.
  - 0 productos legacy fuera de esa lista o con `DeletionDate` quedan visibles/vendibles, para evitar reactivar vinos antiguos que el cliente ya no vende.
- Resultado verificado en Lovable Cloud para la conexión `Baco Getafe` (`32f46d47-3984-413a-8c18-b5502418dadc`):
  - `enabled=false`.
  - `catalog_sync_enabled=false`.
  - `write_mode=NONE`.
  - `auto_push_on_create=false`.
  - `auto_push_on_update=false`.
  - `auto_push_verified_ready=false`.
- `winerim_push_tracking` de los productos Baco importados se marcó como `HIDDEN` con `last_error=rollback_to_legacy`, para que el estado local refleje que ya no están operativos en TPV.
- Nota operativa: Baco debe cerrar y reabrir la comandera/app de Agora si la tablet mantiene caché visual de botones. En backend y export Agora el rollback ya está aplicado.

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
  - Todos los productos Winerim importados tienen precios en price lists `1`, `2`, `3`, `VatId=3`, `PreparationTypeId=1`, `PreparationOrderId=1`.
  - Política visual corregida: `UseAsDirectSale=false` para que no salgan duplicados como botones raíz; `SaleableAsMain=true` para que sean vendibles dentro de sus familias WINERIM.
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
- Corrección por reporte de problemas en Baco — 2026-05-28:
  - Verificación directa contra Agora `export-master`: 118/118 productos Winerim presentes, 0 faltantes; 8 familias WINERIM visibles; familias legacy de vino ocultas.
  - Incidencia detectada: los 118 productos Winerim estaban presentes pero con `UseAsDirectSale=false` en el XML vivo de Agora, aunque `SaleableAsMain=true`.
  - Corrección aplicada con `set-product-visibility`: 118/118 productos Winerim actualizados a `UseAsDirectSale=true` y `SaleableAsMain=true`, sin tocar precios, familias, IVA ni stock.
  - Verificación posterior directa: 118 presentes, `notDirect=0`, `notMain=0`, `hiddenFamily=0`.
- Corrección por duplicado visual en Baco — 2026-05-28:
  - El cliente reportó que dentro de `TINTOS WINERIM` aparecía lo mismo que en la pantalla principal.
  - Causa: `UseAsDirectSale=true` hace que Agora muestre los productos también como botones directos en la pantalla raíz, además de dentro de la familia.
  - Corrección aplicada directamente en Agora: 118/118 productos Winerim con `UseAsDirectSale=false` y `SaleableAsMain=true`, reutilizando los elementos XML completos para no tocar precios/familias/IVA/stock.
  - Verificación posterior: 118 presentes, `directRootButtons=0`, `notSaleableAsMain=0`, `hiddenFamily=0`.
  - Backup local sin secretos: `.codex-backups/baco-winerim-direct-sale-before-2026-05-28T13-21-44-119Z.json`.
- Reporte `Tamaral Crianza copas` Baco — 2026-05-29:
  - Verificación en Winerim/Lovable Cloud:
    - `Tamaral Roble` (`winerim_id=163818`) tiene copa: `glass_sale_price=3.80`, `glass_stock_id=190387`, `serve_by_glass=true`.
    - `Tamaral` (`winerim_id=163823`, probable Crianza por histórico legacy) NO tiene copa en Winerim: `glass_sale_price=null`, `glass_stock_id=null`, `serve_by_glass=false`; solo botella y magnum.
    - `Tamaral Reserva` (`winerim_id=178798`) solo botella.
    - `Tamaral Verdejo` (`winerim_id=163820`) sí tiene copa.
  - Verificación directa en Agora:
    - Existe `C Tamaral Roble` / botón `C Tamaral Roble (RIBERA)` (`ProductId=863818`) en `COPAS WINERIM`, familia visible, `SaleableAsMain=true`, `UseAsDirectSale=false`.
    - Existe `C Tamaral Verdejo` (`ProductId=863820`) en `COPAS WINERIM`.
    - No existe `C Tamaral Crianza` porque Winerim no expone variante copa para `Tamaral`/Crianza.
    - El legacy `TAMARAL CRIANZA` (`ProductId=3538`) sigue oculto/no vendible en familia legacy `TINTOS`.
  - Cambio de código local: `generateImportXml` pasa a generar productos Winerim con `UseAsDirectSale=false` y `SaleableAsMain=true`, para conservar la política corregida de no duplicar productos en raíz en futuras importaciones.
  - Validación local: parse TypeScript de `agora-proxy` OK; `npm test -- --run src/test/agoraProductNaming.test.ts src/test/stockSyncUtils.test.ts` OK (13 tests).
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

### Sa Pedrera · piloto `DULCES WINERIM` D701-D709 — 2026-06-04 14:23 CEST

#### Hechos
- Se ejecutó una prueba controlada para publicar solo los dulces Winerim `D701-D709` en la familia Agora `903925`.
- La familia existía como `DULCE WINERIM` y estaba oculta (`ShowInPos=false`); quedó como `DULCES WINERIM`, visible (`ShowInPos=true`).
- Se publicaron 14 productos:
  - Botella: `D701`, `D702`, `D703`, `D704`, `D706`, `D707`, `D708`, `D709`.
  - Copa: `D701`, `D702`, `D703`, `D704`, `D705`, `D706`.
- `D705` solo se publicó como copa porque no tiene precio de botella.
- `D707` no se publicó como copa porque Winerim marca `serve_by_glass=false`, aunque exista `glass_sale_price` en cache.
- Verificación live por `export-master`: los 14 productos devuelven `FamilyId=903925` y nombre correcto.
- Se refrescó `agora_master_data` después de la importación: `1259` productos, `72` familias, `1` price list, sin warnings de truncado.
- `product_mappings` y `winerim_push_tracking` quedaron actualizados para los 14 productos; tracking `VERIFIED`.
- Informe específico: `SA_PEDRERA_DULCES_WINERIM_TRIAL_2026-06-04.md`.

#### Decisiones
- Se reutilizó la familia existente `903925` para evitar una familia duplicada.
- Orden operativo enviado: código Winerim `D701-D709`, con botella antes que copa cuando ambos formatos están activos.
- No se ocultó ni reubicó el residuo antiguo `712174` (`C D701-Valverán...`) porque no formaba parte de los formatos activos del piloto y tocarlo ampliaba el alcance.

#### Hipótesis / riesgos
- En esa primera prueba no se verificó `Product.Order`; la API solo se usó para confirmar familia/nombre, no el layout de tablet.
- Si la tablet no respetaba el orden enviado, había que identificar si mandaba `Product.Id`, caché local u otro campo/layout real de Agora.
- El commit `deaac47` añade una acción Edge específica para este piloto, pero Lovable Cloud seguía respondiendo `Unknown action` al probarla; falta confirmar redeploy efectivo.

#### Tareas pendientes inmediatas
- Pedir al cliente que abra `DULCES WINERIM` en una tablet y confirme familia única, contenido D701-D709 y orden visual.
- Si el orden visual no coincide, no reimportar masivamente: primero investigar el mecanismo real de orden/posición de botones Agora.
- Decidir con el cliente si las copas dulces deben convivir dentro de `DULCES WINERIM` o ir a una familia separada de copas.

### Sa Pedrera · corrección `DULCES WINERIM` por vídeo — 2026-06-04 16:31 CEST

#### Hechos
- Sa Pedrera envió vídeo indicando que dentro de `DULCES WINERIM` los vinos salían repetidos y no ordenados por numeración.
- Transcripción relevante: "te salen ya repetidos... East India sale dos veces y no salen colocados por la numeración".
- Diagnóstico:
  - Con la importación de aquel momento, la tablet seguía ordenando de forma compatible con `Product.Id`; todavía no se había validado el atributo real `Product.Order`.
  - El piloto anterior publicó botella+copa cuando existían ambas, por eso aparecían duplicados.
- Corrección aplicada:
  - un solo botón visible por código `D701-D709`;
  - copa si Winerim tiene `serve_by_glass=true`, botella como fallback;
  - IDs correlativos `903701-903709` para forzar orden visual.
- Estado final verificado:
  - `DULCES WINERIM` (`903925`) contiene 9 productos visibles;
  - `D701-D706` quedan como copa;
  - `D707-D709` quedan como botella;
  - 9/9 `SaleableAsMain=true`, `UseAsDirectSale=false`;
  - los 14 productos anteriores del piloto quedaron archivados/ocultos en `POSTRE WINERIM` (`907893`) con prefijo `ARCH`.
- `product_mappings` y `winerim_push_tracking` apuntan a los nuevos IDs visibles; tracking `VERIFIED`.
- Se refrescó `agora_master_data`: `1268` productos, `73` familias, sin warnings.
- Informe específico: `SA_PEDRERA_DULCES_WINERIM_ORDER_FIX_2026-06-04.md`.

#### Decisiones
- Para familias donde el cliente exige orden visual, usar IDs Agora correlativos por código comercial, no IDs derivados de `winerim_id`.
- Para evitar duplicados en la misma familia, publicar una sola variante visible por código; en dulces se prioriza copa activa.
- Aunque por formato las copas podrían pertenecer a `COPAS WINERIM`, por decisión operativa temporal se deja todo el piloto `D701-D709` dentro de `DULCES WINERIM` para validar primero orden visual y usabilidad con el cliente.

#### Hipótesis / riesgos
- La API confirma composición final, pero el cliente debe validar visualmente en tablet.
- Si el cliente pide también botella para `D701-D706`, no debe reintroducirse en la misma familia sin decidir otra estructura visual.
- Si más adelante se decide separar por formato, habrá que mover `D701-D706` a `COPAS WINERIM` de forma controlada y documentar el cambio de criterio.

#### Tareas pendientes inmediatas
- Pedir a Sa Pedrera que vuelva a abrir `DULCES WINERIM` y confirme que ve 9 botones en orden `D701-D709`.
- Si el orden aún no coincide, investigar más allá de `Product.Id`/familia: layout interno, cache de tablet o sincronización local Agora.

### Sa Pedrera · `DULCES WINERIM` altas nuevas no aparecían — 2026-06-05 11:52 CEST

#### Hechos
- Sa Pedrera confirmó que el orden visual ya está bien, pero reportó que vinos activados o añadidos en Winerim no aparecían en Agora.
- Capturas recibidas:
  - Winerim muestra `D710- Don PX 1993 Tº Albalá` y `D716-Lions de Suduiraut` activos.
  - Agora seguía mostrando solo `D701-D709` dentro de `DULCES WINERIM`.
- Diagnóstico:
  - El piloto anterior estaba acotado a `D701-D709`.
  - Sa Pedrera tiene `auto_push_on_create=true` y `auto_push_on_update=true`, pero `auto_push_verified_ready=false`, por lo que el auto-push general no publica nuevas altas.
  - Las reglas generales de routing de Sa Pedrera mandan postres a familias legacy (`Vino Dulce` / `Copa Vino Postre`), no a la pantalla validada `DULCES WINERIM`.
- Corrección aplicada en vivo:
  - Reimportada `DULCES WINERIM` (`903925`) con todos los `D###` activos de postre/dulce: `D701-D710` y `D716`.
  - `D710` queda como `B D710- Don PX 1993 Tº Albalá` (`903710`).
  - `D716` queda como `B D716-Lions de Suduiraut` (`903716`).
  - Inactivos excluidos: `D715-Pancaliente` y `D705-(MR) Mountain Wine`.
- Verificación:
  - 11/11 productos esperados en `FamilyId=903925`;
  - 11/11 `SaleableAsMain=true`;
  - 11/11 `UseAsDirectSale=false`;
  - `product_mappings` y `winerim_push_tracking` apuntan a los nuevos IDs `9037xx`;
  - `agora_master_data` refrescado: `1270` productos, `73` familias, sin warnings.
- Informe específico: `SA_PEDRERA_DULCES_WINERIM_DYNAMIC_SYNC_2026-06-05.md`.
- Código subido a GitHub en commit `1d62dc6`, pero prueba posterior contra Lovable Cloud sigue devolviendo `{"error":"Unknown action"}` para `sa-pedrera-dulces-winerim-trial`; el runtime desplegado aún no contiene la acción.
- Redeploy resuelto desde Lovable Cloud el 2026-06-05 12:20 CEST:
  - dry-run real de `sa-pedrera-dulces-winerim-trial` devuelve `plannedCount=11`;
  - códigos: `D701-D710` y `D716`;
  - IDs: `903701-903710` y `903716`.
- Tras dry-run correcto, se activó `auto_push_verified_ready=true` solo en Sa Pedrera.
- Estado post-activación:
  - `auto_push_on_create=true`;
  - `auto_push_on_update=true`;
  - `write_mode=XML_IMPORT`;
  - `provider_capabilities.can_write_products=YES`;
  - `readiness_status=READY`;
  - tareas abiertas `QUEUED/RUNNING/FAILED/BLOCKED=0`.

#### Decisiones
- La pantalla `DULCES WINERIM` debe sincronizar todos los `D###` activos de postre/dulce, no solo un rango fijo.
- Para Sa Pedrera + postre/dulce + código `D###`, el generador debe usar familia `903925` e IDs `903xxx` para conservar el orden visual validado.
- Activar `auto_push_verified_ready=true` en Sa Pedrera solo después de confirmar redeploy real con dry-run correcto.

#### Hipótesis / riesgos
- El automático queda habilitado, pero debe monitorizarse el siguiente ciclo de catálogo para confirmar que no reencola updates masivos.
- Si un futuro vino `D###` no tiene precio válido o está inactivo, no se publicará automáticamente.

#### Tareas pendientes inmediatas
- Confirmar con Sa Pedrera que ahora ve `D710` y `D716` dentro de `DULCES WINERIM`.
- Monitorizar el próximo cron de catálogo de Sa Pedrera: no debe crear backlog masivo y cualquier nuevo `D###` activo debe entrar en `DULCES WINERIM` con ID `903xxx`.
- Si aparecen tareas nuevas, revisar que sean solo `AUTO_CREATE`/`AUTO_UPDATE` diferenciales y no reimportación masiva.

### Kava · restaurar legacy `GENEROSOS` y `DULCES` — 2026-06-04 16:20 CEST

#### Hechos
- Kava pidió dejar visibles las familias legacy de postres/dulces y fortificados/generosos.
- Se restauraron solo dos familias Agora legacy:
  - `2069` · `GENEROSOS`
  - `2070` · `DULCES`
- Estado previo:
  - ambas familias estaban `ShowInPos=false`;
  - sus 15 productos estaban `SaleableAsMain=false` y `UseAsDirectSale=false`.
- Estado aplicado:
  - ambas familias quedan `ShowInPos=true`;
  - los 15 productos quedan `SaleableAsMain=true`;
  - los 15 productos mantienen `UseAsDirectSale=false`, por lo que no aparecen como botones raíz.
- Verificación posterior:
  - familias visibles: 2/2;
  - productos vendibles dentro de familia: 15/15;
  - productos directos en raíz: 0/15.
- Se refrescó `agora_master_data`: `1681` productos, `93` familias, sin warnings de truncado.
- Informe específico: `KAVA_LEGACY_DULCES_GENEROSOS_RESTORE_2026-06-04.md`.

#### Decisiones
- Se trató como restauración legacy operativa, no como integración Winerim.
- No se inventaron mappings Winerim ni se tocaron familias/productos Winerim.
- Se mantuvo `UseAsDirectSale=false` para preservar la política visual validada: vendible dentro de familia, sin duplicar en pantalla raíz.

#### Hipótesis / riesgos
- La mayoría de productos restaurados no tienen mapping Winerim confirmado. Dos tenían mapping `PENDING` fuzzy de baja calidad (`MOSCATEL LAUR4A` y `SICHEL SAUTERNES`).
- Las ventas desde estos legacy pueden no descontar stock en Winerim ni aparecer en historial Winerim hasta hacer mapping seguro o publicar equivalentes Winerim.

#### Tareas pendientes inmediatas
- Confirmar con Kava que visualmente ven `GENEROSOS` y `DULCES` como esperan.
- Si quieren que esas ventas descuenten stock Winerim, hacer mapping seguro producto a producto antes de declarar esos legacy integrados.

### Auditoria flota Agora y Sa Pedrera `TINTOS WINERIM` — 2026-06-09 05:30 CEST

#### Hechos
- Alcance auditado: todas las conexiones Agora salvo Sa Vida.
- Prueba viva `agora-proxy test`:
  - OK: Baco, Casa Nene, Katsu, Kava, La Candela y Sa Pedrera.
  - Fallo: Luruna (`No route to host`) y Cienvinos (timeout).
- Casa Nene:
  - `READY/XML_IMPORT/YES`, `292` productos Winerim, `0` direct-sale, `0` no vendibles.
  - La cola nueva de `20` tareas se proceso manualmente con dispatcher limitado a la conexion: `20/20 SUCCESS`, quedan `0 QUEUED/RUNNING/FAILED`.
  - Sigue pendiente primer cierre real con venta Winerim.
- Kava:
  - `20` lineas mapeadas y `20` descuentos stock `SUCCESS` en los ultimos 7 dias, `0` fallos recientes de stock.
  - Mantiene deuda antigua de cola (`7 FAILED`, `9 BLOCKED`) y fallos historicos de mayo.
- Sa Pedrera:
  - POS/master OK, `21` descuentos stock `SUCCESS` en los ultimos 7 dias, `0` fallos recientes.
  - Se volcaron `200` tintos activos Winerim a `TINTOS WINERIM` (`900157`), familia visible.
  - `199` productos Winerim existentes se movieron de familias regionales Winerim a `TINTOS WINERIM`; `1` producto nuevo creado: `T83` (`902083`).
  - Verificacion viva: `200/200` productos en `FamilyId=900157`, `UseAsDirectSale=false`, `SaleableAsMain=true`, `badCount=0`.
  - Snapshot de rollback: `SA_PEDRERA_TINTOS_WINERIM_APPLIED_2026-06-09.json`.
- Katsu:
  - POS y ventas OK, cola 0.
  - Ultimos 7 dias: `605` lineas candidatas de vino, `0` mapeadas, `0` descuentos stock.
- La Candela:
  - POS y ventas OK, cola 0.
  - Ultimos 7 dias: `546` lineas candidatas de vino, `0` mapeadas, `0` descuentos stock.
- Luruna:
  - No operativa ahora por conectividad (`No route to host`), aunque tenia master cache del 2026-06-08.
  - Ultimos 7 dias: `1` linea mapeada y `1` stock `SUCCESS`.
- Cienvinos:
  - No operativo ahora por timeout; conserva cache del 2026-06-08.
  - Quedan `68 QUEUED` y `4 BLOCKED`; sin ventas ni stock recientes.
- Baco:
  - Responde al test, pero esta en rollback legacy intencional (`enabled=false`, `write_mode=NONE`, auto-push off).

#### Decisiones
- No declarar la flota Agora como "perfecta": Katsu/La Candela necesitan mapping, Luruna/Cienvinos conectividad, Casa Nene primera venta y Baco esta apagado por decision.
- Para Sa Pedrera tintos no se crearon IDs nuevos `902###` de forma masiva porque `197/200` nombres ya existian en Agora y habrian duplicado/rechazado la importacion.
- Se conservaron IDs existentes de productos Winerim para no romper mappings, tracking ni historico; solo se movieron a `TINTOS WINERIM`.
- Se creo solo el producto no existente `T83` (`902083`).
- No se reintenta ni limpia en bloque la cola antigua de Sa Pedrera/Cienvinos/Luruna/Kava hasta clasificar causa y riesgo.

#### Hipotesis / riesgos
- En ese momento aún no estaba resuelto si Agora respetaba `Product.Order` o dependía de layout local/cache/IDs; había que verificar el orden real en tablet.
- En Katsu y La Candela, `is_wine_candidate` puede incluir falsos positivos, pero tambien aparecen vinos reales no mapeados; hace falta revision de mapping.
- Luruna y Cienvinos pueden estar bien configurados en Lovable Cloud pero no disponibles desde red publica en este momento.

#### Tareas pendientes inmediatas
- Pedir a Sa Pedrera validacion visual de `TINTOS WINERIM`: 200 tintos, orden `T1...T282`, sin duplicados no esperados.
- Si el orden no coincide, no reimportar masivamente: investigar si Agora usa layout local/cache de tablet u otro campo distinto de `Product.Order`.
- Revisar mappings Katsu y La Candela antes de prometer descuento de stock automatico.
- Recuperar conectividad Luruna y Cienvinos antes de drenar colas.
- Validar primer cierre Casa Nene con stock Winerim.

### Sa Pedrera familias Winerim dedicadas — 2026-06-09 17:20 CEST

#### Hechos
- Se amplio el piloto visual de Sa Pedrera a familias Winerim dedicadas sin ocultar el legacy regional del cliente.
- Familias Winerim visibles y verificadas por export real Agora:
  - `900157` `TINTOS WINERIM`: `200` productos esperados verificados, `badCount=0`.
  - `904241` `BLANCOS WINERIM`: `98` productos verificados, `badCount=0`.
  - `903516` `ROSADOS WINERIM`: `8` productos verificados, `badCount=0`.
  - `908875` `ESPUMOSOS WINERIM`: `43` productos verificados, `badCount=0`.
  - `908182` `FORTIFICADOS WINERIM`: `1` producto verificado, `badCount=0`.
  - `904289` `MAGNUM WINERIM`: `29` productos verificados, `badCount=0`.
  - `901954` `COPAS WINERIM`: `15` productos verificados, `badCount=0`.
  - `903925` `DULCES WINERIM` se mantiene del piloto anterior.
- Total snapshot aplicado: `394` productos esperados, todos con `UseAsDirectSale=false` y `SaleableAsMain=true`.
- Cola Sa Pedrera tras cierre: `0 QUEUED / 0 RUNNING`.
- `provider_config.family_structure_mode` queda en `WINERIM_DEDICATED_FAMILIES`.
- Se cambiaron las reglas de routing de Sa Pedrera desde familias regionales legacy a familias Winerim dedicadas.
- Se detecto bucle de auto-push: el runtime vivo seguia generando tandas `AUTO_CREATE` para productos ya verificados.
- Para proteger Agora, quedaron pausados temporalmente `auto_push_on_create=false` y `auto_push_on_update=false` solo en Sa Pedrera. Ventas y stock no dependen de estos flags.
- Duplicado no deseado `T83` con `ProductId=784242` quedo no vendible y mapping `REJECTED`; los productos canonicos son `902083` botella y `984242` copa.
- Extra legitimo en `TINTOS WINERIM`: `D207-Domaine Les Bruyeres 'Georges' Crozes-Hermitage` (`675360`), tinto activo real sin codigo `T###`.
- Artefactos:
  - `SA_PEDRERA_WINERIM_FAMILIES_2026-06-09.md`.
  - `SA_PEDRERA_WINERIM_FAMILIES_DRY_RUN_2026-06-09.json`.
  - `SA_PEDRERA_WINERIM_FAMILIES_APPLIED_2026-06-09.json`.
  - `SA_PEDRERA_PROVIDER_CONFIG_BEFORE_WINERIM_FAMILIES_2026-06-09.json`.
  - `SA_PEDRERA_AUTO_PUSH_FLAGS_BEFORE_PAUSE_2026-06-09.json`.

#### Decisiones
- Mantener legacy visible en Sa Pedrera por ahora; la accion solo consolida Winerim en familias dedicadas.
- Pausar temporalmente el auto-push de catalogo Winerim -> Agora hasta confirmar que Lovable Cloud ejecuta la guarda idempotente para `CREATE` ya verificados.
- No reactivar esos flags por intuicion: primero probar `evaluate-auto-push` con un vino ya verificado y comprobar que no crea tareas.

#### Riesgos
- Mientras los flags esten pausados, nuevas altas o cambios de precio/nombre en Winerim no subiran automaticamente a Agora en Sa Pedrera.
- Rehabilitar auto-push sin confirmar deploy puede recrear tandas de `AUTO_CREATE` y volver a tocar Agora cada ciclo.
- La validacion API no prueba orden visual de tablet; el cliente debe revisar pantalla real.

#### Tareas pendientes inmediatas
- Confirmar visualmente con Sa Pedrera que las familias Winerim se ven bien y que `T83` no aparece duplicado.
- Confirmar si aceptan `D207` dentro de `TINTOS WINERIM` o si quieren pantalla estricta `T###`.
- Confirmar deploy efectivo de `agora-proxy` con la guarda `create_skipped:formats_already_verified`.
- Si el deploy esta activo, reactivar `auto_push_on_create/update` y verificar que no nacen tareas repetidas.
- Hacer venta de prueba botella + copa Winerim y validar `sales_line_items.mapped=true` + `stock_sync_log.SUCCESS`.

## Hipótesis abiertas
- Jardí (2026-06-18): el cliente reporta que se ha descontado una venta y no aparece en Winerim, pero la auditoría viva muestra `stock_sync_log=0`; por tanto no consta ningún descuento de stock enviado a Winerim para Jardí. Sí hay ventas importadas hasta business day `2026-06-17`, pero todas las líneas están `mapped=false` (`2386/2386`), porque las ventas leídas corresponden a botones legacy de Agora con IDs bajos y no a productos Winerim importados.
- Jardí (2026-06-18): el catálogo Winerim vivo devuelve `175` vinos y la caché local tiene los mismos `175`. Hay `170` formatos activos/preciados esperados y los `170` existen en Agora; no se detectan formatos Winerim READY ausentes. El único vino creado después del 2026-06-17 detectado es `Anais Blanc Organic`, visible como `B Anais Blanc Organic` en `BLANCOS WINERIM` y `C Anais Blanc Organic` en `COPAS WINERIM`.
- Jardí (2026-06-18): `fetch-catalog` devuelve `newWines=0`, `changedWines=2`, `detailRequestsFailed=0`. Como `auto_push_on_update=false`, los cambios sobre vinos existentes no se publican automáticamente, pero las altas nuevas sí deben entrar por `CREATE` si aparecen como inéditas y tienen precio/formato publicable.
- Jardí (2026-06-18): `last_catalog_sync_at` seguía `null` aunque `fetch-catalog` funcionaba; se corrige para marcar la fecha al completar un recorrido entero de catálogo Winerim.
- Resiliencia extendida cubre el caso de saturación si el cliente reabre el problema. Falta validar en producción real con BDP/Revo/Toast/Numier/ICG (todavía sin clientes activos saturando).
- 7 días sin incidente Agora aún por confirmar (llevamos ~1 día).
- La doble rama `auto-sync-sales` puede explicar discrepancias entre intención de near-real-time y comportamiento real D-1: la rama intradía está inalcanzable.
- Resuelto el 2026-06-17: el atributo persistente/exportado para ordenación de producto Agora es `Product.Order`; `SortOrder` no debe usarse.
- La documentación Winerim v2 puede estar por delante o detrás del despliegue productivo real; especialmente `PUT /stock/bulk` debe probarse con token real antes de migrar el cron de stock.
- `PUT /stock/bulk` sigue sin activarse en automático hasta comprobar con token real que producción devuelve JSON y `errors[]` como indica la documentación.
- `Product.Order` quedó probado en Sa Pedrera con import XML y verificación viva `438/438` OK; queda pendiente solo la validación visual del cliente en tablet.
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

## 2026-07-11 · Agora: piloto de ventas casi en tiempo real y auditoría de flota

### Hechos
- Se activó `intraday_sales_sync_enabled=true`, `open_tickets_sync_enabled=true`, `open_tickets_stock_sync_enabled=true` y `open_tickets_min_line_age_minutes=2` en conexiones Agora activas cuyo endpoint de tickets respondió correctamente: Casa Nene, Chiquilla, El Bejeque, Katsu Izakaya, Kava, Luruna, Restaurante Cienvinos Ecija, Restaurante Qtomas, Restaurante Triana, Sa Pedrera y Sa Vida.
- No se activó el piloto en Jardí porque `eljardiparets.ddns.net:8984` devuelve `NETWORK_UNREACHABLE / No route to host` desde backend. Tampoco se activó en conexiones deshabilitadas o en modo lectura/pausadas: Baco Getafe, Don Bernardo Ponzano, Don Bernardo Santander, La Candela de Triana y PurOsushi.
- El dispatcher manual `sales-stock` procesó la flota con `dispatched=33` y `skippedByPreflight=1` (Jardí).
- Sa Pedrera ya captura tickets abiertos: se detectaron 3 tickets abiertos con 43 líneas; 2 movimientos de stock Winerim se registraron correctamente y 1 falló por venta de un vino inactivo/inaccesible (`B310- Albenc`, Winerim `296314`).
- Casa Nene capturó ticket abierto y registró stock correctamente (`B Pepe Luis [botella]`, Winerim `260865`).
- Cienvinos captura tickets abiertos y ventas intradía; el stock no se movió en la muestra porque las líneas abiertas no resolvían vino Winerim o no requerían stock.
- Kava y Luruna conectan, pero tienen fallos vivos de stock por vinos que Winerim devuelve como `404 Wine not found/not accessible`.
- Se publicaron en GitHub dos commits:
  - `3917045` fuerza reconciliación incremental de stock cuando `open_tickets_sync_enabled` está activo, evitando doble descuento al cerrarse después la factura.
  - `89c5950` endurece lectura de respuestas de importación Agora para que una respuesta truncada/vacía no deje tareas de ocultación bloqueadas con `unexpected end of file`.
- El despliegue CLI desde esta máquina no fue posible porque falta token de acceso de Lovable Cloud; el código está en `main`, pero necesita redeploy de `agora-proxy`.

### Decisiones
- Para todas las conexiones Agora con tickets disponibles, el piloto de "tiempo real" se basa en `/api/export/tickets/` + reconciliación incremental, no en mutar stock dos veces.
- El histórico de facturas cerradas sigue siendo la fuente de reconciliación definitiva. Si el TPV cae, al volver debe recuperarse la venta cerrada por `Invoices`; los estados transitorios de tickets abiertos no se garantizan si el servidor estuvo inaccesible durante ese intervalo.
- Un vino inactivo, sin precio o con variante ya no publicable debe quedar oculto también a nivel producto, no solo a nivel familia. Si vuelve a estar activo y con precio, debe volver a publicarse por el flujo normal de upsert.

### Hipótesis
- En Sa Pedrera, el caso reportado de copas no visibles no parece ser un problema de cola para `Sanger Voyage 360`: existen mappings `BOTTLE` y `GLASS` confirmados y se re-publicó el producto. Puede quedar una discrepancia de cache/visual de terminal o de verificación contra `export-master`.
- Los 404 de Kava (`CLOE Chardonnay`, `Luis Alegre Crianza`) y Luruna (`CAMPILLO 2021 CRIANZA`) apuntan a stock/acceso Winerim o mapping antiguo, no a caída de Agora.
- Jardí probablemente tiene un problema externo de red/DDNS/router/puerto, porque la conexión cerrada reciente funcionaba pero el endpoint de tickets no enruta desde backend.

### Riesgos
- Mientras no se despliegue `89c5950`, las tareas `AGORA_HIDE_PRODUCT` pueden seguir quedando bloqueadas si Agora aplica el cambio pero devuelve cuerpo incompleto.
- Muchas conexiones tienen `auto_push_on_update=false`; por tanto altas nuevas pueden subir, pero cambios de precio, inactivaciones o retirada de precio pueden no propagarse automáticamente en esas conexiones hasta activar una política diferencial segura.
- `provider_products` puede no reflejar algunos productos que `winerim_push_tracking` marca como `VERIFIED`; hay que endurecer la validación de "formato ya verificado" para evitar falsos positivos visuales.

## 2026-07-11 · Nuevas integraciones Agora creadas en modo seguro

### Hechos
- Se crearon filas `pos_connections` para nuevas integraciones Agora que faltaban en Lovable Cloud:
  - `Saddle` (`f4387c78-7b5b-4f8b-845d-0db6636660a1`)
  - `El Higuerón` (`c2e41778-fd14-4a83-9b24-d4fd305fe490`)
  - `Tintorera` (`1efe95c0-5fb7-404f-9947-416eed598a46`)
  - `O Bistro` (`c0b4b35b-bce8-4927-9134-e23045cf7dcd`)
  - `Taberna de Elia` (`ae599bfb-d580-4250-9661-a97535d25e85`)
- Todas se crearon con `auto_push_on_create=false`, `auto_push_on_update=false`, `auto_push_verified_ready=false`, `write_mode=NONE` y política de legacy visible. No se ocultó legacy ni se subieron familias Winerim.
- `Taberna de Elia` quedó activa en lectura (`enabled=true`, `sync_mode=PULL_ONLY`, `write_mode=NONE`):
  - test Agora OK;
  - master data OK: `117` familias, `2.940` productos, `17` centros de venta;
  - catálogo Winerim enriquecido completo: `365` vinos, `365/365` detalles correctos;
  - ventas cerradas importadas en lectura: `24` días, `371` facturas/eventos, `4.303` líneas; `resolvedLines=0` porque aún no hay matching confirmado contra Winerim.
- `Saddle` responde desde la máquina local a `tickets`, `export-master` e `Invoices`, pero desde backend las llamadas abortan (`AbortError`). No se activó.
- `El Higuerón` devuelve `401` con la clave facilitada. No se activó.
- `Tintorera` no responde dentro de timeout local (`connection timed out`). No se activó.
- `O Bistro` usa IP privada `192.168.1.22`; Lovable Cloud/backend no puede acceder a esa red sin URL externa, DDNS o VPN. No se activó.
- `Don Quijote Marbella` sigue sin conexión creada porque no hay URL/API token/token Winerim localizados en el contexto operativo.

### Decisiones
- Empezar todas estas altas en modo lectura/validación. No se publica Winerim ni se toca el legacy hasta validar estructura visual, matching y prueba de venta.
- Mantener Taberna de Elia en lectura aunque ya importe ventas, porque existe decisión previa de no hacer volcado directo por matching incompleto y estructura `Bodega` muy trabajada.

### Hipótesis
- Saddle puede estar filtrando o degradando tráfico desde la red de Lovable Cloud/backend aunque responda desde la red local del operador.
- El Higuerón probablemente tiene clave API incorrecta, caducada o el módulo HTTP activo con otra clave.
- Tintorera puede tener TPV apagado, DDNS/puerto caído o firewall bloqueando.

### Tareas pendientes inmediatas
- Saddle: pedir a SAT un DDNS/URL alternativa o revisar firewall/ruta desde Lovable Cloud/backend; repetir `sync-master-data` cuando responda.
- El Higuerón: pedir confirmación literal de clave API HTTP y que prueben `GET /api/export/tickets/` con esa clave.
- Tintorera: pedir al cliente/SAT confirmar TPV encendido, DDNS `tintorera.dyndns.org`, router/firewall y puerto `8984`.
- O Bistro: pedir URL externa o DDNS; la IP `192.168.1.22` solo sirve dentro del local.
- Don Quijote Marbella: solicitar URL servidor Agora, clave API HTTP y token Winerim.
- Taberna de Elia: preparar revisión de matching legacy vs Winerim antes de activar stock o publicar catálogo.

## 2026-07-11 · El Bejeque: legacy de vinos ocultado de forma reversible

### Hechos
- Se inspeccionó El Bejeque directamente contra Agora (`https://elbejeque.infogral.es`) porque Lovable Cloud/backend devolvía timeouts/522 en la consulta de control.
- Antes del cambio, las familias Winerim estaban visibles:
  - `TINTOS WINERIM`: 39 productos, 39 vendibles.
  - `COPAS WINERIM`: 21 productos, 20 vendibles.
  - `ROSADOS WINERIM`: 3 productos, 3 vendibles.
  - `DULCE WINERIM`: 6 productos, 6 vendibles.
  - `BLANCOS WINERIM`: 16 productos, 14 vendibles.
  - `MAGNUM WINERIM`: 6 productos, 6 vendibles.
  - `FORTIFICADOS WINERIM`: 2 productos, 2 vendibles.
  - `ESPUMOSOS WINERIM`: 8 productos, 8 vendibles.
- Se ocultó el legacy visible de vino a nivel familia (`ShowInPos=false`):
  - `29 · VINOS`
  - `30 · BLANCOS`
  - `31 · TINTOS`
  - `32 · ESPUMOSO`
  - `33 · POSTRE`
  - `34 · FORTIFICADO`
  - `35 · ROSADO`
- Se dejó no vendible el producto legacy dentro de esas familias (`UseAsDirectSale=false`, `SaleableAsMain=false`) para cumplir la regla de no ocultar solo la familia:
  - `104 · ALEXANDER VS. THE HAM FACTORY`
  - `105 · 62 MILLAS`
  - `114 · BHILAR BIODINÁMICO`
  - `152 · RAMÓN BILBAO EARLY HARVEST ROSADO`
  - `158 · PIU ANCESTRAL PARRONA`
  - `161 · DEMORADO`
  - `1226 · DOSTERRAS BLANC`
- Verificación posterior contra `export-master`:
  - legacy visible: `0` familias;
  - productos legacy vendibles: `0`;
  - familias Winerim siguen visibles y con productos.

### Decisiones
- Ocultar legacy de El Bejeque sin borrar familias ni productos. El rollback es reactivar `ShowInPos` de las familias legacy y `UseAsDirectSale/SaleableAsMain` de los productos legacy necesarios.

### Hipótesis
- La caché `agora_master_data` de Lovable Cloud puede quedar temporalmente desactualizada porque la acción se aplicó por API directa de Agora al estar Lovable Cloud/backend con timeout/522.

### Tareas pendientes inmediatas
- Cuando Lovable Cloud/backend responda, ejecutar `sync-master-data` para El Bejeque y confirmar que la caché interna refleja legacy oculto.
- Pedir al cliente una prueba visual en TPV/tablet y una venta real desde botón Winerim para confirmar historial/stock.

## 2026-07-11 · Abadía Yuste: credenciales recibidas y precheck externo OK

### Hechos
- Se recibieron credenciales para integrar `Abadía Yuste` con Agora y Winerim.
- No se guardan tokens en documentación de sesión; quedan solo en el contexto operativo de la conversación.
- Precheck directo contra Agora (`http://abadiayuste.cctvddns.net:8984`) con la clave facilitada:
  - `/api/export/tickets/`: HTTP 200, `7` tickets abiertos detectados.
  - `/api/export-master/?filter=Families`: HTTP 200.
  - `/api/export-master/?filter=Products`: HTTP 200, catálogo grande (`2.423` productos).
  - `/api/export/?business-day=2026-07-10&filter=Invoices`: HTTP 200, `4` facturas detectadas.
- Precheck directo contra Winerim API v2 con el token facilitado:
  - `/api/v2/wines?page=1&limit=100`: HTTP 200.
  - Catálogo Winerim: `264` vinos (`3` páginas).
- Estructura Agora observada:
  - `108` familias.
  - `2.423` productos.
  - `2.180` productos vendibles.
  - Familias de vino/DO detectadas, muchas ya ocultas: `Vinos`, `Botellas Vino`, `Tierra de extremadura`, `D.O. Rioja`, `D.O. Ribera del Duero Robles`, `D.O. Ribera del duero Grandes vinos`, `D.O. Otros`, `D.O. Blancos`, `Cavas y champagnes`, `APERITIVOS CAVAS Y CHAMPAGNES`, `BLANCOS DE AQUI Y DE ALLI`, `TINTOS DE AQUI Y DE ALLI`, `BLANCOS Y TINTOS DE OTRO NIVEL`, `VINOS DE POSTRE`, entre otras.
- Bloqueo actual: Lovable Cloud/backend devuelve HTTP `522` persistente en REST y Edge Functions; no se pudo crear todavía la fila `pos_connections` ni lanzar `sync-master-data` desde backend.

### Decisiones
- No hacer escrituras directas en Agora para Abadía Yuste mientras no exista conexión registrada en Lovable Cloud y no se haya validado estructura/matching desde el middleware.
- Preparar el alta en modo seguro cuando Lovable Cloud vuelva: `enabled=false` o lectura controlada, `write_mode=NONE`, auto-push apagado y legacy visible.

### Hipótesis
- La integración es técnicamente viable: Agora responde desde fuera, Winerim token es válido y hay endpoint de tickets abiertos para piloto casi en tiempo real.
- La estructura de vinos de Agora está trabajada por DO/región; puede requerir matching o decisión explícita antes de ocultar legacy y publicar familias Winerim.

### Tareas pendientes inmediatas
- Reintentar alta en `pos_connections` cuando Lovable Cloud/backend deje de devolver `522`.
- Tras crear conexión: ejecutar `agora-proxy/test`, `sync-master-data`, `probe-open-tickets`, `find-last-business-day`.
- Ejecutar `winerim-proxy/fetch-catalog` start + enrich completo.
- Preparar informe de familias legacy vs Winerim antes de publicar familias Winerim u ocultar legacy.

## 2026-07-13 · Agora: preservar hora real de venta en líneas y sales/import

### Hechos
- Se confirmó que Winerim API v2 tiene `POST /api/v2/sales/import` y que ese endpoint registra ventas sin modificar stock.
- Se añadió migración `20260713073627_add_agora_provider_sold_at_to_sales_lines.sql`:
  - `sales_line_items.provider_sold_at timestamp without time zone`
  - `sales_line_items.provider_sold_at_source text`
  - índice por `(connection_id, provider_sold_at)`.
- `agora-proxy` ahora extrae la hora original de Agora desde `line.CreationDate` como prioridad, con fallback a campos de item/documento y finalmente al business day.
- Los flujos que guardan ventas (`sync-open-tickets`, backfill analítico, `save-sales`, `sync-intraday-sales`, `auto-sync-sales`) persisten `provider_sold_at` y su fuente.
- Cuando `PUT /stock/{stockId}` no mueve inventario y se llama al fallback `sales/import`, el `soldAt` enviado a Winerim usa `provider_sold_at` si existe.
- Se implementó la separación explícita de endpoints por `stockActive` de la variante Winerim:
  - `stockActive=true`: se mantiene `PUT /api/v2/stock/{stockId}` para descontar stock absoluto;
  - `stockActive=false`: se usa directamente `POST /api/v2/sales/import` para registrar venta/historial sin modificar unidades;
  - `stockActive` acepta booleanos, números (`1/0`) y strings (`true/false`, `yes/no`, `si/no`) y por defecto conserva el comportamiento anterior (`true`) si Winerim no envía el campo.
- El panel `AgoraWizard` queda alineado con la regla backend de copas: para publicar COPA basta `glass_sale_price > 0`; `serve_by_glass=false` queda como aviso informativo, no bloqueo duro.
- Validación local:
  - `npx tsc --noEmit` OK.
  - Bundle `agora-proxy` con esbuild OK.
  - Checks estáticos Node OK: un solo `req.json()`, sin llamadas directas a `export-master Products` fuera de caché, presencia de `provider_sold_at` y tres ramas `stockActive=false` por los tres flujos de stock.
  - `vitest` queda colgado antes de ejecutar assertions incluso en tests individuales; se abortó con wrapper local y queda como verificación pendiente del runner, no como fallo de compilación.
  - `npm run build` queda colgado en `vite build` sin salida adicional; se abortó localmente. `tsc` sí valida el front TypeScript.

### Decisiones
- Guardar la hora de Agora como `timestamp without time zone` para preservar la hora local del restaurante y evitar desplazamientos UTC en historiales.
- No llamar siempre a `sales/import` además de `PUT /stock`, porque Winerim documenta que bajar stock mediante `PUT /stock/{stockId}` ya puede crear historial de venta y se podría duplicar.
- Tratar `stock desactivado` distinto de `stock activo a 0`: el primero no debe mutar inventario nunca; el segundo intenta `PUT /stock` y usa `sales/import` solo si no hay movimiento real.

### Hipótesis
- Las horas visibles raras (`00:00`, `02:00`, `06:35`, `08:55`) vienen de mezclar rutas: importación sales-only, efecto lateral de stock, sync nocturno o interpretación de hora por Winerim. Con `provider_sold_at` se podrá auditar cada caso contra la hora real de Agora.
- Para ventas con stock activo, si Winerim genera historial únicamente desde `PUT /stock/{stockId}`, hará falta que Winerim acepte `soldAt` en ese endpoint o que provea un endpoint combinado stock+venta para mostrar la hora real sin duplicar.

### Tareas pendientes inmediatas
- Aplicar primero la migración en Lovable Cloud y después desplegar `agora-proxy`.
- Repetir prueba controlada en Sa Pedrera:
  - venta de botella/copa con `stockActive=true`, comprobar descuento e historial;
  - venta de botella/copa con `stockActive=false`, comprobar `sales_only_stock_inactive`, historial y stock sin cambios;
  - comparar `provider_sold_at`, `stock_sync_log.winerim_response` y hora visible en ERP Winerim.
- Pedir a Winerim API soporte para `soldAt` en el flujo que descuenta stock o endpoint combinado si el historial por `PUT /stock` sigue mostrando hora de proceso.
- Cuando el backend deje de devolver 522, auditar restaurante por restaurante: Agora `CreationDate` vs `sales_line_items.provider_sold_at` vs ERP `/sales`.
  - `Restaurante Qtomas`: bloqueado temporalmente por conectividad `POS_DOWN` durante import XML; las `60` tareas quedan en `QUEUED` con `next_retry_at` igual al fin del breaker para recuperación automática.

## 2026-07-13 · El Higuerón: revalidación de integración

### Hechos
- Conexión existente en `pos_connections`: `El Higuerón` (`c2e41778-fd14-4a83-9b24-d4fd305fe490`).
- Estado de la conexión: `enabled=false`, `write_mode=NONE`, `sync_mode=PULL_ONLY`, auto-push desactivado y legacy visible por seguridad.
- La clave API HTTP guardada coincide literalmente con la clave facilitada para Agora; no hay espacios ni diferencias de formato.
- Revalidación contra Agora `http://vpn1.provisa.net:8984`:
  - `/api/export/?business-day=2026-07-13&filter=Invoices`: HTTP `401`;
  - `/api/export/tickets/`: HTTP `401`;
  - `/api/export-master/?filter=Families`: HTTP `401`;
  - `/api/export-master/?filter=Products`: HTTP `401`.
- Revalidación contra Winerim API v2 con el token facilitado: HTTP `200`, catálogo accesible.

### Decisiones
- No activar la integración, no publicar familias Winerim y no activar ventas hasta recibir una clave API HTTP válida de Agora.
- Mantener la conexión preparada en modo seguro para poder retomar rápido cuando el SAT/cliente corrija la clave o permisos.

### Hipótesis
- El fallo no parece red/puerto porque el host responde rápido; el bloqueo es de credencial/permisos del módulo API HTTP de Agora.

### Tareas pendientes inmediatas
- Pedir al SAT/cliente que confirme una nueva clave API HTTP literal y que el módulo/API HTTP de Agora esté activo para `Export`, `Products` y lectura de ventas.
- Tras nueva clave: actualizar credencial, ejecutar `agora-proxy/test`, `sync-master-data`, `probe-open-tickets`, `find-last-business-day` y `winerim-proxy/fetch-catalog` antes de cualquier escritura.
## 2026-07-14 - Ocultacion legacy solicitada en seis instalaciones Agora

### Hechos
- Se aplico ocultacion reversible, sin borrar datos, y se refresco `sync-master-data` contra las seis instalaciones.
- `Chiquilla`: ya estaba completada; legacy visible `0` familias / `0` productos vendibles, `77/77` formatos Winerim activos con precio presentes y cola abierta `0`.
- `Kava`: se ocultaron los dos botones residuales `99010 TEST Espumosos` y `16 Vinos`; los productos legacy de vino ya estaban no vendibles. Se preservo `2080 Cocteles` por no ser una familia de vino.
- `Restaurante Jardi`: las familias legacy de vino ya estaban ocultas; se dejaron no vendibles los cuatro botones genericos de vino `388-391` dentro de la familia mixta `BEGUDES`. Se preservaron las bebidas y los tres elementos no vinicolas revisados.
- `Sa Pedrera`: no quedaban familias legacy de vino visibles. El producto Winerim `597995 B MAGNUM 32 - Morgon`, que aun apuntaba a la familia antigua oculta `30`, se reasigno a `904289 MAGNUM WINERIM`; cola final `0`.
- `Sa Vida`: se oculto la familia antigua real `95 VINOS` y se dejaron no vendibles sus 16 productos `978-993`. Las familias geograficas con IDs Winerim se preservaron porque contienen productos generados desde Winerim y no son legacy.
- `Taberna de Elia`: ya estaba completada; legacy visible `0` familias / `0` productos vendibles, `412/412` formatos Winerim activos con precio presentes y cola abierta `0`.
- En las seis conexiones se guardo `provider_config.legacy_visibility_policy=HIDDEN_REVERSIBLE` con alcance y fecha de verificacion.

### Verificacion
- Las seis instalaciones respondieron HTTP 200 a `sync-master-data` despues del cambio.
- No quedo ninguna tarea `QUEUED` o `RUNNING` en estas seis conexiones.
- Snapshots de rollback: `outputs/CHIQUILLA_LEGACY_HIDE_SNAPSHOT_2026-07-14.json`, `outputs/KAVA_LEGACY_HIDE_SNAPSHOT_2026-07-14.json`, `outputs/KAVA_LEGACY_FINAL_CLEANUP_2026-07-14.json`, `outputs/JARDI_LEGACY_HIDE_SNAPSHOT_2026-07-14.json`, `outputs/SA_PEDRERA_LEGACY_CLEANUP_SNAPSHOT_2026-07-14.json`, `outputs/SA_VIDA_LEGACY_HIDE_SNAPSHOT_2026-07-14.json` y `outputs/TABERNA_DE_ELIA_LEGACY_HIDE_SNAPSHOT_2026-07-14.json`.

## 2026-07-14 · Yurest V2 · acceso real y base read-only para Blasco

### Hechos
- Se validaron las credenciales de usuario y el token V2 contra `POST /v2/auth/login`: HTTP `200`.
- El local objetivo se identificó como `Jenkin’s - Blasco Ibañez`, `store_id=2054`.
- Almacenes: `8394 COCINA` activo; `8398 Cocina principal` y `8399 Barra principal` inactivos.
- Lecturas reales:
  - `2.906` productos activos globales;
  - `3.032` registros globales de coste;
  - `536` productos con coste en Blasco;
  - `216` con precio de compra, `263` con coste de ficha y `1` con coste de receta;
  - `161` proveedores y `3.674` productos de proveedor;
  - último inventario de Blasco `2026-06-30 22:28:50`, con `347` líneas.
- El usuario master ve costes de `18` locales, así que no se puede consumir ninguna respuesta sin filtrar `store_id=2054`.
- Bloqueos reales:
  - `GET /v2/stores`: HTTP `403`;
  - `GET /v2/delivery-notes`: HTTP `403`;
  - `GET /v2/stock`: HTTP `500`, también al acotar por almacén válido;
  - `GET /v2/stock/movements`: HTTP `500`;
  - `GET /v2/bills`: HTTP `500`.
- Se implementaron cliente y proxy Yurest de solo lectura, con renovación Bearer, secretos fuera de base de datos y aislamiento de local.
- Las lecturas globales de catálogo/proveedores quedan bloqueadas por defecto en el proxy y requieren habilitación explícita.
- Verificación local: `36/36` tests, `npx tsc --noEmit`, build Vite y lint de los archivos Yurest nuevos OK. No hay `deno` instalado localmente para ejecutar `deno check`.

### Decisiones
- Mantener Agora como fuente de ventas/PVP, Yurest como fuente futura de compras/stock/coste y Winerim como fuente de catálogo hacia Agora.
- No desplegar ni activar sincronización Yurest hasta que los endpoints de stock/movimientos respondan y se confirme el alcance exacto del local.
- No guardar credenciales Yurest en `pos_connections.api_token` ni `provider_config`; usar secretos de Lovable Cloud referenciados por nombre.

### Hipótesis
- Los HTTP `500` parecen un fallo o incompatibilidad del backend V2 de Yurest, no de autenticación, porque catálogo, costes, proveedores e inventarios responden con la misma sesión.
- Los HTTP `403` corresponden a scopes/permisos ausentes del token o del usuario.

### Tareas pendientes inmediatas
- Enviar a Yurest la matriz de endpoints y pedir permisos de locales, stock, movimientos, albaranes y facturas.
- Pedir endpoint V2 para listar pedidos de compra existentes; la OpenAPI actual solo documenta crear y consultar uno por ID.
- Confirmar que solo se integra `store_id=2054` y acordar identificador estable Yurest ↔ Winerim para vinos.
- Cuando Yurest responda: configurar secretos, crear conexión en modo `read_only`, desplegar `yurest-proxy` y ejecutar dry-run sin escrituras.
