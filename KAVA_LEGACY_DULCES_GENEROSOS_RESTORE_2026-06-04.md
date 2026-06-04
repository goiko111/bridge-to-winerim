# Kava · Restaurar legacy `GENEROSOS` y `DULCES` · 2026-06-04

## Resumen

Kava pidió dejar visibles las familias legacy de postres/dulces y fortificados/generosos. Se restauraron solo las familias Agora legacy:

- `2069` · `GENEROSOS`
- `2070` · `DULCES`

El cambio no toca familias Winerim, precios, IVA, preparación, token Winerim ni colas.

## Hechos

- Conexión Lovable Cloud: `f1ce42a4-ffe2-44ea-bb3d-e22b306b1d8c` (`Kava`).
- Estado previo:
  - `GENEROSOS` estaba `ShowInPos=false`.
  - `DULCES` estaba `ShowInPos=false`.
  - Sus 15 productos estaban `SaleableAsMain=false` y `UseAsDirectSale=false`.
- Estado aplicado:
  - `GENEROSOS` queda `ShowInPos=true`.
  - `DULCES` queda `ShowInPos=true`.
  - Los 15 productos quedan `SaleableAsMain=true`.
  - Los 15 productos mantienen `UseAsDirectSale=false` para no crear botones duplicados en la pantalla raíz.
- Verificación posterior en Agora:
  - Familias visibles: 2/2.
  - Productos vendibles dentro de familia: 15/15.
  - Productos directos en raíz: 0/15.
- Se refrescó `agora_master_data`: `1681` productos, `93` familias, sin warnings de truncado.
- Snapshot técnico local: `KAVA_LEGACY_DULCES_GENEROSOS_RESTORE_2026-06-04.json`.

## Productos legacy restaurados

### GENEROSOS (`2069`)

- `14081` · `MANZANILLA PAPIRUSA`
- `14082` · `MANZANILLA ALEGRIA`
- `14083` · `CABERRUBIA CARRASCAL FINO`
- `14084` · `INOCENTE`
- `14085` · `DON ZOILO AMONTILLADO 12 AÑOS`
- `14086` · `PALO CORTADO CLASICO URIUM`
- `14087` · `GREAT DUKE PALO CORTADO`
- `14088` · `BERTOLA PALO CORTADO`
- `14238` · `FINO ELECTRICO EN RAMA`
- `14239` · `GRAN BARQUERO AMONTILLADO`

### DULCES (`2070`)

- `14089` · `MOSCATEL LAUR4A`
- `14090` · `LA CILLA PX`
- `14240` · `DON PX`
- `14241` · `Nº 2 VICTORIA`
- `14242` · `SICHEL SAUTERNES`

## Riesgo importante

Estos productos son legacy. En la revisión previa, la mayoría no tenían mapping Winerim confirmado. Dos productos tenían mapping `PENDING` fuzzy de baja calidad:

- `MOSCATEL LAUR4A` → `Los Aguilares` (`FUZZY`, score 12, `PENDING`)
- `SICHEL SAUTERNES` → `Oxer Suzzane` (`FUZZY`, score 11, `PENDING`)

Por tanto, una venta desde estos botones legacy puede no descontar stock en Winerim ni aparecer correctamente como historial Winerim hasta que se haga mapping seguro o se creen/publican equivalentes Winerim.

## Decisión operativa

Se aceptó restaurar la visibilidad legacy porque la petición es operativa de sala, pero se limitó el alcance:

- no se activaron como botones raíz;
- no se inventaron mappings;
- no se tocaron productos/familias Winerim;
- no se tocaron precios ni preparación.

## Rollback

Para volver al estado anterior:

1. Poner `ShowInPos=false` en familias `2069` y `2070`.
2. Poner `SaleableAsMain=false` y `UseAsDirectSale=false` en los 15 productos listados.

El snapshot previo exacto queda en `KAVA_LEGACY_DULCES_GENEROSOS_RESTORE_2026-06-04.json`.
