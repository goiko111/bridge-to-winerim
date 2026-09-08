# Runtime Port Manifest - 2026-08-02

## Objetivo

Inventario para portar de forma progresiva y verificable el runtime Agora/Winerim
desde Edge Functions Deno a Cloudflare Workers, Queues, Cron Triggers y Postgres
gestionado. Este documento no autoriza trafico productivo, cambios de datos ni un
cutover. El sistema actual debe seguir siendo la ruta de rollback hasta completar
el canary.

## Alcance inspeccionado

Runtime principal:

- `supabase/functions/agora-proxy/index.ts` - 10.143 lineas.
- `supabase/functions/winerim-proxy/index.ts` - 1.628 lineas.
- `supabase/functions/agora-cron-dispatcher/index.ts` - 202 lineas.

Helpers importados directa o funcionalmente relevantes:

- `_shared/agoraOpenTickets.ts`
- `_shared/agoraProductNaming.ts`
- `_shared/agoraSalesLineIdentity.ts`
- `_shared/middlewareIncidentAlerts.ts`
- `_shared/resilience.ts`
- `_shared/stockSyncUtils.ts`
- `_shared/providerConfig.ts` se conserva en el inventario comun aunque estas tres
  funciones no lo importan hoy directamente.

El arbol de Playground no tiene un `HEAD` Git valido. Para que este inventario sea
reproducible, el snapshot leido queda identificado por SHA-256:

| Archivo | SHA-256 |
|---|---|
| `agora-proxy/index.ts` | `a21988f64ee7f9026368ae4d19da736130a7a1f653bf059728a940034d02560b` |
| `winerim-proxy/index.ts` | `a18c003bc61592aead747f291ff06be1c0cb15db842a9da4f97ebdb0e3363547` |
| `agora-cron-dispatcher/index.ts` | `3b6f12fe88c92169344239a03a6621b786af5eff0fee7c8e1e4b115540de4104` |
| `_shared/agoraOpenTickets.ts` | `325aab28860deeaf03f0e2e40cfc35e1d44b043741f2cf38155cbfe3a7c0f687` |
| `_shared/agoraProductNaming.ts` | `7496878ef7deb1c891d0efc8bc53a7cd8d79d9adbad669f9138b61498b7b4b90` |
| `_shared/agoraSalesLineIdentity.ts` | `0377054eebe66d3ea8dc7a597b107542265d75f2241c696eef6449c9f30fea0b` |
| `_shared/middlewareIncidentAlerts.ts` | `a954365475f743a531e8d3b25c7c012454aa59b64884cad5ace8bb711feaea6c` |
| `_shared/resilience.ts` | `19e7416f44063bdad9fb5d3912a927f8ec73ac6fe751268a809f1095988f4856` |
| `_shared/stockSyncUtils.ts` | `88f94b5395f69fdff25bc09d7dec6d7f2507959aea49e0afe589d8e9236cb0d9` |

## Hechos, decisiones e hipotesis

### Hechos

- `agora-proxy` es hoy un monolito que mezcla rutas read-only, persistencia,
  catalogo, ventas, stock, cola, diagnostico y herramientas administrativas.
- Las tres funciones crean un cliente privilegiado con `SUPABASE_URL` y
  `SUPABASE_SERVICE_ROLE_KEY`.
- Las rutas actuales no validan por si mismas el `Authorization` recibido antes de
  ejecutar una accion. La proteccion depende de la superficie Edge/plataforma.
- `agora-proxy` y `winerim-proxy` leen el body una sola vez.
- El rate limit Agora es un `Map` en memoria por isolate, maximo 2 solicitudes por
  segundo y `connection_id`. No coordina isolates distintos.
- El cache de `export-master Products` tambien es memoria local, TTL 60 segundos.
- La idempotencia de stock y cola depende principalmente de Postgres, no del
  proceso Edge.
- El dispatcher procesa chunks de 10 llamadas y espera 1,5 segundos entre chunks.
- Las migraciones locales contienen `cron.unschedule(...)` para los tres cron de
  cinco minutos. Por tanto, la programacion activa no puede reconstruirse solo con
  este repositorio y debe inventariarse en el backend antes del cutover.

