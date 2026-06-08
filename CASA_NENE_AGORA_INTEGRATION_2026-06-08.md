# Casa Nene Agora Integration — 2026-06-08

## Resumen
- Cliente: Casa Nene.
- Conexión Lovable Cloud: `e3cb6dbb-3474-4926-b740-706fbd0ef7e0`.
- URL Agora usada por Lovable Cloud: `http://casanene.ddns.net:8984/`.
- IP local indicada por cliente: `192.168.1.131` (solo referencia local, no usable desde Lovable Cloud).
- Tokens Agora/Winerim: configurados en Lovable Cloud. No se documentan valores.

## Hechos Verificados
- Agora responde correctamente:
  - `/version/`: HTTP 200, Agora `7.9.0`.
  - `/api/export-master/?filter=Families`: HTTP 200.
  - `/api/export-master/?filter=Products`: HTTP 200.
  - `/api/export/?business-day=2026-06-07&filter=Invoices`: HTTP 200 con `<Export />`.
- Winerim API v2 responde correctamente con el token configurado.
- Master data inicial Agora:
  - Familias: `22`.
  - Productos: `304`.
  - IVAs: `4`.
  - PriceLists: `1` (`Barra`).
  - PreparationTypes: `3`.
  - PreparationOrders: `4`.
  - Warehouses: `1` (`CASA NENE`).
  - SaleCenters: `3` (`Barra`, `COMEDOR`, `TERRAZA`).
- Defaults de escritura configurados:
  - IVA: `3` / 10%.
  - Preparación: `1/1` (`Barra` / `Bebidas`).
  - Almacén: `1`.
  - SaleCenters: `1`, `2`, `3`.
- Catálogo Winerim cacheado:
  - Vinos activos: `292`.
  - Botellas exportables: `277`.
  - Magnums exportables: `15`.
  - Copas exportables: `0` (Winerim no expone copas activas/preciadas para esta carta).
- Familias Winerim creadas/visibles:
  - `900157` `TINTOS WINERIM`.
  - `904241` `BLANCOS WINERIM`.
  - `908875` `ESPUMOSOS WINERIM`.
  - `908182` `FORTIFICADOS WINERIM`.
  - `903925` `DULCE WINERIM`.
  - `903516` `ROSADOS WINERIM`.
  - `904289` `MAGNUM WINERIM`.
  - `901954` `COPAS WINERIM` (visible, sin productos porque Winerim no tiene copas activas).
- Importación Winerim -> Agora:
  - Botellas: `277/277` importadas y verificadas.
  - Magnums: `15/15` importados y verificados.
  - Total productos Winerim visibles/vendibles dentro de familias Winerim: `292`.
  - Productos Winerim como botón raíz (`UseAsDirectSale=true`): `0`.
  - Productos Winerim no vendibles dentro de familia: `0`.
  - Mappings XML_IMPORT confirmados: `277` botellas + `15` magnums.
  - `winerim_push_tracking`: `277` `VERIFIED:BOTTLE` + `15` `VERIFIED:MAGNUM`.
- Legacy de vino ocultado sin borrar:
  - Familias ocultadas: `5` `VINO`, `6` `ESPUMOSO`, `7` `BLANCO`, `8` `TINTO`, `9` `DULCES`, `13` `VINO FUERA DE CARTA`.
  - Productos legacy de vino desactivados de venta en familia: `148`.
  - Verificación final: `0` familias legacy de vino visibles y `0` productos legacy de vino visibles/vendibles.

## Estado Automático
- Conexión activada:
  - `enabled=true`.
  - `catalog_sync_enabled=true`.
  - `write_mode=XML_IMPORT`.
  - `auto_push_on_create=true`.
  - `auto_push_on_update=true`.
  - `auto_push_verified_ready=true`.
- Cursor inicial de ventas:
  - `last_business_day_synced=2026-06-07`.
  - Motivo: evitar reprocesar ventas históricas/legacy anteriores a la puesta en marcha.
- Capacidades:
  - `can_read_sales=true`.
  - `can_read_catalog=true`.
  - `can_write_products=YES`.
  - `readiness_status=READY`.
- Comprobaciones posteriores:
  - `auto-sync-sales`: OK, sin error.
  - `fetch-catalog` tras activación: `no_catalog_changes_detected`.
  - Cola abierta Casa Nene: `0 QUEUED`, `0 RUNNING`, `0 FAILED`, `0 BLOCKED`.

## Riesgos / Hipótesis
- No hay copas publicadas porque Winerim no expone ninguna variante de copa activa/preciada para Casa Nene. Si el cliente espera vender copas, debe activarlas/preciarlas en Winerim y el automático las subirá a `COPAS WINERIM`.
- No hay todavía venta real cerrada con productos Winerim de Casa Nene. La lectura de ventas está preparada, pero el descuento de stock debe validarse con el primer cierre que contenga una botella o magnum Winerim.
- El histórico de ventas visible en Winerim sigue dependiendo de cómo Winerim represente internamente los movimientos hechos por `PUT /api/v2/stock/{stockId}`; el middleware sí registra ventas canónicas y `stock_sync_log` en Lovable Cloud.

## Rollback
Si el cliente reporta un problema operativo:
1. Desactivar automático de Casa Nene en `pos_connections`:
   - `enabled=false`.
   - `catalog_sync_enabled=false`.
   - `auto_push_on_create=false`.
   - `auto_push_on_update=false`.
   - `auto_push_verified_ready=false`.
   - `write_mode=NONE`.
2. Ocultar familias Winerim:
   - `900157`, `904241`, `908875`, `908182`, `903925`, `903516`, `904289`, `901954` con `ShowInPos=false`.
3. Desactivar productos Winerim:
   - Productos con `FamilyId` en las familias Winerim anteriores: `UseAsDirectSale=false`, `SaleableAsMain=false`.
4. Restaurar legacy:
   - Familias `5`, `6`, `7`, `8`, `9`, `13` con `ShowInPos=true`.
   - Productos legacy bajo esas familias con `UseAsDirectSale=false`, `SaleableAsMain=true`.
5. Refrescar master data y verificar:
   - Legacy visible/vendible.
   - Winerim no visible/vendible.
   - Cola abierta a 0 antes de dejarlo cerrado.
