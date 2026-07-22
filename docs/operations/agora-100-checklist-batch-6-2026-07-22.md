# Auditoria Agora 100% - lote 6

Fecha: `2026-07-22`

Restaurantes: Sa Vida, Saddle, Taberna de Elia, Tintorera y Vinatea.

Modo: `SOLO LECTURA`.

## Criterio y alcance

- El corte vivo se realizo aproximadamente entre las `11:20` y las `11:36 CEST`.
- Se hizo lectura fresh de salud y catalogo exclusivamente en las conexiones activas.
- Saddle estaba deshabilitada. Se clasifico `NOT_ACTIVE` sin lanzar sondas externas.
- Se contrastaron configuracion, master fresh, cache Winerim, mappings, tracking,
  tareas, alertas, ledger canonico y logs de stock/cancelacion.
- La evidencia ERP procede de las conciliaciones autenticadas mas recientes ya
  documentadas. Cuando no existe una comprobacion ERP valida, se indica como
  ausencia de evidencia y no se convierte automaticamente en fallo.
- Los `sold_at` sin sufijo se interpretan en la zona de la conexion,
  `Europe/Madrid`. Los timestamps con `Z` estan en UTC.
- `PASS` significa comprobacion positiva. `WARN` significa ausencia de una
  prueba obligatoria o riesgo no cerrado. `FAIL` significa discrepancia o
  incidencia realmente observada. `NOT_ACTIVE` significa que la conexion esta
  deshabilitada y no se ha sondeado.
- No se modificaron precios, productos, flags, mappings, tracking, colas,
  legacy ni ningun otro dato operativo. No se imprimen credenciales.

## Resumen inicial

| Restaurante | 1 Conectividad | 2 Configuracion | 3 Catalogo | 4 Cambios auto. | 5 Estructura/legacy | 6 Ventas | 7 Stock | 8 Resiliencia | 9 Monitorizacion | 10 Firma final |
|---|---|---|---|---|---|---|---|---|---|---|
| Sa Vida | PASS | FAIL | FAIL | FAIL | WARN | FAIL | WARN | WARN | WARN | FAIL |
| Saddle | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE |
| Taberna de Elia | PASS | FAIL | PASS | WARN | WARN | FAIL | WARN | WARN | FAIL | FAIL |
| Tintorera | PASS | PASS | PASS | WARN | WARN | WARN | WARN | WARN | FAIL | FAIL |
| Vinatea | PASS | FAIL | PASS | WARN | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL |

**Resultado:** ninguna de las cinco conexiones cumple el criterio estricto
`100%_SIGNED_OFF` en este corte.

---

## Sa Vida

Estado conservador: `LIVE / FAIL_100_PERCENT`.

