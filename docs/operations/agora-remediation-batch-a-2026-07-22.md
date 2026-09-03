# Agora remediation batch A - 2026-07-22

## Alcance y reglas aplicadas

Alcance exclusivo:

- Kava;
- PurOsushi;
- Restaurante Qtomas;
- Taberna de Elia.

La intervencion se limito a configuracion y datos de cada conexion. No se
editaron Edge Functions, migraciones, codigo compartido ni los cuatro
documentos de sesion. No se borro historial, no se compensaron ventas por
nombre y no se adopto ownership sin prueba fresh.

Politica aplicada:

- `open_tickets_stock_sync_enabled=false`: un ticket provisional no escribe
  stock ni historial Winerim;
- `intraday_sales_sync_enabled=true`: la factura cerrada es la fuente de
  escritura;
- frecuencia operativa de cinco minutos.

Kava, Qtomas y Taberna mantienen `open_tickets_sync_enabled=true` solo para
observabilidad. PurOsushi queda temporalmente con
`open_tickets_sync_enabled=false`: Agora devuelve como abiertos tickets de los
dias 18 y 21, y el cron usa el dia abierto mas antiguo para retroceder el
cursor cerrado a 17/07. Mantener esa observabilidad hasta corregir el codigo
haría inestable el cursor aunque la escritura provisional ya estuviera
desactivada.

## Salvaguardas previas

Antes de mutar se generaron los siguientes artefactos:

- `outputs/AGORA_REMEDIATION_BATCH_A_ROLLBACK_2026-07-22.json`;
- `outputs/AGORA_REMEDIATION_BATCH_A_KAVA_PAMPANEANDO_BEFORE_2026-07-22.json`;
- `outputs/AGORA_REMEDIATION_BATCH_A_KAVA_SELECTIVE_SYNC_SNAPSHOT_2026-07-22.json`;
- `outputs/AGORA_REMEDIATION_BATCH_A_KAVA_DAY18_SELECTIVE_BEFORE_2026-07-22.json`.

Los dry-runs fresh iniciales dieron:

| Conexion | Fresh antes | Cola activa antes |
|---|---:|---:|
| Kava | 229/229 exactos | 0 |
| PurOsushi | 355/357 exactos | 0 |
| Restaurante Qtomas | 1430/1430 exactos | 0 |
| Taberna de Elia | 410/410 exactos | 0 |

En PurOsushi las dos diferencias eran exclusivamente precios BOTTLE de los
productos `709944` y `709986`. En Qtomas las 57 filas de tracking `FAILED`
coincidian 57/57 con el catalogo fresh; el error almacenado era un timeout de
verificacion, no una diferencia de producto.

## Cambios realizados

### Kava

1. Se desactivo la escritura desde tickets abiertos y se mantuvo su lectura.
2. Se confirmo por factura cerrada y por ID que Agora vendio:
   - una copa de `947191 / C Pampaneando` el 17/07;
   - dos copas del mismo producto el 18/07.
3. El mapping `c4fab2ac-b400-4f91-b4c1-7a49e35353ed` estaba `CONFIRMED` contra
   Winerim `247191`, formato `GLASS`, score 100.
4. Se ejecuto `save-sales` con `skipStockSync=true` para ambos dias. El runtime
   convirtio las dos lineas definitivas a `mapped=true` e
   `is_wine_candidate=true` antes de escribir en Winerim.
5. Para el 18/07 se aislo la factura `ccb31f6c-b357-4b5e-ae1b-b144ae22a1f9`,
   se sincronizaron exactamente dos copas de Pampaneando y se restauraron los
   `raw_json` originales en `finally`. No se creo ningun claim ajeno.
6. Para el 17/07, la factura `ba80735a-7970-4ae3-a007-c6a3438895ab` contenia
   tres grupos sin claim definitivo. El sincronizador, que opera por factura,
   proceso conjuntamente:
   - una copa de Pampaneando, correcta y ausente;
   - una copa de Menade, tambien una venta cerrada ausente;
   - una botella de Microcosmico Macabeo.
7. Microcosmico ya tenia un claim provisional `SUCCESS` del mismo dia y no
   tenia reversal. Por tanto, la ejecucion genero una segunda deduccion de una
   botella. No se oculto este hecho, no se borro el claim y no se hizo una
   compensacion por nombre.
