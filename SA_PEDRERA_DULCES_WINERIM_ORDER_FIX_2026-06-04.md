# Sa Pedrera · Corrección `DULCES WINERIM` por duplicados/orden · 2026-06-04

## Resumen

Sa Pedrera envió vídeo tras el piloto `DULCES WINERIM`. Confirmaron dos problemas:

- dentro de la familia aparecían duplicados botella/copa para algunos vinos;
- los botones no salían por numeración Winerim (`D701-D709`).

Se corrigió el piloto dejando un solo botón visible por código y usando IDs Agora correlativos para forzar el orden visual.

## Evidencia del vídeo

Transcripción:

> Mira, se ve dulces winering, pero cuando abres, te salen ya repetidos. Aquí dos sale dos veces, en India sale dos veces y no salen colocados por la numeración. Continúan saliendo sin estar en orden. Bueno, lo ves como aparece todo, ¿no? Pues ya me dices.

Lectura técnica:

- La tablet ordenaba por `Product.Id`, no por el `SortOrder` enviado en XML.
- Los IDs anteriores dependían del `winerim_id` (`512174`, `512176`, `512178`, `712176`, etc.), por eso visualmente salía `D707`, `D702`, `D706`, `D702`, etc.
- Los duplicados venían de publicar botella y copa del mismo código en la misma familia.

## Corrección aplicada

Política final:

- Un solo botón visible por código `D701-D709`.
- Si Winerim tiene `serve_by_glass=true` y precio de copa, se publica la copa.
- Si no tiene copa activa, se publica botella.
- IDs Agora nuevos correlativos:
  - `903701` para `D701`
  - `903702` para `D702`
  - ...
  - `903709` para `D709`

## Estado verificado por API

Familia visible: `903925` · `DULCES WINERIM`.

Productos visibles finales:

| Código | Agora product id | Formato | Nombre |
| --- | --- | --- | --- |
| D701 | `903701` | GLASS | `C D701- Moscatel de la Marina` |
| D702 | `903702` | GLASS | `C D702-East India Solera` |
| D703 | `903703` | GLASS | `C D703 -Spínola Delicado` |
| D704 | `903704` | GLASS | `C D704 -Jordi Miró Naturalment Pansificat` |
| D705 | `903705` | GLASS | `C D705-El Sequé Dulce` |
| D706 | `903706` | GLASS | `C D706-Niepoort LBV` |
| D707 | `903707` | BOTTLE | `B D707- Valverán Sidra de Hielo` |
| D708 | `903708` | BOTTLE | `B D708- Tokaji Aszú 3 Puttonyos` |
| D709 | `903709` | BOTTLE | `B D709- Petracs` |

Verificación:

- 9/9 productos nuevos en `FamilyId=903925`.
- 9/9 `SaleableAsMain=true`.
- 9/9 `UseAsDirectSale=false`.
- Los 14 productos anteriores del piloto quedaron archivados/ocultos en `POSTRE WINERIM` (`907893`), con nombre `ARCH ...`, `SaleableAsMain=false`, `UseAsDirectSale=false`.
- `product_mappings` y `winerim_push_tracking` apuntan a los nuevos IDs para los formatos visibles; tracking `VERIFIED`.
- `agora_master_data` refrescado: `1268` productos, `73` familias, sin warnings.

## Riesgos / validación pendiente

- La API confirma nombres/familia/visibilidad, pero la validación final del orden debe hacerla el cliente en tablet.
- Esta corrección confirma la hipótesis: para controlar orden visual en Agora no basta `SortOrder`; en esta instalación el orden efectivo depende de `Product.Id`.
- Si el cliente quiere también venta por botella para `D701-D706`, habrá que decidir otra familia o un criterio visual distinto, porque volver a poner B+C en la misma familia recrearía el duplicado reportado.

## Rollback

Rollback al piloto anterior:

- Rehacer visibles los IDs antiguos listados en `SA_PEDRERA_DULCES_WINERIM_TRIAL_2026-06-04.md`.
- Ocultar los nuevos `903701-903709`.

Rollback recomendado si el cliente no acepta esta familia:

- Ocultar `DULCES WINERIM` (`903925`).
- Mantener archivados los productos antiguos y nuevos.
