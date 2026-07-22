# Auditoría Agora 100% - Lote 1 - 2026-07-22

## Alcance y criterio

Restaurantes auditados exclusivamente en este lote:

- Abadía Yuste.
- Baco Getafe.
- Casa Esteban.
- Casa Nene.
- Chiquilla.

La auditoría fue estrictamente de solo lectura. No se modificaron precios,
productos, flags, mappings, tracking, colas, legacy ni datos operativos en
Agora, Winerim o Lovable Cloud. Tampoco se procesaron colas. Las conexiones
deshabilitadas se clasificaron como `NOT_ACTIVE` y no recibieron sondas fresh.

A petición operativa, cualquier prueba externa quedó limitada a 20 segundos.
Un timeout se trata como evidencia de indisponibilidad puntual, no como motivo
para seguir esperando. No quedó ninguna sonda externa ejecutándose al cerrar
el informe.

### Significado de estados

- `PASS`: existe evidencia directa, reciente y suficiente del requisito.
- `WARN`: no hay un fallo concluyente, pero falta evidencia obligatoria o
  existe un riesgo concreto pendiente.
- `FAIL`: el requisito se incumple de forma comprobada.
- `NOT_ACTIVE`: la conexión está deshabilitada; no se sondea ni se certifica.

La marca final `FAIL` no significa necesariamente que toda la integración esté
caída. Significa que, con el criterio universal, todavía no puede firmarse como
`100%_SIGNED_OFF`. Un catálogo `N/N` por sí solo no es suficiente.

## Resumen inicial

| Restaurante | 1 Conectividad | 2 Configuración | 3 Catálogo | 4 Cambios automáticos | 5 Estructura / legacy | 6 Ventas | 7 Stock | 8 Resiliencia | 9 Monitorización | 10 Firma final |
|---|---|---|---|---|---|---|---|---|---|---|
| Abadía Yuste | PASS | PASS | PASS | WARN | WARN | WARN | WARN | WARN | WARN | FAIL |
| Baco Getafe | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE |
| Casa Esteban | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE |
| Casa Nene | PASS | PASS | PASS | WARN | PASS | WARN | WARN | WARN | WARN | FAIL |
| Chiquilla | PASS | PASS | PASS | PASS | PASS | PASS | WARN | PASS | WARN | FAIL |

Resultado del lote:

- Conexiones activas: `3/5`.
- Conexiones deshabilitadas: `2/5`.
- Conexiones `100%_SIGNED_OFF`: `0/5`.
- Catálogo fresh exacto en las tres activas: Abadía `281/281`, Casa Nene
  `372/372` y Chiquilla `73/73`.
- Cola activa en las tres activas: `0 QUEUED / 0 RUNNING`.
- Claves de idempotencia `SUCCESS` exactamente duplicadas en la ventana de
  siete días: `0` en las tres activas.
- Alertas abiertas al cierre: `sales_stale` en Abadía y Casa Nene;
  `outbound_queue` en Chiquilla. En Chiquilla la alerta no coincide con el
  estado fresh actual: catálogo exacto y cola vacía.

## Evidencia y límites

La evidencia del lote combina:

1. Reconciliación fresh de catálogo ejecutada el `2026-07-22 09:23 UTC` solo
   para las tres conexiones activas.
2. Lectura de configuración, capabilities, breaker, cola, alertas y health
   realizada el `2026-07-22 09:33 UTC`.
3. Auditoría de ledger de siete días generada el `2026-07-22 09:24 UTC`.
4. Historial ERP autenticado ya verificado en los cierres individuales del 21
   y 22 de julio. Este lote no fabricó ventas nuevas ni volvió a iniciar sesión
   en el ERP.

Cuando no existe una medición real de latencia, se indica como ausencia de
evidencia. No se deduce una latencia a partir de la hora `sold_at`, porque esa
hora prueba conservación temporal, pero no cuánto tardó en aparecer la tarjeta
en el ERP.

