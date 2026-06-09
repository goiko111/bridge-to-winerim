# Sa Pedrera - TINTOS WINERIM - 2026-06-09

## Hechos

- Objetivo: volcar los tintos Winerim de Sa Pedrera dentro de `TINTOS WINERIM` sin tocar el legacy original del TPV.
- Familia destino Agora: `900157` · `TINTOS WINERIM`.
- Estado previo: la familia existia pero estaba oculta (`ShowInPos=false`) y con `DeletionDate=2026-05-18T14:52:45`.
- Vinos detectados: `200` tintos activos Winerim con codigo comercial `T###` y precio de botella.
- Hallazgo antes de escribir: `197/200` nombres ya existian en Agora con el mismo nombre (`B T###...`) dentro de familias regionales Winerim; crear nuevos productos con otros IDs habria provocado rechazo por nombre duplicado y/o duplicidad visual.
- Accion aplicada:
  - `199` productos Winerim existentes se movieron a `TINTOS WINERIM`;
  - `1` producto nuevo se creo porque no existia en Agora: `T83` / `902083` / `B T83- Marqués de Murrieta Reserva`;
  - `TINTOS WINERIM` quedo visible (`ShowInPos=true`);
  - todos los productos importados quedaron `UseAsDirectSale=false` y `SaleableAsMain=true`;
  - se escribieron `Order` y `SortOrder` correlativos `1..200` siguiendo el codigo Winerim.
- Verificacion post-write:
  - Agora import respondio HTTP 200;
  - lectura viva posterior de `Products` y `Families` confirmo `200/200` productos en `FamilyId=900157`;
  - `badCount=0`;
  - cache Lovable Cloud refrescada con `sync-master-data` OK.
- Snapshot de rollback sin secretos: `SA_PEDRERA_TINTOS_WINERIM_APPLIED_2026-06-09.json`.

## Decisiones

- No se usaron IDs nuevos `902###` para todos los tintos porque Agora ya tenia productos Winerim con los mismos nombres y rechaza nombres duplicados.
- Se conservaron los IDs existentes para no romper mappings, tracking ni historico de ventas.
- Se creo solo `T83` con ID `902083` al no existir producto previo.
- El legacy original de Agora no se oculto ni se hizo no vendible en esta accion.
- El codigo de `agora-proxy` queda preparado para que futuras botellas `T###` de Sa Pedrera se enruten a `TINTOS WINERIM` con el ID Winerim normal; copas y magnums conservan su routing de formato.

## Riesgos

- Aunque se escribieron `Order` y `SortOrder`, queda pendiente confirmar en tablet si Agora respeta ese orden para productos existentes. En `DULCES WINERIM` se habia observado que `SortOrder` solo no bastaba.
- La accion no toca el legacy original, pero si mueve productos Winerim que antes estaban publicados en familias regionales (`T Baleares`, `T Ribera C.Leon`, etc.) hacia `TINTOS WINERIM`.
- La cola antigua de Sa Pedrera sigue teniendo tareas `QUEUED/FAILED/BLOCKED`; no se debe reintentar en bloque sin clasificar porque podria alterar visuales validados.

## Rollback

- El rollback completo esta documentado en `SA_PEDRERA_TINTOS_WINERIM_APPLIED_2026-06-09.json`, producto a producto, con `previous.familyId`, nombre y estado previo.
- Rollback visual rapido: ocultar la familia `900157` (`ShowInPos=false`). Esto quita la pantalla nueva, pero no restaura las familias regionales Winerim para esos productos.
- Rollback completo: generar/importar XML que restaure cada producto `existedBefore=true` al `previous.familyId` del snapshot y oculte `900157`; el producto nuevo `902083` puede quedar oculto con la familia o marcarse no vendible si hiciera falta.

## Validacion pendiente con cliente

- Abrir `TINTOS WINERIM` en tablet.
- Confirmar que aparecen los 200 tintos.
- Confirmar que el orden visual sigue `T1, T2, T3... T282`.
- Probar una venta desde `TINTOS WINERIM` y verificar que baja a Lovable Cloud y descuenta stock Winerim.
