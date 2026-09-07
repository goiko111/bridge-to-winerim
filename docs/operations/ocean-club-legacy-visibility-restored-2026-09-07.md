# Ocean Club — familias legacy visibles de nuevo (2026-09-07)

Connection: 706b952e-767d-41af-9cba-8e225b16a877

## Cambio aplicado
`set-family-visibility` → ShowInPos=true en familias 49 (WHITE WINE), 50 (ROSE WINE), 51 (RED WINE), 52 (CHAMPAGNE).
41 (GLASS WINE) ya estaba visible. Familias WINERIM (900157, 901954, 903516, 903925, 904241, 904289, 908182, 908875) siguen ShowInPos=false, sin cambios.
Productos legacy (169, familias 41/49/50/51/52): sin cambios, ya estaban SaleableAsMain=true / UseAsDirectSale=false (estado original).
Verificación viva tras `sync-master-data`: 49/50/51/52 = true.

## Rollback
`set-family-visibility` con showInPos=false para 49, 50, 51, 52.

## Deuda pendiente (no tocada)
Winerim expone variantes de formato grande no soportadas por el middleware:
jeroboam (14 vinos), matusalem (9), salmanzar, baltasar, nabucodonosor, rehoboham (1 cada).
15 vinos afectados. Los botones Agora 3L/6L/9L/12L/15L (~27) facturan pero no descuentan stock.