8. `save-sales` con `skipStockSync` retrocedio temporalmente el cursor al
   18/07. Se restauro a su valor previo correcto, 21/07.

Resultado operativo actual:

- catalogo fresh 229/229 exacto;
- cursor 21/07;
- cola activa 0;
- alertas abiertas 0;
- fallos de stock del 22/07: 0;
- tracking `FAILED`: 0.

Pendiente no resoluble de forma segura solo desde esta operacion:

- anular la deduccion duplicada exacta de Microcosmico del 17/07;
- retirar la tarjeta historica duplicada de Chavost Paradoxe.

Ambos casos requieren un endpoint Winerim de anulacion/reversion de venta o
una operacion ERP aprobada que conserve trazabilidad. No deben corregirse con
otro `PUT stock` ni por coincidencia de nombre.

### PurOsushi

1. Se desactivo la escritura desde tickets abiertos y se mantuvo observacion.
2. Se ejecuto reconciliacion diferencial en lote maximo de dos productos:
   - B Boissonneuse, producto `709944`, vino `209944`;
   - B Keller Kirchspiel Riesling GG, producto `709986`, vino `209986`.
3. La verificacion posterior dio 357/357 productos exactos y cola 0.
4. Se revisaron los dias 18 y 21/07. Las unicas ventas definitivas mapeadas sin
   claim definitivo ya tenian un claim provisional `SUCCESS` exacto de la
   misma referencia, variante y cantidad. No se reimporto ninguna venta.
5. Un primer avance manual a 21/07 fue revertido automaticamente a 17/07 por
   `activeOpenTicketDays=[2026-07-18, 2026-07-21]`. Esta carrera se observo en
   vivo y no se oculto.
6. Se desactivo temporalmente la lectura de tickets abiertos solo en esta
   conexion y se vacio su guard de cursor, conservando snapshot completo en
   `outputs/AGORA_REMEDIATION_BATCH_A_PUROSUSHI_CURSOR_ROLLBACK_2026-07-22.json`.
7. `auto-sync-sales` proceso las facturas cerradas del 18 y 21/07: 16 eventos,
   217 lineas, 0 escrituras nuevas, 8 claims idempotentes omitidos y 0 fallos.
   El cursor avanzo de forma estable a 21/07.
8. Una segunda ejecucion confirmo que `sync-open-tickets` queda omitido por
   configuracion y que `auto-sync-sales` conserva el cursor sin dias abiertos.
9. Tras esperar un ciclo completo adicional de cinco minutos, el cursor seguia
   en 21/07, el guard seguia vacio y no aparecieron alertas, cola ni fallos de
   stock.
10. El monitor resolvio la alerta `sales_stale` sin enviar email.
11. El producto `1113781`, sin ownership probado, no se adopto ni modifico.

Resultado operativo actual:

- catalogo fresh 357/357 exacto;
- cursor 21/07;
- observabilidad de tickets abiertos desactivada temporalmente;
- cola activa 0;
- alertas abiertas 0;
- fallos de stock del 22/07: 0;
- tracking `FAILED`: 0.

El historial provisional/definitivo antiguo no se borro. Su limpieza tambien
depende de una anulacion explicita en Winerim.

### Restaurante Qtomas

1. Se desactivo la escritura desde tickets abiertos.
2. Se activo la operacion automatica por conexion:
   - `sync_frequency_minutes=5`;
   - `catalog_sync_enabled=true`;
   - `write_glass=true`;
   - `auto_push_on_create=true`;
   - `auto_push_on_update=true`;
   - `auto_push_verified_ready=true`.
3. Solo despues de verificar 1430/1430 productos fresh exactos, se normalizaron
   las 57 filas de tracking cuyo unico fallo era el timeout de verificacion.
4. Se hizo una prueba real de rollback sobre la fila
   `1dc7973f-31df-4a9e-8a84-8eef4c1051fb`: se restauro su estado `FAILED`, se
   verifico, y se reaplico `VERIFIED` con el timestamp de remediacion.
5. Se limpio el breaker expirado del 16/07, conservado solo como residuo, tras
   comprobar `consecutive_failures=0` y ausencia de alerta viva.

Resultado operativo actual:

