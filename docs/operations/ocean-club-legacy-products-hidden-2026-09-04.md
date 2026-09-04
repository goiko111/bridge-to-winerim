# Ocean Club - ocultacion de productos legacy · 2026-09-04

Conexion: `706b952e-767d-41af-9cba-8e225b16a877`
Hora: 2026-09-04 17:12 CEST

## Cambio aplicado

Accion unica: `set-product-visibility` sobre los 169 productos legacy de las familias
`41 GLASS WINE`, `49 WHITE WINE`, `50 ROSE WINE`, `51 RED WINE`, `52 CHAMPAGNE`.

- `UseAsDirectSale=false` y `SaleableAsMain=false` (antes: 166 con `SaleableAsMain=true`, 3 ya en false).
- Verificacion viva tras la importacion: 169/169 con ambos atributos en `false`.
- No se han tocado productos Winerim, precios, mappings, tracking, ventas ni stock.

## Rollback

Reaplicar `set-product-visibility` con `useAsDirectSale=false` y `saleableAsMain=true`
para los 169 ids (excepto los 3 que ya estaban en false: ver snapshot previo del panel).

Ids afectados: 440-446, 448-588, 797, 833-837, 955, 1086, 1088, 1167, 1220, 1225, 1226,
1247, 1248, 1254, 1228498, 1228499, 1228506, 1228507, 1228528.
