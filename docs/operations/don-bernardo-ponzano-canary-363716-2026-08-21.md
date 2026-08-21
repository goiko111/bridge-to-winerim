# Canary productivo Don Bernardo Ponzano — wineId 363716 (2026-08-21)

Conexión: `a700d425-9194-4758-95ff-7fee86419e14` (Don Bernardo Ponzano), modo `VINOTECA_REGION_REFERENCE_NATIVE_FORMATS`.

## Precondiciones verificadas (master fresco 18:07:34Z, 160 familias / 1974 productos)
- Root `112 VINOTECA ABIERTA`: `ShowInPos=true`, sin padre.
- Legacy `123 CAVA`: `ShowInPos=false`, `ParentFamilyId` ausente, no eliminada.
- `Product 2363716` activo en `FamilyId=123`; `SaleFormat 3363716` (copa) presente y activo.
- Winerim `363716` `Reserva Heredad Brut`, región exacta `Cava`, `is_active=true`, `serve_by_glass=true`, botella 35.00, copa 7.00, sin magnum.
- Familia `900284` inexistente antes del canary.

## Hashes snapshot pre-cambio
- `families_json` SHA-256 `42f871bb46f97dcc9d40bd9f809f4612b9b97f72f3f0edc22a7ca8d07d508b21`
- `products_summary_json` SHA-256 `38cac9c8aa388598dba14e24430eca6a685f633c2af25614d4361a862d668c11`

## Cambio de código (solo `agora-proxy`)
`xml-import` ahora resuelve la identidad Agora con `trackingAgoraProductIdForFormat`, de forma que en conexiones VINOTECA persiste exclusivamente `2M/3M/4M` y nunca `500k/700k/900k`.

## Ejecución
| Paso | HTTP | XML SHA-256 |
| --- | --- | --- |
| dry-run previo | 200 | `b49864982913548349c8de4ee8c161b8d2d6b8fccc33d815d57cc8e12d017608` |
| import #1 | 200 (`success:true`) | `b4986498…7608` (idéntico al dry-run) |
| import #2 (idempotencia) | 200 (`success:true`) | `e4336c29bebad92a42a56e7c530098f4a32f78a99bf667df97f82c91219f340d` (sin nodo `<Families>`; `<Product>` byte-idéntico) |

## Readback contractual (master fresco post-import)
- `900284 VINOTECA ABIERTA - Cava`, `ParentFamilyId=112`, `ShowInPos=true`.
- `Product 2363716` → `FamilyId=900284`, nombre/ButtonText/VatId 3/`PreparationTypeId=6`/`PreparationOrderId=2`/`UseAsDirectSale=false`/`SaleableAsMain=true` intactos.
- `SaleFormat 3363716` `C Reserva Heredad Brut` vive bajo `FamilyId=900284`, precio 7.00; botella 35.00 en PL 1 y 3.
- Legacy `123 CAVA` sigue `ShowInPos=false` y rootless; no reactivada.
- Diff de productos: 1 solo cambio (el canary). Diff de familias: solo `900284` nueva + desplazamiento de `Order`; 160 → 161.
- Middleware: `product_mappings` y `winerim_push_tracking` conservan solo `2363716`/`3363716` (0 filas genéricas); estado `PUSHED`/`CONFIRMED`.

## Rollback
XML inverso listo en `don-bernardo-ponzano-canary-363716-rollback-2026-08-21.xml`
(`Product 2363716` → `FamilyId=123`, `900284` → `ShowInPos=false`, nunca borrar).
Rollback de código: revertir `importAgoraIdFor` en `xml-import` y redeployar solo `agora-proxy`.