| Bloque | Estado | Evidencia |
|---|---|---|
| 1. Conectividad | PASS | Health fresh `HTTP 200` en `186 ms`; breaker cerrado, `0` fallos consecutivos y master fresh obtenido a las `11:30:11 CEST`. |
| 2. Configuracion | FAIL | Conexion, catalogo, altas y actualizaciones estan activos con escritura XML. Sin embargo, `auto_push_verified_ready=false` y la escritura desde tickets abiertos sigue habilitada pese a los ciclos de provisional/reversion/definitiva ya observados. |
| 3. Catalogo | FAIL | Reconciliacion fresh: `1532/1541 MATCH`, `4 MISSING`, `5 DIFFERENT`, `0` tareas activas. Winerim contiene `1278` vinos activos y `1541` formatos elegibles: `1264` botella, `257` copa y `20` magnum. |
| 4. Cambios automaticos | FAIL | Los flags no sustituyen la prueba. El catalogo conserva nueve discrepancias y los canaries historicos tardaron aproximadamente `29 min` y `5 h 08 min`, muy por encima de cinco minutos. |
| 5. Estructura y legacy | WARN | El legacy principal esta oculto: familia `VINOS` con `16` productos no vendibles y sin uso reciente. `0` trackings `HIDDEN` siguen vendibles. Falta una validacion visual/search fresh del cliente y hay dos formatos con discrepancia de vendibilidad. |
| 6. Ventas | FAIL | Hay ventas reales de botella y copa, pero no existe conciliacion ERP autenticada vigente. Ademas, estan comprobados ciclos `+2/-2/+2` y `+1/-1/+1`: el stock puede quedar neto, pero la tarjeta provisional positiva puede permanecer en el historial. |
| 7. Stock | WARN | Cobertura stockId completa para los formatos elegibles: `1264/1264` botella, `257/257` copa y `20/20` magnum. En diez dias: `41 SUCCESS`, `15 SKIPPED`; `20` botellas y `21` copas. Se probaron stock activo y `sales-only`, pero no se concilio el saldo final ERP tras cancelaciones. |
| 8. Resiliencia | WARN | Actualmente no hay breaker ni tareas fallidas/atascadas. El monitor resolvio episodios previos de `sales_stale`, pero la elevada recurrencia anterior y el retraso real de algunas ventas impiden firmar recuperacion automatica estable. |
| 9. Monitorizacion | WARN | `0` alertas abiertas y `0 QUEUED/RUNNING`; tracking: `1533 VERIFIED`, `128 HIDDEN`, `121 NOT_PUSHED` y `3 FAILED`. El catalogo fresh demuestra que la deuda no esta cerrada aunque el monitor este verde. |
| 10. Firma final | FAIL | Catalogo no exacto, automatizacion fuera de SLA, cancelaciones no conciliadas y ausencia de firma ERP/visual actual. |

### Diferencias fresh de catalogo

Ausentes:

- `B Ester Canale Langhe Nebbiolo`.
- `B Giovanni Rosso Barolo Vigna Rionda Ester Canale`.
- `B Tavel Posterite Soixante-Dix`.
- `C Tavel Posterite Soixante-Dix`.

Diferentes:

- `B Dominio de Es Vinas Viejas de Soria`: lista de precio.
- `B Giovanni Rosso Barolo`: precio.
- `C Marta Mate`: nombre, boton, familia, vendibilidad y precio.
- `B Pairal`: precio.
- `C Primordium`: vendibilidad y precio.

No hay productos con tracking `HIDDEN` todavia vendibles, pero `C Marta Mate`
y `C Primordium` tienen una discrepancia fresh de vendibilidad. Por ello la
regla de retirada no puede darse por firmada.

### Ventas, variantes y latencia

La ventana de diez dias contiene `2985` lineas POS, de las que `59` son vino
mapeado (`22 BOT`, `37 COPA`). Las restantes incluyen principalmente comida y
otros productos POS; no se consideran automaticamente fallos de mapping de
vino.

| Producto | Variante | Cantidad | sold_at Agora | Modo observado |
|---|---|---:|---|---|
| B Cami dels Xops Ancestral | botella | 1 | `2026-07-21 20:53:00` | Stock activo, stockId de botella |
| C Antoine Sanzay La Paterne | copa | 2 | `2026-07-21 21:07:15` | `sales-only`, stock inactivo |
| C Kir Yianni Assyrtiko The North | copa | 3 | `2026-07-21 15:04:02` | Venta mapeada |

- Canary historico de ventas: `3 min 04 s`.
- La botella mas reciente se persistio alrededor de las `02:00 CEST` del dia
  siguiente, por lo que la operacion real no demuestra una cadencia estable de
  cinco minutos.
- Idempotencia tecnica: `0` claves `SUCCESS` exactamente duplicadas.
- Cancelaciones: `5` restores de ticket y `3` movimientos negativos recientes.
  El neto de stock puede ser correcto, pero el historial no esta conciliado.

---

## Saddle

Estado: `READ_ONLY / NOT_ACTIVE / NO_GO`.

