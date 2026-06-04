# NEXT_STEPS

> Tareas pendientes priorizadas. Al retomar: leer este archivo + `CURRENT_STATE.md`.

## P0 — Auditoría flota Agora 2026-06-04
- [x] Ejecutar auditoría read-only contra Lovable Cloud y endpoints Agora vivos.
- [x] Confirmar que todas las conexiones productivas registradas son Agora; el resto de providers existen en código/wizards pero no tienen conexión viva auditable.
- [x] Confirmar conectividad: `Katsu`, `Kava`, `La Candela`, `Luruna`, `Cienvinos` y `Sa Pedrera` responden catálogo/facturas; `Baco` responde pero está desactivado; `Sa Vida` sigue en HTTP 501.
- [x] Detectar que `Cienvinos` tiene las 8 familias Winerim ocultas aunque sus 428 productos Winerim estén vendibles dentro de familia.
- [x] Confirmar que `Baco` está efectivamente en rollback legacy: Winerim oculto/no vendible y legacy visible/vendible.
- [x] Confirmar que `Sa Pedrera` sigue híbrida: familias legacy/regionales visibles y mappings parciales; no es instalación "solo Winerim".
- [x] Confirmar stock reciente real solo donde hay logs `SUCCESS`: `Kava` copa+botella, `Luruna` botella, `Sa Pedrera` botella; el resto necesita venta/cierre de prueba.
- [x] Reparar `Cienvinos` con cambio mínimo: poner visibles las 8 familias `... WINERIM`, sin tocar precios, productos, IVA, preparación ni stock; verificado después `familias visibles=8`, `directSale=0`, `notSaleableAsMain=0`, `prepMismatch=0`.
- [x] Preparar rollback de la reparación Cienvinos: volver a `ShowInPos=false` en esas 8 familias si el cliente reporta impacto visual (`900157`, `901954`, `903516`, `903925`, `904241`, `904289`, `908182`, `908875`).
- [ ] Ejecutar venta/cierre de prueba por conexión para `Katsu`, `La Candela`, `Luruna` y `Cienvinos` con una botella y una copa Winerim cuando existan; validar `stock_sync_log.variant`, `stock_id`, `idempotency_key`, `SUCCESS`.
- [ ] En `Sa Pedrera`, revisar los `20 PENDING` y `58 REJECTED` actuales antes de prometer descuento de todo el legacy; priorizar copas con bloqueo terminal.
- [x] Resetear breakers/fallos obsoletos en conexiones que ya responden 200 después de una sonda controlada por conexión; no se reseteó `Sa Vida`.
- [ ] Crear métrica/vista ligera para colas abiertas por conexión; la consulta amplia de `outbound_tasks` canceló por timeout durante la auditoría.
- [x] Dejar sin tareas activas (`QUEUED/RUNNING=0`) a `Cienvinos`; el cron/cola ya no muestra pendientes.
- [x] Bloquear el único reintento abierto de `Sa Pedrera` (`AGORA_HIDE_PRODUCT` / `D715-Pancaliente`) por error duplicado y modo híbrido legacy; no reintentar sin revisión.
- [ ] Revisar deuda histórica `FAILED/BLOCKED` antes de limpiarla: `Kava` (`7/9`), `Luruna` (`10/58`), `Sa Pedrera` (`294/142`). No cerrar en masa sin clasificar causa y riesgo.
- [ ] Mantener `Sa Vida` fuera de procesamiento: backlog `QUEUED=1055`, `FAILED=3322`, `BLOCKED=1861` hasta que Agora devuelva 200 en API.
- [ ] Sa Pedrera: reprobar API HTTP; a las 11:47 CEST `export-master Families/Products` devuelve HTTP 501 (`El módulo de servicios de integración no está habilitado.`) aunque la web y `/version/` responden 200.
- [ ] Sa Pedrera: preparar dry-run `legacy-first` para detectar Winerim publicados que duplican legacy `CONFIRMED` por mismo `winerim_wine_id + format`, con propuesta de ocultar solo el Winerim duplicado y conservar legacy mapeado.
- [x] Sa Pedrera: generar informe de mapping/publicación `SA_PEDRERA_MAPPING_UPLOAD_REPORT_2026-06-04.md` con recuentos de Winerim publicado, legacy mapeado, legacy sin mapping y duplicados probables.
- [ ] Sa Pedrera: antes de ocultar duplicados, filtrar los `92` duplicados probables por calidad de mapping; priorizar `LEGACY_SAFE_MATCH=38` y revisar manualmente los `FUZZY=55` porque algunos candidatos son sospechosos.
- [x] Sa Pedrera: generar dry-run de matching por código `SA_PEDRERA_CODE_MATCH_DRY_RUN_2026-06-04.md`; confirma que `390/393` productos Winerim visibles tienen código, pero solo `1` legacy visible trae código extraíble.
- [x] Codificar helper `productCodeMatching.ts` y priorizar `CODE_EXACT` en `winerim-proxy` antes de fuzzy.
- [ ] Tras push/redeploy, ejecutar `match-products` en modo controlado o dry-run para confirmar que los nuevos matches por código quedan como `CODE_EXACT` y que `CODE_AMBIGUOUS` no auto-confirma.
- [ ] Sa Pedrera: decidir política visual con cliente: ocultar legacy sin mapping y usar Winerim codificado, o mapear manualmente legacy más usado, o hacer limpieza `legacy-first` solo para duplicados seguros.
- [ ] Sa Pedrera: revisar con cliente ejemplos concretos antes de aplicar: `Rock Angel`, `Binitord Blanc`, `Magnum Viña Sastre`, `Rioja Bordón crianza`, `Charles Heidsieck-Rosé`, `Nounat`.
- [ ] Confirmar redeploy diferencial de `winerim-proxy` y reactivar `auto_push_verified_ready` conexión por conexión solo tras `no_catalog_changes_detected` o `differential=true`.
- [ ] Validar con Winerim si los movimientos de stock por API aparecen en "Historial de ventas" o si hay endpoint adicional no documentado.

