# Agora - checklist universal 100 % - lote 3 - 2026-07-22

## Alcance y criterio

Auditoria estrictamente de solo lectura de estas cinco conexiones:

- El Higueron.
- El Porton de Sorni.
- Finca Eslava.
- Katsu Izakaya.
- Kava.

No se cambiaron precios, productos, flags, mappings, tracking, colas, legacy,
stock ni historial. No se proceso ninguna cola. Todas las conexiones del lote
estaban activas, por lo que se hizo lectura fresh del catalogo. Las pruebas
externas se limitaron a 20 segundos; una evidencia ausente se marca `WARN` y no
se convierte en fallo tecnico. `FAIL` se reserva para una discrepancia o riesgo
funcional observado.

La firma `100%_SIGNED_OFF` exige evidencia real de cada control aplicable. Un
catalogo `N/N MATCH`, por si solo, no permite firmar la integracion.

## Resumen inicial

Leyenda de bloques:

1. Conectividad.
2. Configuracion.
3. Catalogo.
4. Cambios automaticos.
5. Estructura y legacy.
6. Ventas.
7. Stock.
8. Resiliencia.
9. Monitorizacion.
10. Firma final.

| Restaurante | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | Estado conservador |
|---|---|---|---|---|---|---|---|---|---|---|---|
| El Higueron | PASS | WARN | PASS | WARN | PASS | WARN | WARN | WARN | FAIL | WARN | `LIVE_AUTOMATIC / PENDIENTE_FIRMA` |
| El Porton de Sorni | PASS | PASS | PASS | WARN | FAIL | WARN | PASS | WARN | PASS | FAIL | `LIVE_PENDING / FAIL_LEGACY_COVERAGE` |
| Finca Eslava | PASS | WARN | PASS | WARN | FAIL | FAIL | WARN | FAIL | FAIL | FAIL | `LIVE_PENDING / FAIL_HISTORY_LEGACY` |
| Katsu Izakaya | PASS | WARN | PASS | WARN | PASS | WARN | PASS | WARN | PASS | WARN | `LIVE_AUTOMATIC / PENDIENTE_FIRMA` |
| Kava | PASS | WARN | PASS | WARN | WARN | FAIL | WARN | FAIL | WARN | FAIL | `LIVE / FAIL_HISTORY_RECONCILIATION` |

Ninguna conexion de este lote queda `100%_SIGNED_OFF`.

## Evidencia comun del lote

- Lectura fresh de catalogo: `2026-07-22T09:24Z`.
- Las cinco conexiones: `enabled=true`, `BIDIRECTIONAL`, `XML_IMPORT`, ciclo
  configurado de 5 minutos, zona `Europe/Madrid`, breaker cerrado y
  `consecutive_failures=0`.
- Las cinco tienen alta, actualizacion y verificacion automatica activas en los
  campos autoritativos de la conexion.
- Cola activa al cierre: `0 QUEUED / 0 RUNNING` en las cinco.
- Duplicados exactos de clave idempotente en la ventana auditada: `0` en las
  cinco. Esto no descarta duplicados funcionales con claves distintas.
- Todos los formatos elegibles tienen `stock_id` de su variante en la cache
  Winerim. No se observo un formato elegible sin `bottle_stock_id`,
  `glass_stock_id` o `magnum_stock_id` aplicable.
- La lectura autenticada del ERP se repitio en este lote para Katsu Izakaya y
  Finca Eslava. Para El Higueron se usa una comprobacion autenticada del mismo
  dia. Para El Porton y Kava se conserva la ultima conciliacion autenticada
  disponible y se declara expresamente la falta de una nueva lectura ERP.

---

## El Higueron

### 1. Conectividad - PASS

- Conexion activa y breaker cerrado.
- Lectura fresh Agora completa: 96 familias, 2.415 productos, 6 listas de
  precio, 13 centros de venta, 5 IVAs, 17 tipos de preparacion y 10 ordenes de
  preparacion.
- Ultimo health check: HTTP `200`, aproximadamente `147 ms`.
- La alerta de ventas stale se trata en monitorizacion; no es un fallo de red.

### 2. Configuracion - WARN

- Configuracion efectiva: `BIDIRECTIONAL`, `XML_IMPORT`, catalogo y ventas cada
  5 minutos, tickets abiertos e intradia activos, edad minima 2 minutos y zona
  `Europe/Madrid`.