### Decisiones heredadas que se mantienen

- Postgres gestionado es el core transaccional; D1 no sustituye este esquema.
- Cloudflare sera el plano de API, Access, Cron Triggers, Queues y coordinacion por
  conexion.
- La migracion es por slices y canary, nunca big-bang.
- Las escrituras a Agora y Winerim quedan apagadas por defecto en staging.
- Los contratos de idempotencia, breaker, cursor fail-closed y copas live son gates
  de compatibilidad, no mejoras opcionales.

### Hipotesis a validar

- Cloudflare Workers puede alcanzar de forma estable todos los hosts Agora
  publicos, incluidos HTTP y puerto 8984. Debe probarse por conexion; no se asume.
- Hyperdrive es la ruta preferente a Postgres, pero la semantica transaccional y de
  `FOR UPDATE SKIP LOCKED` debe verificarse con el proveedor Postgres elegido.
- Los limites de subrequests, CPU, memoria y tamano de respuesta obligaran a partir
  los recorridos largos; no se debe trasladar una accion de 120 segundos como una
  unica invocacion.

## Grafo operativo actual

```text
pg_cron / pg_net
  -> agora-cron-dispatcher
       catalog
         -> winerim-proxy:fetch-catalog
         -> agora-proxy:sync-master-data
       sales-stock
         -> agora-proxy:auto-sync-sales
         -> agora-proxy:sync-intraday-sales (por config)
         -> agora-proxy:sync-open-tickets (por config)
       outbound-queue
         -> agora-proxy:process-xml-outbound-queue

winerim-proxy:fetch-catalog
  -> Postgres winerim_wines
  -> agora-proxy:evaluate-auto-push
  -> agora-proxy:process-xml-outbound-queue
  -> schedule_next_catalog_batch (RPC + pg_net)

agora-proxy ventas
  -> Agora export invoices/tickets
  -> sales_events + sales_line_items
  -> stock_sync_log claim idempotente
  -> Winerim stock / sales/import
  -> cursor solo si persistencia y stock terminan correctamente

agora-proxy catalogo
  -> Winerim cache + Agora master cache
  -> diff esperado vs actual
  -> outbound_tasks
  -> Agora XML import
  -> readback export-master
  -> tracking/capabilities/task status
```

## Superficies HTTP externas

### Agora

| Metodo/ruta | Uso | Mutabilidad |
|---|---|---|
| `GET /api/` | Preflight de alcance | Read-only |
| `GET /api/export/?business-day=YYYY-MM-DD&filter=Invoices` | Facturas cerradas, discovery y backfill | Read-only |
| `GET /api/export/tickets/` | Tickets abiertos, JSON o XML `TicketModel` | Read-only |
| `GET /api/export/?filter=Articles|Products|Catalog` | Discovery/catalogo legacy | Read-only |
| `GET /api/export-master/?filter=Products` | Catalogo completo y readback | Read-only; siempre por helper/cache |
| `GET /api/export-master/?filter=Families,Vats,PriceLists,PreparationTypes,PreparationOrders,Warehouses` | Master base | Read-only |
| `GET /api/export-master/?filter=SalePoints|SaleCenters|Families` | Scope, familias y centros | Read-only |
| `OPTIONS/POST /api/import/articles|products`, `POST /api/products|articles` | Deteccion/JSON legacy | Potencialmente mutable |
| `POST /api/import/` XML | Familias, productos, visibilidad, orden y precios | Mutable, requiere snapshot/diff/readback/rollback |

Autenticacion externa: cabecera `Api-Token`, almacenada por conexion.

### Winerim API v2

| Metodo/ruta | Uso | Mutabilidad |
|---|---|---|
| `GET /wines?page=&limit=` | Lista paginada | Read-only |
| `GET /wines/{id}` y variantes de detalle | Precio, formatos y stock IDs | Read-only |
| `GET /stock/wine/{wineId}` | Readback de variantes/stock | Read-only |
| `PUT /stock/{stockId}` | Stock absoluto por variante | Mutable |
| `PUT /stock/bulk` | Stock absoluto en lote | Mutable |
| `POST /sales/import` | Historial y copa live | Mutable/idempotente por `orderId` |