## P0 — Sa Vida API HTTP Agora
- [x] Reprobar Sa Vida con base URL `http://80.32.137.41:8984/` y token Agora indicado por el usuario; el valor guardado en Lovable Cloud coincide.
- [x] Confirmar que IP/puerto llegan al servidor correcto: raíz web HTTP 200, versión Agora `8.7.4`, installation type `2`.
- [x] Confirmar que el bloqueo no es token: `export-master` devuelve el mismo HTTP 501 con token correcto y sin token.
- [x] Reprobar en profundidad tras aviso del instalador de que el API HTTP está habilitada: sigue HTTP 501 en `export-master`, `export`, `tickets` e `import`; probado también sin barra final, con `Accept` XML, cabeceras alternativas, query params de token y comparación con Kava/Cienvinos/Baco.
- [x] Comprobar puertos públicos probables: solo responde `80.32.137.41:8984`; puertos `80`, `443`, `8080`, `8081`, `8888`, `8980`-`8983`, `8985`-`8990`, `9984` no exponen API Agora accesible.
- [ ] Enviar al instalador la prueba exacta local/externa:
  - Local en el PC Sa Vida: `curl -i -H 'Api-Token: <token>' -H 'Accept: application/xml' 'http://localhost:8984/api/export-master/?filter=Families'`.
  - Externa: `curl -i -H 'Api-Token: <token>' -H 'Accept: application/xml' 'http://80.32.137.41:8984/api/export-master/?filter=Families'`.
  - Si local=200 y externa=501, revisar NAT/port forwarding a otro equipo/servicio. Si local=501, activar realmente `API HTTP` y reiniciar/recargar servicio.
