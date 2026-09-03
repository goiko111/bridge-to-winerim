# Katsu Izakaya definitive Agora activation · 2026-06-19

## Hechos

- Conexion: `982f1e63-5f15-48b8-b35f-037eafd4593e` (`Katsu Izakaya`).
- Se refresco master data Agora y catalogo Winerim antes de escribir.
- Se importaron productos Winerim por XML separado por formato para evitar mappings falsos:
  - `64` botellas;
  - `65` copas;
  - `2` magnums.
- Verificacion viva tras import:
  - `131/131` formatos Winerim esperados existen en Agora;
  - `131/131` estan vendibles;
  - `0` faltantes;
  - `0` productos Winerim como boton raiz;
  - familias Winerim verificadas:
    - `BLANCOS WINERIM`: `29`;
    - `COPAS WINERIM`: `65`;
    - `TINTOS WINERIM`: `16`;
    - `FORTIFICADOS WINERIM`: `4`;
    - `DULCE WINERIM`: `4`;
    - `ESPUMOSOS WINERIM`: `8`;
    - `ROSADOS WINERIM`: `3`;
    - `MAGNUM WINERIM`: `2`.
- Se activo modo definitivo:
  - `enabled=true`;
  - `catalog_sync_enabled=true`;
  - `write_mode=XML_IMPORT`;
  - `auto_push_on_create=true`;
  - `auto_push_on_update=true`;
  - `auto_push_verified_ready=true`;
  - `auto_push_glass=true`;
  - `write_glass=true`;
  - `provider_config.family_structure_mode=WINERIM_DEDICATED_FAMILIES`.
- Se oculto legacy de vino de forma reversible:
  - familias legacy objetivo: `11`, `33`, `37`;
  - productos legacy no Winerim detectados: `198`;
  - productos legacy vendibles tras ocultacion: `0`;
  - productos legacy como boton directo tras ocultacion: `0`.
- Tras activar el catalogo automatico, `fetch-catalog` completo funciono:
  - `67` vinos Winerim leidos;
  - `67/67` detalles correctos;
  - `0` errores de detalle;
  - `newWines=0`;
  - `changedWines=65`;
  - cola XML drenada al final: `0 QUEUED / 0 RUNNING / 0 FAILED / 0 BLOCKED`.
- Ventas:
  - Agora responde y el cursor de ventas esta en `last_business_day_synced=2026-06-18`;
  - las ventas historicas previas a esta activacion seguian entrando desde productos legacy y por eso no sirven para validar stock Winerim;
  - la validacion pendiente es una venta real posterior desde boton Winerim.

## Rollback

- No se ha borrado legacy: se oculto mediante visibilidad/vendibilidad.
- Snapshot previo: `KATSU_LEGACY_HIDE_SNAPSHOT_2026-06-19.json`.
- Aplicacion de ocultacion: `KATSU_LEGACY_HIDE_APPLIED_2026-06-19.json`.
- Para volver atras:
  1. Pausar `auto_push_on_create`, `auto_push_on_update` y `auto_push_verified_ready` en Katsu.
  2. Restaurar los productos legacy con los flags guardados en `KATSU_LEGACY_HIDE_SNAPSHOT_2026-06-19.json`.
  3. Si el cliente pidiera volver visualmente a legacy, reactivar las familias legacy que correspondan tras revisar la pantalla real, porque el snapshot muestra varias familias ya ocultas antes de esta sesion.
  4. Si hiciera falta retirar Winerim visualmente, ocultar las familias `... WINERIM` sin borrar productos ni mappings.

## Riesgos

- No afirmar stock confirmado hasta que haya una venta real posterior a la activacion usando producto Winerim y se compruebe `sales_line_items.mapped=true` + `stock_sync_log.SUCCESS`.
- El fallo historico de stock del 2026-05-20 no queda resuelto por la activacion visual; debe tratarse como deuda antigua si reaparece.
- Si Agora genera nuevas tandas `AUTO_UPDATE`, deben pasar por `process-xml-outbound-queue`; no conviene escribir productos fuera de cola salvo operacion de emergencia documentada.

## Evidencias

- `KATSU_ACTIVATION_VERIFY_2026-06-19.json`.
- `KATSU_FETCH_CATALOG_POST_ACTIVATION_2026-06-19.json`.
- `KATSU_PROCESS_QUEUE_DRAIN_FINAL_2026-06-19.json`.
- `AGORA_FLEET_AUDIT_2026-06-19.json`.