Autenticacion externa: cabecera `WINERIM-API-TOKEN`, almacenada por conexion.

### Otros servicios

- `https://ai.gateway.lovable.dev/v1/chat/completions`: solo `ai-match`, usa
  `LOVABLE_API_KEY`. No debe entrar en el primer port operativo.
- `https://api.resend.com/emails`: alertas internas de incidentes, usa
  `RESEND_API_KEY`. Debe ejecutarse fuera del camino critico y con dedupe.

## Inventario de `agora-proxy`

Clasificacion:

- `RO`: lectura de DB/POS; puede devolver diagnostico.
- `DB`: escribe solo estado interno.
- `POS`: puede escribir Agora.
- `STOCK`: puede escribir historial o stock Winerim.
- `ADMIN`: rescate/operacion manual; no exponer a Cron ni UI comercial.

| Accion | Clase | Contrato y dependencias principales | Slice |
|---|---|---|---|
| `test` | RO | Invoices de hoy, fallback tickets | 1 |
| `find-last-business-day` | RO | Escaneo Invoices hasta 60 dias, corta tras vacios | 2 |
| `discover-live-sales` | RO | Prueba filtros de venta; diagnostico | 1 |
| `probe-open-tickets` | RO | JSON/XML `TicketModel`, sin persistencia | 1 |
| `sync-open-tickets` | DB/STOCK | Guarda `OpenTicket`; stock solo con flags, edad minima y mapping | 5 |
| `fetch-day` | RO | Normaliza una jornada sin guardar | 2 |
| `backfill-sales-analytics` | DB | Max. 120 dias; metadata historical, sin stock ni cursor; `dryRun` real | 3 |
| `save-sales` | DB/STOCK | Upsert facturas/lineas, resolucion y stock; cursor fail-closed | 5 |
| `sync-intraday-sales` | DB/STOCK | Facturas del dia, stock incremental, no avanza cursor cerrado | 5 |
| `auto-sync-sales` | DB/STOCK | Dias cerrados, catch-up y cursor por dia solo tras stock OK | 6 |
| `resolve-sales` | DB | Remapea lineas ya guardadas desde mapping autoritativo | 3 |
| `sales-analytics` | RO | Resumen de eventos, formatos y no resueltos | 2 |
| `discover-catalog` | RO/DB | Prueba endpoints y persiste `catalog_endpoint` seleccionado | 2 |
| `test-catalog-endpoint` | RO | Valida endpoint configurado | 1 |
| `sync-catalog` | DB | Importa/deriva `provider_products` y clasifica | 3 |
| `build-derived-catalog` | DB | Deriva productos desde Invoices | 3 |
| `recompute-classification` | DB | Reclasifica cache en lotes de 500 | 3 |
| `sync-stock` | STOCK | Mutacion real Winerim para un dia | 5 |
| `detect-capabilities` | DB/POS | Probes de escritura y `provider_capabilities`; aislar por riesgo | 7 |
| `process-outbound-task` | POS/DB | Procesador JSON legacy `AGORA_UPSERT_PRODUCT` | 8 |
| `process-outbound-queue` | POS/DB | Cola JSON legacy y migracion familiar | 8 |
| `export-products` | RO | Export CSV desde cache/mappings | 3 |
| `sync-master-data` | DB | Lee master, actualiza cache/capabilities/breaker/incidentes | 3 |
| `create-pilot-families` | POS | Crea familias piloto por XML | 9 |
| `set-family-visibility` | POS | Modifica `ShowInPos`; requiere snapshot inverso | 9 |
| `set-product-visibility` | POS | Modifica vendibilidad/visibilidad preservando XML | 9 |
| `archive-products` | POS | Mueve productos a familia archivo | 10 |
| `hide-families` | POS | Oculta familias | 9 |
| `create-family` | POS | Crea familia con ID estable | 9 |
| `reorder-products-by-commercial-code` | RO/POS | `dryRun` por defecto; puede cambiar `Order` y devuelve rollback XML | 9 |
| `sa-pedrera-dulces-winerim-trial` | RO/POS | Trial allowlisted, `dryRun` por defecto | 10 |
| `preview-xml` | RO | Genera XML/labels sin import | 4 |
| `xml-import` | POS/DB | `dryRun` solo si se solicita; import, tracking y readback | 7 |
| `process-xml-outbound-task` | POS/DB | Claim, XML, hash, import, readback, retry/breaker/tracking | 7 |
| `queue-xml-outbound` | DB | Encola con guard de pendientes | 4 |
| `process-xml-outbound-queue` | POS/DB | Claim atomico, backoff, hide/migrate/upsert, encadenado | 8 |
| `retry-failed-tasks` | ADMIN/DB | Reabre tareas fallidas | 10 |
| `delete-all-tasks` | ADMIN/DB | Borrado operativo destructivo | No portar inicialmente |
| `cleanup-and-push-glasses` | ADMIN/DB | Repara tracking/cola de copas | 10 |
| `requeue-blocked-as-update` | ADMIN/DB | Convierte bloqueadas a UPDATE | 10 |
| `backfill-prices` | ADMIN/DB | Genera tareas de precio | 10 |
| `backfill-preparation` | ADMIN/DB | Genera tareas con preparacion | 10 |
| `reassign-families` | ADMIN/DB | Genera tareas de reasignacion | 10 |
| `requeue-task-current-scope` | ADMIN/DB | Clona tarea con scope actual | 10 |
| `verify-products` | RO/DB | Export-master y tracking VERIFIED/FAILED | 4 |
| `debug-bundle` | RO | Diagnostico master/tareas/precios/XML | 4 |
| `diagnose` / `export` | RO | Devuelve Invoices crudo | 1 |
| `evaluate-auto-push` | RO/DB | Diff fail-closed; `dryRun` no encola; modo real crea hide/upsert | 4 |
| `probe-pricelist-persistence` | POS | Crea producto sonda real y lo lee | 10 |
| `migrate-families-to-production` | ADMIN/DB | Encola migraciones para tracking VERIFIED | 10 |
| `restore-glass-overdiscount` | ADMIN/STOCK | Dry-run salvo doble confirmacion legacy; no portar al camino normal | No portar inicialmente |

