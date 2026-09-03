# Verificacion independiente post-remediacion Agora - 2026-07-22

## Alcance y garantias

Auditoria independiente y estrictamente de solo lectura ejecutada despues de los
seis lotes de remediacion del 22/07/2026.

Fuentes revisadas:

- `AGENTS.md` y los cuatro documentos de sesion disponibles;
- `agora-fleet-100-checklist-2026-07-22.md`;
- `agora-remediation-batch-a..f-2026-07-22.md`;
- estado fresh de Lovable Cloud;
- `audit-winerim-products`, declarado `readOnly`, con lectura forzada del
  catalogo Agora para cada conexion activa.

No se procesaron colas, no se lanzaron importaciones, no se reconocieron
alertas, no se crearon ventas, no se modificaron datos y no se ejecuto el
monitor. La primera pasada concurrente produjo un 503 transitorio en Don
Quijote; una repeticion aislada devolvio 114/114 y no dejo breaker ni contador
de fallos.

Ventana operativa observada: aproximadamente 12:55-13:08 Europe/Madrid.

## Resultado de flota

| Control | Resultado fresh |
|---|---:|
| Conexiones Agora | 30 |
| Activas / deshabilitadas | 23 / 7 |
| Conectividad final | 23/23 |
| Frecuencia `<=5 min` | 23/23 |
| `auto_push_on_create/update/verified_ready` | 23/23 |
| `catalog_sync_enabled=true` | 23/23 |
| `open_tickets_stock_sync_enabled=false` | 23/23 |
| Cola activa `QUEUED/RUNNING` | 0 |
| Breakers activos | 0 |
| Cursores en 21/07 | 20/23 |
| Alertas `OPEN/ACKED` | 6 |
| Fallos de stock en 24 h | 1 |
| Tracking `FAILED` en 24 h | 0 |

El catalogo es exacto en 22 conexiones con la comparacion generica. Higueron
presenta cinco diferencias exclusivamente de `ButtonText`; son los aliases
abreviados y documentados que preservan su regla particular. Nombre, precio,
familia, orden y visibilidad coinciden, por lo que su resultado funcional es
292/292.

## Matriz por conexion activa

Leyenda:

- `PASS`: no se demuestra una incidencia viva en los controles leidos.
- `WARN`: existe deuda o una incidencia demostrada que no impide todo el flujo.
- `FAIL`: existe un bloqueo operativo demostrado.
- `EXTERNAL`: el runtime esta correcto, pero falta canary o decision del cliente/SAT.

