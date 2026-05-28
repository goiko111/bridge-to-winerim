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
