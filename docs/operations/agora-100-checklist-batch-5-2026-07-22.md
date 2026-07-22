# Auditoria Agora 100% - lote 5 - 2026-07-22

Alcance exclusivo: Restaurante Cienvinos Ecija, Restaurante Jardi, Restaurante Qtomas, Restaurante Triana y Sa Pedrera.

Modo: solo lectura. No se han cambiado precios, productos, flags, mappings, tracking, colas, legacy ni datos operativos. Todas las conexiones del lote estaban habilitadas, por lo que se hizo lectura fresh del catalogo en las cinco. No se imprimen credenciales.

Ventana operativa principal: siete dias desde `2026-07-15`. Las lecturas de salud y catalogo se cerraron el `2026-07-22`, alrededor de `09:30 UTC`. Las comparaciones ERP citadas proceden de las auditorias autenticadas mas recientes disponibles. Una ausencia de evidencia se marca `WARN`; un `FAIL` exige una discrepancia o bloqueo comprobado.

## Resumen inicial

| Restaurante | 1 Conectividad | 2 Configuracion | 3 Catalogo | 4 Cambios auto | 5 Estructura / legacy | 6 Ventas | 7 Stock | 8 Resiliencia | 9 Monitorizacion | 10 Firma final |
|---|---|---|---|---|---|---|---|---|---|---|
| Restaurante Cienvinos Ecija | PASS | PASS | PASS | PASS | WARN | FAIL | FAIL | PASS | WARN | FAIL |
| Restaurante Jardi | PASS | WARN | WARN | WARN | WARN | FAIL | WARN | PASS | FAIL | FAIL |
| Restaurante Qtomas | PASS | FAIL | WARN | FAIL | FAIL | FAIL | FAIL | WARN | FAIL | FAIL |
| Restaurante Triana | PASS | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | WARN | FAIL | FAIL |
| Sa Pedrera | PASS | WARN | FAIL | WARN | WARN | FAIL | FAIL | WARN | FAIL | FAIL |

Resultado del lote: `0/5` conexiones cumplen `100%_SIGNED_OFF`. Ninguna conexion se clasifica `NOT_ACTIVE` porque las cinco estaban habilitadas en el momento de la lectura.

## Criterio de marcas

- `PASS`: control demostrado con evidencia real y vigente.
- `WARN`: funcionamiento parcial o ausencia de una prueba necesaria; no implica por si solo un fallo observado.
- `FAIL`: incumplimiento, discrepancia o bloqueo demostrado.
- `NOT_ACTIVE`: conexion deshabilitada; no se sondea. No aplica a este lote.

## 1. Restaurante Cienvinos Ecija

### Resultado por bloque

| Bloque | Estado | Evidencia |
|---|---|---|
| 1. Conectividad | PASS | Cinco health checks consecutivos `OK`; ultimo HTTP `200`, `133 ms`, sin breaker y `consecutive_failures=0`. |
| 2. Configuracion | PASS | Conexion activa y `READY`, escritura `XML_IMPORT`, frecuencia `5 min`, alta/update/verified-ready, botella, copa, catalogo e intradia activados. Tickets abiertos activos solo como lectura; escritura de stock provisional desactivada. Zona `Europe/Madrid`. |
| 3. Catalogo | PASS | Lectura fresh: `519/519`, `missing=0`, `different=0`, `unownedExisting=0`, cola activa `0`. Tracking: `519 VERIFIED + 12 HIDDEN`. Retirados Winerim aun vendibles: `0`. |
| 4. Cambios automaticos | PASS | Hay canaries previos de alta/update con propagacion observada de `50-82 s`, dentro del objetivo de cinco minutos. No se genero un cambio artificial en esta auditoria. |
| 5. Estructura / legacy | WARN | Ocho familias Winerim contienen `519` formatos, pero tienen `ShowInPos=false`; la familia visible `VINOS` esta vacia. Existe `1` producto no ownership, `C MANZANILLA ZULETA`, vendible dentro de `COPAS WINERIM` y con uso reciente. El export no certifica el buscador fisico ni el arbol de categorias del terminal. |
| 6. Ventas | FAIL | Transporte activo, pero no concilia. Del 15 al 21/07: Agora cerrado `451` lineas / `535` uds.; ledger exitoso `180` filas / `525` uds.; ERP TPV `184` tarjetas / `447` uds. El 21/07: Agora `60` uds., ledger `67`, ERP `30`. |
| 7. Stock | FAIL | En siete dias: `194` intentos, `180 SUCCESS` y `14 FAILED`; variantes: `22 botella`, `158 copa`. Rutas exitosas: `5 intraday_day_total_delta` y `175 sales_only_stock_inactive`. La divergencia de cantidades y los fallos 500/503 impiden certificar exactitud de stock/historial. |
| 8. Resiliencia | PASS | Breaker cerrado, fallos consecutivos `0`, cola activa `0` y claves idempotentes exitosas exactamente duplicadas `0`. La conexion se recupero despues de los errores 500/503 observados el 19-20/07. |
| 9. Monitorizacion | WARN | No habia alerta abierta al cierre, pero la ausencia de alerta no detecta la divergencia Agora-ledger-ERP. Hubo `14` fallos recientes y el control de conciliacion debe formar parte del monitor, no solo salud HTTP. |
| 10. Firma final | FAIL | Catalogo y automatizacion estan listos, pero las ventas reales no concilian y la navegacion/buscador no esta certificada. No es `100%_SIGNED_OFF`. |

