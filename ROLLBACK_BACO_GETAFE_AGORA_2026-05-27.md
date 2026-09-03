# Rollback Baco Getafe Agora — 2026-05-27

> Objetivo: revertir la importación de catálogo Winerim en Agora Baco Getafe si el cliente reporta incidencia operativa.

## Identificación
- Cliente: `Baco Getafe`.
- `connection_id`: `32f46d47-3984-413a-8c18-b5502418dadc`.
- Estado dejado tras importación: `enabled=false`, `write_mode=XML_IMPORT`.
- No se documentan credenciales en este archivo.

## Cambios aplicados
- Creadas familias WINERIM:
  - `900157` — `TINTOS WINERIM`
  - `904241` — `BLANCOS WINERIM`
  - `903516` — `ROSADOS WINERIM`
  - `908875` — `ESPUMOSOS WINERIM`
  - `903925` — `DULCE WINERIM`
  - `908182` — `FORTIFICADOS WINERIM`
  - `901954` — `COPAS WINERIM`
  - `904289` — `MAGNUM WINERIM`
- Importados/verificados 118 productos Winerim:
  - 82 botellas.
  - 21 copas.
  - 15 magnums.
- Familias legacy ocultadas:
  - `2` — `VINO`
  - `4` — `FINOS`
  - `5` — `ROSADOS`
  - `6` — `TINTOS`
  - `7` — `CHAMPAGNE`
  - `29` — `BLANCOS`
- Productos legacy ocultados:
  - 348 productos de las familias legacy anteriores quedaron con `UseAsDirectSale=false` y `SaleableAsMain=false`.
- Nombres duplicados tratados temporalmente durante importación:
  - `272054` importado en Agora como `M Alión 054`; nombre Winerim local restaurado a `Alión`.
  - `262977` importado en Agora como `B Villacardiel 977`; nombre Winerim local restaurado a `Villacardiel`.

## Rollback seguro recomendado
1. Mantener `pos_connections.enabled=false` durante todo el rollback.
2. Ocultar productos WINERIM importados:
   - Productos botella: `500000 + winerim_id`.
   - Productos copa: `700000 + winerim_id`.
   - Productos magnum: `900000 + winerim_id`.
   - Usar `agora-proxy` action `set-product-visibility` con `visible=false` en lotes.
3. Ocultar familias WINERIM:
   - Usar `agora-proxy` action `set-family-visibility` con `showInPos=false` para las 8 familias WINERIM.
4. Restaurar familias legacy:
   - Usar `agora-proxy` action `set-family-visibility` con `showInPos=true` para `2`, `4`, `5`, `6`, `7`, `29`.
5. Restaurar productos legacy:
   - Usar `agora-proxy` action `set-product-visibility` con `visible=true` para los 348 productos legacy si el cliente necesita volver al catálogo anterior completo.
6. Ejecutar `sync-master-data`.
7. Verificar:
   - 0 productos WINERIM visibles.
   - Familias legacy visibles.
   - Productos legacy vendibles de nuevo si se aplicó el paso 5.

## Notas
- No borrar productos salvo indicación explícita: ocultar es reversible y conserva histórico.
- No activar `enabled=true` hasta que Lovable Cloud tenga migraciones P0 aplicadas y stock idempotente por variante verificado.

## Rollback ejecutado — 2026-05-29
- Ejecutado rollback operativo a legacy por petición del usuario.
- No se borraron productos ni familias.
- Backups locales creados antes de modificar visibilidad:
  - `.codex-backups/baco-rollback-winerim-to-legacy-before-2026-05-29T08-31-53-116Z.json`.
  - `.codex-backups/baco-legacy-normalize-before-2026-05-29T08-44-26-592Z.json`.
  - `.codex-backups/baco-fix-legacy-frontal-before-2026-05-29T09-34-07-292Z.json`.
- Estado verificado en Agora tras rollback:
  - 118 productos Winerim existentes, 0 visibles/vendibles.
  - 8 familias Winerim ocultas.
  - 6 familias legacy visibles.
  - Corrección posterior tras feedback del cliente: los vinos legacy no deben salir en el frontal; deben estar dentro de `VINO`.
  - `FINOS`, `ROSADOS`, `TINTOS`, `CHAMPAGNE` y `BLANCOS` cuelgan de `VINO` (`ParentFamilyId=2`).
  - 348 productos legacy revisados: 0 con `UseAsDirectSale=true`; 195 vendibles dentro de familia (`SaleableAsMain=true`); 0 productos antiguos/borrados reactivados.
- Estado verificado en Lovable Cloud:
  - `enabled=false`.
  - `catalog_sync_enabled=false`.
  - `write_mode=NONE`.
  - `auto_push_on_create=false`.
  - `auto_push_on_update=false`.
  - `auto_push_verified_ready=false`.
  - Tracking Winerim marcado como `HIDDEN` para Baco.

## Ruta de vuelta a Winerim si el rollback causara problemas
1. Mantener la conexión apagada mientras se restaura (`enabled=false`).
2. Restaurar desde los backups locales si se necesita el XML exacto anterior.
3. Reimportar productos Winerim con `UseAsDirectSale=false` y `SaleableAsMain=true`.
4. Mostrar familias WINERIM y ocultar familias legacy de vino.
5. Confirmar que los 118 productos Winerim quedan visibles solo dentro de sus familias, no como botones raíz.
6. Rehabilitar Lovable Cloud solo tras verificación:
   - `enabled=true`.
   - `catalog_sync_enabled=true`.
   - `write_mode=XML_IMPORT`.
   - `auto_push_verified_ready=true`.
   - `auto_push_on_create=true`.
   - `auto_push_on_update=false` hasta que exista update diferencial.
7. Validar una venta/cierre real con producto Winerim antes de considerar Baco de nuevo en automático.
