# Sa Pedrera · Reordenación por código comercial Agora

Fecha: 2026-06-17

## Objetivo

Ordenar las familias Winerim de Sa Pedrera en Agora siguiendo el código comercial visible en Winerim (`T501`, `B437`, `E516`, `D709`, `G801`, `MAGNUM21`, etc.), sin recrear productos ni cambiar IDs.

La necesidad operativa es que si el cliente añade o recoloca un vino en Winerim, Agora pueda respetar ese orden visual sin trabajo manual diario.

## Alcance aplicado

Conexión: Sa Pedrera.

Familias reordenadas:

- `900157` · `TINTOS WINERIM`
- `904241` · `BLANCOS WINERIM`
- `903516` · `ROSADOS WINERIM`
- `908875` · `ESPUMOSOS WINERIM`
- `908182` · `FORTIFICADOS WINERIM`
- `904289` · `MAGNUM WINERIM`
- `901954` · `COPAS WINERIM`
- `903925` · `DULCES WINERIM`

Configuración activada en `provider_config`:

- `agora_product_sort_mode="COMMERCIAL_CODE_NUMERIC"`
- `agora_product_sort_prefix_order=["T","B","R","E","D","G","MAGNUM"]`
- `agora_product_sort_prefix_order_by_family={"904289":["MAGNUM","T","B","R","E","D","G"]}`
- `agora_product_sort_family_ids=["900157","904241","903516","908875","908182","904289","901954","903925"]`

## Hallazgo técnico

Durante la aplicación se comprobó que Agora no persiste `SortOrder` en productos. El campo real exportado/importado para controlar el orden es `Product.Order`.

Por tanto, cualquier lógica nueva debe escribir `Order`, no `SortOrder`.

## Resultado

Aplicación directa por XML contra Agora:

- Import Agora: HTTP `200`
- Productos con `Order` modificado: `321`
- Verificación viva posterior: `438/438` productos con `Order` esperado
- Fallos de verificación: `0`

Resumen por familia:

- `BLANCOS WINERIM`: `108` productos, `101` cambios
- `ROSADOS WINERIM`: `8` productos, `0` cambios
- `TINTOS WINERIM`: `212` productos, `131` cambios
- `ESPUMOSOS WINERIM`: `52` productos, `52` cambios
- `FORTIFICADOS WINERIM`: `1` producto, `0` cambios
- `MAGNUM WINERIM`: `30` productos, `10` cambios
- `COPAS WINERIM`: `16` productos, `16` cambios
- `DULCES WINERIM`: `11` productos, `11` cambios

Artefactos locales:

- `SA_PEDRERA_COMMERCIAL_CODE_REORDER_DRY_RUN_2026-06-17.json`
- `SA_PEDRERA_COMMERCIAL_CODE_REORDER_APPLIED_2026-06-17.json`

## Riesgos

- Una tablet puede mantener caché visual hasta cerrar sesión, refrescar o reiniciar la pantalla.
- Si una familia concreta ignorase `Product.Order` visualmente, habría que tratarla como caso especial. `DULCES WINERIM` ya conserva IDs deterministas `903xxx`.
- Lovable Cloud todavía no había redeployado la nueva acción `reorder-products-by-commercial-code` en la sonda posterior al push, por eso la aplicación inicial se hizo mediante XML directo controlado.

## Rollback

Rollback visual inmediato:

1. Importar el `rollbackXml` guardado en `SA_PEDRERA_COMMERCIAL_CODE_REORDER_APPLIED_2026-06-17.json`.
2. Opcionalmente desactivar `provider_config.agora_product_sort_mode` para impedir que la cola vuelva a ordenar.

Rollback de código:

1. Revertir la acción `reorder-products-by-commercial-code`.
2. Revertir el bloque `COMMERCIAL_CODE_NUMERIC` en `generateImportXml`.
3. Revertir la invocación automática posterior a `process-xml-outbound-queue`.

## Pendiente

- Confirmar redeploy real de Lovable Cloud.
- Pedir al cliente validación visual tras refrescar/cerrar sesión en tablets.
- Probar un caso futuro controlado, por ejemplo que un `T499` nuevo o reordenado quede antes de `T501`.