## Inventario de `winerim-proxy`

| Accion | Clase | Contrato y dependencias principales | Slice |
|---|---|---|---|
| `fetch-catalog` | DB | Lista paginada, cache, detalle por lotes, inactive reconciliation, auto-push y encadenado | 3/4 |
| `fetch-wine-details` | DB | Enriquece pendientes/errores y vuelve a evaluar auto-push | 3/4 |
| `match-products` | DB | Matching determinista SKU/fuzzy y propagacion a lineas | 4 |
| `ai-match` | DB/externo | Gateway AI, hasta 20 pendientes, auto-confirma >=85 | 10 opcional |
| `confirm-mapping` | DB | Confirma y actualiza lineas existentes | 4 |
| `reject-mapping` | DB | Bloqueo explicito de resolucion | 4 |
| `ignore-mapping` | DB | Exclusion administrativa | 4 |
| `update-stock` | STOCK | PUT absoluto de una variante | No exponer; usar servicio stock |
| `bulk-update-stock` | STOCK | PUT absoluto por chunks de 100 | No exponer; usar servicio stock |
| `get-stock` | RO | Readback Winerim | 2 |
| `diagnose-unknown` | DB | Reclasifica estado de precios cacheados | 3 |
| `create-manual-mapping` | DB | Mapping exacto y backfill de lineas | 4 |
| `unlink-mapping` | DB | REJECTED y desmapea lineas | 4 |

## Inventario de `agora-cron-dispatcher`

| Job | Seleccion | Dispatch actual | Target Cloudflare |
|---|---|---|---|
| `catalog` | Agora `enabled=true`, breaker vencido | `fetch-catalog` + `sync-master-data` | Cron produce mensajes separados con jitter por conexion |
| `sales-stock` | Igual, con preflight `/api/` 5 s | `auto-sync-sales`, intraday y open tickets por flags | Cron produce jobs de lectura; stock va a cola dedicada |
| `outbound-queue` | Igual, con preflight `/api/` 5 s | `process-xml-outbound-queue` | Queue consumer serializado por conexion |