### Ventas reales, variantes y hora

- Ultimas ventas fuente detectadas: `C Satinela Semidulce`, copa, `1`, `sold_at=2026-07-21T23:19:23`; `C Pinchaperas`, copa, `1`, `sold_at=2026-07-21T23:16:06`; `B Manzanilla Gabriela`, botella, documento agregado `2`, `sold_at=2026-07-21T21:49:25`.
- El ledger conserva `provider_sold_at`, pero el ERP auditado expuso `time=null`; la hora real no queda demostrada de extremo a extremo.
- No hubo venta magnum real en la ventana, por lo que esa variante carece de canary.
- Se detectaron seis lineas negativas en facturas cerradas en la auditoria ampliada, pero no una prueba controlada de anulacion que demuestre la correccion del historial ERP.
- Latencia conocida: catalogo `50-82 s`. La latencia de ventas a ERP no se firma por las discrepancias de cantidad y de hora.

### Falta exactamente para 100%

1. Conciliar por documento las diferencias del 15-21/07 entre Agora, ledger y ERP sin borrar ni compensar por nombre.
2. Ejecutar una venta cerrada conocida de botella y otra de copa y comparar producto, cantidad, variante, `sold_at` y una unica tarjeta ERP.
3. Ejecutar un canary magnum si el restaurante usa esa variante.
4. Confirmar visualmente buscador y navegacion en el terminal, y decidir el tratamiento de `C MANZANILLA ZULETA`.
5. Incorporar una alerta de divergencia de conciliacion, no solo de conectividad o fallos HTTP.

## 2. Restaurante Jardi

### Resultado por bloque

| Bloque | Estado | Evidencia |
|---|---|---|
| 1. Conectividad | PASS | El TPV respondio HTTP `200` en cinco checks; ultimo `94 ms`. No hay breaker ni fallos consecutivos. El transporte funciona aunque el health funcional figura `STALE`. |
| 2. Configuracion | WARN | Conexion activa y `READY`, escritura `XML_IMPORT` y flags de catalogo activos, pero frecuencia configurada `15 min`, no cinco. `last_business_day_synced=2026-07-10` no avanza pese a actividad intradia posterior. |
| 3. Catalogo | WARN | Lectura fresh de producto: `177/177`, sin missing, diferencias ni retirados vendibles. Sin embargo, tracking conserva `182 VERIFIED`: cinco formatos retirados siguen con metadata obsoleta. Catalogo fisico correcto; trazabilidad no cerrada. |
| 4. Cambios automaticos | WARN | Hay flags de alta/update y evidencia anterior de update, pero no canary observado de alta ni dos ciclos consecutivos en cinco minutos. La propia frecuencia de `15 min` incumple el SLA objetivo. |
| 5. Estructura / legacy | WARN | Familias antiguas de vino aparecen ocultas y con `0` productos vendibles. La familia `BODEGA` conserva `2` productos no ownership vendibles. No hay confirmacion fisica de que el buscador no localice legacy residual. |
| 6. Ventas | FAIL | Hay trafico reciente, pero el cursor definitivo esta parado en 10/07 y existe alerta `sales_stale`. En siete dias: `89` eventos, `849` lineas, `148` candidatas, solo `30` mapeadas y `120` sin resolver. No se dispuso de ERP autenticado de Jardi; la completitud no puede firmarse. |
| 7. Stock | WARN | `18/18 SUCCESS`, `0 FAILED`; `13 botella`, `5 copa`; `8` operaciones delta y `10` sales-only por stock inactivo. Falta ERP autenticado, canary de cancelacion y evidencia magnum. Es ausencia de evidencia, no fallo de la API de stock. |
| 8. Resiliencia | PASS | Breaker cerrado, fallos consecutivos `0`, cola activa `0` y duplicados exactos de idempotency key `0`. |
| 9. Monitorizacion | FAIL | Alerta `sales_stale` abierta, `3` ocurrencias entre 09:10 y 09:30 UTC. Health alterna `OK/STALE`; el ultimo estado era `STALE`. |
| 10. Firma final | FAIL | Catalogo fisico exacto, pero ventas definitivas, ERP, cadencia y canaries no estan cerrados. No es `100%_SIGNED_OFF`. |