---

## Abadía Yuste

Estado operativo observado: activa y automatizada, pero no firmable al 100%.

### 1. Conectividad - PASS

- Conexión habilitada.
- Health fresh con HTTP `200`.
- Latencia de sonda conocida: `115 ms`.
- Circuit breaker cerrado y `0` fallos consecutivos.
- Capabilities en estado `READY`, con lectura de catálogo y ventas y escritura
  declarada disponible.

### 2. Configuración - PASS

- Modo `BIDIRECTIONAL` y escritura `XML_IMPORT`.
- Sincronización de catálogo activa.
- Autoalta, autoactualización y publicación de formatos verificados activas.
- Botella y copa habilitadas.
- Intradía, tickets abiertos y stock de tickets abiertos activados.
- Cadencia configurada: `5 minutos`.
- Zona horaria: `Europe/Madrid`.

### 3. Catálogo - PASS

- Formatos Winerim elegibles: `281`.
- Encontrados en Agora: `281`.
- Coincidencias exactas: `281/281`.
- Ausentes: `0`.
- Diferencias de nombre, variante, precio, familia, orden o visibilidad: `0`.
- Sin ownership: `0`.
- Tracking `VERIFIED`: `281`.
- Mappings `CONFIRMED`: `281`.
- Cola activa: `0`.
- No se conocen formatos Winerim retirados que sigan vendibles.

### 4. Cambios automáticos - WARN

Los automatismos están correctamente activados y el catálogo fresh es exacto,
pero no existe una prueba real trazable de alta o cambio de precio con tiempos
de origen, tarea y llegada. La latencia de publicación no puede certificarse.

Esto es ausencia de evidencia, no un fallo de publicación comprobado.

### 5. Estructura y legacy - WARN

- Familias Winerim visibles: `8`.
- Productos Winerim vendibles dentro de ellas: `281`.
- Distribución: Tintos `141`, Blancos `57`, Rosados `11`, Espumosos `37`,
  Dulce `2`, Fortificados `5`, Magnum `14` y Copas `14`.
- La familia legacy `102 - D.O. Ribera del Duero Crianzas` sigue visible con
  `18` productos vendibles.
- Otras familias legacy están ocultas, pero contienen productos todavía
  vendibles y por tanto localizables por el buscador.
- Entre el 17 y el 20 de julio se vendieron `28` unidades legacy por `292 EUR`;
  no llegaron a Winerim porque no tenían mapping.

El incumplimiento está comprobado: el legacy sigue interviniendo en la
operativa y el buscador.

### 6. Ventas - WARN

Ventas reales comprobadas en Agora, ledger e historial ERP:

| Vino | Variante | Cantidad | `sold_at` local | Importe | ERP |
|---|---|---:|---|---:|---|
| Habla de Ti Sauvignon Blanc | botella | 1 | 2026-07-17 22:07:54 | 23 EUR | TPV, exacta |
| Le Domaine Blanco de Guarda | botella | 1 | 2026-07-17 21:54:41 | 56 EUR | TPV, exacta |
| Laurent-Perrier Cuvée Rosé | botella | 1 | 2026-07-19 22:16:35 | 98 EUR | TPV, exacta |

- Líneas cerradas canónicas en la ventana: `3`.
- Operaciones `SUCCESS`: `3`.
- Duplicados exactos de idempotencia: `0`.
- La variante botella y la hora real se conservan.
- No existe canary real de copa, aunque hay `14` copas publicadas.
- No existe canary de magnum; Abadía publica `14` formatos magnum.
- Latencia de ingestión ERP: no medida.

La venta de botella funciona. Faltan pruebas obligatorias de las otras
variantes aplicables.

### 7. Stock - WARN

- Las tres ventas comprobadas tenían stock desactivado.
- Entraron correctamente por `sales/import`, una sola vez y sin modificar
  inventario: flujo `sales-only` comprobado.
