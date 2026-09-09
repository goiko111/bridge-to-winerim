# El Higuerón - ocultación de productos legacy (también del buscador) · 2026-09-08

Conexión: `c2e41778-fd14-4a83-9b24-d4fd305fe490`
Hora: 2026-09-08 ~06:20 CEST

## Cambio aplicado

Acción única: `set-product-visibility` sobre los 73 productos legacy mapeados
(`match_method LIKE 'LEGACY%'`, 55 BOTTLE + 18 GLASS).

- `UseAsDirectSale=false` y `SaleableAsMain=false`.
- Verificación viva tras importación: 73/73 con ambos atributos en `false`, `skipped=[]`.
- No se tocaron productos Winerim, precios, familias, mappings, tracking, ventas ni stock.
- Los mappings legacy siguen activos: si se restauran, seguirán descontando stock.

Ids afectados: 2330,2333,2334,2335,2344,2348,2354,2357,2359,2362,2370,2374,2376,2381,
2382,2387,2391,2392,2398,2406,2407,2408,2409,2413,2418,2429,2447,2462,2482,2483,2501,
2507,2515,2518,2527,2535,2536,2541,2542,2545,2548,2550,2553,2559,2565,2571,2577,2578,
2579,2581,2582,2593,2622,2629,2630,2631,2633,3055,3117,3128,3198,3218,3221,3242,3266,
3324,3325,3347,3348,3351,3353,3361,3368.

## Rollback

Reaplicar `set-product-visibility` con `useAsDirectSale=false` y `saleableAsMain=true`
sobre esos 73 ids (estado previo: vendibles como principal, no venta directa).
