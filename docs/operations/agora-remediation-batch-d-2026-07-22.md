# Agora remediation batch D - 2026-07-22

## Alcance y garantias

- Conexiones exclusivas: Sa Pedrera, Restaurante Jardi y Vinatea.
- No se modifico codigo compartido ni se desplegaron funciones.
- No se editaron los cuatro documentos de sesion.
- Todas las escrituras fueron diferenciales y por `connection_id`.
- Se genero snapshot previo, dry-run, rollback identificable y verificacion fresca.
- No se adelanto ningun cursor manualmente y no se proceso ninguna cola de flota.

Snapshots previos:

- `outputs/agora-remediation-batch-d-2026-07-22/sa-pedrera-before.json`
- `outputs/agora-remediation-batch-d-2026-07-22/jardi-before.json`
- `outputs/agora-remediation-batch-d-2026-07-22/vinatea-before.json`
- `outputs/agora-remediation-batch-d-2026-07-22/snapshot-summary.json`

Verificacion posterior:

- `outputs/agora-remediation-batch-d-2026-07-22/sa-pedrera-after.json`
- `outputs/agora-remediation-batch-d-2026-07-22/jardi-after.json`
- `outputs/agora-remediation-batch-d-2026-07-22/vinatea-after.json`
- `outputs/agora-remediation-batch-d-2026-07-22/snapshot-after-summary.json`

## Sa Pedrera

### Hechos previos

- El producto Agora `605908` era el unico diferente: `PRICE_LIST_1_MISMATCH`.
- Winerim `105908`, `E545 - Egly-Ouriet 'Les Premices'`, estaba activo con botella a 150 EUR.
- Winerim `296315`, `B310 - Albenc`, ya no estaba en el catalogo activo; el detalle no era accesible y `/stock/wine/296315` devolvia 404.
- El producto Agora `796315` asociado a ese Albenc ya estaba oculto (`SaleableAsMain=false`, `UseAsDirectSale=false`).
- Cursor previo: `2026-07-15`.

### Cambios aplicados

- Dry-run de `105908`: una unica escritura potencial, formato `BOTTLE`.
- Se publico solo `105908`; el producto `605908` quedo con tarifa 1 a 150 EUR.
- El mapping de `296315` se marco `REJECTED` por estado real inaccesible y su tracking se normalizo a `HIDDEN`.
- No se oculto ni altero el Albenc activo `284166`, que sigue resolviendo ventas correctamente.
- Se desactivo stock provisional de tickets abiertos; las facturas definitivas siguen siendo la fuente de stock.
- Se ejecuto catch-up desde el cursor, sin salto: cinco dias con facturas, 83 eventos y 1.099 lineas; 98 lineas de vino resueltas; ocho deducciones correctas y cero fallos.
- Cursor final: `2026-07-21`.

### Verificacion

- Catalogo fresco: `483/483 MATCH`, cero ausentes y cero diferencias.
- Segunda ejecucion: cero dias pendientes y cero nuevas deducciones; idempotencia confirmada.
- Cola activa: cero. Tareas fallidas recientes: cero.
- Alerta `sales_stale`: resuelta automaticamente.
- Alerta de stock: `ACKED`, clasificada como fallo historico de `296315`. El unico fallo vivo en ventana se creo el `2026-07-22T08:15:38Z`; debe resolverse automaticamente al salir de la ventana de 24 horas si no reaparece.

### Rollback

- Restaurar mapping, tracking y `provider_config` desde `sa-pedrera-prepare-result.json`.
- Para revertir el precio, republicar exclusivamente `105908` con el valor anterior de Agora (118 EUR observado en la venta definitiva previa) y verificar de nuevo el producto `605908`.
- No reducir el cursor: el catch-up es idempotente y ya produjo historia/stock definitivo. Una correccion de stock, si fuese necesaria, debe hacerse con una operacion compensatoria explicita.

## Restaurante Jardi

### Hechos previos

- Cadencia previa: 15 minutos.
- Cursor previo: `2026-07-10`.
- Un ticket abierto residual del `2026-07-11` mantenia un techo de cursor aunque ya existian facturas definitivas.
- Cinco trackings retirados seguian como `VERIFIED`, aunque sus productos ya estaban no vendibles en Agora.
- La familia `45 - BODEGA` contenia solo dos productos vendibles no vinicolas: `401 - CONVINAT` y `488 - calcotada can butjosa`.

### Cambios aplicados