- Stock activo usa actualizacion absoluta por variante; stock inactivo usa
  `sales/import`.
- Hay deuda de metadatos: `provider_config` conserva copias antiguas de flags
  de auto-publicacion en `false` y notas de legacy visible, mientras los campos
  autoritativos estan activos y el runtime ya publico correctamente. No rompe
  el flujo actual, pero impide considerar la configuracion limpia y univoca.

### 3. Catalogo - PASS

- Formatos elegibles: `292` = 253 botellas, 30 copas y 9 magnum.
- Verificacion funcional especifica: `292/292`, 0 ausentes, 0 sin ownership,
  0 diferencias de precio, IVA, familia, orden o flags de venta.
- El auditor generico devuelve `287/292` por cinco `ButtonText` abreviados de
  forma intencionada para respetar el limite de 20 caracteres y evitar
  colisiones. No son diferencias funcionales.
- Mappings: `292 CONFIRMED`. Tracking: `292 VERIFIED`.
- Retirados Winerim aun vendibles: `0` detectados.
- Cola activa: `0`.

### 4. Cambios automaticos - WARN

- Alta/cambio comercial real medido: `Pago de Carraovejas El Anejon` aparecio
  en Agora en `61 s`.
- El ciclo configurado es de 5 minutos.
- Falta una secuencia fresh completa y trazable de cuatro canaries distintos:
  alta, cambio de precio, retirada por inactivo/sin precio y reactivacion.
- La evidencia de 61 s prueba funcionamiento, pero no constituye por si sola
  un SLA estable ni cubre las cuatro transiciones.

### 5. Estructura y legacy - PASS

- Ocho familias Winerim, con politica exclusiva: orden alfabetico por vino y
  texto visible sin prefijos tecnicos `B`, `C` o `M`.
- Siete familias legacy de vino y `396` productos legacy fueron auditados.
- Resultado actual documentado: las siete familias con `ShowInPos=false` y los
  `396` productos con `UseAsDirectSale=false` y `SaleableAsMain=false`.
- Legacy localizable por buscador: `0` productos vendibles.
- Ocultacion reversible y con snapshot; no se borro ningun elemento.

### 6. Ventas - WARN

- Ledger reciente:
  - `El Lagar de Isilla`, botella, `sold_at=2026-07-21 21:26:08`, procesada
    aproximadamente a las `21:28:19`: latencia `2 min 11 s`.
  - `Jose Pariente`, botella, `sold_at=2026-07-21 21:06:11`, procesada
    aproximadamente a las `21:08:16`: latencia `2 min 05 s`.
- Evidencia ERP autenticada del mismo dia: `Domaine Vacheron Sancerre Blanc`,
  factura Agora `14401`, una sola tarjeta y hora original conservada.
- No hay una venta real reciente de copa ni una venta real sales-only con
  stock desactivado. Es ausencia de evidencia, no fallo probado.
- Dos muestras antiguas conservan desfases aproximados de 55 y 4 minutos.

### 7. Stock - WARN

- Botella con stock activo y `stock_id` correcto: comprobada.
- Cancelacion provisional de `La Vieille Ferme Rose Recolte`: stock restaurado
  mediante ajuste sin crear otra venta.
- Todos los IDs de stock de los 292 formatos elegibles estan disponibles.
- Faltan canaries reales de copa y de stock desactivado/sales-only.

### 8. Resiliencia - WARN

- Breaker cerrado, 0 fallos consecutivos, 0 claves idempotentes exactas
  duplicadas y cola activa 0.
- Existe evidencia positiva de una cancelacion y de una segunda pasada no-op.
- No hay canary fresh de recuperacion tras caida/reinicio y el monitor mantiene
  una alerta stale. La recuperacion completa no puede firmarse solo por
  configuracion.

### 9. Monitorizacion - FAIL

- Health HTTP `200`, pero existe una alerta abierta `sales_stale` con `105`
  ocurrencias desde el 21/07.
- `last_business_day_synced` continua en `2026-07-14` pese a existir actividad
  intradia posterior. Puede ser un falso positivo por diferenciar facturas
  cerradas de tickets, pero el monitor no esta representando un estado limpio.
- Cola activa 0; no se observaron tareas recientes sin clasificar.

### 10. Firma final - WARN

