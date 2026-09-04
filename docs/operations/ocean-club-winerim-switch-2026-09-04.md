# Ocean Club - vuelco a familias Winerim · 2026-09-04

Conexion: `706b952e-767d-41af-9cba-8e225b16a877`
Hora: 2026-09-04 16:36 CEST

## Estado previo (snapshot para rollback)

| Familia | Id | ShowInPos antes |
|---|---|---|
| GLASS WINE | 41 | true |
| WHITE WINE | 49 | false |
| ROSE WINE | 50 | false |
| RED WINE | 51 | false |
| CHAMPAGNE | 52 | false |
| TINTOS WINERIM | 900157 | false |
| COPAS WINERIM | 901954 | false |
| ROSADOS WINERIM | 903516 | false |
| DULCE WINERIM | 903925 | false |
| BLANCOS WINERIM | 904241 | false |
| MAGNUM WINERIM | 904289 | false |
| FORTIFICADOS WINERIM | 908182 | false |
| ESPUMOSOS WINERIM | 908875 | false |

## Cambio aplicado

Unica accion: `set-family-visibility` (solo atributo `ShowInPos`).

- Las ocho familias `... WINERIM` pasan a `true`.
- Las cinco familias anteriores `41`, `49`, `50`, `51`, `52` pasan a `false`.
- Verificacion viva tras la importacion: `13/13` familias con el valor esperado.
- No se han tocado productos, precios, mappings, tracking, ventas ni stock.

## Rollback

Reaplicar `set-family-visibility` con los valores de la tabla "Estado previo":
`41=true` y el resto `false`.