- Stock IDs ausentes en líneas cerradas: `0`.
- No existe una venta real reciente con stock activo que demuestre deducción
  sobre `bottle_stock_id` o `glass_stock_id`.
- No existe evidencia real de cancelación y restauración de stock en esta
  conexión.

### 8. Resiliencia e idempotencia - WARN

- Breaker cerrado, `0` fallos consecutivos y cola activa `0`.
- Duplicados exactos de idempotencia: `0`.
- No existe una prueba documentada de caída y recuperación automática.
- `open_tickets_stock_sync_enabled=true`; no hubo doble ciclo provisional y
  definitivo en la ventana observada, pero la escritura provisional sigue
  siendo un riesgo hasta certificar su anulación idempotente.

### 9. Monitorización - WARN

- Último health: HTTP `200`, pero estado funcional `STALE`.
- Alerta abierta: `sales_stale`.
- `last_business_day_synced`: `2025-03-16`, incompatible con las ventas reales
  comprobadas en julio y por tanto claramente atrasado.
- Cola actual: `0`; no hay tareas fallidas o bloqueadas vivas en la conexión.

El servicio responde, pero el cursor y la alerta no describen fielmente la
actividad real.

### 10. Firma final - FAIL

Abadía no es `100%_SIGNED_OFF`: funcionan catálogo y ventas sales-only de
botella, pero faltan canaries de copa, magnum, stock activo, cancelación,
propagación de catálogo y recuperación; además, el legacy sigue vendible y el
monitor marca ventas obsoletas.

### Falta exacta para 100%

1. Medir una alta o cambio de precio real Winerim -> Agora sin intervención.
2. Vender una copa Winerim y confirmar variante, `sold_at`, ERP e idempotencia.
3. Vender un magnum si continúa siendo una variante operativa del cliente.
4. Probar una referencia con stock activo y confirmar el `stock_id` correcto.
5. Probar cancelación/reversión sin duplicar venta ni stock.
6. Resolver la estrategia del legacy y evitar que siga vendible o localizable
   cuando tenga sustituto Winerim.
7. Corregir el cursor diario y cerrar la alerta `sales_stale` mediante el flujo
   normal, sin adelantarlo manualmente.
8. Confirmar visualmente la estructura en los terminales del cliente.

---

## Baco Getafe

Estado operativo: `NOT_ACTIVE / ROLLBACK_LEGACY`.

### Bloques 1 a 10 - NOT_ACTIVE

La conexión está deshabilitada por rollback solicitado. Conforme al alcance,
no se realizó ninguna sonda fresh. Por tanto, conectividad, configuración,
catálogo, cambios, estructura, ventas, stock, resiliencia, monitorización y
firma se clasifican `NOT_ACTIVE`, no `FAIL`.

### Evidencia conservada

- `enabled=false`.
- Sincronización de catálogo y auto-push desactivados.
- Última sincronización conocida: `2026-05-29`.
- Último día procesado conocido: `2026-05-28`.
- Productos Winerim conservados: `118`, todos no vendibles.
- Familias Winerim ocultas: `8`.
- Mappings conservados: `118`.
- Familia `VINO` y seis familias legacy visibles.
- Productos legacy vendibles: `171`; son localizables en la operativa y el
  buscador porque Baco opera deliberadamente con legacy.
- Ventas de julio persistidas: `0`.
- Histórico de mayo: `41` descuentos `SUCCESS`, sin claves exactas duplicadas.
- Cola y alertas actuales: `0`, pero no hay health checks porque la conexión
  está deshabilitada.

### Incoherencias conocidas, sin efecto mientras siga deshabilitada

- `write_mode=XML_IMPORT` permanece como metadato residual, aunque el rollback
  documentado esperaba `NONE`.
- Tracking permanece `VERIFIED`, aunque los productos Winerim están ocultos y
  semánticamente deberían constar como `HIDDEN`.

### Falta exacta para 100%