No se debe conservar el fan-out HTTP interno como mecanismo principal. Cron debe
producir mensajes y cada consumidor debe confirmar/reintentar de forma explicita.

## Dependencias Postgres

### Tablas core

| Tabla | Papel en runtime | Invariantes necesarias |
|---|---|---|
| `pos_connections` | Tenant, URLs, tokens, flags, cursor y breaker | Aislamiento estricto por `connection_id`; timestamps atomicos |
| `winerim_wines` | Cache por conexion del catalogo Winerim | Unique `(connection_id,winerim_id)` |
| `provider_products` | Cache/clasificacion POS | Unique `(connection_id,provider_product_id)` |
| `product_mappings` | Resolucion POS -> Winerim | Estado REJECTED prevalece; identidad incluye formato |
| `sales_events` | Documento de venta | Unique `(connection_id,provider_doc_id)` |
| `sales_line_items` | Lineas de venta | Reemplazo por evento debe ser transaccional |
| `stock_sync_log` | Claim, auditoria e idempotencia stock | Unique parcial de `(connection_id,idempotency_key)` para PENDING/SUCCESS |
| `outbound_tasks` | Cola/catalogo y reintentos | Claim atomico `SKIP LOCKED`; estados y `next_retry_at` |
| `agora_master_data` | Cache XML parseado y scope | Una fila coherente por conexion |
| `provider_capabilities` | Gates de lectura/escritura | `can_write_products` UNKNOWN/YES/NO |
| `winerim_push_tracking` | Estado por vino/formato/producto Agora | No mezclar formatos ni conexiones |
| `wine_family_rules` | Clasificacion de lineas | Unique por conexion/familia |
| `wine_type_family_mappings` | Routing a familias Agora | Resolucion estable por mapping key |
| `classification_config` | Heuristicas de catalogo | Lectura versionada |

### Tablas de incidentes

- `middleware_incidents`
- `middleware_incident_events`
- `middleware_incident_email_attempts`
- `connection_notification_contacts`

### RPC actuales que deben desaparecer o reimplementarse

- `claim_outbound_tasks`: mantener en Postgres como funcion transaccional; no
  reemplazar por `SELECT` seguido de `UPDATE`.
- `schedule_next_catalog_batch`: sustituir RPC + `pg_net` por Queue.
- `schedule_next_queue_batch`: sustituir RPC + `pg_net` por Queue.

## Secrets y configuracion

### Secrets globales actuales

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `LOVABLE_API_KEY`
- `RESEND_API_KEY`
- `INCIDENT_OPERATOR_EMAIL`
- `INCIDENT_EMAIL_FROM`
- `INCIDENT_SUGGESTED_EMAIL_TO`
- `INCIDENT_SUGGESTED_EMAIL_CC`

### Target Cloudflare

- Binding Hyperdrive o `DATABASE_URL` solo en secret de Worker.
- `MIDDLEWARE_ADMIN_TOKEN` temporal hasta Access/JWT.
- Service tokens Cloudflare Access para Cron/Queue/admin.
- `RESEND_API_KEY` solo en worker de incidentes.
- No portar `LOVABLE_API_KEY` al camino critico; AI matching queda opcional.
- `Api-Token` Agora y `WINERIM-API-TOKEN` deben cifrarse en reposo con una clave
  externa al Postgres. El esquema historico los define como texto; esto contradice
  la descripcion general de "credenciales cifradas" y debe resolverse antes del
  go-live propio.
- Nunca devolver tokens en respuestas, logs, DLQ ni payloads de Queue.

## Contratos que el port debe conservar

### Idempotencia de ventas y stock

1. `sales_events`: upsert por `(connection_id, provider_doc_id)`.
2. `stock_sync_log`: claim antes de mutar Winerim.
3. Clave por linea: `connectionId:salesLineItemId:variant`.
4. Clave por total deseado: conexion/dia/vino/variante/target.
5. `sales/import orderId`: determinista, estable entre reintentos.
6. Un timeout despues de enviar no permite asumir fallo; hay que hacer readback o
   repetir con la misma idempotencia.

