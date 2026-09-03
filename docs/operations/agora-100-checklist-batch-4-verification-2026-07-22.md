# Verificacion critica del lote 4 - 2026-07-22

Revision estrictamente de solo lectura del informe
`agora-100-checklist-batch-4-2026-07-22.md`. Se contrastaron el resultado
original conservado en `/tmp/agora-batch4-intraday-2026-07-22.json` y las
tablas persistidas de Lovable Cloud. No se realizaron escrituras ni nuevas
sondas largas contra los TPV.

## Luruna - CONFIRMED

El `FAIL` de ventas no depende del total amplio de `1.939` lineas candidatas.
Hay cuatro productos de vino identificables vendidos en facturas cerradas:

| ID Agora | Producto | Lineas | Unidades | Mapeadas |
|---:|---|---:|---:|---:|
| 1330 | COPA LUIS ALEGRE CRIANZA | 20 | 26 | 0 |
| 1164120 | Copia de RAMON BILBAO | 7 | 7 | 0 |
| 676 | COPA GRAN FEUDO NAVARRO | 20 | 21 | 0 |
| 346 | COPA LUIS CANAS CARB. COSECHERO | 51 | 69 | 0 |

Para esos cuatro IDs no existe `product_mapping`, no hay `winerim_product_id`
en las lineas y no existe ninguna fila asociada en `stock_sync_log`. La
auditoria autenticada del ERP devolvio cero tarjetas TPV. El ejemplo mas
reciente es `COPA LUIS ALEGRE CRIANZA`, vendido el 22/07 a las 00:10:58.
Por tanto, el fallo queda confirmado con referencias concretas; el total de
lineas candidatas no debe citarse como volumen exacto de vino.

## PurOsushi - CONFIRMED

La duplicacion es funcional, no una repeticion de la misma clave idempotente,
y esta sustentada por vinos concretos:

- `De los Abuelos 1890` (Winerim 209890, stock 240894): ledger `+1` desde
  ticket abierto, `-1` de reversal y `+1` definitivo. El ERP conserva dos
  tarjetas positivas, el 18/07 a las 23:35 y el 20/07 a las 09:32.
- `Keller Riesling Kabinett Limestone` (Winerim 220996, stock 252877): ledger
  `+1` provisional, `-1` de reversal y `+1` definitivo. El ERP conserva dos
  tarjetas positivas, el 21/07 a las 22:56 y el 22/07 a las 02:00.
- `Etienne Sauzet Puligny-Montrachet` (stock 247115): Agora presenta una venta
  `+1` y su abono `-1`, con neto cero, mientras el ERP conserva tres tarjetas
  positivas.

Las claves del ledger son distintas y validas tecnicamente; precisamente por
eso la ausencia de claves duplicadas no invalida el `FAIL`. Tampoco se usa el
clasificador amplio de 201 lineas para demostrar estos casos. Se mantiene el
veredicto por discrepancia real entre documentos Agora, ledger e historial ERP.

## Ocean Club - CONFIRMED

`WARN`, y no `FAIL`, es la clasificacion correcta. Hay 113 mappings
`CONFIRMED` y 113 trackings `VERIFIED`, pero no existen lineas vendidas
mapeadas, escrituras en `stock_sync_log` ni tarjetas TPV en el ERP. Las ventas
identificables observadas (`GLS CHAMPAGNE`, `WHISP. ANGEL 1,5L` y
`GLS VERDEJO`) pertenecen a botones legacy sin mapping.

Esto demuestra que la operativa sigue usando legacy, pero no demuestra que un
boton Winerim falle: esa ruta aun no se ha probado. El total amplio de `6.749`
lineas candidatas no debe interpretarse como ventas de vino. Hasta ejecutar un
canary real desde un boton Winerim, el resultado debe permanecer `WARN`.

## Conclusion

- Luruna: `CONFIRMED FAIL` por ventas de vinos concretos sin mapping ni llegada
  a Winerim.
- PurOsushi: `CONFIRMED FAIL` por duplicacion funcional y discrepancias
  concretas, aunque no haya claves idempotentes repetidas.
- Ocean Club: `CONFIRMED WARN`; falta evidencia operativa de la ruta Winerim,
  no existe un fallo reproducido de esa ruta.