| Bloque | Estado | Evidencia |
|---|---|---|
| 1. Conectividad | NOT_ACTIVE | `enabled=false`. No se lanzo sonda fresh, tal como exige el alcance. |
| 2. Configuracion | NOT_ACTIVE | Escritura `NONE`; catalogo, altas, cambios y readiness desactivados. |
| 3. Catalogo | NOT_ACTIVE | No hay master, cache Winerim, mappings ni tracking en el backend de Lovable Cloud. |
| 4. Cambios automaticos | NOT_ACTIVE | No estan activados y no existen canaries. |
| 5. Estructura y legacy | NOT_ACTIVE | Sin master vivo no puede verificarse visibilidad, buscador ni retirados. |
| 6. Ventas | NOT_ACTIVE | No hay ledger integrado ni prueba ERP. |
| 7. Stock | NOT_ACTIVE | No hay stock logs, stockIds certificados ni flujo `sales-only`. |
| 8. Resiliencia | NOT_ACTIVE | La ausencia de health/alertas no demuestra salud en una conexion deshabilitada. |
| 9. Monitorizacion | NOT_ACTIVE | No hay monitor operativo de la conexion. |
| 10. Firma final | NOT_ACTIVE | No procede firmar una conexion deshabilitada. |

La ultima evidencia historica de solo lectura, no fresh en este corte, mostro
`14` familias, `4552` productos, `129` facturas y `1924` lineas en siete dias.
Incluia menus, armonias, `MenuGroup` y referencias de devolucion. Esa evidencia
solo confirma viabilidad tecnica potencial; no demuestra integracion Winerim.

El bloqueo real es funcional: menus y armonias requieren la composicion
versionada de tSpoonLab para convertir una tecla Agora en los vinos y formatos
realmente consumidos. Inferirlos por nombre produciria stock e historial falsos.

---

## Taberna de Elia

Estado: `LIVE / CATALOG_READY / FAIL_HISTORY_RECONCILIATION`.

| Bloque | Estado | Evidencia |
|---|---|---|
| 1. Conectividad | PASS | Health fresh `HTTP 200` en `234 ms`; breaker cerrado y master fresh a las `11:22:42 CEST`. La caida nocturna se recupero. |
| 2. Configuracion | FAIL | Conexion, catalogo, altas, cambios y readiness estan activos. La escritura de tickets abiertos tambien sigue activa aunque ya se demostro duplicidad logica al llegar la factura definitiva. |
| 3. Catalogo | PASS | `410/410 MATCH`, `0 MISSING`, `0 DIFFERENT`; `364` vinos activos y `410` formatos: `348` botella, `50` copa, `12` magnum. `410 VERIFIED`, `7 HIDDEN`, `417 CONFIRMED`. |
| 4. Cambios automaticos | WARN | Existe un canary historico de alta en `99 s`, pero no una bateria vigente completa de alta, precio, retirada y reactivacion. Una actualizacion fallo durante la caida y permanece como deuda historica aunque el master actual sea exacto. |
| 5. Estructura y legacy | WARN | Legacy oculto reversiblemente: `955` candidatos no vendibles y sin uso posterior al 12/07; los `7` formatos Winerim retirados tambien estan ocultos y `0` siguen vendibles. Falta firma visual/search reciente del cliente. |
| 6. Ventas | FAIL | Conciliacion ERP 11-20/07: `50` lineas definitivas Agora frente a `76` tarjetas TPV ERP y `49` logs `SUCCESS`. Casos Aalto, Luis R, Predicador y Mauro muestran snapshots provisionales repetidos. |
| 7. Stock | WARN | Cobertura stockId completa (`348/348`, `50/50`, `12/12`). En diez dias: `53 SUCCESS`, `26 SKIPPED`; `29` botellas y `24` copas. Hay stock activo y `sales-only`, pero las cancelaciones no estan cerradas contra el historial ERP. |
| 8. Resiliencia | WARN | La conexion se recupero automaticamente y no tiene tareas activas. Quedan `4` FAILED/BLOCKED en diez dias: una caida `POS_DOWN` reciente y tres HTTP 404 antiguas sin clasificacion final. |
| 9. Monitorizacion | FAIL | Al corte existe una alerta `outbound_queue` abierta con `59` ocurrencias, pese a que la cola activa es cero. |
| 10. Firma final | FAIL | Catalogo exacto, pero historial duplicado, cancelaciones no seguras, alerta abierta y tareas fallidas sin cerrar. |