### Ventas reales, variantes y hora

- Ultimas mapeadas: `B Hito`, botella, `2`, `sold_at=2026-07-21T16:16:12`; `C Algars Blanc`, copa, `2`, `sold_at=2026-07-21T15:18:45`; `B La Rosa`, botella, `1`, `sold_at=2026-07-18T22:47:57`.
- El ledger demuestra botella y copa, y demuestra las dos ramas, stock y sales-only.
- ERP: `NO AUDITADO` con sesion propia de Jardi. No se interpreta esa ausencia como una venta fallida concreta, pero impide el PASS.
- Cancelaciones: `0` casos recientes; no existe canary de anulacion. Magnum: sin evidencia real reciente.
- Latencia conocida: salud HTTP `94 ms`; catalogo/ventas a negocio configurados a `15 min`, sin medicion que pruebe cinco minutos.

### Falta exactamente para 100%

1. Corregir o justificar `last_business_day_synced=2026-07-10` y cerrar la alerta `sales_stale` solo cuando avance con facturas definitivas.
2. Cambiar la cadencia efectiva a cinco minutos y medir dos ciclos consecutivos.
3. Conciliar al menos diez dias con el ERP autenticado de Jardi.
4. Corregir los cinco tracking `VERIFIED` retirados a su estado real, sin tocar productos ya no vendibles.
5. Clasificar los dos productos vendibles de `BODEGA` y confirmar el buscador fisico.
6. Ejecutar canaries de alta, precio, hide/reactivate y cancelacion; anadir magnum si aplica.

## 3. Restaurante Qtomas

### Resultado por bloque

| Bloque | Estado | Evidencia |
|---|---|---|
| 1. Conectividad | PASS | Cinco checks HTTP `200`; ultimo `110 ms`, `consecutive_failures=0`. El breaker ya no esta vigente. |
| 2. Configuracion | FAIL | Frecuencia `15 min`; `auto_push_on_create=false`, `auto_push_on_update=false`, `auto_push_verified_ready=false`, `catalog_sync_enabled=false` y escritura automatica de copa desactivada. El motivo historico de breaker sigue almacenado aunque la pausa expiro. |
| 3. Catalogo | WARN | Lectura fresh: `1430/1430`, sin missing/different/unowned y cola activa `0`. Pero tracking mantiene `57 FAILED` aunque los productos ya existen y coinciden. Retirados Winerim vendibles: `0`. |
| 4. Cambios automaticos | FAIL | Alta, update y catalog sync estan apagados. No puede demostrarse ni garantizarse la propagacion automatica de nuevos vinos, precios, ocultacion o reactivacion. |
| 5. Estructura / legacy | FAIL | Las familias legacy estan ocultas a nivel familia, pero miles de productos siguen vendibles. Ejemplos: `VINO TINTO` `952`, `VINO BLANCO` `449`, `COPAS` `250`, `VINOS POR COPA` `38`, `VINO ESPUMOSO` `82`. Son localizables potencialmente por buscador al conservar flags de venta. |
| 6. Ventas | FAIL | Siete dias: `212` eventos, `2310` lineas, `724` candidatas y solo `10` mapeadas; `714` sin resolver. El ERP contiene duplicacion funcional por provisional + definitiva: Domaine Roumier Agora `2`, ERP `4`; Cherisey `1`, ERP `2`; Emilio Moro `1`, ERP `2`. |
| 7. Stock | FAIL | `20` filas: `19 SUCCESS`, `1 FAILED`; solo botella. Hay `15` deltas y `4` restauraciones, pero restaurar stock no elimina la tarjeta provisional del ERP. Copa y magnum no tienen canary. |
| 8. Resiliencia | WARN | Breaker efectivo cerrado y cola activa `0`; claves exactas duplicadas `0`. Sin embargo, persiste motivo de breaker historico y la idempotencia semantica falla: distintas claves representan la misma venta provisional/definitiva. |
| 9. Monitorizacion | FAIL | No habia alerta abierta pese a `57` tracking FAILED, automatizacion desactivada y duplicaciones ERP demostradas. El estado HTTP `OK` produce una falsa sensacion de integracion completa. |
| 10. Firma final | FAIL | Catalogo presente, pero cambios automaticos, legacy, ventas, cancelaciones y monitorizacion incumplen el contrato. No es `100%_SIGNED_OFF`. |

