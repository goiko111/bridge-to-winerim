# Sa Pedrera - Familias Winerim dedicadas - 2026-06-09

## Hechos
- Conexion: `Sa Pedrera` (`e2f6ce27-0e94-444f-9d64-09ba425a2b83`).
- Objetivo: ampliar el piloto validado de `DULCES WINERIM` y `TINTOS WINERIM` al resto de familias Winerim, sin ocultar el legacy regional del cliente.
- Familias Winerim visibles en Agora:
  - `900157` `TINTOS WINERIM`.
  - `904241` `BLANCOS WINERIM`.
  - `903516` `ROSADOS WINERIM`.
  - `908875` `ESPUMOSOS WINERIM`.
  - `908182` `FORTIFICADOS WINERIM`.
  - `904289` `MAGNUM WINERIM`.
  - `901954` `COPAS WINERIM`.
  - `903925` `DULCES WINERIM` se mantiene desde el piloto anterior.
- Operacion aplicada por import XML controlado:
  - `TINTOS WINERIM`: `200` productos esperados verificados.
  - `BLANCOS WINERIM`: `98` productos verificados.
  - `ROSADOS WINERIM`: `8` productos verificados.
  - `ESPUMOSOS WINERIM`: `43` productos verificados.
  - `FORTIFICADOS WINERIM`: `1` producto verificado.
  - `MAGNUM WINERIM`: `29` productos verificados.
  - `COPAS WINERIM`: `15` productos verificados.
- Total snapshot final: `394` productos esperados, todos con `badCount=0`, `UseAsDirectSale=false` y `SaleableAsMain=true`.
- La cola de salida de Sa Pedrera quedo estable en `0 QUEUED / 0 RUNNING` tras pausar el auto-push de catalogo y procesar la tanda abierta.
- `provider_config.family_structure_mode` queda en `WINERIM_DEDICATED_FAMILIES` con reglas de routing hacia familias Winerim.
- Se detecto un duplicado no deseado de `T83` con `ProductId=784242`; quedo no vendible (`SaleableAsMain=false`, `UseAsDirectSale=false`) y el mapping se marco `REJECTED`.
- El producto canonico de `T83` queda:
  - botella `902083` en `TINTOS WINERIM`;
  - copa `984242` en `COPAS WINERIM`.
- `D207-Domaine Les Bruyeres 'Georges' Crozes-Hermitage` (`675360`) queda en `TINTOS WINERIM` como tinto activo real de Winerim, aunque no forma parte del subconjunto `T###` ordenado.

## Decisiones
- Mantener visible el legacy regional de Sa Pedrera por ahora. La accion solo asegura que Winerim existe en familias dedicadas y no borra la organizacion previa del cliente.
- Pasar Sa Pedrera de `LEGACY_REGION_ROUTING` a `WINERIM_DEDICATED_FAMILIES` para que cualquier XML generado por el runtime actual use familias Winerim.
- Pausar temporalmente `auto_push_on_create=false` y `auto_push_on_update=false` en Sa Pedrera.
- Motivo de la pausa: el runtime vivo seguia reencolando `AUTO_CREATE` de productos ya verificados cada ciclo, generando tandas repetidas de importaciones contra Agora.
- Mantener ventas/stock activos: la pausa afecta al auto-push de catalogo Winerim -> Agora, no al flujo de ventas Agora -> Winerim.

## Rollback
- Snapshot de configuracion previa: `SA_PEDRERA_PROVIDER_CONFIG_BEFORE_WINERIM_FAMILIES_2026-06-09.json`.
- Snapshot de flags previos al pause: `SA_PEDRERA_AUTO_PUSH_FLAGS_BEFORE_PAUSE_2026-06-09.json`.
- Snapshot dry-run completo: `SA_PEDRERA_WINERIM_FAMILIES_DRY_RUN_2026-06-09.json`.
- Snapshot aplicado completo: `SA_PEDRERA_WINERIM_FAMILIES_APPLIED_2026-06-09.json`.
- Rollback visual rapido: ocultar familias Winerim dedicadas (`ShowInPos=false`) y dejar legacy como esta.
- Rollback completo: restaurar `provider_config` desde el snapshot previo y reimportar cada producto al `previous.familyId` del snapshot aplicado; mantener `784242` no vendible salvo que se decida restaurarlo expresamente.

## Riesgos
- Mientras `auto_push_on_create/update` este pausado, altas o cambios de precio/nombre en Winerim no subiran automaticamente a Agora para Sa Pedrera.
- Rehabilitar esos flags sin confirmar que Lovable Cloud ejecuta el commit con la guarda `create_skipped:formats_already_verified` puede reabrir el bucle de colas.
- La tablet puede tener cache/layout local; la API confirma familia y vendibilidad, pero el orden visual final debe validarlo el cliente en el TPV.
- `D207` es un tinto activo sin codigo `T###`; si el cliente quiere una pantalla estrictamente `T###`, decidir si se mueve/oculta o si se acepta como tinto fuera de secuencia.

## Validacion pendiente con cliente
- Abrir familias Winerim en tablet y confirmar visualmente:
  - `TINTOS WINERIM` sin duplicado visible de `T83`;
  - `BLANCOS WINERIM`, `ROSADOS WINERIM`, `ESPUMOSOS WINERIM`, `FORTIFICADOS WINERIM`, `MAGNUM WINERIM` y `COPAS WINERIM` visibles;
  - el legacy regional sigue disponible.
- Hacer una venta de prueba con botella y copa Winerim y validar en Lovable Cloud:
  - `sales_line_items.mapped=true`;
  - `stock_sync_log.status=SUCCESS`;
  - variante y `stock_id` correctos.
- Tras confirmar deploy efectivo, probar `evaluate-auto-push` con un vino ya verificado y reactivar `auto_push_on_create/update` solo si responde `create_skipped:formats_already_verified` o no genera tareas.