### Copas live

- Operativa: `POST /sales/import` con `live:true`.
- Aceptacion por linea: `stockApplied:true` o `duplicate:true`.
- `409`: hasta tres intentos, espera aproximada de un segundo, mismo payload y
  mismo `orderId`.
- `200` con lineas `retryable:true`: reenviar solo esas lineas.
- Historico: sin `live`, marcado `_winerim_import_mode=historical_analytics` y
  `_stock_sync_eligible=false`.
- Botella/magnum: PUT absoluto de su propio `stockId`; no doble descuento.

### Cursor

- `last_business_day_synced` solo avanza cuando guardar ventas y stock requerido
  terminan correctamente.
- Si falta token Winerim o falla stock, se actualiza como mucho `last_sync_at`; el
  dia queda reintentable.
- Backfill analytics y sync intradia no avanzan cursor de dias cerrados.

### Breaker y retry

- `BUSINESS_ERROR`: no cuenta contra POS; resetea contador.
- `POS_DOWN`: 5 fallos, pausa 60 min.
- `POS_OVERLOADED`: 10 fallos, pausa 15 min.
- Fetch POS: timeout, rate limit y un retry de red.
- Cola XML: backoff persistido, `next_retry_at`, max attempts y BLOCKED para errores
  de datos.
- `404/405` en import puede degradar `can_write_products=NO`.

### Catalogo

- IDs deterministas por formato: botella `500000+wineId`, copa `700000+wineId`,
  magnum `900000+wineId`.
- `UseAsDirectSale=false`, `SaleableAsMain=true` para productos Winerim vendibles.
- `PreparationTypeId` y `PreparationOrderId`: ambos vacios o ambos informados.
- UPDATE automatico diferencial y fail-closed si no se puede comparar master.
- `Product.Name` y `ButtonText` deben mantener la desambiguacion de anada.
- Scope de PriceLists/SaleCenters congelado en la tarea y verificado post-import.
- `REJECTED` bloquea una resolucion aunque exista tracking historico.

## Arquitectura target propuesta

```text
Cloudflare Access
  -> middleware-api (HTTP control plane y read-only)

Cron Triggers
  -> scheduler Worker
      -> catalog-read queue
      -> sales-read queue
      -> open-ticket-read queue
      -> outbound-catalog queue

Queue consumers
  -> Durable Object por connection_id
      - rate limit global 2 req/s
      - lease para evitar dos consumidores simultaneos
      - breaker cache/read-through
  -> Postgres gestionado por Hyperdrive
  -> Agora / Winerim

Postgres
  - source of truth de cursor, claims, mappings, tracking y auditoria
  - outbox transaccional para mensajes que deben publicarse tras commit

DLQ
  - referencia a task/event IDs, nunca tokens ni XML completo sensible
```

El Durable Object coordina trafico, pero el breaker y los claims definitivos deben
persistir en Postgres para sobrevivir a recreaciones y rollback.

## Orden de port por slices verificables

### Slice 0 - Base y seguridad

Entregables:

- Paquete Worker comun con router, `requestId`, body-once, respuestas JSON y
  redaccion de secretos.
- Access/service-token obligatorio en toda ruta interna.
- Cliente Postgres con transacciones y timeouts.
- Repositorios tipados por tabla; ninguna llamada directa dispersa desde handlers.
- Feature flags por conexion y kill switch global de escrituras.

Gate: tests de auth, aislamiento por `connection_id`, timeout y no filtrado de
tokens. Rollback: retirar rutas staging; cero trafico productivo.

### Slice 1 - Probes Agora read-only

Portar `test`, `discover-live-sales`, `probe-open-tickets`,
`test-catalog-endpoint`, `diagnose/export`. Incluir parser JSON/XML y prueba real de
egress por puerto 8984.

Gate: paridad de status/conteos contra runtime actual en al menos tres variantes de
Agora. Rollback: desactivar rutas Cloudflare.

