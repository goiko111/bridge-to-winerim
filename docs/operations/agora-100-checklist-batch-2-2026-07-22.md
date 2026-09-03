# Auditoria Agora al 100% - lote 2

Fecha: 2026-07-22
Alcance: De la O, Don Bernardo Ponzano, Don Bernardo Santander, Don Quijote Marbella y El Bejeque.
Modo: estrictamente solo lectura. No se han modificado conexiones, catalogos, precios, mappings, tracking, colas, legacy ni datos operativos.

## Resumen ejecutivo

| Restaurante | 1. Conectividad | 2. Configuracion | 3. Catalogo | 4. Cambios automaticos | 5. Estructura / legacy | 6. Ventas | 7. Stock | 8. Resiliencia | 9. Monitorizacion | 10. Firma | Estado global |
|---|---|---|---|---|---|---|---|---|---|---|---|
| De la O | PASS | WARN | PASS | WARN | WARN | FAIL | WARN | PASS | PASS | WARN | NO FIRMADO |
| Don Bernardo Ponzano | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE |
| Don Bernardo Santander | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE |
| Don Quijote Marbella | PASS | WARN | PASS | WARN | WARN | WARN | WARN | WARN | PASS | WARN | NO FIRMADO |
| El Bejeque | PASS | PASS | PASS | WARN | PASS | FAIL | WARN | PASS | PASS | WARN | NO FIRMADO |

Ninguna conexion de este lote puede clasificarse como `100%_SIGNED_OFF`.

### Criterio de clasificacion

- `PASS`: existe evidencia viva y suficiente del bloque.
- `WARN`: no hay un fallo vivo bloqueante, pero falta evidencia de una prueba obligatoria o queda deuda operativa.
- `FAIL`: hay una discrepancia funcional comprobada, no una mera ausencia de evidencia.
- `NOT_ACTIVE`: la conexion esta deshabilitada; no se han ejecutado sondas contra el TPV.

Los tiempos de espera no se han prolongado: las lecturas externas utilizadas terminaron dentro del limite. En este lote no hubo ningun timeout que reclasificar.

## Metodo y evidencias comunes

- Se leyeron las fuentes de verdad del proyecto y `AGORA_INTEGRATION_CHECKLIST.md` antes de auditar.
- Para las tres conexiones activas se hizo lectura fresca de catalogo Agora el 2026-07-22 a las 09:29 UTC. Las tres respondieron sin timeout.
- Para las dos conexiones deshabilitadas no se hizo ninguna sonda externa; sus cifras de catalogo Agora se identifican expresamente como snapshots historicos.
- Se contrastaron configuracion, cache Winerim, mappings, tracking, cola, alertas, eventos canonicos, lineas de venta, stock logs y las pantallas ERP de ventas disponibles.
- Un `updated_at` masivo del cache no se considero prueba de cambio real. Las latencias solo se atribuyen a tareas o canarios identificables.
- La ausencia de una prueba de reactivacion, cancelacion o cambio de precio no se presenta como fallo: se presenta como `WARN`.

## 1. De la O

### Evidencia cuantitativa

| Dato | Evidencia |
|---|---|
| Estado | Activa, `BIDIRECTIONAL`, escritura por `XML_IMPORT`, readiness `READY` |
| Salud | HTTP 200 en 122 ms; breaker cerrado y 0 fallos consecutivos |
| Catalogo fresco | 119/119 formatos Winerim presentes; 0 ausentes, 0 diferentes, 0 sin ownership; cola activa 0 |
| Cache Winerim | 117 vinos: 106 activos y 11 inactivos |
| Formatos elegibles | 90 botellas, 29 copas y 0 magnums; 0 stock IDs ausentes |
| Mappings | 139 `CONFIRMED`: 109 botella y 30 copa |
| Tracking | 119 `VERIFIED`, 20 `HIDDEN`, 0 errores |
| Ventas desde 15/07 | 139 eventos, 1.383 lineas, 37 lineas de vino mapeadas: 31 botella y 6 copa |
| Stock/sales import | 23 logs: 17 `SUCCESS`, 6 `SKIPPED`; 14 botella y 3 copa con exito; 8 exitos sales-only |
| Idempotencia | 0 claves de exito exactamente duplicadas |
| Operacion | 0 tareas activas, 0 fallidas/bloqueadas en 24 h y 0 alertas abiertas |

### Checklist por bloque