- [ ] Pedir a Agora/instalador revisión literal de `La integración a través del API HTTP no está habilitada.` en la instalación de Sa Vida; comprobar opción específica API HTTP, token, licencia/configuración, instancia correcta y reinicio del servicio.
- [ ] Cuando el instalador diga que está aplicado, reprobar exactamente: `GET /api/export-master/?filter=Families`, `GET /api/export-master/?filter=Products` y `GET /api/export/?business-day=<ayer>&filter=Invoices`; solo continuar si devuelven HTTP 200/XML.
- [ ] Si Sa Vida devuelve HTTP 200, entonces ejecutar en orden: `agora-proxy test`, `sync-master-data`, `find-last-business-day`, revisar backlog y solo después decidir limpieza/activación de colas.

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
- [x] Reparar visual Cienvinos tras auditoría del 2026-06-01: 428 productos Winerim publicados quedan `UseAsDirectSale=false`, `SaleableAsMain=true`, preparación coherente y 0 tareas `AGORA_XML_UPSERT_PRODUCT` abiertas.
- [ ] Confirmar redeploy efectivo del commit `a180c6c` en Lovable Cloud antes de activar cambios de precio automáticos: `winerim-proxy fetch-catalog` debe devolver `autoPushResult.reason=no_catalog_changes_detected` o `autoPushResult.differential=true`.
- [ ] Tras ese redeploy, activar `auto_push_on_update=true` en Cienvinos para que cambios de precio/nombre/formato se reflejen automáticamente sin reimportar lotes completos.
- [ ] Monitorizar el primer cierre nuevo con productos WINERIM; validar `stock_sync_log.variant`, `stock_id`, `idempotency_key` y respuesta Winerim `previousStock/newStock`.
- [ ] Si el cliente no quiere mantener vinos en los 3 sale centers, ajustar `selected_sale_center_ids` antes de futuras actualizaciones masivas.