| Conexion | Estado | Catalogo fresh | Cursor | Alertas / cola / breaker | Tickets abiertos | Bloqueo o pendiente demostrado |
|---|---|---:|---|---|---|---|
| Abadia Yuste | FAIL | 281/281 | 2025-03-16 | 1 OPEN / 0 / cerrado | observa, no escribe | Cursor de ventas detenido; 11 legacy vendidos y canaries pendientes |
| Casa Nene | EXTERNAL | 372/372 | 2026-07-21 | 0 / 0 / cerrado | observacion desactivada | Ticket huerfano del 17/07 en Agora; canaries de copa oculta, sales-only y cancelacion |
| Chiquilla | WARN | 73/73 | 2026-07-21 | 1 OPEN / 0 / cerrado | observa, no escribe | Una tarea FAILED superseded sigue reabriendo la alerta de cola |
| De la O | PASS | 119/119 | 2026-07-21 | 0 / 0 / cerrado | observa, no escribe | Flujo futuro correcto; dos discrepancias historicas preservadas sin compensacion insegura |
| Don Quijote Marbella | EXTERNAL | 114/114 | 2026-07-21 | 0 / 0 / cerrado | observa, no escribe | Venta botella/copa y decision de legacy pendientes; 503 transitorio recuperado |
| El Bejeque | PASS | 94/94 | 2026-07-21 | 0 / 0 / cerrado | observa, no escribe | Sin incidencia viva demostrada |
| El Higueron | WARN | 287/292 generico; 292/292 funcional | 2026-07-14 | 1 ACKED / 0 / cerrado | observa, no escribe | Factura definitiva sin avanzar; cinco aliases intencionales no son fallo de catalogo |
| El Porton de Sorni | EXTERNAL | 175/175 | 2026-07-21 | 0 / 0 / cerrado | observa, no escribe | Revisar legacy no inequivoco y aceptar/probar latencia sales-only |
| Finca Eslava | FAIL | 123/123 | 2026-07-18 | 1 OPEN / 0 / cerrado | observa, no escribe | Cursor definitivo atrasado; legacy no inequivoco y primera venta pendientes |
| Katsu Izakaya | EXTERNAL | 157/157 | 2026-07-21 | 0 / 0 / cerrado | observa, no escribe | Canary de copa con hora de marcado/cierre y cancelacion pendientes |
| Kava | WARN | 230/230 final | 2026-07-21 | 0 / 0 / cerrado | observa, no escribe | Bimbache Tinto se publico en 5 min 42 s; duplicados historicos requieren anulacion Winerim |
| Luruna | WARN | 140/140 | 2026-07-21 | 0 / 0 / cerrado | observa, no escribe | Cuatro botones legacy vendidos siguen sin equivalencia inequivoca |
| Ocean Club | EXTERNAL | 115/115 | 2026-07-21 | 0 / 0 / cerrado | observa, no escribe | Estrategia de categorias/grupos con SAT y canaries pendientes |
| PurOsushi | WARN | 357/357 | 2026-07-21 | 0 / 0 / cerrado | observacion desactivada | Codigo de tickets abiertos antiguos aun puede hacer retroceder el cursor; flujo definitivo sigue operativo |
| Restaurante Cienvinos Ecija | PASS | 519/519 | 2026-07-21 | 0 / 0 / cerrado | observa, no escribe | Sin incidencia viva; dos intentos provisionales historicos no deben reabrirse |
| Restaurante Jardi | WARN | 177/177 | 2026-07-21 | 0 / 0 / cerrado | observacion desactivada | Ticket abierto residual obliga a prescindir temporalmente de observacion intradia |
| Restaurante Qtomas | PASS | 1430/1430 | 2026-07-21 | 0 / 0 / cerrado | observa, no escribe | Sin incidencia viva demostrada |
| Restaurante Triana | EXTERNAL | 129/129 | 2026-07-21 | 0 / 0 / cerrado | observa, no escribe | Canary real pendiente; dos IDs legacy colisionados deben reidentificarse antes de ocultar |
| Sa Pedrera | WARN | 483/483 | 2026-07-21 | 1 ACKED / 0 / cerrado | observa, no escribe | Un fallo de stock de Albenc 296315, retirado/inaccesible, sigue dentro de la ventana de 24 h |
| Sa Vida | WARN | 1541/1541 | 2026-07-21 | 1 OPEN / 0 / cerrado | observa, no escribe | 24 tareas BLOCKED del canary de rollback generan ruido aunque no exista cola activa |
| Taberna de Elia | PASS | 407/407 | 2026-07-21 | 0 / 0 / cerrado | observa, no escribe | Flujo vivo correcto; duplicados historicos solo son corregibles con anulacion trazable |
| Tintorera | EXTERNAL | 313/313 | 2026-07-21 | 0 / 0 / cerrado | observa, no escribe | Primera venta real y decision posterior de legacy pendientes |
| Vinatea | WARN | 132/132 | 2026-07-21 | 0 / 0 / cerrado | observacion desactivada | `sales/import` representa algunas copas como botella en ERP; canary real pendiente |

## Incidencias demostradas restantes

1. **Cursores de ventas:** Abadia Yuste, Higueron y Finca Eslava no han
   avanzado a 21/07. No deben corregirse adelantando el cursor por SQL; hay que
   demostrar si faltan facturas cerradas, cierre de caja o mapping.
2. **Monitor Chiquilla:** el informe F afirma que la segunda alerta superseded
   quedo cerrada, pero el estado fresh muestra la misma tarea
   `a104ad03-c29b-400c-b46f-f4b22ad69f4f` en `FAILED` y una alerta
   `outbound_queue` OPEN. El catalogo 73/73 prueba que no es una diferencia de
   producto, pero el monitor seguira reabriendola mientras la tarea conserve
   ese estado.
3. **Sa Pedrera:** queda un fallo de stock de `B B310- Albenc 315`, Winerim
   296315, por `Wine not found/not accessible`. Coincide con la clasificacion
   de retirado del lote D; la alerta solo puede considerarse resuelta si no
   reaparece al salir de las 24 horas.
4. **Sa Vida:** las 24 tareas `READINESS_ROLLBACK` no estan activas y el
   catalogo es exacto, pero siguen clasificadas como `BLOCKED`; el monitor las
   interpreta como incidencia y mantiene una alerta OPEN.