1. **Conectividad - PASS.** La sonda viva respondio HTTP 200 en 122 ms, sin breaker ni fallos consecutivos.
2. **Configuracion - WARN por riesgo conocido, no por caida.** Catalogo, altas, cambios, botella, copa, intradia y periodo de 5 minutos estan activos. Sin embargo, la escritura desde tickets abiertos sigue habilitada. El mismo consumo aparece en snapshots `OpenTicket` y en factura definitiva, por lo que la configuracion conserva una via de duplicacion funcional.
3. **Catalogo - PASS.** La lectura fresca dio 119/119, sin diferencias ni tareas pendientes. Los 139 mappings estan confirmados y no falta ningun stock ID para formatos elegibles.
4. **Cambios automaticos - WARN por evidencia incompleta.** Hay una alta real medida entre 32,4 y 53,1 segundos y una tarea de actualizacion procesada en 11,5 segundos. No se dispone de una medicion completa desde el guardado de un cambio de precio hasta su lectura fresca en Agora, ni de un canario completo inactivar-volver a activar.
5. **Estructura y legacy - WARN.** Las familias/productos Winerim estan presentes, pero el legacy continua localizable y vendible: el ultimo inventario verificable detecto 323 candidatos legacy, 54 en familias visibles y 269 bajo familias ocultas pero buscables. Esto es una condicion operativa conocida, no un fallo de publicacion Winerim.
6. **Ventas - FAIL real.** Hay ventas recientes visibles en ERP y ledger, incluidas botella y copa: Fortuny Fabregas botella el 21/07 a las 20:38-20:41, Lagar Santa Magdalena copa a las 22:14 y The Algeciras copa a las 22:34. No obstante, siguen sin reparar dos discrepancias historicas verificadas: Vina Mein quedo sobrerrepresentado tras una cancelacion y Camarolos infrarrepresentado al venderse por encima del stock. Ademas, el flujo provisional y definitivo sigue activo simultaneamente. La existencia de 414 candidatos no mapeados se registra como observacion de legacy, no como 414 fallos.
7. **Stock - WARN por cancelaciones no firmadas.** Se han observado stock activo y sales-only, botella y copa, sin stock IDs ausentes. No existe una cancelacion reciente controlada que demuestre la correccion integral de ERP e inventario; no se encontro log de cancelacion vinculado en la ventana de siete dias.
8. **Resiliencia - PASS.** Una incidencia externa de conectividad con 50 ocurrencias se recupero automaticamente; actualmente breaker, cola y contadores estan limpios. La idempotencia tecnica no muestra claves de exito duplicadas.
9. **Monitorizacion - PASS.** Salud viva, tracking sin errores, cola a cero y alertas abiertas a cero. Las alertas recientes de conectividad, outbound y ventas obsoletas figuran resueltas.
10. **Firma - WARN.** No puede firmarse mientras haya discrepancias de ventas sin reparar, legacy vendible y falta de canario completo de precio/reactivacion/cancelacion.

### Falta exactamente para 100%

1. Deshabilitar la escritura de stock/ERP desde tickets abiertos y dejar la factura cerrada como fuente definitiva, manteniendo los tickets solo para observabilidad si se desea.
2. Reconciliar y documentar Vina Mein y Camarolos en ERP/ledger sin volver a descontar stock.
3. Ejecutar un canario controlado de cambio de precio y medir guardado Winerim -> lectura fresca Agora.
4. Ejecutar un canario inactivar -> ocultar -> reactivar -> republicar.
5. Ejecutar una venta y cancelacion controladas para botella y, si aplica, copa, verificando ERP, ledger y stock.
6. Decidir con el cliente el tratamiento del legacy localizable por buscador y aplicar ocultacion reversible si procede.
7. Observar al menos 24 horas sin duplicados, tareas fallidas ni alertas antes de la firma.

## 2. Don Bernardo Ponzano

### Evidencia disponible sin sonda externa

| Dato | Evidencia |
|---|---|
| Estado | Deshabilitada, `PULL_ONLY`, escritura `NONE`, readiness `UNKNOWN` |
| Ultima sincronizacion registrada | 2026-06-23; no existe cursor de dia de negocio |
| Cache Winerim actual | 95 vinos activos; 93 botellas y 35 copas elegibles; 0 stock IDs ausentes |
| Mappings / tracking | 0 / 0 |
| Operacion desde 15/07 | 0 eventos, 0 lineas, 0 stock logs, 0 tareas activas y 0 alertas |
| Agora historico | Snapshot del 23/06: 169 candidatos legacy vendibles, casi todos visibles. No es evidencia fresca |

### Checklist por bloque