## P0 — Revisión flota Agora 2026-05-27
- [x] Generar checklist operativa read-only de integraciones: `INTEGRATIONS_CHECKLIST_2026-06-01.md`.
- [x] Reparar visual/preparación en Katsu, Kava, La Candela, Luruna y Sa Pedrera: 0 productos Winerim activos quedan como botón raíz, 0 activos quedan sin pareja de preparación, 0 tareas `AGORA_XML_UPSERT_PRODUCT` abiertas en esas cinco conexiones tras la limpieza.
- [x] Refrescar master data de las cinco conexiones tras la reparación.
- [x] Subir fix de código a GitHub: commit `81c7dbb` (`Fix Agora visual routing and preparation repair`).
- [x] Confirmar redeploy efectivo de `agora-proxy` en Lovable Cloud: `preview-xml` genera `UseAsDirectSale="false"` y preparación completa para muestra de La Candela.
- [x] Cerrar tareas abiertas de catálogo supersedidas tras reparación: Cienvinos 85, Kava 27, Luruna 13 y Sa Pedrera 62 quedan en 0 abiertas.
- [x] Reparar desalineaciones residuales verificadas: Katsu y Sa Pedrera quedan con productos Winerim publicados `direct=0`, `notMain=0`, `mismatchPrep=0`.
- [x] Subir auto-push diferencial a GitHub: commit `a180c6c` (`Make Winerim catalog auto-push differential`).
- [ ] Confirmar redeploy efectivo de `winerim-proxy` en Lovable Cloud: `fetch-catalog` debe devolver `autoPushResult.reason=no_catalog_changes_detected` o `autoPushResult.differential=true`. Actualmente sigue devolviendo `auto_push_not_verified_no_manual_import_success_yet`.
- [ ] Solo después del redeploy diferencial, reactivar `auto_push_verified_ready=true` en Katsu, Kava, La Candela, Luruna y Sa Pedrera, ejecutar una verificación XML y confirmar que no se generan botones raíz ni reimportaciones masivas.
- [ ] Validar en tablets de Sa Pedrera que los vinos Winerim quedan dentro de familias regionales y que una orden de vino llega a barra.
- [ ] Ajustar reglas regionales de Sa Pedrera si el cliente identifica vinos concretos en una familia distinta a la esperada.
- [ ] Validar con Winerim si su "Historial de ventas" se alimenta de los movimientos `PUT /stock/{stockId}` o si necesitan un endpoint adicional de ventas no documentado.
- [ ] Validar con venta/cierre real de copa en `Katsu`, `La Candela`, `Luruna` y `Cienvinos`; hoy están preparados por stockIds/mappings, pero sin prueba reciente de descuento `SUCCESS` de variante `copa`.
- [ ] Sa Pedrera: revisar los `BLOCKED` históricos de copa y decidir si esos productos legacy/rechazados deben quedarse bloqueados, mapearse manualmente o ocultarse del TPV.
- [x] Sa Pedrera legacy matching fase 1: aplicados `38` mappings `CONFIRMED` con `LEGACY_SAFE_MATCH`; excluidos `Roda`, `Tokaji Aszú 6 Puttonyos` y `Magnum Marques de Murrieta` por ambigüedad/riesgo.
- [ ] Sa Pedrera legacy matching fase 2: revisar los `13` mappings `PENDING`, los `58` legacy sin mapping restante y, especialmente, los `34` con candidato pero sin variante/stockId Winerim.
- [x] Kava: revisar producto directo no-Winerim `EL LANCE` dentro de `TINTOS WINERIM`; queda oculto sin borrar (`1000011`, `SaleableAsMain=false`, `UseAsDirectSale=false`) porque existe producto Winerim confirmado para `El Lance 7 Fuentes`.
- [x] Luruna: revisar productos directos no-Winerim `COPA ONDALAN TINTO`, `VIUDA DE CLICQUOT ROSADO` y `COPA VIÑA SASTRE CRZ`; quedan ocultos sin borrar (`1164074`, `1164081`, `1164082`, `SaleableAsMain=false`, `UseAsDirectSale=false`).
- [x] Repetir auditoría XML de Cienvinos: verificado el 2026-06-04 contra XML vivo con 8/8 familias Winerim visibles, 428 productos Winerim, 0 botones raíz, 0 no vendibles como main y 0 mismatch de preparación.
- [ ] Sa Vida: mantener fuera de procesamiento hasta resolver HTTP 501 en `export-master`; revalidación 2026-06-02 con `http://80.32.137.41:8984/` sigue devolviendo `501` en `test`, `Products` y `Families`.
- [x] Cienvinos: revisar/drenar 85 tareas `AGORA_XML_UPSERT_PRODUCT` en `QUEUED`; quedan 0 abiertas tras verificar catálogo vivo.
- [ ] Cienvinos: confirmar por qué no hay ventas/cierres desde `2026-05-27`.
- [x] Kava: cerrar tareas abiertas de catálogo supersedidas por la reparación visual/preparación; quedan 0 `QUEUED/RUNNING` de `AGORA_XML_UPSERT_PRODUCT`.
- [x] Luruna: cerrar tareas abiertas de catálogo supersedidas por la reparación visual/preparación; quedan 0 `QUEUED/RUNNING` de `AGORA_XML_UPSERT_PRODUCT`.
- [x] Sa Pedrera: cerrar tareas abiertas de catálogo supersedidas por la reparación visual/preparación; quedan 0 `QUEUED/RUNNING` de `AGORA_XML_UPSERT_PRODUCT`.
- [x] Katsu y La Candela: escritura real verificada con import Agora HTTP 200 y `provider_capabilities` corregidas a `READY/XML_IMPORT/YES`.
- [x] Actualizar credenciales Sa Vida en Lovable Cloud sin documentar secretos.
- [x] Probar Sa Vida con `agora-proxy test` y `sync-master-data`: endpoints Agora devuelven HTTP `501`.
- [x] Marcar Sa Vida como `UNKNOWN/NOT_CONNECTED/NONE` en `provider_capabilities` para no mostrarla lista.
- [x] Resetear breakers obsoletos de Kava, Luruna y Sa Pedrera tras comprobar endpoints operativos.
- [ ] Pedir a Sa Vida/Agora que habiliten la integración/API HTTP en Agora: la IP `80.32.137.41:8984` carga `Administrar Ágora`, pero `/api/export` y `/api/export-master` devuelven `501` con `La integración a través del API HTTP no está habilitada.`
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
  - Kava/Luruna/Sa Pedrera: tras la reparación del 2026-06-01 quedan 0 `QUEUED/RUNNING` de catálogo, pero hay que revisar históricos `FAILED/BLOCKED` si siguen ensuciando monitor.
  - Sa Vida: backlog grande (`1055 QUEUED`, `3322 FAILED`, `1861 BLOCKED`), no procesar hasta resolver HTTP 501.