No existe fallo comprobado de catalogo o venta de botella, pero faltan la copa
real, sales-only, la secuencia completa de cambios automaticos, recuperacion
fresh, cierre de la alerta stale y aceptacion visual del cliente.

### Falta exacta para 100 %

1. Limpiar la contradiccion de flags/notas duplicadas en `provider_config` con
   una migracion controlada.
2. Venta real de copa y comprobacion ERP/ledger/stock_id.
3. Venta real con stock desactivado y comprobacion sales-only.
4. Canaries de precio, retirada y reactivacion, ademas del alta ya medida.
5. Resolver o reclasificar correctamente la alerta `sales_stale` y observar
   24/48 h sin alertas nuevas.
6. Canary de recovery y validacion visual del cliente en pantalla/buscador.

---

## El Porton de Sorni

### 1. Conectividad - PASS

- Conexion activa, breaker cerrado y 0 fallos consecutivos.
- Fresh catalog completo y health HTTP `200`, aproximadamente `116 ms`.
- Sin alertas abiertas de conectividad.

### 2. Configuracion - PASS

- `BIDIRECTIONAL`, `XML_IMPORT`, catalogo y ventas a 5 minutos, zona
  `Europe/Madrid` y auto create/update/verified activos.
- Tickets abiertos, intradia y stock del dia actual activos.
- La restauracion stale de dias previos esta desactivada; se considera riesgo
  de recovery en el bloque 8, no error de acceso/configuracion base.

### 3. Catalogo - PASS

- Fresh `175/175 MATCH`, 0 missing, 0 different y 0 unowned.
- Elegibles: 152 botellas, 22 copas y 1 magnum.
- Mappings: `177 CONFIRMED`; tracking: `176 VERIFIED` y `1 HIDDEN`.
- El formato oculto no aparece como vendible; retirados Winerim detectados aun
  vendibles: `0`.
- Cola activa 0.

### 4. Cambios automaticos - WARN

- Configuracion automatica activa y seis verificaciones de tarea terminaron
  entre 0,1 y 0,3 minutos.
- Esas verificaciones no sustituyen un cambio comercial real. No hay evidencia
  fresh completa de alta, precio, retirada y reactivacion solicitadas desde el
  editor Winerim.

### 5. Estructura y legacy - FAIL

- Las ocho familias Winerim estan presentes.
- Persisten cuatro familias legacy visibles y al menos `18` productos legacy
  vendibles/localizables en la ultima lectura de legacy. La auditoria anterior
  identifico `37` pares legacy/Winerim que requieren clasificacion.
- Uso real: `114` lineas, `121` unidades y `1.409,40 EUR` sin mapping en diez
  dias. No son solo residuos visuales; contaminan la cobertura de ventas.

### 6. Ventas - WARN

- Ledger desde el 15/07: `17` filas, `14 SUCCESS` y `3 SKIPPED` diferidas.
- Evidencia por variante:
  - `Triga Chardonnay`, botella con stock activo,
    `sold_at=2026-07-21 14:41:31`, procesada a las `14:45:08`: `3 min 37 s`.
  - `Carmelo Rodero`, botella con stock activo,
    `sold_at=2026-07-21 15:48:17`, procesada a las `15:56:14`: `7 min 57 s`.
  - `Marques de Murrieta`, copa qty 2, sales-only,
    `sold_at=2026-07-21 15:56:30`, procesada a las `17:00:11`: `63 min 41 s`.
- Hay botella y copa reales en ledger, pero no se completo una nueva lectura
  autenticada de ERP en este lote. La latencia de la copa incumple el objetivo
  nominal de 5 minutos.

### 7. Stock - PASS

- Botella con stock activo: decrementos registrados.
- Copa con stock desactivado: importada por sales-only sin mover inventario.
- IDs de stock completos para 152/22/1 formatos elegibles.
- No se detectaron claves exactas duplicadas.

### 8. Resiliencia - WARN

- Breaker limpio, cola activa 0 y 0 claves exactas duplicadas.
- Seis de siete botellas del muestreo anterior se escribieron primero desde
  ticket abierto.
- Falta cancelacion mapeada y recovery real. La restauracion stale de dias
  previos esta desactivada, por lo que no puede firmarse recuperacion completa.

### 9. Monitorizacion - PASS

- Health HTTP `200`, aproximadamente `116 ms`.
- Alertas abiertas: `0`.
- Cola `QUEUED/RUNNING`: `0`.
- No se observaron tareas FAILED/BLOCKED recientes sin clasificar.