1. Autorización expresa del cliente para abandonar `LEGACY_ONLY`.
2. Normalizar los metadatos de rollback con snapshot previo.
3. Tratar la reactivación como onboarding nuevo y volver a validar URL/API,
   Families, Products, Invoices y token Winerim.
4. Reconciliar catálogo, ownership, retirados y legacy con lectura fresh.
5. Definir estrategia visual y obtener aceptación del cliente.
6. Activar automatismos por etapas y medir alta/cambio de precio.
7. Ejecutar canaries reales de botella, copa y magnum si aplican.
8. Validar stock activo, sales-only, cancelación e idempotencia.
9. Activar health, alertas y observación de 24/48 horas.

---

## Casa Esteban

Estado operativo: `STAGING / NOT_ACTIVE`.

### Bloques 1 a 10 - NOT_ACTIVE

La conexión está deshabilitada. No se realizó sonda fresh y no puede
certificarse ninguno de los diez bloques en este lote.

### Evidencia previa conservada

- `enabled=false`.
- Modo `PULL_ONLY` y escritura `NONE`.
- Autoalta, autoactualización y verified-ready desactivados.
- La última comprobación de onboarding conocida obtuvo HTTP `200` en Families,
  Products, Invoices y Tickets, pero no es una sonda fresh de este lote.
- Estructura Agora observada entonces: `12` familias visibles, `91` productos y
  `3` tarifas.
- Catálogo Winerim local: `0` vinos, `0` mappings, `0` tracking y `0` master
  data.
- Ventas observadas: `11` facturas, `14` líneas y `20` unidades, sin ninguna
  línea identificada como vino.
- Legacy de vino: no detectado por nombre, pero sin validación visual; esto es
  ausencia de evidencia, no prueba de que no exista.
- Cola: `0`, porque no existe flujo activo.
- Monitorización, health y contactos: no configurados.

### Falta exacta para 100%

1. Confirmar que el estado de túnel/bloqueo anterior está realmente resuelto.
2. Leer y validar el catálogo Winerim y su token sin escribir en Agora.
3. Capturar variantes y stock IDs.
4. Obtener master data y comparar catálogo, estructura y legacy.
5. Definir familias, categorías, defaults Agora y rollback.
6. Ejecutar piloto de catálogo controlado y comprobar N/N fresh.
7. Medir alta, precio, retirada y reactivación automáticas.
8. Hacer canaries reales de botella, copa y magnum si aplican.
9. Validar stock activo, sales-only, cancelaciones e idempotencia.
10. Configurar monitor, contactos y observación 24/48 horas.
11. Obtener aceptación visual del cliente antes de `LIVE_AUTOMATIC`.

---

## Casa Nene

Estado operativo observado: estable y automatizada, pero sin firma estricta.

### 1. Conectividad - PASS

- Conexión habilitada.
- Health fresh con HTTP `200`.
- Latencia de sonda conocida: `152 ms`.
- Breaker cerrado y `0` fallos consecutivos.
- Capabilities `READY`.

### 2. Configuración - PASS

- Modo `BIDIRECTIONAL`, escritura `XML_IMPORT`.
- Catálogo, autoalta, autoactualización y verified-ready activados.
- Botella y copa activas.
- Intradía, tickets abiertos y stock intradía activos.
- Cadencia: `5 minutos`.
- Zona horaria: `Europe/Madrid`.
- Excepción explícita `publish_hidden_glass_variants=true` para las copas que
  el cliente no quiere mostrar en la carta pública.

### 3. Catálogo - PASS

- Formatos elegibles: `372`.
- Encontrados: `372`.
- Coincidencias exactas: `372/372`.
- Ausentes: `0`; diferentes: `0`; sin ownership: `0`.
- Tracking `VERIFIED`: `372`; tracking `HIDDEN`: `6`.
- Mappings `CONFIRMED`: `376`; `REJECTED`: `2`, justificados por vinos
  inactivos o no accesibles.
