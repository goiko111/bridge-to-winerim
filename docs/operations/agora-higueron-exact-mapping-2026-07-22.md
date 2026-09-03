# El Higuerón - matching exacto de legacy vendido

Fecha: 2026-07-22

Conexión: `c2e41778-fd14-4a83-9b24-d4fd305fe490`

Ventana analizada: ventas desde `2026-07-15`

## Alcance y restricciones

La operación se limitó exclusivamente a El Higuerón. El objetivo era reducir el
bloqueo del cursor mediante mappings de productos legacy vendidos, aceptando
únicamente:

1. código/SKU exacto con variante única; o
2. nombre normalizado exacto con variante única.

Quedaron expresamente fuera productos genéricos, licores, bebidas ambiguas,
coincidencias aproximadas y targets no unívocos. También quedaba prohibido
procesar ventas, stock o cursor y modificar flags, catálogo o legacy.

## Lectura fresh y snapshot

Antes de escribir se ejecutaron lecturas fresh de salud, catálogo y ventas
cerradas por día. Los snapshots, planes, verificaciones y rollback están en:

`outputs/agora-higueron-exact-mapping-2026-07-22/`

Todos los ficheros de evidencia tienen permisos `0600`. Los principales son:

- `snapshot-before.json`: estado inicial, catálogo fresh y primer plan;
- `snapshot-before-dry-run-aa652b837bfb.json`: dry-run de las copas exactas;
- `snapshot-before-dry-run-4f53cda18c2b.json`: cobertura tras 24 matches;
- `snapshot-before-dry-run-74cffa93e7ae.json`: propuesta posterior no aplicada;
- `rollback.json`: 24 tuplas exactas y DELETE de vuelta atrás por ID;
- `final-audit-after-rollback-final.json`: auditoría final de solo lectura;
- `emergency-rollback-final.json`: resumen forense y estado final.

Estado inicial relevante:

- cursor: `2026-07-14`;
- mappings existentes: `292`;
- tracking existente: `292`;
- cola activa: `0`;
- breaker cerrado y `0` fallos consecutivos.

## Criterio de matching

La normalización solo eliminó acentos, puntuación, espacios repetidos y el
prefijo técnico compatible con la variante (`B`, `C`, `M`, incluyendo `C.`).
No se eliminaron palabras comerciales que pudieran convertir dos vinos
distintos en el mismo nombre.

Cada candidato debía cumplir simultáneamente:

- haber sido vendido desde `2026-07-15`;
- no tener ya resolución válida;
- pertenecer a una única variante observada;
- tener exactamente un vino Winerim candidato para esa variante;
- no compartir el mismo target vino-variante con otro legacy propuesto;
- no ser genérico, licor ni falso positivo.

El primer dry-run encontró `22` botellas exactas y rechazó `358` candidatos. El
segundo encontró `2` copas exactas. No apareció ningún match por código/SKU; los
24 fueron por nombre normalizado exacto más variante única.

## Plan exacto aplicado y revertido