### Ventas, variantes y latencia

La ventana contiene `1712` lineas POS y `106` lineas de vino mapeadas. La
muestra reciente mantiene equilibrio de formatos: aproximadamente `53` copa y
`53` botella.

| Producto | Variante | Cantidad | sold_at Agora | Resultado |
|---|---|---:|---|---|
| C Silva Daponte Godello | copa | 2 | `2026-07-21 13:13:34` | `sales-only`, stock inactivo |
| B Dehesa de Los Canonigos | botella | 1 | `2026-07-21 14:48:06` | Stock activo |
| C Silva Daponte Godello | copa | 1 | `2026-07-21 15:51:33` | Venta mapeada |

- La botella Dehesa de Los Canonigos se sincronizo a las `14:50:13 CEST`:
  latencia observada `2 min 07 s`.
- La copa Silva Daponte de las `13:13:34` se proceso a las `16:15:29 CEST`:
  latencia observada aproximada `3 h 01 min 55 s`.
- Idempotencia tecnica: `0` claves `SUCCESS` exactas duplicadas.
- Idempotencia semantica: FAIL. El caso confirmado de ticket abierto y factura
  definitiva genera dos tarjetas positivas con claves distintas.
- Cancelaciones: `3` restores; existen cantidades negativas, pero Winerim no
  ofrece anulacion negativa idempotente de la tarjeta provisional ya creada.

---

## Tintorera

Estado: `LIVE_PENDING_SALE_CANARY`.

| Bloque | Estado | Evidencia |
|---|---|---|
| 1. Conectividad | PASS | Health fresh `HTTP 200` en `121 ms`; master fresh a las `11:35:05 CEST`. La caida nocturna se recupero. |
| 2. Configuracion | PASS | Conexion bidireccional, XML, catalogo, altas, cambios y readiness activos; cadencia configurada de cinco minutos. Tickets abiertos se observan, pero no escriben stock/historial provisional. |
| 3. Catalogo | PASS | `313/313 MATCH`, `0 MISSING`, `0 DIFFERENT`; `300` vinos activos y `313` formatos: `285` botella, `13` copa, `15` magnum. Cobertura stockId `313/313`; mappings y tracking `313/313`. |
| 4. Cambios automaticos | WARN | La configuracion esta activa, pero no existe canary real con timestamps para alta, precio, retirada y reactivacion. `N/N` no prueba propagacion automatica. |
| 5. Estructura y legacy | WARN | Legacy preservado deliberadamente. La familia `Bodega` esta oculta, pero conserva `521` productos vendibles y por tanto localizables por buscador. No hay productos Winerim `HIDDEN` todavia vendibles. |
| 6. Ventas | WARN | Ausencia de evidencia: `0` lineas de vino mapeadas y ninguna venta real de botella/copa verificada en ERP. No es un fallo comprobado de importacion, pero bloquea la firma. |
| 7. Stock | WARN | Los stockIds estan capturados para botella, copa y magnum, pero hay `0` stock logs. No se han probado stock activo, `sales-only`, variante ni cancelacion. |
| 8. Resiliencia | WARN | Recuperacion automatica de la caida demostrada y breaker sano. Quedan `2` tareas FAILED recientes por `POS_DOWN`; no hay tarea activa. |
| 9. Monitorizacion | FAIL | Al corte hay una alerta `outbound_queue` abierta con `20` ocurrencias. |
| 10. Firma final | FAIL | Catalogo exacto sin canaries de ventas/stock/cancelacion ni SLA de cambios, con alerta abierta y legacy buscable. |

### Latencia y ventas

- Conectividad fresh: `121 ms`.
- Latencia Winerim -> Agora: no medida con un cambio real.
- Latencia Agora -> Winerim: no medida; no hay venta real mapeada.
- Idempotencia y cancelaciones: no hay evidencia, no se declaran fallidas.
- El cursor de negocio avanzo al `2026-07-21`, pero ese avance sin una venta de
  vino mapeada no acredita el flujo de vinos.

