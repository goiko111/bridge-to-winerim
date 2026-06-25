# Agora checklist · Katsu Izakaya · 2026-06-25

## Estado

- Estado operativo: `LIVE_AUTOMATIC` condicionado a prueba intradia real de venta Winerim.
- Conexion: `982f1e63-5f15-48b8-b35f-037eafd4593e`.
- Proveedor: Agora.
- Rollback: reversible. No se borro legacy; se mantiene oculto/no vendible.

## Configuracion activa

- `enabled=true`.
- `catalog_sync_enabled=true`.
- `write_mode=XML_IMPORT`.
- `auto_push_on_create=true`.
- `auto_push_on_update=true`.
- `auto_push_verified_ready=true`.
- `auto_push_glass=true`.
- `write_glass=true`.
- `provider_config.family_structure_mode=WINERIM_DEDICATED_FAMILIES`.
- `provider_config.intraday_sales_sync_enabled=true`.
- `provider_config.sales_timezone=Europe/Madrid`.

## Estructura visual en Agora

- Raiz `33` · `VINOS`
  - visible en Agora;
  - sin productos directos vendibles;
  - contiene:
    - `900157` · `TINTOS WINERIM`;
    - `904241` · `BLANCOS WINERIM`;
    - `903516` · `ROSADOS WINERIM`;
    - `908875` · `ESPUMOSOS WINERIM`;
    - `908182` · `FORTIFICADOS WINERIM`;
    - `903925` · `DULCE WINERIM`;
    - `904289` · `MAGNUM WINERIM`.
- Raiz `37` · `Copas de Vino`
  - visible en Agora;
  - sin productos directos vendibles;
  - contiene:
    - `901954` · `COPAS WINERIM`.

## Verificaciones realizadas

- Master data Agora refrescado a `2026-06-25T15:28:05Z`.
- Catalogo Winerim refrescado:
  - `70` vinos leidos;
  - `0` altas nuevas;
  - `68` updates encolados por activacion de `auto_push_on_update`.
- Cola XML Katsu drenada:
  - `0 QUEUED`;
  - `0 RUNNING`;
  - `0 FAILED`;
  - `0 BLOCKED`.
- Dispatcher `sales-stock` limitado a Katsu:
  - `auto-sync-sales` OK;
  - `sync-intraday-sales` OK;
  - `skippedByBreaker=0`;
  - `skippedByPreflight=0`.
- Monitor de conexiones:
  - alerta `outbound_queue` de Katsu resuelta;
  - sin alertas abiertas para Katsu tras la verificacion.
- Stock reciente:
  - descuentos `SUCCESS` de copa confirmados para `C Sarmentero Vendimia Seleccionada [copa]`;
  - descuento `SUCCESS` de copa confirmado para `C Lawson's Dry Hills Gewürztraminer [copa]`.

## Observacion intradia 2026-06-25

- `sync-intraday-sales` reviso el business day `2026-06-25`.
- Agora devolvio `8` facturas y `58` lineas.
- `resolvedLines=0`: en ese momento no habia venta del dia desde producto Winerim mapeado.
- Por tanto, no habia stock que descontar intradia en esa ejecucion.

## Pendiente para cerrar al 100%

- Pedir al cliente una venta real desde:
  - un producto de `VINOS > ... WINERIM`;
  - y, si usan copas, un producto de `Copas de Vino > COPAS WINERIM`.
- Esperar al siguiente ciclo corto de `sales-stock` o invocar `sync-intraday-sales`.
- Validar:
  - `sales_line_items.mapped=true`;
  - `stock_sync_log.SUCCESS`;
  - variante correcta (`botella`, `copa` o `magnum`);
  - venta visible en historial Winerim si aplica al endpoint desplegado.

## Riesgos conocidos

- `isWineCandidate()` sigue marcando algunas lineas de comida/bebida como candidatas por la clasificacion generica. No descuenta stock si no hay mapping Winerim, pero ensucia metricas de no-mapeados.
- Si reaparecen updates masivos repetidos en cada cron de catalogo, pausar `auto_push_on_update=false` y revisar idempotencia de tracking antes de reactivar.