| ID Agora | Producto legacy | ID Winerim | Variante | Evidencia |
|---:|---|---:|---|---|
| 2330 | ABADIA RETUERTA LE DOMAINE | 281924 | BOTTLE | nombre exacto + variante única |
| 2354 | MARQUES DE RISCAL LIMOUSIN | 281909 | BOTTLE | nombre exacto + variante única |
| 2357 | LAPOLA | 281905 | BOTTLE | nombre exacto + variante única |
| 2359 | VIÑA ZORZAL CHARDONNAY | 281913 | BOTTLE | nombre exacto + variante única |
| 2376 | JOSE PARIENTE VERDEJO | 281916 | BOTTLE | nombre exacto + variante única |
| 2381 | EYA MOSCATO | 281931 | BOTTLE | nombre exacto + variante única |
| 2391 | O LUAR DO SIL | 281922 | BOTTLE | nombre exacto + variante única |
| 2392 | AVANCIA GODELLO | 281962 | BOTTLE | nombre exacto + variante única |
| 2398 | TRIAY GODELLO | 281944 | BOTTLE | nombre exacto + variante única |
| 2406 | C EMILIO MORO | 282010 | GLASS | nombre exacto + variante única |
| 2413 | C VIÑA ZORZAL CHARDONNAY | 281913 | GLASS | nombre exacto + variante única |
| 2462 | BOLLINGER SPECIAL CUVEE | 281870 | BOTTLE | nombre exacto + variante única |
| 2501 | SAN ROMAN | 282101 | BOTTLE | nombre exacto + variante única |
| 2507 | PROTOS 27 | 282028 | BOTTLE | nombre exacto + variante única |
| 2535 | ULTREIA SAINT JACQUES | 281985 | BOTTLE | nombre exacto + variante única |
| 2541 | ANGELES DE AMAREN | 282032 | BOTTLE | nombre exacto + variante única |
| 2548 | AALTO PS | 281990 | BOTTLE | nombre exacto + variante única |
| 2550 | PSI | 282035 | BOTTLE | nombre exacto + variante única |
| 2553 | MAURO | 282021 | BOTTLE | nombre exacto + variante única |
| 2577 | DEHESA DE LOS CANONIGOS | 282005 | BOTTLE | nombre exacto + variante única |
| 2578 | BOSQUE DE MATASNOS | 326912 | BOTTLE | nombre exacto + variante única |
| 2630 | NUMANTHIA | 282106 | BOTTLE | nombre exacto + variante única |
| 2631 | ALONSO DEL YERRO | 282076 | BOTTLE | nombre exacto + variante única |
| 3325 | CANECO | 327194 | BOTTLE | nombre exacto + variante única |

Hashes de autorización del plan:

- 22 botellas: `7e8f61e873e4c654acb980149d648057c92eb641779869453ebc8eb930e47ab3`;
- 2 copas: `aa652b837bfba0877f578f66670bfcdc7b19507e19727d2b2df27761e95e13bb`.

Tras los 24 mappings, la cobertura del primer día bloqueado mejoraba de
`1/63` líneas estrictas resueltas a `18/63`; las no resueltas bajaban de `62` a
`45`. Esto demuestra utilidad, pero no era suficiente para liberar el cursor.

La propuesta adicional `3324 · C. CANECO -> 327194 · GLASS`, hash
`74cffa93e7ae43e676be7a0b92cf1cac5fbf8c2a0bfbfa9b81029458a9664b46`,
se detectó después y **no se aplicó**.

## Condición de carrera detectada

El dry-run y los writes por ID fueron correctos, pero existe una condición de
carrera operativa: el cron definitivo de producción detecta inmediatamente los
mappings `CONFIRMED` y comienza a consumir ventas históricas. No hubo una
invocación manual de ventas o stock, pero el cron activo empezó a procesar los
días `2026-07-16` y `2026-07-17` antes de terminar la verificación.

Esto incumplía la restricción de no procesar ventas, stock ni cursor. En cuanto
se observó el primer lote se ejecutó el rollback exacto de los 24 mappings.

Efectos automáticos alcanzados antes del rollback:

| Día | Modo | Logs SUCCESS | Cantidad |
|---|---|---:|---:|
| 2026-07-16 | stock activo, delta diario | 9 | 10 |
| 2026-07-16 | stock inactivo, sales/import | 2 | 9 |
| 2026-07-17 | stock activo, delta diario | 6 | 7 |
| 2026-07-17 | stock inactivo, sales/import | 2 | 26 |

Total: `19` logs exitosos, `17` unidades con stock activo y `35` unidades
registradas mediante `sales/import` con stock inactivo. No hubo fallos.

No se intentó una compensación automática. Restaurar stocks previos o borrar
historial sin reconciliar las facturas reales podría crear duplicados o
falsear ventas legítimas. Los logs e idempotency keys se conservaron.

## Rollback ejecutado

El rollback eliminó exclusivamente las 24 filas que coincidían en:

- `connection_id` de El Higuerón;
- `provider_product_id` exacto;
- `winerim_wine_id` exacto;
- variante exacta;
- `match_method=LEGACY_EXACT_*_20260722`.

No se hizo un borrado por nombre, rango ni conexión completa. Las 24 operaciones
reproducibles están enumeradas en `rollback.json`.

## Invariantes finales

Verificación final fresh: `2026-07-22T12:03:09.479Z`.

