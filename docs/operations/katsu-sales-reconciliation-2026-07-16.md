# Katsu Izakaya - conciliacion de ventas y catalogo

Fecha: `2026-07-16`

## Alcance

- Comparar las ventas cerradas de Agora contra el historial ERP Winerim desde
  la retirada del legacy: `2026-06-19T09:20:00+02:00`.
- Eliminar duplicados antiguos sin perder ventas reales ni modificar el stock
  final.
- Completar ventas cerradas ausentes mediante `sales/import`.
- Verificar idempotencia actual, catalogo, visibilidad y colas.

## Resultado de ventas

- Lineas canonicas cerradas Agora: `52`.
- Diferencias diarias finales: `0`.
- Diferencias acumuladas por variante: `0`.
- Huellas ERP duplicadas finales: `0`.
- StockIds canonicos sin resolver: `0`.
- Claves idempotentes exactas duplicadas: `0`.

Se anularon tarjetas acumulativas o repetidas de:

- Sarmentero Vendimia Seleccionada, botella.
- Dr. Loosen Red Slate Trocken, copa.
- Lawson's Dry Hills Sauvignon Blanc, copa.
- Biu Blanc, copa.
- Abad Dom Bueno Godello Esencia, copa.

Tambien se corrigio una venta de Rosat de Mestres que el proceso nocturno habia
fechado el `05/07 02:00`; queda registrada con la hora Agora original
`04/07 15:03`.

## Historico completado

- Filas importadas por `POST /api/v2/sales/import`: `14`.
- Unidades registradas sin tocar stock: `24`.
- Segunda ejecucion: todas omitidas por `orderId`, sin duplicados.
- Stock antes y despues de cada importacion: sin cambios.

## Regla de correccion de stock

La cancelacion de una tarjeta ERP repone stock incluso cuando la variante no
usa stock. Bajar despues el inventario con `PUT /stock/{stockId}` crea una
venta nueva como efecto lateral.

La reparacion correcta es:

1. anular la tarjeta incorrecta;
2. leer el stock resultante;
3. aplicar desde el ERP `No, solo ajuste`;
4. importar la venta historica con `sales/import` cuando proceda;
5. repetir el mismo `orderId` y exigir `skipped`.

Las tarjetas tecnicas creadas durante la primera compensacion fueron retiradas
y el stock final quedo igual al inicial.

## Idempotencia viva

Se ejecutaron dos veces seguidas:

- `sync-intraday-sales`;
- `sync-open-tickets`.

Resultado entre la primera y la segunda vuelta:

- `sales_events`: delta `0`;
- `sales_line_items`: delta `0`;
- `stock_sync_log`: delta `0`;
- cola activa: `0`.

En el historial del dia solo quedo la venta real observada:
`Abalon Godello`, copa, `15:45`, una unidad.

## Catalogo

- Vinos Winerim cacheados: `112`.
- Vinos activos: `82`.
- Formatos elegibles: `157`.
- Auditoria fresh Agora: `157 MATCH`, `0 MISSING`, `0 DIFFERENT`,
  `0 UNOWNED`.
- Tracking operativo: `157 VERIFIED` y `35 HIDDEN`.
- Tareas `QUEUED/RUNNING/FAILED/BLOCKED`: `0/0/0/0`.

La doble evaluacion de un alta ya publicada devolvio
`create_skipped:formats_already_verified`. La doble evaluacion de un cambio sin
diferencia devolvio `update_skipped:no_agora_changes`. Ninguna genero tareas.

Cinco tareas antiguas de Craggy Range se reclasificaron como `SUCCESS`: Agora
habia convertido un tabulador en espacio, pero ID, familia, precios y atributos
coincidian.

## Estructura y legacy

- Raiz `VINOS` -> familias Winerim de botella y magnum.
- Raiz `COPAS DE VINOS` -> `COPAS WINERIM`.
- Los productos legacy de vino que permanecen en las raices no son vendibles.
- Los productos Winerim retirados o sin precio permanecen no vendibles.
- La familia legacy `COPAS` contiene destilados y licores, no vinos; se
  preservo su configuracion y no forma parte de la retirada de legacy vinicola.

## Rollback

- No borrar mappings, tracking ni logs.
- Para reconstruir una venta anulada, usar el documento Agora original y
  `sales/import` con el mismo `orderId`.
- Para corregir inventario sin historial, usar `No, solo ajuste`.
- Si el catalogo automatico generase una diferencia real, desactivar
  `auto_push_on_create` y `auto_push_on_update`, sin reactivar legacy.

## Firma pendiente

Katsu queda `LIVE` y tecnicamente conciliado. Para `100%_SIGNED_OFF` formal
faltan solo:

- canary comercial de una alta o cambio real de precio;
- confirmacion visual del cliente tras refrescar el terminal;
- observacion limpia durante 24 horas.