- catalogo fresh 1430/1430 exacto;
- cursor 21/07;
- breaker cerrado y sin residuo;
- cola activa 0;
- alertas abiertas 0;
- fallos de stock del 22/07: 0;
- tracking `FAILED`: 0.

### Taberna de Elia

1. Se desactivo la escritura desde tickets abiertos y se mantuvo observacion.
2. La tarea `b4ec0355-9c8c-49f3-baab-608aecf6df17`, fallida por un `POS_DOWN`
   historico, solicitaba BOTTLE y GLASS del vino `255002`.
3. Una comprobacion fresh encontro ambos productos ya exactos. La tarea se
   marco `SUCCESS` sin replay y con nota explicita de resolucion.
4. El monitor dejo la conexion en `OK` y sin alerta de cola.

Resultado operativo actual:

- catalogo fresh 410/410 exacto;
- cursor 21/07;
- cola activa 0;
- alertas abiertas 0;
- fallos de stock del 22/07: 0;
- tracking `FAILED`: 0.

El historial provisional/definitivo antiguo se mantiene intacto hasta disponer
de una anulacion soportada por Winerim.

## Verificacion final conjunta

El monitor se ejecuto con `sendEmails=false` y `notifyClients=false`:

| Conexion | Monitor | Fresh catalogo | Abiertos observables | Cola | Alertas | Stock FAILED reciente |
|---|---|---:|---|---:|---:|---:|
| Kava | OK | 229/229 | si, sin escritura | 0 | 0 | 0 |
| PurOsushi | OK | 357/357 | no, bloqueo temporal | 0 | 0 | 0 |
| Restaurante Qtomas | OK | 1430/1430 | si, sin escritura | 0 | 0 | 0 |
| Taberna de Elia | OK | 410/410 | si, sin escritura | 0 | 0 | 0 |

La prueba de rollback de metadata de Qtomas termino `PASS`. No se probo el
rollback de `open_tickets_stock_sync_enabled` porque restaurarlo a `true`
reintroduciria deliberadamente la causa conocida de duplicaciones. El payload
anterior esta preservado en el snapshot general.

## Rollback disponible

- Configuracion por conexion: restaurar los valores `before` de
  `AGORA_REMEDIATION_BATCH_A_ROLLBACK_2026-07-22.json`.
- Qtomas tracking: seleccionar las filas de la conexion con
  `verified_at=2026-07-22T10:24:25.109Z` y restaurar el estado/error del
  snapshot.
- Qtomas breaker: restaurar, solo como dato historico, la pausa expirada
  `2026-07-16T15:01:59.026Z` y su razon almacenada.
- Taberna: restaurar los campos de la tarea `b4ec...` desde el snapshot si la
  prueba fresh fuera invalidada.
- PurOsushi: no se recomienda revertir los dos precios, porque el rollback
  devolveria el catalogo al estado incorrecto demostrado por el dry-run.
- PurOsushi cursor/abiertos: restaurar `provider_config` desde
  `AGORA_REMEDIATION_BATCH_A_PUROSUSHI_CURSOR_ROLLBACK_2026-07-22.json`; hacerlo
  antes de corregir el techo de cursor reactivaria el problema observado.
- Kava: las importaciones Winerim exitosas son append-only con la API actual;
  no existe rollback automatico seguro.

## Pendientes para el agente principal o cliente

1. Corregir en codigo que `save-sales` con `skipStockSync=true` pueda avanzar o
   retroceder `last_business_day_synced` durante una rehidratacion historica.
2. Incorporar un filtro de evento/linea al `sync-stock` no incremental para
   permitir recuperaciones exactas sin procesar todos los grupos de una
   factura.
3. Desacoplar el cursor de facturas cerradas de los tickets abiertos usados
   solo para observabilidad y filtrar tickets abiertos obsoletos; despues se
   puede reactivar la observabilidad de PurOsushi.
4. Deduplicar provisional y definitivo por identidad operativa cuando sean
   eventos distintos; desactivar nuevas escrituras provisionales ya evita que
   el problema siga creciendo.
5. Disponer de un endpoint Winerim de anulacion/reversion de venta que preserve
   trazabilidad para Chavost, Microcosmico y duplicados historicos de
   PurOsushi/Qtomas/Taberna.
6. Observar 24 horas y validar una venta cerrada y una anulacion real por cada
   conexion antes de firmar el historial historico como reconciliado.
