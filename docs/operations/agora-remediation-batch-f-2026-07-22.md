# Remediacion Agora - lote F - 2026-07-22

## Alcance

Intervencion de produccion limitada a:

- Abadia Yuste
- Casa Nene
- Chiquilla
- Don Quijote Marbella
- Katsu Izakaya
- Ocean Club

No se edito codigo compartido ni documentacion de sesion. No se cambiaron
precios, productos, mappings, familias, categorias, centros de venta o
visibilidad legacy. Las lecturas fresh y las escrituras operativas se
realizaron sin exponer credenciales.

## Protocolo de seguridad

1. Lectura previa de `AGENTS.md` y los cuatro documentos de sesion.
2. Auditoria fresh de catalogo en modo `READ_ONLY`.
3. Snapshot antes de cualquier escritura.
4. Dry-run de cada cambio de configuracion o estado.
5. Escrituras limitadas por conexion y con control de concurrencia.
6. Verificacion fresh posterior de catalogo, cola, breaker, alertas y flags.
7. Rollback independiente para el lote, Casa Nene y la segunda alerta de
   Chiquilla.

Snapshots conservados con permisos `0600`:

- `outputs/AGORA_REMEDIATION_BATCH_F_CONFIG_ROLLBACK_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_F_CASA_CURSOR_ROLLBACK_2026-07-22.json`
- `outputs/AGORA_REMEDIATION_BATCH_F_CHIQUILLA_ALERT_ROLLBACK_2026-07-22.json`

## Evidencia fresh final

Lectura final ejecutada aproximadamente a las 10:39 UTC, 12:39
Europe/Madrid.

| Conexion | Catalogo Winerim/Agora | Diferencias | Cola activa | Breaker/fallos | Escritura provisional posterior |
|---|---:|---:|---:|---|---:|
| Abadia Yuste | 281/281 | 0 | 0 | cerrado / 0 | 0 |
| Casa Nene | 372/372 | 0 | 0 | cerrado / 0 | 0 |
| Chiquilla | 73/73 | 0 | 0 | cerrado / 0 | 0 |
| Don Quijote Marbella | 114/114 | 0 | 0 | cerrado / 0 | 0 |
| Katsu Izakaya | 157/157 | 0 | 0 | cerrado / 0 | 0 |
| Ocean Club | 115/115 | 0 | 0 | cerrado / 0 | 0 |

En las seis conexiones, `open_tickets_stock_sync_enabled=false`. Los tickets
abiertos pueden conservarse como observabilidad donde el endpoint es fiable,
pero no escriben ventas/stock provisionales en Winerim. Las facturas cerradas
siguen siendo la fuente definitiva.

## Resultado por conexion

### Abadia Yuste - WARN, canaries preparados

Se clasifico el uso legacy real a partir de facturas definitivas entre el 17 y
el 20 de julio. Se localizaron 28 unidades, 292 EUR y 11 botones de vino:

| ID Agora | Boton | Unidades | Importe EUR |
|---:|---|---:|---:|
| 1845 | Copa Ribera del duero | 8 | 28,00 |
| 3224 | Copa Vino extremeno | 5 | 17,50 |
| 3305 | Copa Rioja | 4 | 14,00 |
| 3327 | Copa semidulce | 3 | 9,00 |
| 2103 | Habla de la tierra | 2 | 48,00 |
| 2085 | Valdesil Godello | 1 | 27,50 |
| 2101 | Payva Crianza | 1 | 20,00 |
| 2126 | Vina Puebla Madre Agua | 1 | 34,00 |
| 2147 | Malleolus | 1 | 47,00 |
| 3360 | Muga Rosado Joven | 1 | 22,00 |
| 3390 | Ruiz Torres Verdejo | 1 | 25,00 |

La clasificacion queda como `REVIEW_ONLY_NO_AUTO_MAPPING_NO_HIDE`: no se creo
ningun mapping por nombre y no se oculto ningun boton.

Los canaries preparados son copa, magnum si se usa, stock activo, sales-only,
cancelacion y alta/cambio de precio. No se ejecutaron sin una venta controlada
del cliente.

Bloqueo real: `last_business_day_synced=2025-03-16` y alerta `sales_stale`
abierta. No se cerro porque no esta superseded. Antes de firmar la conexion hay
que decidir el mapping de los 11 legacy y ejecutar los canaries.

### Casa Nene - PASS tecnico, canaries finales pendientes

Se preservo expresamente la excepcion comercial de copas ocultas en la carta
publica pero disponibles en Agora:

- `publish_hidden_glass_variants=true`
- 31 excepciones configuradas, sin cambios en su lista
- catalogo fresh 372/372

Agora seguia exponiendo un ticket abierto del 17 de julio, con 10 lineas y
100,70 EUR, cinco dias despues. No existe una factura definitiva exacta para
ese ticket. Refrescarlo cada cinco minutos mantenia el cursor bloqueado en el
16 de julio.

Se aplico exclusivamente en Casa Nene:

- `open_tickets_sync_enabled=false`
- `open_tickets_stock_sync_enabled=false`
- facturas definitivas intradia conservadas
- guard de dias abiertos neutralizado con motivo documentado

El flujo normal e idempotente avanzo el cursor hasta `2026-07-21`. Verificacion
final: cola 0, breaker cerrado, 0 fallos y 0 alertas abiertas. No se avanzo el
cursor por SQL ni se fabrico una factura.

Quedan pendientes los canaries reales de copa oculta, sales-only, cancelacion
y alta/cambio de precio.

### Chiquilla - PASS de recuperacion