### Slice 2 - Lecturas y analytics

Portar `find-last-business-day`, `fetch-day`, `sales-analytics`, `get-stock` y la
parte read-only de discovery. Sin writes externas.

Gate: fixtures + comparacion shadow de respuestas. Rollback: apagar shadow.

### Slice 3 - Caches internas

Portar `sync-master-data`, `fetch-catalog`, `fetch-wine-details`, `sync-catalog`,
`build-derived-catalog`, `recompute-classification` y `diagnose-unknown` sin
auto-push. Sustituir encadenado `pg_net` por Queue paginada.

Gate: conteos, hashes de master, precios/formatos y cero tareas outbound creadas.
Rollback: truncar solo cache staging o volver a snapshot staging.

### Slice 4 - Mapping, preview y evaluacion dry-run

Portar mapping determinista/manual, `preview-xml`, `verify-products` shadow y
`evaluate-auto-push` forzado a `dryRun:true`. Portar naming, identity y generador
XML como librerias puras con golden fixtures.

Gate: XML, labels, diff y decisiones de format iguales byte a byte o equivalentes
semanticamente. Rollback: apagar routes; no hay writes POS.

### Slice 5 - Ventas y stock shadow

Portar normalizacion/persistencia de Invoices y OpenTicket en una base staging.
Ejecutar calculo de stock, idempotency keys, cursor decision y payload
`sales/import` sin enviarlos.

Gate: shadow de 7-14 dias por conexion; cero diferencias no explicadas en eventos,
lineas, variantes, cantidades y cursor propuesto.

### Slice 6 - Primer canary ventas

Una conexion no critica y una referencia controlada. Activar una cola de stock con
lease por conexion. Exigir readback Winerim y ausencia de doble descuento.

Gate: botella, copa live y duplicate idempotente; cursor fail-closed demostrado.
Rollback: kill switch, detener Queue consumer y enrutar de nuevo al runtime actual.

### Slice 7 - Cola XML quirurgica

Portar `queue-xml-outbound`, claim atomico y `process-xml-outbound-task`. Solo un
producto allowlisted. Preservar hash XML, scope congelado, import y readback.

Gate: preview, import, tracking, task status y rollback XML verificados. Rollback:
pausar consumer y restaurar XML snapshot.

### Slice 8 - Dispatcher y colas operativas

Portar los tres jobs a Cron Triggers + Queues. Eliminar fan-out HTTP y RPC de
encadenado. Anadir jitter y limite por tenant.

Gate: dos ciclos consecutivos sin backlog creciente, duplicados ni diferencia de
cursor. Rollback: pausar Cron/Queues Cloudflare y mantener scheduler actual.

### Slice 9 - Herramientas visibles reversibles

Portar familias, visibilidad y orden solo tras un framework comun de
snapshot/diff/readback/rollback y autorizacion de rol tecnico.

Gate: una operacion canary por tipo y XML inverso validado.

### Slice 10 - Rescate y administracion

Portar de forma separada retry/requeue/backfills/migraciones/pricelist probe. No
portar inicialmente `delete-all-tasks` ni `restore-glass-overdiscount` al API
general. Si se conservan, deben ser jobs firmados, allowlisted, con doble
confirmacion y auditoria inmutable.

## Riesgos Deno -> Workers