| Invariante | Antes | Después | Estado |
|---|---:|---:|---|
| Identidad de conexión | El Higuerón | El Higuerón | PASS |
| Enabled | true | true | PASS |
| Write mode | XML_IMPORT | XML_IMPORT | PASS |
| Cursor | 2026-07-14 | 2026-07-14 | PASS |
| Mappings totales | 292 | 292 | PASS |
| Mappings del lote | 0 | 0 | PASS tras rollback |
| Tracking | 292 | 292 | PASS |
| Cola activa | 0 | 0 | PASS |
| Breaker | cerrado | cerrado | PASS |
| Fallos consecutivos | 0 | 0 | PASS |

El último efecto automático asociado al lote terminó a las
`2026-07-22T11:51:19.217Z`. Las auditorías posteriores de `11:56`, `11:57`,
`11:59` y `12:03 UTC` confirmaron que no aparecieron nuevos logs de stock del
lote. El cron normal siguió actualizando únicamente su telemetría de lectura.

No se cambiaron flags operativos, catálogo, familias, visibilidad legacy,
precios ni ownership. Los únicos campos de `provider_config` que variaron fueron
`last_intraday_sales_sync` y `last_open_tickets_sync`, actualizados por el cron
normal, no por esta operación.

## Resultado y siguiente condición segura

El objetivo **no se da por completado**: los matches exactos están identificados
y probados, pero se revirtieron para respetar el alcance. Mantenerlos confirmados
en producción habría continuado procesando ventas y stock.

Antes de reintentar se necesita un bloqueo de mantenimiento por conexión que:

1. impida a los procesadores de ventas consumir nuevos mappings;
2. permita insertar y verificar mappings exactos dentro de una ventana aislada;
3. libere el procesamiento solo con autorización explícita;
4. conserve cursor, stock e historial sin efectos laterales durante la fase de
   matching.

Hasta disponer de ese mecanismo, no se deben volver a aplicar los 24 mappings
en una conexión activa. El operador local
`tmp/agora-higueron-exact-mapping-2026-07-22.mjs` conserva el dry-run, pero su
modo `--apply` queda bloqueado de forma explícita hasta implementar ese lock.

## Reaplicación aislada bajo lease de `sales-stock`

Segunda ventana ejecutada entre `2026-07-22T12:24:45Z` y
`2026-07-22T12:29:11Z`, usando el RPC existente de lease del dispatcher y sin
modificar código, flags, `provider_config`, cursor, catálogo o legacy.

1. Baseline: `292` mappings, `292` tracking, cursor `2026-07-14`, cola activa
   `0` y los mismos `19` logs previos con idempotency key.
2. El lease `sales-stock` se adquirió a las `12:25:06Z`, con vencimiento a las
   `12:40:06Z`; una segunda comprobación confirmó ownership antes de escribir.
3. Los mismos `24` mappings exactos se insertaron atómicamente bajo una
   precondición `WHERE EXISTS lock_check` y quedaron marcados con
   `maintenance_reapply:4e47b041-572f-48c7-9af6-497af387695b`.
4. Dos verificaciones separadas por más de veinte segundos mantuvieron:
   mappings `316`, lote `24`, tracking `292`, cursor `2026-07-14`, cola `0` y
   exactamente los mismos `19` logs.
5. El lease se liberó explícitamente a las `12:26:20Z` y la tabla de locks
   quedó vacía para la conexión.
6. La observación posterior, hasta `12:29:11Z`, no detectó nuevos
   `stock_sync_log`, `sales_events`, tareas abiertas ni movimiento de cursor.

La auditoría completa de `stock_sync_log` de El Higuerón contiene `30` filas y
`0` idempotency keys duplicadas. Los `19` efectos de la carrera inicial se
conservan intactos para conciliación; no se compensaron ni se reescribieron.

### Estado final de esta intervención

| Invariante | Estado final |
|---|---:|
| Mappings totales | 316 |
| Mappings exactos reaplicados | 24 |
| Tracking | 292 |
| Cursor | 2026-07-14 |
| Cola activa | 0 |
| Breaker | cerrado |
| Nuevos writes tras reaplicación | 0 |
| Idempotency keys duplicadas | 0 |

La reaplicación exacta queda completada de forma aislada. El cursor no se
libera todavía: la cobertura del primer día sigue siendo parcial y las líneas
legacy ambiguas requieren equivalencia humana. El lease protege la operación
de mantenimiento, pero no autoriza procesar una factura incompleta.
