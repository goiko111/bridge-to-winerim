# Agora Checklist - Casa Nene - 2026-06-25

## Estado

- Estado actual: `PAUSED`.
- Motivo: Agora estuvo conectado y operativo, pero ahora no es alcanzable desde Lovable Cloud (`NETWORK_UNREACHABLE / No route to host`); el polling intradia esta pausado tras la validacion de idempotencia.
- Objetivo: volver a `SALES_VALIDATION` y despues `LIVE_AUTOMATIC` cuando conectividad e idempotencia intradia queden validadas.
- Rollback: legacy ya fue ocultado de forma reversible segun `provider_config.casa_nene_setup`; no borrar productos/mappings.

## Resumen tecnico

- `connection_id`: `e3cb6dbb-3474-4926-b740-706fbd0ef7e0`.
- `enabled=true`.
- `catalog_sync_enabled=true`.
- `write_mode=XML_IMPORT`.
- `auto_push_on_create=true`.
- `auto_push_on_update=true`.
- `auto_push_verified_ready=true`.
- `auto_push_bottle=true`.
- `auto_push_glass=true`.
- `write_bottle=true`.
- `write_glass=true`.
- `intraday_sales_sync_enabled=false`.
- `last_catalog_sync_at=2026-06-08T11:23:05.406Z`.
- `last_business_day_synced=2026-06-23`.
- Ultima venta guardada: business day `2026-06-24`, factura `18419`.
- Sonda viva 2026-06-25: `NETWORK_UNREACHABLE`.
- Evidencia de funcionamiento previo:
  - ventas de `2026-06-24` guardadas en Lovable Cloud;
  - descuentos Winerim con `stock_sync_log.SUCCESS` el `2026-06-24`;
  - ejemplos: `B Valbuxan Tinto Lexitimo`, `B Pazo de Señorans`, `B Tamerán Malvasía Volcánica`.

## Obligatorio

- [x] URL/API Agora recibida.
- [x] Token Winerim recibido.
- [ ] Sonda Agora OK.
  - Actual: falla `No route to the Agora server`.
- [ ] Families OK en sonda actual.
  - Historicamente OK, pero no verificable mientras no haya conectividad.
- [ ] Products OK en sonda actual.
  - Historicamente OK, pero no verificable mientras no haya conectividad.
- [ ] Invoices OK en sonda actual.
  - Ultimo dato guardado `2026-06-24`; sonda viva actual falla.
- [x] Winerim catalogo cacheado en Lovable Cloud.
  - `309` vinos cacheados.
  - `307` activos.
- [x] StockIds por variante capturados donde aplica.
  - `295` con `bottle_stock_id`.
  - `15` con `magnum_stock_id`.
  - `0` con copa porque no hay `glass_sale_price` cacheado.
- [x] Estrategia visual decidida.
  - `WINERIM_SEPARATE_FAMILIES`.
  - Legacy oculto reversible tras verificacion.
- [x] Defaults Agora confirmados.
  - IVA `3`.
  - Warehouse `1`.
  - Preparation type/order `1/1`.
  - Sale centers `1`, `2`, `3`.
- [x] Snapshot/configuracion legacy documentada en `provider_config.casa_nene_setup`.
- [x] Import XML inicial realizado.
  - `winerim_products_verified=292`.
- [x] Mappings `CONFIRMED`.
  - `309`.
- [x] Tracking `VERIFIED`.
  - `307`.
- [x] Cola sin `QUEUED/RUNNING`.
  - `0 QUEUED`, `0 RUNNING`.
- [ ] Cola sin incidencias.
  - Queda `1 FAILED` antiguo: `AGORA_XML_UPSERT_PRODUCT`, `2026-06-17`, `POS_DOWN / AbortError`.
- [ ] Validacion visual cliente actual.
  - Pendiente confirmar tras recuperar conectividad.
- [x] Venta real botella detectada.
  - `B Valbuxan Tinto Lexitimo`, `B Pazo de Señorans`.
- [ ] Venta prueba copa.
  - No aplica si Casa Nene no tiene copas Winerim con precio; revisar con cliente antes de marcar.
- [ ] Venta prueba magnum.
  - Pendiente si el cliente usa magnums en Agora.
- [x] `stock_sync_log.SUCCESS` para botella.
  - `90 SUCCESS` historicos.
- [ ] Historial Winerim validado post-incidencia.
  - Pendiente revisar tras recuperar conectividad e intradia.
- [ ] Automatismos finales activados.
  - Catalogo esta activo; intradia esta pausado.
- [ ] Monitor 24/48h OK.
  - No aplica hasta recuperar Agora.

## Opcional

- [ ] Intradia.
  - Implementado por flag, pero pausado.
- [ ] Historico analitico sin stock.
- [x] Ocultacion legacy reversible.
- [ ] Alertas por conectividad/DDNS.
- [ ] Alertas por cola `FAILED`.

## Incidencias

- Bloqueante actual: regresion de conectividad externa, `NETWORK_UNREACHABLE / No route to host` contra Agora.
- Diagnostico externo 2026-06-25:
  - `casanene.ddns.net` resuelve a `95.178.112.16`;
  - `nc/curl` contra `casanene.ddns.net:8984` falla;
  - `nc/curl` contra `95.178.112.16:8984` falla;
  - Lovable Cloud tambien falla contra `http://casanene.ddns.net:8984/api/export/?business-day=2026-06-25&filter=Invoices`.
  - Diagnostico: el DNS existe, pero el puerto TCP `8984` no esta accesible desde fuera.
- `intraday_sales_sync_enabled=false` desde `2026-06-24T17:46:12.769Z`.
- Razon intradia pausado: riesgo detectado de doble descuento tras validacion de deploy con logs manuales previos.
- Tres logs de stock duplicados quedaron `BLOCKED` correctamente:
  - `B Pazo de Señorans [botella]`, qty `1`;
  - `B Valbuxan Tinto Lexitimo [botella]`, qty `2`;
  - `B Valbuxan Tinto Lexitimo [botella]`, qty `1`.
- Hay una tarea antigua `FAILED`:
  - `AGORA_XML_UPSERT_PRODUCT`;
  - error `POS_DOWN / AbortError`;
  - no reintentar hasta recuperar conectividad.

## Decision final

- [ ] `READ_ONLY_AUDIT`
- [ ] `CATALOG_PILOT`
- [ ] `SALES_VALIDATION`
- [ ] `LIVE_AUTOMATIC`
- [x] `PAUSED`
- [ ] `LEGACY_ONLY`

## Para pasar a `LIVE_AUTOMATIC`

- [ ] Recuperar conectividad Agora desde Lovable Cloud.
- [ ] Repetir sonda `test`.
- [ ] Ejecutar prueba segura de intradia con el parche de idempotencia por total diario.
- [ ] Confirmar que no vuelve a descontar `Valbuxan` ni `Pazo de Señorans` ya aplicados.
- [ ] Reactivar `intraday_sales_sync_enabled=true`.
- [ ] Confirmar una nueva venta real:
  - `sales_events`;
  - `sales_line_items.mapped=true`;
  - `stock_sync_log.SUCCESS`;
  - stock Winerim correcto;
  - historial Winerim visible.
- [ ] Dejar monitorizado 24/48h.