| Riesgo | Evidencia actual | Tratamiento obligatorio |
|---|---|---|
| Imports remotos Deno | `deno.land` y `esm.sh` | Dependencias npm fijadas y bundle reproducible |
| Handler | `Deno.serve` | `export default { fetch, scheduled, queue }` |
| Variables | `Deno.env.get` | `Env` bindings explicitos; nunca acceso global |
| Fire-and-forget | `functions.invoke(...).then(...)` | `ctx.waitUntil` o Queue con ack |
| Fan-out recursivo | HTTP a otras Edge Functions | Queue/evento interno versionado |
| Rate limit local | `Map` por isolate | Durable Object/limiter coordinado por conexion |
| Cache local | XML Products 60 s en memoria | Cache API/KV solo para lectura; invalidacion tras write |
| Acciones largas | Guards de 120 s, loops de 120 dias | Jobs paginados y checkpoints persistidos |
| Claim concurrente | RPC `SKIP LOCKED` | Mantener transaccion Postgres; no emular en memoria |
| XML por regex | Helpers y readback ad hoc | Golden fixtures; considerar parser streaming seguro |
| Egress Agora | Hosts HTTP y puerto 8984 | Canary por host, DNS, TLS, timeout y SSRF policy |
| Subrequests | Muchos detalles/ventas/productos | Partir por Queue; presupuesto explicito por job |
| Respuestas/logs | Previews pueden contener datos | Sanitizacion central y limites de tamano |
| CORS amplio | `Access-Control-Allow-Origin: *` | Origen fijo + Access; Cron/Queue no llevan CORS |
| Auth implicita | Handlers no validan bearer | Autorizacion en router antes de leer `connectionId` |
| Tokens en filas | Columnas text historicas | Cifrado de aplicacion/KMS y rotacion antes de go-live |
| Semantica de timeout | Mutacion puede completarse tras timeout | Idempotencia + readback, nunca retry con nueva clave |
| Emails en camino de sync | Incident helper puede llamar Resend | Queue de incidentes independiente y no bloqueante |

## Estrategia de rollback

1. Cada slice usa flags `shadow`, `read_enabled`, `write_enabled` y allowlist por
   `connection_id`.
2. Nunca ejecutar el runtime viejo y el nuevo como writers simultaneos para la
   misma conexion/operacion.
3. Antes de activar un writer Cloudflare: snapshot DB, version Worker, payload
   esperado, readback y artefacto de rollback.
4. Rollback inmediato: pausar Cron/Queue Cloudflare, activar ruta anterior y dejar
   mensajes no confirmados en DLQ; no marcarlos SUCCESS.
5. Cursor y claims permanecen en Postgres para que el runtime anterior pueda
   continuar sin repetir operaciones confirmadas.
6. Los cambios XML requieren XML inverso derivado del master fresco, no una
   reconstruccion por nombre.

## Gates de aceptacion del port completo

- [ ] Todas las rutas internas autentican antes de acceder a datos.
- [ ] Aislamiento multi-tenant probado con tests negativos.
- [ ] Egress Agora validado por HTTP/HTTPS y puerto real de cada canary.
- [ ] Catalogo Winerim completo, paginado y enriquecido sin starvation.
- [ ] Diff catalogo fail-closed y precio/alta propagados dentro del SLA.
- [ ] Cola con claim atomico, backoff, DLQ y replay idempotente.
- [ ] Breaker global por conexion con umbrales equivalentes.
- [ ] Ventas cerradas e intradia sin huecos ni duplicados.
- [ ] Copa operativa `live:true` con `stockApplied` o `duplicate`.
- [ ] Botella y magnum escriben solo su variante.
- [ ] Historico no mueve stock ni cursor operativo.
- [ ] Cursor no avanza ante fallo de persistencia o stock.
- [ ] OpenTicket no duplica al llegar la factura definitiva.
- [ ] Snapshot/diff/readback/rollback obligatorio en XML.
- [ ] Observabilidad por job, conexion, accion, intento y request ID.
- [ ] Dos ciclos sanos consecutivos antes de ampliar allowlist.
- [ ] Runbook de rollback probado, no solo documentado.

## Siguiente implementacion recomendada

Crear un paquete limpio `infrastructure/runtime/packages/runtime-core` con helpers
puros y tests, y un Worker separado `middleware-agora-read` para Slice 1. No copiar
el monolito de 10.143 lineas al Worker existente. El primer PR debe contener solo:

1. router autenticado;
2. tipos de `Env` y repositorios sin secretos;
3. `normalizeAgoraBaseUrl` y fetch con timeout;
4. parser OpenTicket JSON/XML;
5. acciones `test` y `probe-open-tickets`;
6. fixtures/golden tests;
7. kill switch y logs sanitizados.

Hasta que ese slice pase staging, quedan expresamente fuera los Cron Triggers,
Queues con writers, XML import, stock, cursores y clientes productivos.