---

## Vinatea

Estado: `LIVE_PENDING_SALE_CANARY / FAIL_SALES_IMPORT`.

| Bloque | Estado | Evidencia |
|---|---|---|
| 1. Conectividad | PASS | Health fresh `HTTP 200` en `265 ms`; master fresh a las `11:32:23 CEST`; breaker cerrado y `0` fallos consecutivos. |
| 2. Configuracion | FAIL | Catalogo, alta, cambios y readiness estan activos. Tambien esta activa la escritura desde tickets abiertos pese a que la importacion de copas con stock inactivo persiste cantidad/variante/hora de forma incorrecta. |
| 3. Catalogo | PASS | `132/132 MATCH`, `0 MISSING`, `0 DIFFERENT`; `128` vinos activos y `132` formatos: `108` botella, `23` copa, `1` magnum. StockId completo `132/132`; `132 VERIFIED`, `242 CONFIRMED`. |
| 4. Cambios automaticos | WARN | No existe canary real de alta o precio con timestamps. Tampoco estan cerradas retirada y reactivacion. |
| 5. Estructura y legacy | FAIL | Las familias ocultas `50-55` conservan `174` productos activos y vendibles: `104` mapeados y `70` sin mapping. Siguen localizables por buscador y una venta de los `70` no tiene descuento garantizado. |
| 6. Ventas | FAIL | El ledger reciente contiene ventas, pero el cursor sigue en `2026-07-18` y hay ventas con `sold_at` del 21/07. La conciliacion ERP previa mostro `15` lineas/`22` unidades frente a `14` tarjetas/`14` unidades; nueve lineas de copa se muestran como botella, cantidad uno y sin hora. |
| 7. Stock | FAIL | En diez dias: `11 SUCCESS` de botella y `3 SKIPPED`; no hay `SUCCESS` de copa. Stock activo de botella funciona, pero el flujo `sales-only` de copa no queda correctamente representado en historial. |
| 8. Resiliencia | FAIL | Health verde, pero `last_business_day_synced=2026-07-18` y el catch-up no avanza pese a existir ventas posteriores. La recuperacion funcional no esta demostrada. |
| 9. Monitorizacion | FAIL | Al corte hay una alerta `sales_stale` abierta con `42` ocurrencias. Cola activa y tareas fallidas: cero. |
| 10. Firma final | FAIL | Catalogo exacto, pero ventas/cursor, copas, legacy sin mapping, alerta y cancelaciones impiden operacion cerrada. |

### Ventas, variantes y latencia

La lectura reciente contiene `48` lineas mapeadas: `24 COPA`, `14 BOT` y diez
lineas con etiquetas legacy. Ejemplos:

| Producto | Variante | Cantidad | sold_at Agora | Resultado |
|---|---|---:|---|---|
| COPA DE VILLARRICA | copa | 1 | `2026-07-21 14:47:05` | Mapeada; creada en ledger el 22/07; sin `SUCCESS` de copa |
| B Honeymoon | botella | 2 | `2026-07-21 16:47:15` | Stock activo |
| COPA DE REBELS DE BATEA BLANCO | copa | 1 | `2026-07-19 15:26:46` | Mapeada; representacion ERP incorrecta |

- B Honeymoon se sincronizo a las `16:51:54 CEST`: latencia `4 min 39 s`.
- No existe latencia valida de copa porque el flujo no termino correctamente.
- Idempotencia tecnica: `0` claves `SUCCESS` duplicadas. La segunda pasada del
  backfill de copas devolvio `0 imported / 9 skipped`, por lo que el endpoint
  fue idempotente aunque el contenido persistido fuera incorrecto.
- Cancelacion: no existe canary real; ausencia de evidencia, no fallo probado.

---

## Falta exacta para llegar al 100%

### Sa Vida

1. Corregir diferencialmente los `4` formatos ausentes y los `5` diferentes;
   repetir lectura fresh y exigir `1541/1541`.