Los diez bloques se clasifican `NOT_ACTIVE`. La conexion esta deshabilitada y no se ha sondeado el TPV. Los 128 formatos elegibles del cache Winerim no estan respaldados por mappings ni tracking de publicacion. La ausencia de eventos, tareas o alertas no demuestra funcionamiento; solo demuestra ausencia de actividad del middleware.

### Falta exactamente para 100%

1. Autorizar la activacion y acordar estrategia visual/legacy con el cliente.
2. Verificar en vivo conectividad, modulo de integracion, API HTTP y endpoints Families, Products e Invoices.
3. Configurar modo operativo, zona horaria, dia de negocio, periodicidad y politica intradia/factura.
4. Publicar diferencialmente los 128 formatos elegibles y obtener mappings confirmados y tracking verificado.
5. Validar familia, orden, visibilidad, IVA, preparacion y buscador; revisar los 169 legacy del snapshot con lectura fresca.
6. Probar alta, precio, inactivacion y reactivacion Winerim -> Agora con latencia medida.
7. Probar venta real de botella y copa; validar `sold_at`, ERP, idempotencia y modo stock activo/sales-only.
8. Probar cancelacion/reembolso y recuperacion tras una indisponibilidad controlada.
9. Dejar cola y alertas a cero y observar 24 horas antes de firmar.

## 3. Don Bernardo Santander

### Evidencia disponible sin sonda externa

| Dato | Evidencia |
|---|---|
| Estado | Deshabilitada, `PULL_ONLY`, escritura `NONE`, readiness `UNKNOWN` |
| Ultima sincronizacion registrada | 2026-06-23; no existe cursor de dia de negocio |
| Cache Winerim actual | 147 vinos activos; 144 botellas y 48 copas elegibles; 0 stock IDs ausentes |
| Mappings / tracking | 0 / 0 |
| Operacion desde 15/07 | 0 eventos, 0 lineas, 0 stock logs, 0 tareas activas y 0 alertas |
| Agora historico | Snapshot del 23/06: 217 candidatos legacy vendibles y visibles. No es evidencia fresca |

### Checklist por bloque

Los diez bloques se clasifican `NOT_ACTIVE`. No se ha hecho ninguna sonda externa. Los 192 formatos elegibles del cache no tienen mapping ni evidencia de publicacion. Tampoco hay evidencia operativa reciente de ventas, stock, resiliencia o monitorizacion.

### Falta exactamente para 100%

1. Autorizar la activacion y decidir estructura/legacy.
2. Verificar en vivo conectividad, modulo, API HTTP y endpoints de catalogo y facturas.
3. Definir configuracion de ventas, zona horaria, dia de negocio, periodo e intradia.
4. Publicar los 192 formatos elegibles de forma diferencial y verificar mapping/tracking.
5. Contrastar el snapshot de 217 legacy con catalogo fresco y decidir ocultacion reversible.
6. Ejecutar canarios de alta, precio, inactivacion y reactivacion con latencia medida.
7. Ejecutar ventas reales de botella y copa, comprobando `sold_at`, ERP, stock activo/sales-only e idempotencia.
8. Validar cancelaciones, recuperacion automatica, cola y alertas.
9. Observar 24 horas estables y obtener conformidad del cliente.

## 4. Don Quijote Marbella

### Evidencia cuantitativa

| Dato | Evidencia |
|---|---|
| Estado | Activa, `BIDIRECTIONAL`, `XML_IMPORT`, readiness `READY` |
| Salud | HTTP 200 en 108 ms; breaker cerrado y 0 fallos consecutivos |
| Catalogo fresco | 114/114 formatos presentes; 0 ausentes, 0 diferentes, 0 sin ownership; cola activa 0 |
| Cache Winerim | 97 vinos: 96 activos y 1 inactivo |
| Formatos elegibles | 95 botellas, 15 copas y 4 magnums; 0 stock IDs ausentes |
| Mappings | 116 `CONFIRMED`: 96 botella, 16 copa y 4 magnum |
| Tracking | 114 `VERIFIED`, 1 `HIDDEN`, 0 errores |
| Ventas desde 15/07 | 159 eventos, 2.088 lineas y 81 lineas de vino mapeadas: 46 botella y 35 copa |
| Stock/sales import | 60 logs: 44 `SUCCESS` y 16 `SKIPPED`; 26 botella y 18 copa con exito; 18 sales-only |
| Idempotencia | 0 claves de exito exactamente duplicadas |
| Operacion | 0 tareas activas, 0 fallidas/bloqueadas en 24 h y 0 alertas abiertas |