### Ventas reales, variantes y hora

- Ultima mapeada: `B Domaine Roumier Chambolle-Musigny`, botella, definitiva `2`, `sold_at=2026-07-20T21:30:01`.
- Para esa misma venta existen dos provisionales de `1` y una definitiva de `2` en el ERP. Es fallo comprobado, no ausencia de evidencia.
- Se registraron cuatro `open_ticket_cancellation_restore`; corrigen inventario, pero no anulan la venta provisional ya importada.
- Variantes: solo botella con evidencia. Copa y magnum sin prueba.
- Latencia conocida: salud HTTP `110 ms`; sincronizacion configurada a `15 min`; catalogo automatico apagado.

### Falta exactamente para 100%

1. Desactivar escritura de ventas provisionales o implementar anulacion remota idempotente antes de mantener el piloto de tickets abiertos.
2. Reconciliar por identificador externo las tres duplicaciones demostradas, sin compensar por nombre ni sobrescribir stock.
3. Clasificar y ocultar de forma reversible los productos legacy solo despues de asignar sustituto y validar uso real.
4. Activar create/update/verified/catalog sync de forma escalonada y ejecutar canaries de alta, precio, hide y reactivacion.
5. Corregir los `57` tracking FAILED demostrados resueltos por el catalogo fresh.
6. Probar botella, copa, magnum, sales-only y stock activo, con una unica tarjeta ERP y hora real.
7. Anadir alertas de automatizacion apagada, tracking incoherente y duplicacion funcional.

## 4. Restaurante Triana

### Resultado por bloque

| Bloque | Estado | Evidencia |
|---|---|---|
| 1. Conectividad | PASS | Cinco checks `OK`; ultimo HTTP `200`, `116 ms`, breaker cerrado y fallos consecutivos `0`. |
| 2. Configuracion | FAIL | Frecuencia `5 min` y catalogo activo, pero `auto_push_glass=false` aunque existen copas. La configuracion no cubre todas las variantes aplicables. |
| 3. Catalogo | FAIL | Lectura fresh principal `129/129` sin diferencias, pero dos formatos retirados siguen vendibles: Winerim `311359` MAGNUM producto `1211359` y Winerim `311360` MAGNUM producto `1211360`, ambos Dehesa Gago. Tracking: `132 VERIFIED`, `188 NOT_PUSHED`, `3 HIDDEN`. |
| 4. Cambios automaticos | FAIL | Alta/update general estan activos, pero copa automatica esta apagada y no existe canary extremo a extremo reciente de alta, precio, hide o reactivacion. Los dos retirados aun vendibles prueban que el ciclo de retirada no esta cerrado. |
| 5. Estructura / legacy | FAIL | Legacy visible y vendible: `Vinos por copa` `102`, `Botellas Cava-Champagne` `24`, `Botellas Vino Blanco` `86`, `Botellas Vino TINTO` `186`, `Vinos generosos y dulces` `54`, entre otros. Son botones reales y potencialmente localizables por buscador. |
| 6. Ventas | FAIL | Siete dias: `1674` eventos, `10850` lineas, `2018` candidatas, `0` mapeadas y `2018` sin resolver. En diez dias la auditoria autenticada conto `2895` lineas legacy; el ERP Winerim mostro `0 EUR` y ninguna venta TPV integrada. |
| 7. Stock | FAIL | `0` filas de stock/sales-only. No existe evidencia de botella, copa, magnum, stock activo ni stock inactivo. El cero se debe al mapping nulo, no demuestra que el stock funcione. |
| 8. Resiliencia | WARN | Breaker cerrado y cola activa `0`, pero no hay trafico Winerim que permita probar idempotencia o recuperacion real. Cola vacia no equivale a operacion correcta. |
| 9. Monitorizacion | FAIL | No habia alerta abierta pese a `2018` candidatas sin mapping y `0` escrituras. El monitor no esta elevando el fallo funcional principal. |
| 10. Firma final | FAIL | El catalogo Winerim existe, pero el restaurante vende por legacy y Winerim no recibe ventas ni stock. Estado real: `CATALOG_READY / NOT_LIVE`. |