- Copas internas esperadas/presentes/vendibles: `31/31/31`.
- Botellas recuperadas con mapping confirmado: `24/24`.
- Retirados aún vendibles: `0`.
- Seis productos retirados se conservan físicamente, pero con flags no
  vendibles.
- Cola activa: `0`.

### 4. Cambios automáticos - WARN

- Automatismos activos a cinco minutos.
- No hay tareas fallidas o bloqueadas desde el 15 de julio.
- La última medición real conocida de propagación fue de hasta `7 minutos`.
- El catálogo actual es exacto, pero no se fabricó una nueva modificación
  comercial para demostrar un SLA estricto de cinco minutos.

No hay fallo fresh; falta evidencia de SLA.

### 5. Estructura y legacy - PASS

- Ocho familias Winerim visibles y reconciliadas.
- Productos legacy conservados: `148`.
- Familias legacy visibles: `0`.
- Productos legacy vendibles o localizables por buscador operativo: `0`.
- Las 31 copas internas están en Agora sin hacerse visibles en la carta pública
  de Winerim, conforme a la excepción pedida por Casa Nene.

### 6. Ventas - WARN

- Historial ERP autenticado: `26` registros reales con origen `TPV` entre el
  16, 17, 18 y 21 de julio.
- Líneas cerradas canónicas en la ventana: `35`, todas de botella, con `37`
  unidades agregadas.
- Operaciones `SUCCESS`: `37`.
- Ejemplos reales del 21 de julio:

| Vino | Variante | Cantidad | `sold_at` local | Importe |
|---|---|---:|---|---:|
| Viñas de Gain | botella | 1 | 2026-07-21 21:51:23 | 36 EUR |
| Pazo de Señorans | botella | 1 | 2026-07-21 21:25:04 | 26 EUR |
| Pazo de Señorans | botella | 1 | 2026-07-21 21:38:47 | 26 EUR |
| Lacima | botella | 1 | 2026-07-21 19:54:48 | 48 EUR |
| San Vicente | botella | 1 | 2026-07-21 19:36:11 | 58 EUR |
| Izar-Leku Brut Vintage | botella | 1 | 2026-07-21 19:08:13 | 38 EUR |

- La hora local y la variante botella se conservan.
- No existe una venta externa reciente de copa que certifique las `31` copas
  internas.
- No existe canary reciente de magnum si el formato se usa.
- Latencia exacta de ingestión ERP: no medida.

### 7. Stock - WARN

- Stock activo de botella comprobado mediante operaciones reales.
- Stock IDs ausentes en líneas cerradas: `0`.
- Duplicados exactos de idempotencia: `0`.
- Cancelación real de Bancales Olvidados: operación provisional y reversión
  `-1`, ambas `SUCCESS`, con clave estable de `open_ticket_reversal`.
- El flujo sales-only está implementado, pero no se generó un canary reciente
  con stock desactivado.
- Tampoco hay canary reciente de stock para copa.

### 8. Resiliencia e idempotencia - WARN

- Breaker cerrado, fallos consecutivos `0`, cola activa `0` y sin deuda
  `FAILED/BLOCKED` reciente.
- Duplicados exactos de idempotencia: `0`.
- La auditoría detectó `2` casos de riesgo provisional/definitivo entre tickets
  abiertos y facturas cerradas. No son duplicados exactos confirmados, pero
  requieren reconciliación antes de firmar el mecanismo.
- No existe canary controlado de caída y recuperación.

### 9. Monitorización - WARN

- Health HTTP `200`, pero estado funcional `STALE`.
- Alerta abierta: `sales_stale`.
- `last_business_day_synced=2026-07-16`, aunque existen ventas e invoices
  posteriores hasta el 21 de julio.
- El cursor atrasado no demuestra pérdida de ventas, pero sí una deuda real de
  observabilidad. No debe adelantarse manualmente sin conciliación.

### 10. Firma final - FAIL

