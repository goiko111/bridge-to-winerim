# Katsu Izakaya - histórico de tres meses y auditoría de stock

Fecha: `2026-07-16`

## Alcance

- Importar ventas Agora desde `2026-04-16` hasta `2026-06-23`.
- Registrar solo historial mediante `POST /api/v2/sales/import`.
- No descontar ni modificar stock en el tramo histórico.
- Auditar desde `2026-06-24` que las ventas canónicas y el stock operativo
  quedaron correctamente procesados.

## Lectura y matching

- Días leídos: `69`.
- Facturas/documentos Agora inspeccionados: `1.201`.
- Líneas inspeccionadas: `10.309`.
- Aliases revisados con variante explícita: `60`.
- Fichero reproducible:
  `docs/operations/katsu-historical-sales-aliases-2026-07-16.json`.

El matching automático inicial no era suficiente porque el histórico usaba
nombres legacy y algunos componentes de menú no incluían familia ni prefijo de
formato. Se corrigió la normalización de `C.`/`B.` y se dio prioridad a los
aliases revisados.

## Neteo documental

Agora puede exportar la misma línea dentro de un ticket, su anulación técnica y
la factura definitiva. El backfill ahora agrupa por la línea física y suma las
cantidades firmadas.

Casos ajustados:

- `2026-04-22`: Rafa Cañizares Syrah copa, `+1 -1 = 0`.
- `2026-04-22`: Lawson's Dry Hills Gewürztraminer copa, `+1 -1 = 0`.
- `2026-05-06`: Sarmentero Vendimia Seleccionada copa,
  `+3 -3 +3 = 3`.
- `2026-05-06`: Abad Dom Bueno Godello Esencia copa,
  `+2 -2 +2 = 2`.
- `2026-06-09`: Sarmentero Vendimia Seleccionada botella, `+1 -1 = 0`.
- `2026-06-09`: Sarmentero Roble copa, `+1 -1 = 0`.

Resultado canónico:

- Tarjetas históricas: `253`.
- Unidades: `366`.
- Importe facturado Agora de las líneas importadas: `2.106,45 EUR`.
- `orderId` únicos: `253/253`.

Winerim calcula el importe visible con el PVP actual de cada variante; no
acepta el importe histórico de Agora. La cantidad, variante y hora sí quedan
conservadas.

## Incidencia y reparación

La primera pasada, anterior al neteo firmado, importó `259` tarjetas y `375`
unidades. La auditoría posterior detectó seis tarjetas no canónicas:

- `141593`: Rafa Cañizares Syrah copa, 1.
- `141594`: Lawson's Dry Hills Gewürztraminer copa, 1.
- `141658`: Sarmentero Vendimia Seleccionada copa, 3.
- `141659`: Abad Dom Bueno Godello Esencia copa, 2.
- `141792`: Sarmentero Vendimia Seleccionada botella, 1.
- `141793`: Sarmentero Roble copa, 1.

Las seis fueron anuladas desde el ERP. Como la anulación repone inventario
incluso con stock inactivo, se restauró cada variante con `No, solo ajuste`.
El stock final quedó exactamente igual al inicial:

- `314153`: `0`, activo.
- `317350`: `0`, inactivo.
- `318061`: `0`, inactivo.
- `318065`: `0`, inactivo.
- `319402`: `-1`, inactivo.
- `319446`: `-1`, inactivo.

No se utilizó `PUT /api/v2/stock/*` para compensar.

## Verificación final del histórico

- ERP Winerim: `253` tarjetas `TPV`.
- ERP Winerim: `366` unidades.
- Diferencias por fecha real + stockId: `0`.
- Segunda ejecución del lote canónico:
  - `imported=0`;
  - `skipped=253`;
  - `failed=0`.
- Stock antes y después de ambas pasadas: sin cambios.

La única huella visual repetida restante corresponde a dos ventas reales de
Sarmentero copa del `2026-05-15`: documentos `T-507` y `T-514`, separados por
21 segundos. No se anuló ninguna.

## Ventas no importadas

Quedan `129` unidades históricas fuera del backfill:

- `118` unidades pertenecen a vinos actualmente inactivos en Winerim, por lo
  que `sales/import` no puede acceder a su stockId.
- `11` unidades no tienen equivalencia fiable:
  Hunters Sauvignon Blanc y Garnacha Tintorera.

No se reactivó ningún vino ni se inventó ningún mapping para completar cifras.

## Auditoría desde el 24/06

- Líneas canónicas cerradas Agora: `52`.
- Historial ERP: `PASS`.
- Diferencias diarias: `0`.
- Diferencias acumuladas: `0`.
- Claves idempotentes duplicadas: `0`.
- Huellas ERP duplicadas: `0`.
- StockIds ausentes: `0`.

Descuentos con stock activo verificados:

- Rosat de Mestres botella: `2 -> 1`.
- Sarmentero Roble botella: `6 -> 5`.
- Tarima Sparkling botella: `1 -> 0`.
- Sarmentero Vendimia Seleccionada botella: `0 -> 0`; la venta se registró,
  pero el inventario ya estaba en cero y no puede bajar de cero.

La diferencia antigua `2026-06-24|318065` (`3` logs frente a `1` venta final)
corresponde a una copa con stock desactivado. No dejó deuda de inventario y el
historial final está conciliado.

## Rollback

- No borrar mappings, tracking ni ledger.
- Las ventas históricas usan `orderId` deterministas.
- Para retirar una tarjeta incorrecta, anularla en el ERP y restaurar el stock
  con `No, solo ajuste`.
- No compensar anulaciones mediante `PUT /stock`, porque crearía otra venta.
