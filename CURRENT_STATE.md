# CURRENT_STATE

> Estado vivo del proyecto. Actualizar en cada sesión (y durante si hay cambios significativos).

_Última actualización: 2026-06-12 08:17 CEST_

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
- Nuevo test `src/test/middlewareOnboarding.test.ts`.
- Nuevo documento Cloudflare Pages: `cloudflare/pages/README.md`.
- Nuevo ejemplo de entorno sin secretos: `cloudflare/pages/env.example`.
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
- Validación en rama limpia:
  - `npm ci --ignore-scripts --no-audit --no-fund` OK.
  - `npm test -- --run src/test/middlewareOnboarding.test.ts src/test/agoraProductNaming.test.ts src/test/stockSyncUtils.test.ts` OK: `21` tests.
  - `npx tsc --noEmit` OK.
  - `npm run build` OK con warnings conocidos de Browserslist y chunk >500 kB.
  - Worker bundle OK con `esbuild`.
  - Vite local en rama limpia responde HTTP 200 en `/onboarding`.
  - Browser check: `/onboarding` renderiza; al seleccionar REVO aparecen Base API, Tenant, Access Token, Client Token y Webhook Secret.
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
  - Version ID: `21976e01-4065-4c09-ae5f-6f91d1e7b0c9`.
  - URL funcional: `https://winerim-middleware-api-staging.gugocreative.workers.dev`.
  - Ruta declarada por Wrangler: `api-staging.middleware.winerim.wine/*`.
- `GET /health` OK en `workers.dev`.
- `POST /api/onboarding/test` con payload REVO incompleto devuelve validación correcta y no llama a servicios externos.
- Bloqueo actual: `api-staging.middleware.winerim.wine` no resuelve DNS (`Could not resolve host`), aunque la ruta Worker quedó declarada. Falta crear/apuntar el registro DNS proxied o Custom Domain para ese host desde Cloudflare Dashboard/API.
- No se ha desplegado Cloudflare Pages todavía; se pospone hasta configurar Access o confirmar exposición controlada.
- Proyectos Pages existentes vistos en la cuenta Cloudflare: `winerim-help`, `spiritsrim`, `winerim-informes`; no existe aún proyecto Pages para el middleware.

### Decisiones
- No migrar clientes ni crons todavía: Cloudflare empieza como control plane y staging/canary.
- Mantener Lovable Cloud como producción actual hasta validar Cloudflare con staging y canary.
- La primera API Cloudflare solo puede probar; cualquier escritura queda bloqueada hasta revisión técnica, dry-run y rollback.
- Postgres gestionado seguirá siendo la base principal objetivo; Cloudflare D1 no se usa para el core transaccional del middleware.
- Desplegar solo Worker staging, no producción, y mantener Pages pendiente hasta proteger la UI con Cloudflare Access.
- Usar temporalmente `https://winerim-middleware-api-staging.gugocreative.workers.dev` para pruebas de API staging hasta resolver DNS de `api-staging.middleware.winerim.wine`.

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
- `export-master` no devuelve `SortOrder` de producto. La API confirma familia/nombre, pero no permite demostrar el orden visual final de la tablet.
- Si la tablet no respeta el `SortOrder` enviado en XML, habrá que identificar el campo/layout real de Agora para ordenar botones sin cambiar IDs ni romper mappings.
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
  - Agora ordenaba visualmente por `Product.Id`, no por `SortOrder`.
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
- Agora podria ignorar `Order`/`SortOrder` en productos existentes; hay que verificar el orden real en tablet.
- En Katsu y La Candela, `is_wine_candidate` puede incluir falsos positivos, pero tambien aparecen vinos reales no mapeados; hace falta revision de mapping.
- Luruna y Cienvinos pueden estar bien configurados en Lovable Cloud pero no disponibles desde red publica en este momento.

#### Tareas pendientes inmediatas
- Pedir a Sa Pedrera validacion visual de `TINTOS WINERIM`: 200 tintos, orden `T1...T282`, sin duplicados no esperados.
- Si el orden no coincide, no reimportar masivamente: investigar si Agora usa layout local/cache de tablet u otro campo distinto de `Order`/`SortOrder`.
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