### 10. Firma final - FAIL

La conexion funciona, pero el uso real de legacy deja ventas sin mapping, falta
conciliacion ERP fresh, la copa observada tardo mas de una hora y no hay prueba
de cancelacion/recovery ni de los cuatro canaries de catalogo.

### Falta exacta para 100 %

1. Conciliar contra ERP las ventas recientes por documento, hora y variante.
2. Clasificar los 18 legacy vendibles y los pares duplicados; ocultar solo los
   sustituidos o mapear los identificables con aprobacion del cliente.
3. Eliminar el uso operativo de botones legacy no mapeados.
4. Repetir una copa sales-only y confirmar propagacion menor de 5 minutos.
5. Canaries reales de alta, precio, retirada y reactivacion.
6. Canary de cancelacion y recovery idempotente.
7. Validacion visual y 24/48 h sin diferencias ni alertas.

---

## Finca Eslava

### 1. Conectividad - PASS

- Conexion activa, breaker cerrado, 0 fallos consecutivos.
- Fresh `123/123` completado; health HTTP `200`, aproximadamente `115 ms`.

### 2. Configuracion - WARN

- Campos autoritativos: `BIDIRECTIONAL`, `XML_IMPORT`, create/update/verified
  activos, catalogo/ventas cada 5 minutos y zona `Europe/Madrid`.
- `provider_config.catalog_write_enabled=false` contradice esos campos activos
  y las notas de onboarding son antiguas. El runtime actual funciona, pero la
  configuracion no tiene una unica fuente legible sin ambiguedad.
- Restauracion stale de dias previos desactivada.

### 3. Catalogo - PASS

- Fresh `123/123 MATCH`, 0 missing, 0 different y 0 unowned.
- Elegibles: 111 botellas, 9 copas y 3 magnum.
- `123 CONFIRMED` y `123 VERIFIED`.
- Retirados Winerim aun vendibles: `0` detectados.
- Cola activa 0.

### 4. Cambios automaticos - WARN

- Automatismos configurados y ciclos ejecutandose.
- No existe canary comercial fresh que cubra alta, cambio de precio, retirada
  y reactivacion con latencia medida.

### 5. Estructura y legacy - FAIL

- Familias Winerim presentes y catalogo exacto.
- Aunque varias familias legacy estan ocultas, `115` productos legacy de
  botella y `24` de copa, `139` en total, siguen vendibles por buscador.
- Uso real: `146` unidades y `1.071,50 EUR` en diez dias; el 19/07 hubo 13
  copas genericas y el 20/07 otras 16, ademas de 2 botellas legacy.
- Botones como `COPA TINTO` o `COPA BLANCO` no identifican un vino y no pueden
  mapearse de forma segura.

### 6. Ventas - FAIL

- Lectura ERP autenticada fresh en `/erp/1108/sales`:
  - `Pago de Los Capellanes`, botella, `sold_at=2026-07-21 16:12:54`, aparece
    como `TPV` a las `16:15`; ledger a `16:15:36`, latencia `2 min 42 s`.
  - `Emilio Moro`, botella, venta Agora `2026-07-17 15:42:43` y anulacion un
    minuto despues. Agora netea `+1/-1=0`, pero ERP conserva una tarjeta TPV
    positiva a las `15:45`.
- Ventas Winerim recientes en ledger: 2 SUCCESS de botella y 1 magnum SKIPPED
  diferido.
- No hay canary real de copa Winerim ni sales-only.
- El historial positivo de Emilio Moro tras la anulacion es un fallo real de
  conciliacion, no ausencia de evidencia.

### 7. Stock - WARN

- `Pago de Los Capellanes` demuestra botella con stock activo.
- El stock de Emilio Moro se reparo de `82` a `83` mediante ajuste sin venta;
  el inventario quedo correcto, pero el historial no.
- IDs de stock completos para 111/9/3 formatos.
- Faltan copa real y stock desactivado/sales-only.

### 8. Resiliencia - FAIL

- Breaker limpio, cola activa 0 y 0 claves exactas duplicadas.
- La devolucion definitiva de Emilio Moro no pudo retirar la tarjeta positiva.
- Hay tres tickets abiertos antiguos y la restauracion de dias previos esta
  desactivada. Recovery/cancelacion no son fiables de extremo a extremo.

