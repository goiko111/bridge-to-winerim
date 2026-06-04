# Sa Pedrera · Piloto controlado `DULCES WINERIM` · 2026-06-04

## Resumen

Se ejecutó una prueba controlada en Sa Pedrera para publicar solo los vinos Winerim `D701-D709` dentro de la familia Agora `DULCES WINERIM`, reutilizando la familia existente `903925` que estaba oculta como `DULCE WINERIM`.

La prueba se hizo acotada a una sola familia y a códigos comerciales explícitos para evitar tocar el resto de la estructura legacy/regional de Sa Pedrera.

## Hechos

- Conexión Lovable Cloud: `e2f6ce27-0e94-444f-9d64-09ba425a2b83` (`Sa Pedrera`).
- Familia Agora usada: `903925`.
- Estado previo de la familia: `DULCE WINERIM`, `ShowInPos=false`.
- Estado aplicado: `DULCES WINERIM`, `ShowInPos=true`, `Color=#8B0000`.
- Se publicaron y verificaron 14 productos en Agora mediante `export-master`.
- Se refrescó `agora_master_data` después de la importación: `1259` productos, `72` familias, `1` lista de precios, sin warnings de truncado.
- Se actualizaron `product_mappings` y `winerim_push_tracking` para los 14 productos; el tracking quedó `VERIFIED`.
- El cambio de código con acción específica `sa-pedrera-dulces-winerim-trial` está en GitHub (`deaac47`), pero Lovable Cloud todavía servía runtime anterior (`Unknown action`) al ejecutar la operación. La importación real se hizo con script local controlado, usando rate limit, retry y lectura previa.

## Productos publicados

Orden enviado en XML:

| Orden | Código | Formato | Agora product id | Nombre Agora |
| --- | --- | --- | --- | --- |
| 1 | D701 | BOTTLE | `775099` | `B D701- Moscatel de la Marina` |
| 2 | D701 | GLASS | `975099` | `C D701- Moscatel de la Marina` |
| 3 | D702 | BOTTLE | `512176` | `B D702-East India Solera` |
| 4 | D702 | GLASS | `712176` | `C D702-East India Solera` |
| 5 | D703 | BOTTLE | `781705` | `B D703 -Spínola Delicado` |
| 6 | D703 | GLASS | `981705` | `C D703 -Spínola Delicado` |
| 7 | D704 | BOTTLE | `781707` | `B D704 -Jordi Miró Naturalment Pansificat` |
| 8 | D704 | GLASS | `981707` | `C D704 -Jordi Miró Naturalment Pansificat` |
| 9 | D705 | GLASS | `712177` | `C D705-El Sequé Dulce` |
| 10 | D706 | BOTTLE | `512178` | `B D706-Niepoort LBV` |
| 11 | D706 | GLASS | `712178` | `C D706-Niepoort LBV` |
| 12 | D707 | BOTTLE | `512174` | `B D707- Valverán Sidra de Hielo` |
| 13 | D708 | BOTTLE | `733624` | `B D708- Tokaji Aszú 3 Puttonyos` |
| 14 | D709 | BOTTLE | `733627` | `B D709- Petracs` |

## Decisiones

- No se creó una nueva familia duplicada; se reutilizó `903925` porque ya existía como familia Winerim oculta.
- Se usó el código Winerim (`D701-D709`) como orden operativo, no el nombre alfabético.
- Se incluyeron formatos copa solo cuando Winerim marcaba `serve_by_glass=true` y tenía precio de copa.
- No se creó copa para `D707` aunque había `glass_sale_price=8`, porque Winerim marca `serve_by_glass=false`.
- No se ocultó el producto antiguo `712174` (`C D701-Valverán...`) en esta prueba porque no formaba parte de los formatos activos del piloto; queda como residuo a revisar separadamente.

## Riesgos / verificación pendiente

- `export-master` confirma que los 14 productos están dentro de `FamilyId=903925` con nombre correcto, pero no devuelve `SortOrder` de producto. El XML se envió en orden `D701-D709`, pero el orden visual final en tablet debe validarlo el cliente.
- Si Agora ignora `SortOrder`, puede ordenar por otra clave interna o por posición histórica del botón. En ese caso habrá que identificar el campo/layout real de Agora para ordenar pantalla sin romper mappings.
- La acción de Edge Function específica está en GitHub, pero falta confirmar redeploy efectivo en Lovable Cloud antes de depender de ella desde UI/cron.

## Rollback si el piloto no gusta

Rollback visual mínimo:

1. Ocultar familia `903925` (`ShowInPos=false`).
2. Si se quiere volver exactamente al estado anterior, restaurar estos productos preexistentes:

| Product id | Familia anterior | Nombre anterior |
| --- | --- | --- |
| `775099` | `40` | `B Moscatel de la Marina` |
| `975099` | `23` | `C Moscatel de la Marina` |
| `712176` | `23` | `C D702-East India Solera` |
| `712177` | `23` | `C D706-El Sequé Dulce` |
| `712178` | `23` | `C D707-Niepoort LBV` |
| `733624` | `40` | `B D708- Tokaji Aszú 3 Puttonyos` |
| `733627` | `40` | `B D709- Petracs` |

Productos nuevos creados por el piloto que deberían ocultarse en rollback completo:

`512176`, `781705`, `981705`, `781707`, `981707`, `512178`, `512174`.

## Siguiente validación con cliente

Pedir a Sa Pedrera que abra la familia `DULCES WINERIM` en una tablet y confirme:

- si la familia aparece una sola vez;
- si contiene los D701-D709 esperados;
- si el orden visual coincide con Winerim;
- si quiere copas dentro de la misma familia o mantener copas separadas en `Vinos Por Copas`.