### Ventas reales, variantes y hora

- No hay ventas Winerim recientes en ledger ni ERP.
- Las ventas reales observadas pertenecen a botones legacy. En la auditoria ampliada destacaban `Altos Ribera Copa` y `Albarino Copa`; conservan hora fuente, pero no `winerim_id` ni variante Winerim.
- Cancelaciones, idempotencia, sales-only y stock activo: `SIN EVIDENCIA` porque no hay ninguna escritura integrada. No se califican como errores de endpoint aislados; el fallo comprobado es el mapping/uso operativo cero.
- Latencia de ventas: no medible. Catalogo configurado a cinco minutos, sin canary firmado.

### Falta exactamente para 100%

1. Activar y validar `auto_push_glass`.
2. Ocultar los dos magnum retirados que siguen vendibles, con snapshot reversible.
3. Inventariar cada boton legacy vendido y asignar sustituto Winerim exacto; no mapear productos genericos a un vino concreto.
4. Hacer ventas reales controladas desde botones Winerim de botella y copa, y magnum si aplica.
5. Verificar en menos de cinco minutos una unica tarjeta ERP con `sold_at`, variante y rama stock activo/sales-only correcta.
6. Ocultar legacy de forma reversible solo despues de demostrar sustitutos y flujo de sala.
7. Ejecutar canaries de alta, precio, hide/reactivate y cancelacion.
8. Crear alerta para candidatos de vino sin mapping y ausencia de ledger pese a ventas Agora.

## 5. Sa Pedrera

### Resultado por bloque

| Bloque | Estado | Evidencia |
|---|---|---|
| 1. Conectividad | PASS | El TPV respondio HTTP `200`; ultimo check `217 ms`, sin breaker y con fallos consecutivos `0`. El health funcional figura `WARN`, no hay fallo de transporte. |
| 2. Configuracion | WARN | Frecuencia `5 min`; alta/update/verified, botella, copa, catalogo, intradia y tickets abiertos activos. Sin embargo, escritura provisional de stock desde tickets esta activa mientras existe deuda historica de duplicacion/cancelacion, y el cursor definitivo esta parado en `2026-07-15`. |
| 3. Catalogo | FAIL | Lectura fresh: `482/483`, `missing=0`, `different=1`, cola activa `0`. Diferencia real: Winerim `105908`, botella, producto `605908`, `B E545 -Egly-Ouriet 'Les Premices'`, con `PRICE_LIST_1_MISMATCH`. Retirados Winerim aun vendibles: `0`. |
| 4. Cambios automaticos | WARN | Flags activos y ciclo de cinco minutos configurado, pero la diferencia de precio sigue presente y no hay canary de alta/precio firmado en esta lectura. La configuracion por si sola no demuestra propagacion. |
| 5. Estructura / legacy | WARN | Las `17` familias legacy estan ocultas y sus `119` productos no Winerim constan no vendibles/no directos. Hay `1` producto no ownership vendible dentro de `TINTOS WINERIM`. Falta confirmar fisicamente que el buscador no localice legacy. |
| 6. Ventas | FAIL | Siete dias: `158` eventos, `2048` lineas, `774` candidatas, `181` mapeadas y `600` sin resolver. El cursor definitivo sigue en 15/07. Auditoria ERP de 11-20/07: `169` lineas definitivas mapeadas, `167` SUCCESS y `207` tarjetas ERP; diferencias en `38` stockIds y `45` combinaciones dia/stock. |
| 7. Stock | FAIL | `177` filas: `124 SUCCESS`, `4 FAILED`, `49 SKIPPED`; `79 botella`, `43 copa`, `2 magnum`. Rutas: `64` delta, `44` sales-only, `16` restauraciones. Fallo vivo repetido: `B B310- Albenc`, Winerim `296315`, `404 Wine not found/access`. |
| 8. Resiliencia | WARN | Breaker cerrado, cola operativa activa `0` y duplicados exactos de clave `0`. Persisten `1255` tareas BLOCKED historicas, mayoritariamente ocultaciones truncadas, y la escritura provisional mantiene riesgo semantico. No deben reintentarse masivamente. |
| 9. Monitorizacion | FAIL | Dos alertas abiertas: `sales_stale`, `778` ocurrencias desde 17/07; `stock_sync`, `152` ocurrencias desde 21/07. Health funcional `WARN` con severidad `error`. |
| 10. Firma final | FAIL | Catalogo casi exacto, pero hay diferencia de precio, cursor bloqueado, fallo 404, divergencia ERP y alertas activas. No es `100%_SIGNED_OFF`. |