### 9. Monitorizacion - FAIL

- Health HTTP `200`, aproximadamente `115 ms`.
- Alerta abierta `sales_stale` con `18` ocurrencias; cursor de facturas en
  `2026-07-18`.
- Cola activa 0, pero el monitor no esta limpio.

### 10. Firma final - FAIL

Catalogo y conectividad estan sanos, pero el historial no netea una anulacion
real y la operativa sigue usando 139 botones legacy buscables. Faltan ademas
copa, sales-only, catalog canaries y recovery.

### Falta exacta para 100 %

1. Resolver anulaciones definitivas sin dejar una tarjeta positiva en ERP.
2. Conciliar/corregir Emilio Moro mediante una operacion no comercial y con
   snapshot; no crear otra venta para compensar.
3. Clasificar y retirar de forma reversible los 139 legacy buscables, sin
   inventar mappings para copas genericas.
4. Venta real de copa Winerim y venta sales-only.
5. Canaries de alta, precio, retirada y reactivacion.
6. Canary de cancelacion/recovery tras la correccion.
7. Resolver la alerta stale y observar 24/48 h limpia.

---

## Katsu Izakaya

### 1. Conectividad - PASS

- Conexion activa, breaker cerrado y 0 fallos consecutivos.
- Fresh completo; health HTTP `200`, aproximadamente `132 ms`.
- Sin alertas abiertas.

### 2. Configuracion - WARN

- `BIDIRECTIONAL`, `XML_IMPORT`, 5 minutos, `Europe/Madrid`, create/update/
  verified e intradia activos.
- `provider_config` conserva notas historicas de una pausa de auto-update que
  ya no coincide con los campos autoritativos activos.
- `open_tickets_stock_sync_enabled=true`: crea historial provisional sin que
  exista una API Winerim idempotente para retirar una venta si el ticket se
  cancela. Es un riesgo de configuracion, aunque no se observe solape reciente.

### 3. Catalogo - PASS

- Fresh `157/157 MATCH`, 0 missing, 0 different y 0 unowned.
- Elegibles: 79 botellas, 76 copas y 2 magnum.
- Mappings: 174 CONFIRMED y 18 REJECTED historicos/inactivos.
- Tracking: 157 VERIFIED y 35 HIDDEN; los retirados no son vendibles.
- Cola activa 0.

### 4. Cambios automaticos - WARN

- Automatismos y ciclo de 5 minutos activos; el catalogo fresh esta exacto.
- No existe una prueba comercial fresh completa de alta, precio, retirada y
  reactivacion. Configuracion y `157/157` no sustituyen esos cuatro canaries.

### 5. Estructura y legacy - PASS

- Raiz `VINOS` con siete familias Winerim y raiz `COPAS DE VINOS` con
  `COPAS WINERIM`.
- `197` productos legacy de vino permanecen no vendibles; un ID fue reutilizado
  de forma deliberada como producto Winerim confirmado.
- Legacy de vino localizable/vendible por buscador: `0` en la ultima
  comprobacion. Los vendibles en otras familias ocultas son cerveza/licores,
  no legacy de vino.

### 6. Ventas - WARN

- Lectura ERP autenticada fresh en `/erp/1019/sales`:
  - 21/07: `Paul Cluver Riesling`, copa qty 1, TPV.
  - 21/07: `Abad Dom Bueno Godello Esencia`, copa qty 1, TPV.
  - 18/07: `Rafa Canizares Mistela`, formato ledger botella, TPV a las `16:11`.
- Ledger:
  - Paul Cluver `sold_at=2026-07-21 21:43:32`, procesada a las `22:32:43`,
    aproximadamente `49 min 11 s`.
  - Abad Dom Bueno `sold_at=2026-07-21 21:22:20`, procesada a las `22:01:27`,
    aproximadamente `39 min 07 s`.
  - Rafa Canizares `sold_at=2026-07-18 16:08:51`, procesada a las `16:11:56`,
    `3 min 05 s`.
- Ventana de ledger: `21 SUCCESS`, con 2 filas de botella/qty 2 stock-active y
  19 filas de copa/qty 49 sales-only.
- Botella y copa llegan al ERP, pero las dos copas mas recientes superaron de
  forma amplia el objetivo de 5 minutos. Falta canary real de cancelacion.

### 7. Stock - PASS