2. Resolver o justificar `121 NOT_PUSHED` y `3 FAILED` sin replay masivo.
3. Conseguir canaries reales de alta, precio, retirada y reactivacion dentro
   del SLA de cinco minutos durante dos ciclos.
4. Desactivar escrituras provisionales desde tickets abiertos o disponer de
   anulacion idempotente antes de reactivarlas.
5. Conciliar al menos diez dias Agora/ledger/ERP por documento, linea,
   `sold_at`, variante y cantidad, incluyendo los ciclos `+/-/+`.
6. Verificar saldo antes/despues para botella con stock activo y copa
   `sales-only`, incluida una cancelacion.
7. Obtener validacion visual del cliente: familias, orden, buscador y ausencia
   de legacy/retirados localizables.
8. Observar 24 horas sin drift, alertas nuevas, breaker ni cola.

### Saddle

1. Mantenerla deshabilitada hasta modelar tSpoonLab.
2. Obtener credencial tecnica, centro de coste y relacion de codigos
   Agora/tSpoonLab.
3. Persistir composiciones versionadas de menus y armonias con vigencia.
4. Cargar catalogo Winerim y mappings explicitos por vino y formato.
5. Demostrar conectividad desde Lovable Cloud en modo lectura.
6. Ejecutar dry-runs de venta directa, menu, armonia, devolucion y cancelacion.
7. Solo despues activar un piloto sin stock y completar todos los canaries.

### Taberna de Elia

1. Mantener factura cerrada como fuente autoritaria y detener escrituras
   provisionales mientras no haya anulacion idempotente.
2. Conciliar y reparar, con snapshot y aprobacion, las `76` tarjetas ERP frente
   a `50` lineas definitivas; no limpiar por nombre/hora en bloque.
3. Clasificar las `4` tareas FAILED/BLOCKED y cerrar la alerta outbound sin
   reencolar un catalogo ya exacto.
4. Probar botella, copa, cancelacion y segundo ciclo sin duplicidad; verificar
   hora, variante, stock y ERP.
5. Completar canaries de alta, precio, retirada y reactivacion.
6. Obtener firma visual/search del cliente y observar 24 horas limpias.

### Tintorera

1. El cliente debe vender una botella y una copa desde botones Winerim.
2. Verificar en menos de cinco minutos ledger, ERP, `sold_at`, variante,
   cantidad, stock activo y `sales-only`.
3. Ejecutar una cancelacion y comprobar neto e idempotencia en dos ciclos.
4. Ejecutar canaries reales de alta, precio, retirada y reactivacion.
5. Resolver las `2` tareas FAILED y cerrar la alerta outbound.
6. Acordar y firmar la estrategia legacy; mientras permanezca, documentar que
   los `521` productos de Bodega siguen localizables y pueden no estar mapeados.
7. Validacion visual del cliente y 24 horas estables.

### Vinatea

1. Corregir el flujo Winerim `sales/import` para conservar variante copa,
   cantidad y `sold_at`; reparar las nueve tarjetas historicas sin tocar stock.
2. Corregir el cursor/catch-up, procesar los dias posteriores al 18/07 una sola
   vez y cerrar la alerta `sales_stale`.
3. Ejecutar ventas reales desde `COPAS WINERIM` y desde una copa legacy
   mapeada; ambas deben aparecer como copa con hora y cantidad correctas.
4. Probar botella con stock activo, copa `sales-only` y cancelacion, verificando
   stock e idempotencia en dos ciclos.
5. Resolver los `70` productos legacy vendibles sin mapping o retirarlos del
   buscador mediante ocultacion reversible aprobada.
6. Ejecutar canaries de alta, precio, retirada y reactivacion.
7. Obtener firma visual/search del cliente y observar 24 horas sin alerta,
   cursor atrasado ni diferencias.

## Decision final del lote

- `100%_SIGNED_OFF`: `0/5`.
- Activas con catalogo exacto pero no firmadas: Taberna de Elia, Tintorera y
  Vinatea.
- Activa con fallo fresh de catalogo: Sa Vida.
- Inactiva y no sondeada: Saddle.