5. **Kava:** `Bimbache Tinto` se creo en cache a las 11:01:29 UTC y quedo
   verificado en Agora a las 11:07:11 UTC: 5 min 42 s. El segundo fresh dio
   230/230. La automatizacion funciona, pero esta muestra excede el SLA de cinco
   minutos en 42 segundos.
6. **Tickets abiertos y cursor:** Casa Nene, PurOsushi, Jardi y Vinatea tienen
   observacion desactivada para evitar que tickets huerfanos/antiguos frenen o
   hagan retroceder el cursor. La escritura definitiva por factura permanece
   activa y la escritura provisional esta desactivada en toda la flota.
7. **Representacion Vinatea:** Agora y el middleware resuelven varias lineas
   como `GLASS`, pero Winerim las representa como botella al importar. Es un
   problema de presentacion/contrato del endpoint Winerim, no del catalogo Agora.
8. **Correccion historica:** Kava, De la O, PurOsushi, Qtomas y Taberna
   conservan incidencias historicas que no admiten borrado o compensacion segura
   sin un endpoint Winerim de anulacion idempotente con trazabilidad.

## Bloqueos externos: canary o decision

- Abadia Yuste: identificar/matchear 11 legacy usados y ejecutar copa, stock,
  sales-only, cancelacion y catalogo.
- Casa Nene: SAT debe cerrar o explicar el ticket huerfano; probar copa oculta.
- Chiquilla: obtener ID externo exacto para cancelacion y observar 24 horas.
- Don Quijote: venta Winerim de botella/copa y decision de legacy.
- Higueron: tres canaries preparados y cierre de factura real.
- Porton y Finca: revisar legacy no inequivoco con el cliente.
- Katsu: registrar hora de marcado y hora de cierre de una copa real.
- Luruna: identificar cuatro legacy por SKU/codigo o confirmacion humana.
- Ocean Club: cerrar con SAT la navegacion por categorias y grupos de TPV.
- Triana: venta real y reidentificacion fresh de dos IDs colisionados.
- Tintorera y Vinatea: primera venta real desde boton Winerim.

## Contradicciones y diferencias frente a los lotes

1. **Chiquilla, contradiccion real:** el lote F declara cierre de la segunda
   alerta; el fresh posterior muestra alerta OPEN y tarea FAILED. Debe
   corregirse la regla de superseded o el estado final de la tarea con evidencia,
   sin reejecutarla.
2. **Kava, cambio posterior al lote:** el lote A cerro en 229/229. Durante esta
   auditoria aparecio un nuevo vino, primero 229/230 y despues 230/230. No
   invalida el snapshot del lote, pero aporta una medida real de propagacion de
   5 min 42 s.
3. **Taberna de Elia, cardinalidad cambiada:** el lote A cerro en 410/410 y el
   fresh actual es 407/407. No hay ausentes ni diferencias; la fuente Winerim
   elegible se redujo en tres formatos despues del lote. Debe conservarse como
   cambio de fuente, no interpretarse como perdida en Agora.
4. **Don Quijote, transitorio recuperado:** la primera lectura fresh dio HTTP
   503 bajo carga concurrente; la repeticion aislada dio 114/114, sin breaker ni
   fallos consecutivos. No contradice el PASS del lote F.
5. **Higueron, excepcion confirmada:** el 287/292 generico coincide con el lote
   E. Las cinco diferencias son exclusivamente aliases de `ButtonText` y no una
   regresion funcional.
6. **Sa Vida, informe final confirmado:** aunque el primer probe dejo
   `verified-ready` desactivado, el informe B documenta una reparacion posterior
   y canary estable. El valor top-level fresh es `true`, coherente con el cierre
   final, pero la alerta de las 24 tareas iniciales permanece.

## Conclusiones

- No queda ninguna conexion activa con escritura provisional de tickets.
- No hay cola activa ni breaker abierto en toda la flota.
- La publicacion automatica esta habilitada en las 23 conexiones activas.
- No puede declararse la flota `100%_SIGNED_OFF`: hay tres cursores atrasados,
  deuda de monitor en Chiquilla/Sa Vida, una alerta temporal de stock en Sa
  Pedrera, cuatro excepciones de observacion de tickets y canaries/decisiones
  externas pendientes.
- Las prioridades inmediatas son: cursores Abadia/Higueron/Finca, evitar la
  reapertura falsa de Chiquilla, separar tareas de rollback de las alertas de
  cola en Sa Vida y corregir el acoplamiento tickets abiertos/cursor.