- Botella con stock activo: evidencia real y `stock_id` de botella correcto.
- Copa con stock desactivado: 19 filas/49 unidades registradas por sales-only
  sin mover inventario.
- IDs completos para 79/76/2 formatos.
- No hay claves idempotentes exactas duplicadas.

### 8. Resiliencia - WARN

- Breaker limpio, cola activa 0, 0 duplicados exactos y evidencia historica de
  recuperacion automatica sin replay manual.
- Falta un canary real actual de cancelacion de vino y recovery.
- La escritura provisional desde tickets abiertos sigue siendo insegura sin
  anulacion idempotente; dos documentos de abono no contenian vino mapeado.

### 9. Monitorizacion - PASS

- Health HTTP `200`, aproximadamente `132 ms`.
- Alertas abiertas: `0`.
- Cola activa: `0`.
- No hay FAILED/BLOCKED recientes sin clasificar.

### 10. Firma final - WARN

No hay fallo observado de catalogo, legacy, stock o duplicado tecnico, pero la
latencia reciente de copas no cumple 5 minutos y faltan canaries de cambios,
cancelacion/recovery, magnum y validacion visual fresh.

### Falta exacta para 100 %

1. Neutralizar escritura provisional o disponer de anulacion idempotente.
2. Repetir copa real y demostrar latencia menor de 5 minutos en ERP y ledger.
3. Canary mapeado de cancelacion y recovery sin tarjeta duplicada.
4. Canaries de alta, precio, retirada y reactivacion.
5. Venta real de magnum, si se declara aplicable al cierre.
6. Validacion visual fresh de jerarquia, comandera y buscador.
7. Observar 24/48 h sin diferencias.

---

## Kava

### 1. Conectividad - PASS

- Conexion activa, breaker cerrado y 0 fallos consecutivos.
- Fresh completo; health HTTP `200`, aproximadamente `123 ms`.
- Sin alerta abierta de red.

### 2. Configuracion - WARN

- `BIDIRECTIONAL`, `XML_IMPORT`, 5 minutos, `Europe/Madrid` y automatismos de
  catalogo activos.
- `live_sales_mode=INVOICES_AFTER_CLOSE_ONLY`, mientras tickets abiertos y
  escritura provisional de stock tambien figuran activos. La doble estrategia
  no tiene una politica segura de anulacion de historial.
- Los endpoints de tiempo real de Kava han fallado o devuelto datos no
  utilizables en pruebas anteriores; la autoridad comercial sigue siendo la
  factura cerrada.

### 3. Catalogo - PASS

- Fresh `228/228 MATCH`, 0 missing, 0 different y 0 unowned.
- Elegibles: 209 botellas, 18 copas y 1 magnum.
- Retirado comprobado: no vendible.
- Mappings/tracking incluyen deuda historica de elementos ocultos o rechazados,
  pero no dejan formatos elegibles sin ownership en la lectura fresh.
- Cola activa 0.

### 4. Cambios automaticos - WARN

- Altas comerciales reales medidas: `Ultreia Godello` y `Algueira Finca
  Cortezada` en `70-71 s`.
- No hay evidencia fresh completa de cambio de precio, retirada y reactivacion.

### 5. Estructura y legacy - WARN

- Ocho familias Winerim presentes; el legacy de vino sustituido aparece como
  oculto en la auditoria de catalogo.
- `provider_config` tambien documenta una restauracion operativa posterior de
  legacy de generosos/dulces. No se completo una nueva comprobacion visual del
  buscador tras esa excepcion.
- Resultado: no se demuestra un legacy general vendible, pero la visibilidad
  exacta del subconjunto restaurado queda sin evidencia fresh suficiente.

### 6. Ventas - FAIL

- La autoridad real es post-cierre. Ejemplos del 21/07:
  - `Bassermann-Jordan`, botella,
    `sold_at=2026-07-21 21:22:43`, procesada hacia `2026-07-22 02:00:55`:
    aproximadamente `4 h 38 min`.
  - `Matias Riccitelli`, botella,
    `sold_at=2026-07-21 22:18:53`, procesada hacia `02:00:54`:
    aproximadamente `3 h 42 min`.
  - `Petit Albet`, botella, vendida hacia `20:06`, procesada hacia `02:00:53`:
    casi `5 h 55 min`.
- Ledger desde el 15/07: 66 filas, 46 SUCCESS y 20 SKIPPED; 30 filas de
  botella y 36 de copa.
