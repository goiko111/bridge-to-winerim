# El Higueron - checklist de cierre al 100 %

Fecha de auditoria y correccion: 2026-07-20

## Resultado ejecutivo

El Higueron queda tecnicamente reconciliado: conexion, catalogo, publicacion,
ventas cerradas, historial ERP, stock, idempotencia, cola y alertas pasan la
auditoria final. Las dos diferencias detectadas se corrigieron sin borrar
evidencia ni crear ventas tecnicas de compensacion.

Estado operativo conservador: `LIVE_PENDING_SALE_CANARY`.

No se firma todavia `100%_SIGNED_OFF` porque falta observar una venta real de
copa desde un boton Winerim y el endpoint de tickets abiertos, aunque responde
HTTP 200, solo devolvio tickets antiguos durante la prueba. No se genero una
venta ficticia para cerrar el checklist.

## Checklist final

| Control | Estado | Evidencia |
|---|---|---|
| Conexion y credencial Agora | PASS | `test` HTTP 200, breaker cerrado y `consecutive_failures=0`. |
| Configuracion automatica | PASS | Conexion activa, bidireccional, XML import y ciclo de 5 minutos. |
| Familias Winerim | PASS | Ocho mappings de familias activos. |
| Catalogo Winerim frente a Agora | PASS | Lectura fresh: `292/292`, `0` missing, `0` different y `0` unowned. |
| Cola operativa | PASS | Cero tareas activas. |
| Alertas | PASS | Cero alertas abiertas o reconocidas. |
| Alta/cambio de catalogo | PASS | `Pago de Carraovejas El Anejon` verificado en Agora en 61 segundos. |
| Flags intradia | PASS | Tickets, stock intradia y current-day-only activos; margen de 2 minutos. |
| Conciliacion definitiva | PASS | Cinco lineas canonicas cerradas, cinco tarjetas ERP cerradas y cero diferencias. |
| Idempotencia | PASS | Cero claves exactas duplicadas y segunda ejecucion sin nueva venta. |
| Venta real de botella | PASS | Ventas reales visibles en ERP con hora, variante y stock correctos. |
| Cancelacion de ticket provisional | PASS | La venta cancelada se retiro y el stock se restauro mediante ajuste sin venta. |
| Venta real de copa | PENDING | Falta una venta real reciente desde `Copas Winerim`. |
| Stock inactivo | PENDING | Falta un canary real si el cliente usa una referencia con stock desactivado. |
| Frescura de tickets abiertos | WARN | El endpoint responde, pero en la prueba solo devolvio tickets de 15 y 17 de julio. |
| Legacy | OPTIONAL | Permanece visible y reversible hasta la aceptacion operativa del cliente. |

## Correcciones aplicadas

### Domaine Vacheron Sancerre Blanc

- Vino Winerim `326937`, stock `368741`, producto Agora `826937`.
- Factura Agora `14401`: una botella, 79 EUR, vendida el
  `2026-07-18 17:58:14 Europe/Madrid`.
- La venta no se resolvia porque el mapping explicito quedaba bloqueado por la
  heuristica `is_wine_candidate=false`.
- El mapping explicito pasa ahora a ser autoritativo. La venta se recupero una
  sola vez con `POST /api/v2/sales/import`, `orderId` determinista y la hora
  original.
- Tarjeta ERP final: venta `143556`, origen TPV, 18/07 a las 17:58, 79 EUR.
- Stock final verificado: `6`.

### La Vieille Ferme Rose Recolte

- Vino Winerim `281972`, stock `324862`.
- Existia una venta provisional de ticket abierto del 19/07 a las 14:20, sin
  factura cerrada y con el ticket ya desaparecido.
- La restauracion de stale tickets devolvio una unidad. La tarjeta provisional
  se cancelo y el stock se dejo en `22` mediante `No, solo ajuste`, sin generar
  una nueva venta.

### Belondrade y Lurton / Finca Rodma Seleccion

- La primera prueba de restauracion consulto demasiados IDs definitivos en una
  sola llamada. El desbordamiento del header de PostgREST se interpreto como
  ausencia y restauro por error dos ventas validas.
- Ambas unidades se corrigieron con `No, solo ajuste`; sus tarjetas TPV
  originales permanecen intactas.
- Stocks finales: Belondrade `30`; Finca Rodma `5`.
- Los logs de reverso se conservaron y se reclasificaron como `SKIPPED` con el
  motivo correctivo. No se borro ninguna fila.

## Endurecimiento desplegado

- `8c74f3b`: un mapping explicito de venta tiene prioridad sobre la heuristica
  generica de producto vino.
- `2c1d151`: la restauracion stale trocea consultas de tickets en bloques de
  100 IDs.
- `c20553e`: la comprobacion de ventas definitivas tambien usa bloques de 100
  y falla de forma cerrada ante cualquier error de base de datos.
- `agora-proxy` fue desplegada desde `c20553e` y el runtime fue verificado.
- Pruebas locales: `16/16` tests, TypeScript sin errores y `git diff --check`
  limpio.

## Vuelta atras segura

1. Antes de revertir cualquiera de los commits anteriores, fijar
   `open_tickets_restore_stale_previous_days_enabled=false` para El Higueron.
2. No borrar `stock_sync_log`, tarjetas ERP ni eventos canonicos: son la
   trazabilidad necesaria para reconstruir cualquier ajuste.
3. No compensar una cancelacion mediante `PUT /stock`; esa llamada crea una
   venta. Usar exclusivamente `No, solo ajuste` para inventario sin historial.
4. Una vez desplegado el rollback, ejecutar reconciliacion read-only y exigir
   cero diferencias antes de volver a activar la restauracion stale.

## Validacion externa pendiente

1. El cliente marca una copa real desde `Copas Winerim`, sin cancelarla.
2. Se comprueba en uno o dos ciclos que aparece una sola vez en el ERP con la
   hora local, variante y stock correctos.
3. Si disponen de una referencia con stock desactivado, se repite el canary y
   se confirma que aparece en historial sin alterar inventario.
4. Se confirma con el cliente si desea mantener u ocultar el legacy de forma
   reversible.

Solo despues de estas comprobaciones se cambia el estado a
`100%_SIGNED_OFF`.