Casa Nene está operativa y su catálogo/legacy pasan el control técnico. No se
firma al 100% por SLA de catálogo no demostrado en cinco minutos, ausencia de
canaries recientes de copa y sales-only, dos riesgos provisional/definitivo y
monitorización obsoleta.

### Falta exacta para 100%

1. Medir una alta o actualización real dentro de cinco minutos.
2. Vender una copa Winerim real y comprobar variante, `sold_at`, stock e
   idempotencia.
3. Hacer un canary sales-only con stock desactivado.
4. Probar magnum si continúa siendo una variante operativa.
5. Reconciliar los dos riesgos provisional/definitivo.
6. Validar una recuperación tras caída sin pérdida ni duplicación.
7. Resolver el cursor diario atrasado y cerrar `sales_stale` por el flujo
   normal.
8. Mantener monitorización limpia durante 24/48 horas.

---

## Chiquilla

Estado operativo observado: catálogo y ventas activos; incidencia anterior de
conectividad recuperada.

### 1. Conectividad - PASS

- Conexión habilitada.
- La lectura fresh final respondió y permitió comparar el catálogo completo.
- Health actual con HTTP `200`.
- Latencia de sonda conocida: `254 ms`.
- Breaker cerrado y `0` fallos consecutivos.
- Hubo un timeout/`AbortError` real entre las `06:28` y `06:31 UTC`; la lectura
  fresh posterior demuestra recuperación. No se siguió esperando durante la
  incidencia.

### 2. Configuración - PASS

- Modo `BIDIRECTIONAL`, escritura `XML_IMPORT`.
- Catálogo, autoalta, autoactualización y verified-ready activos.
- Botella y copa activas.
- Intradía, tickets abiertos y stock intradía activos.
- Cadencia: `5 minutos`.
- Zona horaria: `Europe/Madrid`.
- Capabilities `READY`.

### 3. Catálogo - PASS

- Formatos elegibles actuales: `73`.
- Encontrados en Agora: `73`.
- Coincidencias exactas: `73/73`.
- Ausentes: `0`; diferentes: `0`; sin ownership: `0`.
- Cola activa: `0`.
- Los `9` formatos retirados conocidos ya no están vendibles.
- Su tracking aún conserva estado `VERIFIED`; es una inconsistencia de
  metadatos, no un producto operativo en Agora.

Los contadores históricos de `75`, `82` u `86` corresponden a momentos o
entidades diferentes. La autoridad fresh para formatos actualmente elegibles
es `73/73`.

### 4. Cambios automáticos - PASS

- Existe evidencia real sobre `34` formatos propagados de Winerim a Agora.
- Latencia observada: entre `0,9` y `3,5 minutos`.
- No hay tareas diferenciales activas.

### 5. Estructura y legacy - PASS

- Familias Winerim operativas y reconciliadas.
- Familias legacy visibles: `0`.
- Productos legacy vendibles o localizables por buscador operativo: `0`.
- Legacy conservado para rollback, oculto tanto a nivel familia como producto.
- Retirados Winerim aún vendibles: `0`.

### 6. Ventas - PASS

Hay evidencia real de botella y copa en ledger e historial ERP con origen TPV:

| Vino | Variante | Cantidad | `sold_at` local | Observación |
|---|---|---:|---|---|
| Asúa Crianza | botella | 2 | 2026-07-21 14:45:54 | ERP muestra dos botellas |
| Las Margas Garnacha | botella | 1 | 2026-07-20 20:45:58 | cerrada |
| Mestizaje Blanco | copa | 1 | 2026-07-20 15:07:38 | seguida de reversión |
| Quãdis | copa | 2 | 2026-07-18 15:04:46 | cerrada |
| Don Zoilo Oloroso 12 Años | copa | 1 | 2026-07-18 14:30:23 | cerrada |
| Cruz de Alba | copa | 2 | 2026-07-18 14:03:15 | cerrada |

