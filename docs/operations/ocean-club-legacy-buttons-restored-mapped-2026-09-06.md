# Ocean Club - vuelta a botones legacy con mapping a Winerim · 2026-09-06

Conexion: `706b952e-767d-41af-9cba-8e225b16a877`
Hora: 2026-09-06 19:15 CEST

Decision del cliente: la sala sigue usando sus botones antiguos; cada venta de esos
botones descuenta stock del vino Winerim mapeado.

## Cambios aplicados (en este orden)

1. `product_mappings`: +109 filas MANUAL/CONFIRMED (tabla A del informe
   `OCEAN_CLUB_MATCHING_AGORA_WINERIM_2026-09-06.md`), validadas contra vino activo y
   precio positivo por formato. Total manuales: 125 (16 previas + 109).
2. `set-family-visibility`: restaurado el estado previo al 04/09 -> `41=true`;
   `49,50,51,52=false`; las 8 familias `... WINERIM` = `false`. Verificacion 13/13.
3. `set-product-visibility`: 169 productos legacy con `UseAsDirectSale=false` y
   `SaleableAsMain=true` (169/169 verificados). Nota: los 3 que estaban en false antes
   del 04/09 no quedaron identificados; ahora los 169 son vendibles.
4. `sync-master-data` para refrescar la vista del catalogo.

## Pendiente (a confirmar con Ocean Club)

Referencias de la tabla B del informe (576, 521, 518, 570, 835, 1228506, 1228528,
461/466, 575) siguen sin mapping: facturan en Agora pero no descuentan stock.

## Rollback

- Mappings: `delete from product_mappings where connection_id='706b952e-...' and
  match_method='MANUAL' and created_at >= '2026-09-06 17:10+00'` (109 filas).
- Familias/productos: ver `ocean-club-winerim-switch-2026-09-04.md` y
  `ocean-club-legacy-products-hidden-2026-09-04.md` para reaplicar el estado del 04/09.
