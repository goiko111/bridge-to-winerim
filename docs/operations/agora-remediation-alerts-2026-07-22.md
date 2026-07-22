# Normalizacion de alertas residuales Agora - 2026-07-22

## Alcance y garantias

Se revisaron y normalizaron exclusivamente tres artefactos residuales:

- Chiquilla: una tarea `FAILED` superseded por un catalogo ya exacto.
- Sa Pedrera: un fallo reciente de Albenc, vino retirado e inaccesible.
- Sa Vida: 24 tareas `READINESS_ROLLBACK` de un canary deliberado.

No se reejecutaron tareas, no se proceso ninguna cola, no se publicaron ni
ocultaron productos, no se alteraron ventas o stock, no se editaron funciones
compartidas y no se hizo ningun despliegue.

Secuencia de seguridad:

1. Lectura de `AGENTS.md` y de los informes fresh del 22/07/2026.
2. Auditoria read-only forzando una lectura fresca del catalogo Agora.
3. Snapshot completo de tareas, log, alertas y evidencia de catalogo.
4. Dry-run con guardas de cardinalidad, ownership y cola activa cero.
5. Escrituras diferenciales por ID, con control de estado previo.
6. Auditoria fresh posterior y monitor por conexion en `dryRun=true`.
7. Rollback automatico ante cualquier fallo de aplicacion o verificacion.

## Evidencia previa

Snapshot reversible:

- `outputs/agora-remediation-alerts-2026-07-22/snapshot-before.json`

El snapshot tiene permisos `0600` y conserva los valores originales completos
de cada tarea, log y alerta modificados.

### Chiquilla

- Catalogo fresh: `73/73 MATCH`, cero ausentes, diferencias o productos sin
  ownership.
- Cola `QUEUED/RUNNING`: `0`.
- Tarea: `a104ad03-c29b-400c-b46f-f4b22ad69f4f`.
- Estado previo: `FAILED` por un corte `POS_DOWN` para Winerim `139811`.
- El formato objetivo de esa tarea estaba presente, exacto y owned en la
  lectura fresca.
- Alerta residual: `a4abefeb-d390-4499-a778-f930a70c48ff`.

### Sa Pedrera

- Catalogo fresh: `483/483 MATCH`, cero ausentes, diferencias o productos sin
  ownership.
- Cola `QUEUED/RUNNING`: `0`.
- Albenc Winerim `296315` esta inactivo.
- Mapping del producto Agora `796315`: `REJECTED` con metodo
  `WINERIM_INACTIVE_INACCESSIBLE_20260722`.
- Tracking: `HIDDEN`.
- Producto Agora `796315`: `UseAsDirectSale=false` y
  `SaleableAsMain=false`.
- Existian cuatro fallos historicos. Solo se selecciono el que alimentaba la
  ventana viva de 24 horas: log `380e34e1-7b06-4699-90ec-be03f3bfc29a`, creado
  el `2026-07-22T08:15:38Z`.
- Los otros tres fallos historicos se conservaron sin cambios.
- Alerta residual: `e22c0a58-9852-4ae7-96aa-2b1b7de35f98`.

### Sa Vida

- Catalogo fresh previo: `1542/1542 MATCH`, cero ausentes, diferencias o
  productos sin ownership.
- El aumento desde el snapshot anterior `1541` corresponde a una referencia
  nueva ya publicada correctamente.
- Cola `QUEUED/RUNNING`: `0`.
- Se localizaron exactamente 24 tareas `BLOCKED` con razon
  `READINESS_ROLLBACK` pertenecientes al canary de readiness inicial.
- Cada vino y formato pedido por esas tareas estaba presente, exacto y owned en
  el catalogo fresh posterior.
- Alerta residual: `643b3f10-7c6f-4704-90bc-45d13fc21f17`.

## Acciones aplicadas

### Chiquilla

- La unica tarea superseded paso de `FAILED` a `SUCCESS`.
- Se anadio en `payload_json._resolution` la causa, evidencia fresh, estado y
  error originales.
- No se envio de nuevo a Agora.
- La alerta outbound se marco `RESOLVED` con el ID de tarea y la evidencia
  `73/73`.

### Sa Pedrera

- Solo el fallo reciente de Albenc paso de `FAILED` a `SKIPPED`.
- `winerim_response.resolution` conserva error original, IDs afectados y la
  garantia `no_stock_or_sales_write_performed=true`.
- No se modifico el producto, mapping, tracking, venta ni stock.
- La alerta de stock se marco `RESOLVED`.

### Sa Vida

- Las 24 tareas deliberadas pasaron de `BLOCKED` a `SUCCESS` como objetivos
  superseded por el catalogo exacto y el canary limpio posterior.
- Cada tarea conserva en `payload_json._resolution` el estado y razon de
  bloqueo originales junto con la evidencia `1542/1542`.
- No se reejecuto ninguna tarea y no se escribio en Agora.
- La alerta outbound se marco `RESOLVED`.

## Verificacion posterior

Resultado guardado en:

- `outputs/agora-remediation-alerts-2026-07-22/result-after.json`

| Conexion | Catalogo fresh | Cola activa | Alertas abiertas | Monitor dry-run |
|---|---:|---:|---:|---|
| Chiquilla | 73/73 | 0 | 0 | OK, sin problemas |
| Sa Pedrera | 483/483 | 0 | 0 | OK, sin problemas |
| Sa Vida | 1542/1542 | 0 | 0 | OK, sin problemas |

Estados verificados:

- Chiquilla: tarea superseded `SUCCESS`.
- Sa Pedrera: log reciente de Albenc `SKIPPED`.
- Sa Vida: 24/24 tareas de rollback `SUCCESS` con resolucion trazable.

No aparecio ningun breaker, tarea activa ni discrepancia de catalogo durante la
verificacion.

## Rollback

El rollback restaura exactamente las tareas, el log y las tres alertas desde el
snapshot previo:

```bash
node tmp/agora-remediation-alerts-2026-07-22.mjs \
  --rollback \
  --confirm-superseded-artifacts
```

No debe ejecutarse sin repetir primero la lectura fresh: restauraria alertas y
estados historicos que ya no representan una incidencia activa.

## Resultado

Los tres avisos residuales quedan cerrados sin modificar comportamiento
funcional. Son artefactos terminales y trazables, no ventas, stock ni cambios de
catalogo. Las tres conexiones quedan limpias en los controles afectados; sus
canaries o pendientes comerciales ajenos a estas alertas no se consideran
resueltos por esta operacion.