### Checklist por bloque

1. **Conectividad - PASS.** Salud viva HTTP 200 en 108 ms, sin breaker ni fallos consecutivos.
2. **Configuracion - WARN.** Las capacidades principales y el periodo de cinco minutos estan activos, pero tambien permanece habilitada la escritura desde tickets abiertos. Los mismos consumos aparecen en snapshots abiertos y factura, por lo que no esta firmada la fuente definitiva unica.
3. **Catalogo - PASS.** Lectura fresca 114/114, mappings confirmados, tracking sin errores, cero diferencias y cero cola.
4. **Cambios automaticos - WARN por ausencia de evidencia completa.** No hay un canario reciente y trazable que mida alta, cambio de precio, inactivacion y reactivacion de extremo a extremo. El catalogo actual coincide, pero N/N no sustituye esa prueba.
5. **Estructura y legacy - WARN.** La estructura Winerim esta operativa, pero quedan 147 candidatos legacy vendibles: 37 en familias visibles y 110 bajo familias ocultas, por tanto localizables por buscador. El duplicado manual `COPA DE ARZUAGA CRIANZA` fue ocultado, pero no resuelve el conjunto legacy.
6. **Ventas - WARN por riesgo no cerrado.** Existen ventas reales recientes en ERP y ledger de botella y copa: Arzuaga Reserva Especial botella el 21/07 alrededor de las 21:00, Arzuaga Crianza copa cantidad 2 a las 20:34 y La Planta dos copas el 19/07 a las 21:25. El producto oficial de Arzuaga ya registra venta, pero sigue pendiente una reconciliacion exacta de snapshots abiertos frente a facturas; Remelluri mostro previamente el mismo consumo provisional y definitivo. No se clasifica `FAIL` porque no se ha demostrado en esta lectura que el ERP tenga una duplicacion final exacta.
7. **Stock - WARN por cancelacion sin evidencia suficiente.** Hay botella/copa y sales-only verificados, sin stock IDs ausentes. Existe un evento `BasicRefund`, pero no se encontro un log de reversion de vino que permita firmar el tratamiento de cancelaciones.
8. **Resiliencia - WARN por prueba incompleta.** Cola, breaker y alertas estan limpios y la idempotencia tecnica no muestra claves duplicadas, pero no hay una recuperacion controlada reciente ni una cancelacion firmada.
9. **Monitorizacion - PASS.** Salud viva, tracking sin errores, cola a cero y alertas abiertas a cero. Las alertas anteriores de conectividad o ventas obsoletas estan resueltas.
10. **Firma - WARN.** Catalogo correcto, pero faltan canarios automaticos completos, fuente definitiva unica, conciliacion de ventas/cancelaciones y decision sobre legacy.

### Falta exactamente para 100%

1. Dejar tickets abiertos en observabilidad y factura cerrada como unica escritura definitiva, o demostrar con conciliacion que la configuracion actual no duplica ERP/stock.
2. Conciliar una ventana cerrada de Agora frente a ERP/ledger, incluyendo Remelluri y Arzuaga.
3. Ejecutar canarios de alta, precio, inactivacion y reactivacion, midiendo cada latencia.
4. Probar una venta real de botella y una copa desde botones Winerim y confirmar `sold_at`, variante e idempotencia.
5. Probar un reembolso/cancelacion real y verificar ERP, ledger y stock.
6. Decidir y aplicar la politica de los 147 legacy todavia vendibles/buscables.
7. Observar 24 horas estables y obtener firma del cliente.

## 5. El Bejeque

### Evidencia cuantitativa

| Dato | Evidencia |
|---|---|
| Estado | Activa, `BIDIRECTIONAL`, `XML_IMPORT`, readiness `READY` |
| Salud | HTTP 200 en 209 ms; breaker cerrado y 0 fallos consecutivos |
| Catalogo fresco | 94/94 formatos presentes; 0 ausentes, 0 diferentes, 0 sin ownership; cola activa 0 |
| Cache Winerim | 76 vinos: 70 activos y 6 inactivos |
| Formatos elegibles | 69 botellas, 20 copas y 5 magnums; 0 stock IDs ausentes |
| Mappings | 104 `CONFIRMED`: 74 botella, 24 copa y 6 magnum |
| Tracking | 94 `VERIFIED`, 10 `HIDDEN`, 0 errores |
| Ventas desde 15/07 | 97 eventos, 1.013 lineas y 79 lineas de vino mapeadas: 39 botella, 34 copa y 6 magnum |
| Stock/sales import | 74 logs: 52 `SUCCESS`, 21 `SKIPPED`, 1 `FAILED` historico recuperado; 34 botella, 16 copa y 2 magnum con exito; 20 sales-only |
| Idempotencia | 0 claves de exito exactamente duplicadas |
| Operacion | 0 tareas activas, 0 fallidas/bloqueadas en 24 h y 0 alertas abiertas |