- Operaciones `SUCCESS` en siete días: `17`.
- Distribución de ledger: `6` operaciones de botella y `11` de copa.
- Unidades de copa agregadas en esas operaciones: `19`.
- Duplicados exactos de idempotencia: `0`.
- La hora y la variante se conservan.
- Latencia exacta de aparición en ERP: no medida.
- No hay evidencia reciente de magnum; solo sería obligatoria si Chiquilla lo
  usa como formato operativo.

### 7. Stock - WARN

- Flujo de stock activo habilitado y con variante conservada.
- Flujo sales-only documentado para stock desactivado.
- Stock IDs ausentes en líneas cerradas: `0`.
- Reversiones canónicas observadas: Fillaboa `+1/-1` y Mestizaje `+1/-1`.
- Existe una venta cancelada que continúa visible como positiva en el ERP. Sin
  identidad completa del documento y de la tarjeta ERP no puede anularse de
  forma segura e idempotente.

Este es un fallo real y acotado del histórico de cancelación, no una caída del
flujo de ventas nuevas.

### 8. Resiliencia e idempotencia - PASS

- La indisponibilidad temporal de la mañana se recuperó sin intervención y el
  catálogo fresh terminó `73/73`.
- Cola activa final: `0`.
- Breaker cerrado y fallos consecutivos `0`.
- Duplicados exactos de idempotencia: `0`.
- El runtime dispone de clave de reversión estable para restaurar una sola vez
  los tickets provisionales cancelados.

### 9. Monitorización - WARN

- Alerta abierta `outbound_queue` asociada a una tarea fallida de publicación
  del vino `139811` por `AbortError`, agotada tras `3` intentos.
- El estado fresh posterior es `73/73`, sin diferencias y con cola activa `0`;
  por tanto la alerta es histórica/obsoleta, no evidencia de una cola viva.
- Queda también la deuda de normalizar el tracking de los `9` retirados.

### 10. Firma final - FAIL

Chiquilla funciona para catálogo, botella y copa, y ha demostrado propagación
dentro de cinco minutos y recuperación tras timeout. No se firma al 100% por
la tarjeta ERP positiva de una cancelación, la alerta obsoleta aún abierta y
el tracking no normalizado de nueve retirados.

### Falta exacta para 100%

1. Identificar de forma inequívoca la venta cancelada que permanece positiva y
   corregirla sin una segunda mutación de stock.
2. Cerrar o resolver la alerta `outbound_queue` después de verificar que el
   monitor reconoce la recuperación actual.
3. Normalizar el tracking de los `9` formatos retirados a estado oculto sin
   republicarlos.
4. Probar magnum solo si el restaurante usa esa variante.
5. Mantener monitorización limpia durante 24/48 horas y obtener aceptación
   visual final del cliente.

---

## Lista consolidada de bloqueos para `100%_SIGNED_OFF`

| Restaurante | Bloqueos exactos |
|---|---|
| Abadía Yuste | Falta medir cambios automáticos; faltan canaries de copa, magnum, stock activo, cancelación y recuperación; legacy visible/buscable con ventas; cursor y alerta stale; falta aceptación visual. |
| Baco Getafe | Conexión deliberadamente deshabilitada en rollback legacy; requiere autorización y onboarding completo nuevo. |
| Casa Esteban | Conexión deshabilitada y catálogo Winerim local vacío; requiere onboarding completo, canaries, monitor y aceptación visual. |
| Casa Nene | SLA de cinco minutos no demostrado; faltan canaries recientes de copa y sales-only; dos riesgos provisional/definitivo; cursor y alerta stale; falta observación limpia 24/48 h. |
| Chiquilla | Cancelación positiva pendiente en ERP; alerta histórica sin cerrar; tracking de nueve retirados no normalizado; falta observación limpia y aceptación final. |

Ninguna conexión de este lote cumple todavía todos los puntos aplicables del
checklist universal. Las tres activas tienen catálogo fresh exacto, pero solo
Chiquilla dispone además de evidencia real de botella, copa y propagación de
catálogo dentro de cinco minutos.