### Ventas reales, variantes y hora

- Ultimas mapeadas: `B T52-Pintia`, botella, `1`, `sold_at=2026-07-21T21:52:29`; `C T33 -Arrocal Joven Roble`, copa, `2`, `sold_at=2026-07-21T21:35:42`; `C B310- Albenc`, copa, `1`, `sold_at=2026-07-21T20:49:09`.
- Se observan botella, copa y magnum, ademas de stock activo y sales-only.
- Hay `16` restauraciones por cancelacion, pero la conciliacion ERP sigue abierta; restaurar stock no demuestra por si solo que el historial quede anulado correctamente.
- Claves idempotentes exactas duplicadas: `0`; aun asi existen fingerprints repetidos en ERP, por lo que la idempotencia funcional no esta firmada.
- Latencia configurada: cinco minutos. Ejemplos recientes varian desde unos minutos hasta mas de una hora al normalizar hora local/UTC; no existe SLA de venta a ERP demostrado de forma estable.

### Falta exactamente para 100%

1. Resolver el `404` de Albenc `296315`: reactivar, sustituir con mapping exacto o clasificar como legacy aceptado.
2. Reprocesar diferencialmente los dias pendientes solo despues de resolver Albenc y comprobar que el cursor avanza sin saltar ventas.
3. Corregir el precio de lista del producto `605908` y repetir lectura fresh.
4. Conciliar por `saleId` las tarjetas ERP sobrantes y las `38/45` diferencias; no cancelar por nombre.
5. Decidir si se desactiva la escritura provisional de tickets o implementar anulacion remota idempotente antes de mantenerla.
6. Clasificar/archivar las `1255` tareas historicas tras snapshot; no hacer replay masivo.
7. Confirmar en terminal que el legacy oculto no aparece por buscador y clasificar el producto no ownership de `TINTOS WINERIM`.
8. Ejecutar canaries de alta, precio, botella, copa, magnum, cancelacion, stock activo y sales-only, con una unica tarjeta ERP y `sold_at` correcto.
9. Cerrar las alertas solo tras eliminar el fallo y observar al menos 24 horas estables.

## Conclusiones del lote

1. `Catalogo N/N` no equivale a integracion completa: Qtomas y Triana lo demuestran con ventas duplicadas o nulas.
2. La conectividad HTTP es PASS en las cinco, pero solo Cienvinos tiene catalogo y automatizacion de cambios demostrados dentro de cinco minutos.
3. Ninguna conexion puede firmarse al 100% mientras Agora, ledger y ERP no concilien por documento, cantidad, variante y `sold_at`.
4. La ausencia de claves idempotentes exactamente duplicadas no descarta duplicacion funcional por ticket provisional + factura definitiva.
5. Los casos sin evidencia se han dejado como WARN o se han descrito expresamente como `SIN EVIDENCIA`; no se han convertido en FAIL salvo cuando existe una discrepancia comprobada.