Se verifico dos veces el catalogo fresh: 73/73, sin ausentes ni diferencias, y
cola activa 0.

Los 9 formatos retirados que ya no debian publicarse pasaron de tracking
`VERIFIED` a `HIDDEN`. No se republico ningun producto y la lectura fresh
confirmo que no reaparecieron.

La alerta anterior se cerro como superseded solo despues de obtener 73/73 y
cola 0. El monitor creo posteriormente otra alerta por una tarea `FAILED` de
las 06:31 UTC (`POS_DOWN`, vino Winerim 139811). Esa tarea precedia a la
verificacion fresh y su producto ya estaba correcto; se cerro con evidencia
73/73 y cola 0. Verificacion final: sin alertas abiertas.

No se toco ninguna cancelacion positiva: sigue pendiente una prueba con ID
externo exacto, ademas de magnum si se utiliza y observacion 24 h.

### Don Quijote Marbella - PASS de catalogo, canaries pendientes

Catalogo fresh 114/114, cola 0 y sin alertas. Se preservo todo el legacy.

Inventario legacy de vino previamente auditado y mantenido para el piloto:

- 147 productos vendibles
- 37 en familias visibles
- 110 buscables bajo familias ocultas

No se ejecuto ocultacion masiva. Quedan preparados canaries de botella, copa,
sales-only, cancelacion y ciclo alta/precio/retirada/reactivacion. La decision
sobre legacy debe tomarse despues de una venta oficial Winerim validada.

### Katsu Izakaya - PASS de catalogo, WARN de latencia de copas

Se preservo sin cambios la jerarquia acordada:

- raiz `VINOS`, ID 33: Tintos, Blancos, Rosados, Espumosos, Fortificados,
  Dulce y Magnum Winerim
- raiz `Copas de Vino`, ID 37: Copas Winerim
- legacy oculto reversible

Catalogo fresh 157/157, cola 0 y sin alertas. La escritura provisional quedo
neutralizada; las facturas definitivas son la unica fuente de escritura en
Winerim.

La latencia observada en dos copas del 21 de julio fue:

- `C Paul Cluver Riesling`: aproximadamente 49 min 11 s
- `C Abad Dom Bueno Godello Esencia`: aproximadamente 39 min 07 s

Ambas terminaron con `SUCCESS` y fuente definitiva. La cola no estaba
atascada. La evidencia apunta a que Agora no expuso esas lineas como factura
definitiva hasta mas tarde; no es una demora de procesamiento del middleware.
Se mantiene pendiente un canary de copa bajo cinco minutos que registre hora
de marcado y hora de cierre de la factura, junto con cancelacion y el ciclo de
catalogo.

### Ocean Club - PASS de catalogo, estrategia de navegacion pendiente

Catalogo fresh 115/115, cola 0 y sin alertas. Se preservo todo el legacy y no
se tocaron familias/categorias.

Inventario legacy de vino conservado durante el piloto:

- al menos 162 productos vendibles no owned
- familias principales: `GLASS WINE`, `WHITE WINE`, `ROSE WINE`, `RED WINE`
  y `CHAMPAGNE`

Las familias Winerim siguen no visibles conforme a la estrategia de navegacion
por categorias. La API/procedimiento de categorias por grupo de TPV continua
pendiente de certificacion con el SAT.

Quedan preparados canaries de botella, magnum, sales-only, cancelacion y ciclo
alta/precio/retirada/reactivacion. No se ocultara legacy hasta aprobar la
navegacion y completar una venta real Winerim.

## Decisiones aplicadas

1. Las facturas cerradas son la fuente definitiva de ventas y stock.
2. Los tickets abiertos no pueden escribir provisionalmente en Winerim hasta
   existir cancelacion/compensacion idempotente verificable.
3. Casa Nene no captura tickets abiertos mientras Agora mantenga un ticket
   huerfano del 17 de julio; conserva facturas cerradas intradia.
4. No se infieren mappings legacy por semejanza nominal.
5. No se oculta legacy sin inventario, canary y aprobacion del cliente/SAT.

## Rollback

Reversion del cambio general de flags, tracking Chiquilla y primera alerta:

```bash
node tmp/agora-remediation-batch-f-apply.mjs --rollback --confirm-production-remediation
```

Reversion independiente de Casa Nene:

```bash
node tmp/agora-remediation-batch-f-casa-orphan-ticket.mjs --rollback --confirm-production-cursor-remediation
```

Reversion independiente de la segunda alerta Chiquilla:

```bash
node tmp/agora-remediation-batch-f-chiquilla-alert.mjs --rollback --confirm-superseded-alert
```

No debe ejecutarse ningun rollback sin revisar primero el estado fresh, porque
restauraria la escritura provisional en tickets abiertos.

## Pendientes operativos

1. Abadia: resolver el cursor de ventas y revisar humanamente los 11 legacy
   usados antes de cualquier mapping u ocultacion.
2. Casa Nene: pedir al SAT que cierre/elimine el ticket huerfano del 17/07 y
   ejecutar copa oculta, sales-only y cancelacion.
3. Chiquilla: obtener ID externo exacto para el canary de cancelacion y vigilar
   24 h sin reabrir alertas superseded.
4. Don Quijote: ejecutar botella/copa Winerim y decidir despues el legacy.
5. Katsu: repetir una copa anotando marcado y cierre para separar latencia de
   Agora de latencia middleware.
6. Ocean Club: cerrar con SAT la estrategia de categorias/grupos y ejecutar
   botella/magnum Winerim.

No se concede `100%_SIGNED_OFF` a ninguna conexion con canaries reales
pendientes, aunque su catalogo sea exacto.