- Discrepancia real autenticada:
  - Agora tiene cinco copas definitivas de `Pampaneando`; ERP solo contiene
    las dos del 14/07. Faltan tres copas de 17/07 y 18/07.
  - `Chavost Paradoxe` tiene una venta definitiva en Agora y dos tarjetas
    positivas en ERP por el ciclo provisional/restauracion/definitiva.
- La nueva lectura ERP no se completo en este lote; no hay evidencia posterior
  que demuestre que esas discrepancias ya hayan sido corregidas.

### 7. Stock - WARN

- IDs de stock completos para 209/18/1 formatos.
- Modos observados: 22 operaciones definitivas/intradia, 8 restauraciones,
  20 diferidas y 16 sales-only.
- El stock puede quedar neteado tras una restauracion, pero el historial puede
  conservar dos tarjetas positivas. Stock neto correcto no equivale a ventas
  correctas.

### 8. Resiliencia - FAIL

- Breaker limpio, cola activa 0 y 0 claves idempotentes exactas duplicadas.
- Se detectaron `6` ciclos funcionales ticket abierto -> restauracion ->
  factura definitiva con claves distintas. Ese patron puede duplicar historial
  aunque no duplique la clave tecnica.
- Chavost confirma que el riesgo ya se materializo.
- La API Winerim disponible crea ventas, pero no ofrece anulacion idempotente
  de una tarjeta provisional.

### 9. Monitorizacion - WARN

- Health HTTP `200`, aproximadamente `123 ms`, alertas abiertas `0` y cola
  activa `0`.
- Persisten 2 tareas `AGORA_XML_UPSERT_PRODUCT` en estado FAILED del 15/07 para
  el vino `146871`. El catalogo fresh ya es exacto, por lo que parecen deuda
  superseded, pero siguen sin clasificar/cerrar en el registro.
- Un monitor verde no detecta por si solo la duplicidad funcional de Chavost
  ni las tres copas ausentes.

### 10. Firma final - FAIL

El catalogo esta exacto y la red esta sana, pero existen omisiones y duplicados
reales en el ERP. Ademas, Kava opera post-cierre con latencias de varias horas,
no en tiempo casi real.

### Falta exacta para 100 %

1. Confirmar en runtime/despliegue la precedencia del mapping definitivo.
2. Recuperar de forma controlada exactamente las tres copas de Pampaneando y
   verificar que no aparecen ventas adicionales.
3. Corregir la tarjeta duplicada de Chavost mediante operacion ERP no comercial
   y snapshot; no compensar creando otra venta.
4. Desactivar escritura provisional o incorporar anulacion idempotente antes
   de volver a usar tickets abiertos para historial.
5. Canary real de venta cerrada, cancelacion y recovery.
6. Verificar el subconjunto legacy de generosos/dulces en buscador.
7. Clasificar/cerrar las 2 tareas FAILED ya superseded.
8. Canaries de precio, retirada y reactivacion.
9. Observar 24/48 h sin diferencias de Agora frente a ERP.

---

## Conclusion del lote

- Mejor estado tecnico: El Higueron y Katsu Izakaya, ambos pendientes de
  evidencia externa concreta y no de una republicacion masiva.
- El Porton de Sorni necesita retirar o mapear el uso real de legacy antes de
  poder validar cobertura de ventas.
- Finca Eslava tiene un fallo real de anulacion en historial y legacy buscable
  usado por sala.
- Kava tiene el bloqueo mas serio: tres copas ausentes y una botella duplicada
  en ERP, aunque catalogo, red, breaker y cola activa esten sanos.
- Ningun `N/N MATCH` se ha usado como sustituto de una firma integral.

## Fuentes de evidencia conservadas

- `AGORA_INTEGRATION_CHECKLIST.md`.
- `docs/operations/el-higueron-full-audit-2026-07-22.md`.
- `docs/operations/el-porton-de-sorni-100-percent-checklist-2026-07-21.md`.
- `docs/operations/finca-eslava-100-percent-checklist-2026-07-20.md`.
- `docs/operations/katsu-100-percent-checklist-2026-07-20.md`.
- `docs/operations/kava-100-percent-checklist-2026-07-21.md`.
- Lectura fresh de catalogo y tablas operativas realizada el 22/07/2026.
- Lecturas autenticadas de ERP indicadas expresamente en cada restaurante.