- Cadencia cambiada de 15 a 5 minutos.
- Tickets abiertos desactivados para esta conexion y el dia residual conservado como evidencia `previousBusinessDaysClassifiedStale`; no se borro historial.
- Los cinco trackings retirados se cambiaron a `HIDDEN` sin publicar de nuevo ni tocar Agora.
- Se creo una regla exacta `BODEGA -> is_wine=false` para clasificar los dos productos no vinicolas.
- Catch-up desde el cursor: seis dias con facturas, 58 eventos y 555 lineas; 20 lineas de vino resueltas; cero fallos.
- Cursor final: `2026-07-21`.

### Verificacion

- Catalogo fresco: `177/177 MATCH`.
- Los cinco productos retirados siguen no vendibles y sus trackings ya reflejan `HIDDEN`.
- Segunda ejecucion: cero dias pendientes; idempotencia confirmada.
- Alerta `sales_stale`: resuelta y clasificada.
- Alertas abiertas: cero. Cola activa: cero. Tareas fallidas recientes: cero.

### Rollback

- Restaurar los cinco trackings y el `provider_config` desde `jardi-prepare-result.json`.
- Eliminar solo la regla `wine_family_rules.id=d3b61fd2-420a-4791-9f36-1c3f2ce2d588`.
- Restaurar `sync_frequency_minutes=15` si fuese necesario.
- No reducir el cursor ni borrar eventos importados.

## Vinatea

### Hechos previos

- Cursor previo: `2026-07-18`; cadencia ya era de 5 minutos.
- Los cinco botones legacy de copa `1153` a `1157` ya tenian mapping `CONFIRMED`, formato `GLASS` y match manual exacto.
- Las lineas canonicas y los logs usaban `COPA/copa` y stockIds de copa. La representacion como botella ocurre despues, en la persistencia o renderizado de `sales/import` en Winerim, no en el mapping Agora.
- Los dias de tickets abiertos `2026-07-19` y `2026-07-21` estaban bloqueando el cursor.

### Cambios aplicados

- No se reescribieron los cinco mappings porque ya eran exactos.
- Se desactivaron tickets abiertos y su stock provisional; se conservaron sus dias como evidencia clasificada.
- Catch-up definitivo: un dia con facturas, cinco eventos y 58 lineas; cuatro lineas de vino resueltas; cero fallos.
- Cursor final: `2026-07-21`.
- Dry-run exacto de legacy: cinco sustituciones seguras con boton Winerim de copa visible.
- Se ocultaron solo los botones legacy `1153`-`1157`; no se oculto el resto del legacy.
- Rollback de visibilidad preparado en `vinatea-exact-legacy-hide-dry-run.json`.

### Verificacion

- Los cinco botones legacy quedaron `SaleableAsMain=false` y `UseAsDirectSale=false`, verificados con lectura fresca.
- Sus cinco sustitutos Winerim siguen visibles y los mappings siguen `CONFIRMED/GLASS`.
- Catalogo fresco: `132/132 MATCH`.
- Segunda ejecucion: cero dias pendientes; idempotencia confirmada.
- Alerta `sales_stale`: resuelta. Alertas abiertas: cero. Cola activa: cero. Tareas fallidas recientes: cero.

### Bloqueo residual

- La capa Agora ya entrega y mapea copa correctamente. Falta corregir en Winerim la representacion de `sales/import` que muestra esas ventas como botella. Para evitar una deduccion provisional incorrecta, el stock de tickets abiertos queda desactivado hasta que ese comportamiento se valide.
- La conexion conserva `LIVE_PENDING_SALE_CANARY`; conviene una venta controlada desde uno de los nuevos botones Winerim de copa antes de ampliar la ocultacion legacy.

### Rollback

- Restaurar los cinco botones legacy con `SaleableAsMain=true` y `UseAsDirectSale=false` usando el bloque `rollback` del dry-run.
- Restaurar el `provider_config` desde `vinatea-prepare-result.json` y `vinatea-exact-legacy-hide-config-result.json`.
- No reducir el cursor ni borrar los eventos definitivos importados.

## Resultado del lote

| Conexion | Catalogo fresco | Cadencia | Cursor final | Alertas abiertas | Resultado |
|---|---:|---:|---:|---:|---|
| Sa Pedrera | 483/483 | 5 min | 2026-07-21 | 1 ACKED historica | PASS con observacion temporal |
| Restaurante Jardi | 177/177 | 5 min | 2026-07-21 | 0 | PASS |
| Vinatea | 132/132 | 5 min | 2026-07-21 | 0 | PASS de Agora; WARN de representacion Winerim |

No se han detectado colas activas ni tareas fallidas recientes en estas tres conexiones.