- [ ] Decidir limpieza de la conexión `New Location` deshabilitada con URL inválida.
- [x] Revisar por qué Katsu y La Candela tenían tracking verificado pero `provider_capabilities` en `UNKNOWN/NOT_CONNECTED`; quedaron `READY/XML_IMPORT/YES` tras import real HTTP 200.

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
- [x] Verificar rollback contra Agora: 118 productos Winerim existentes pero 0 visibles/vendibles; 6 familias legacy visibles.
- [x] Verificar rollback en Lovable Cloud: `enabled=false`, `catalog_sync_enabled=false`, `write_mode=NONE`, `auto_push_on_create=false`, `auto_push_on_update=false`, `auto_push_verified_ready=false`.
- [x] Corregir rollback legacy tras feedback del cliente: 0 vinos legacy con `UseAsDirectSale=true`, subfamilias de vino bajo `VINO`, 195 productos legacy vendibles solo dentro de familia y 0 antiguos/borrados reactivados.
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

## P0 — Sa Pedrera piloto `DULCES WINERIM`
- [x] Crear/mostrar familia controlada `DULCES WINERIM` reutilizando Agora family id `903925`.
- [x] Publicar `D701-D709` con formatos activos Winerim dentro de esa familia.
- [x] Verificar por API que los 14 productos quedaron con `FamilyId=903925` y nombre correcto.
- [x] Actualizar `product_mappings` y `winerim_push_tracking` a `VERIFIED` para esos 14 productos.
- [x] Documentar estado, decisiones, riesgos y rollback en `SA_PEDRERA_DULCES_WINERIM_TRIAL_2026-06-04.md`.
- [ ] Pedir al cliente validación en tablet: familia única, contenido esperado, orden visual real.
- [ ] Si el orden visual no coincide con Winerim, investigar campo/layout real de Agora antes de reimportar más familias.
- [ ] Decidir si las copas dulces deben quedarse en `DULCES WINERIM` o moverse a una familia separada de copas.
- [ ] Confirmar redeploy efectivo de `agora-proxy` con commit `deaac47`; la prueba de Edge Function seguía respondiendo `Unknown action`.

## P0 — Kava legacy `GENEROSOS` / `DULCES`
- [x] Restaurar visibilidad de familias legacy `2069` (`GENEROSOS`) y `2070` (`DULCES`).
- [x] Restaurar vendibilidad dentro de familia para 15 productos legacy (`SaleableAsMain=true`, `UseAsDirectSale=false`).
- [x] Verificar por API que las familias están visibles, los 15 productos vendibles y 0 productos directos en raíz.
- [x] Refrescar master data Kava en Lovable Cloud (`1681` productos, `93` familias, sin truncation warnings).
- [x] Documentar rollback y riesgo de stock en `KAVA_LEGACY_DULCES_GENEROSOS_RESTORE_2026-06-04.md`.
- [ ] Confirmar visualmente con Kava que `GENEROSOS` y `DULCES` aparecen donde esperan.
- [ ] Si Kava quiere que esas ventas legacy descuenten stock Winerim, hacer mapping seguro producto a producto; no confirmar los mappings fuzzy `PENDING` actuales sin revisión.

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
- Cienvinos: visual reparado el 2026-06-04 y cola abierta final `QUEUED/RUNNING/FAILED/BLOCKED=0/0/0/0`. Esperar primer cierre con producto WINERIM y redeploy diferencial antes de prometer cambios de precio automáticos.
- Baco Getafe: revertido a legacy el 2026-05-29; integración Winerim desactivada en Lovable Cloud y oculta en Agora. Cualquier reactivación Winerim requiere nuevo piloto controlado.
- Sa Vida: credenciales cargadas, pero Agora responde HTTP `501` en catálogo y ventas. Esperando corrección externa de API REST/puerto/versión antes de procesar cola o escrituras.
- Lovable Cloud: reparación de stock/mappings aplicada; bloqueo restante: publicar/redeployar hotfixes actuales, drenar colas residuales antiguas, validar el primer descuento de stock WINERIM real y desarrollar auto-update diferencial de catálogo antes de activar `auto_push_on_update`.

## Notas
- Cron `rescue-zombie-outbound-tasks` corre cada 10 min.
- El módulo compartido vive en `supabase/functions/_shared/resilience.ts`. Importar con ruta relativa `../_shared/resilience.ts`.
- Toast tiene su propio breaker en `provider_config.circuit_breaker` — el global lo respeta porque actualiza `pos_connections.circuit_breaker_paused_until`. Convivencia OK pero no ideal.