### Checklist por bloque

1. **Conectividad - PASS.** Sonda viva HTTP 200 en 209 ms, breaker cerrado y sin fallos consecutivos.
2. **Configuracion - PASS.** La escritura desde tickets abiertos esta deshabilitada; estos quedan para observabilidad y las facturas son la fuente definitiva. Catalogo, altas, cambios, formatos y periodo de cinco minutos estan activos.
3. **Catalogo - PASS.** Lectura fresca 94/94, sin diferencias, sin faltantes, sin ownership pendiente y sin cola. No quedan retirados vendibles en la estructura Winerim verificada.
4. **Cambios automaticos - WARN por una unica evidencia ausente.** Se midieron tareas reales de alta y actualizacion entre 4,4 y 5,7 segundos desde cola hasta verificacion, y la retirada esta demostrada. Falta un canario trazable de reactivacion completa y la latencia desde el clic/guardado en Winerim; el detector sigue teniendo una ventana de hasta cinco minutos.
5. **Estructura y legacy - PASS.** Doce familias legacy estan ocultas y los ocho productos legacy comprobados tienen desactivada la venta principal/directa. No son localizables como vendibles por buscador.
6. **Ventas - FAIL real historico, con flujo futuro corregido.** Hay ventas reales de las tres variantes en ERP: Abad Dom Bueno tres copas el 17/07 a las 20:02, Finca Rodma botella el 18/07 a las 22:15 y Malleolus magnum el 16/07 a las 23:15. Sin embargo, la reconciliacion verifico siete discrepancias historicas: seis duplicados funcionales creados por ticket provisional mas factura y una diferencia fraccional de magnum. La configuracion que las originaba ya esta corregida, pero el historico aun no.
7. **Stock - WARN por deuda historica.** Stock activo, sales-only, botella, copa y magnum estan observados; no faltan stock IDs. Un fallo temporal Winerim 500 de Abad Dom Bueno se recupero y la factura definitiva termino en `SUCCESS` sales-only. Se observaron reversiones de tickets abiertos, pero esas reversiones corrigieron stock y no retiraron las tarjetas historicas duplicadas del ERP.
8. **Resiliencia - PASS.** El fallo temporal se recupero, no hay claves de exito duplicadas, el breaker esta cerrado y la cola limpia. La fuente de escritura futura se ha limitado a facturas definitivas.
9. **Monitorizacion - PASS.** Salud viva, 0 alertas abiertas, 0 tareas activas o fallidas en 24 h y tracking sin errores.
10. **Firma - WARN.** La operativa futura esta encauzada, pero no se puede firmar con siete discrepancias historicas sin reconciliar ni sin canario de reactivacion.

### Falta exactamente para 100%

1. Reconciliar sin descontar stock las seis duplicaciones historicas y la diferencia fraccional de magnum.
2. Ejecutar una ventana cerrada Agora factura -> ledger -> ERP y demostrar igualdad exacta sin tarjetas duplicadas.
3. Ejecutar un canario real de reactivacion y medir guardado Winerim -> publicacion Agora.
4. Probar una venta controlada de botella, copa y magnum bajo la configuracion definitiva, verificando `sold_at`, idempotencia y stock/sales-only.
5. Probar una cancelacion o abono definitivo y verificar ERP, ledger y stock.
6. Observar 24 horas sin discrepancias, tareas fallidas ni alertas y obtener firma del cliente.

## Conclusion del lote

- **PASS comprobado:** las tres conexiones activas responden, tienen catalogo fresco exacto y operacion actualmente limpia.
- **Ausencia de evidencia:** faltan distintos canarios de precio, reactivacion, cancelacion y recuperacion; se marcan `WARN`, nunca como fallos inventados.
- **Fallos reales:** De la O conserva discrepancias historicas no reparadas y una doble fuente de escritura; El Bejeque conserva siete discrepancias historicas aunque la causa futura ya esta desactivada.
- **No activas:** los dos Don Bernardo no se han sondeado ni pueden considerarse operativos por tener cero mapping/tracking y la conexion deshabilitada.
