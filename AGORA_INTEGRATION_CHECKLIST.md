# AGORA_INTEGRATION_CHECKLIST

> Checklist obligatorio para cada integracion Agora. Usar una copia por cliente antes de activar automatismos.

## 1. Estados permitidos

- `READ_ONLY_AUDIT`: conexion creada o probada solo para leer. No escribe en Agora, no oculta legacy, no descuenta stock.
- `CATALOG_PILOT`: Winerim publicado en Agora de forma controlada. Puede convivir con legacy. Ventas/stock aun no estan validados.
- `SALES_VALIDATION`: catalogo listo y se prueban ventas reales desde botones Winerim para confirmar historial y stock.
- `LIVE_AUTOMATIC`: catalogo automatico, ventas automaticas y stock Winerim validados.
- `PAUSED`: conexion pausada por incidencia, rollback, red, token, breaker o decision comercial.
- `LEGACY_ONLY`: cliente opera con legacy; Winerim no debe tocar catalogo/stock salvo nueva autorizacion.

## 2. Obligatorio para cualquier alta

### Datos y acceso

- Nombre exacto del restaurante.
- URL base Agora con protocolo y puerto (`http://...:8984` o `https://...` si aplica).
- API token/API key Agora valido.
- Token Winerim API v2 valido.
- Confirmar si la URL es publica/DDNS/IP fija o solo local.
- Confirmar que Lovable Cloud puede llegar al Agora desde fuera.
- No guardar tokens en documentos, tickets, commits ni capturas.

### Pruebas de lectura Agora

- `test` Agora OK.
- `Families` OK.
- `Products` OK via `export-master` cacheado.
- `Invoices` OK para al menos un dia cerrado con actividad.
- Si `Tickets`, `Orders`, `OpenInvoices` o tiempo real fallan, documentarlo; no bloquea D-1 si `Invoices` funciona.
- Registrar si la integracion sera post-cierre D-1 o intradia.

### Pruebas Winerim

- Token Winerim OK.
- `fetch-catalog` OK.
- Numero de vinos activos.
- Numero de formatos publicables:
  - botella con precio;
  - copa con precio;
  - magnum con precio.
- Captura de `stock_id` por variante:
  - `bottle_stock_id`;
  - `glass_stock_id`;
  - `magnum_stock_id`.
- Regla obligatoria: formato sin precio en Winerim no debe aparecer operativo en Agora.
- Regla obligatoria: vino desactivado en Winerim no debe quedar vendible en Agora.

## 3. Obligatorio antes de escribir en Agora

### Decision visual

- Decidir una de estas estrategias:
  - familias Winerim dedicadas (`TINTOS WINERIM`, `BLANCOS WINERIM`, etc.);
  - mantener estructura legacy y enrutar por reglas;
  - piloto parcial con una familia concreta.
- Documentar si el legacy:
  - se mantiene visible;
  - se oculta reversible;
  - no se toca.
- Nunca borrar legacy en el go-live inicial.
- Definir familias de copa:
  - copas en `COPAS WINERIM`;
  - o bajo familia propia `Copas de Vino` si el cliente lo pide.
- Definir orden visual:
  - por tipo Winerim;
  - por codigo comercial (`T501`, `B302`, `D709`, etc.);
  - por orden legacy/manual.

### Defaults Agora

- IVA por defecto.
- Lista de precio / price list.
- Almacen/warehouse.
- Centros de venta/sale centers.
- Familia destino por formato/tipo.
- Formato botella exacto.
- Formato copa exacto.
- Formato magnum exacto.
- `PreparationTypeId` y `PreparationOrderId`: ambos informados o ambos vacios.
- Productos Winerim vendibles como:
  - `UseAsDirectSale=false`;
  - `SaleableAsMain=true`.

### Seguridad previa

- Crear snapshot de provider_config antes de cambios.
- Crear snapshot de familias/productos legacy antes de ocultar.
- Preparar rollback XML si se reordena u oculta.
- Confirmar breaker limpio.
- Confirmar `0 QUEUED / 0 RUNNING` antes de empezar.
- Si hay deuda `FAILED/BLOCKED`, clasificarla antes; no hacer retry masivo.

## 4. Obligatorio para catalogo Winerim -> Agora

- Dry-run de XML antes de importar.
- Validar en dry-run:
  - productos esperados;
  - sin botones raiz no deseados;
  - sin duplicados evidentes;
  - sin mismatch de preparacion;
  - familias destino correctas;
  - formatos correctos.
- Import XML controlado.
- Refrescar `sync-master-data` tras import.
- Verificar:
  - todos los formatos esperados estan en Agora;
  - todos los formatos esperados estan vendibles;
  - `UseAsDirectSale=false`;
  - `SaleableAsMain=true`;
  - mappings `CONFIRMED`;
  - tracking `VERIFIED`;
  - cola final `0 QUEUED / 0 RUNNING`.
- Hacer validacion visual con cliente/tablet.

## 5. Obligatorio para ventas Agora -> Winerim

- Vender una botella Winerim real en Agora.
- Vender una copa Winerim real en Agora si la conexion tiene copas.
- Vender un magnum si la conexion usa magnum.
- Cerrar jornada o esperar el mecanismo acordado.
- Confirmar en Lovable Cloud:
  - `sales_events` creado;
  - `sales_line_items.mapped=true`;
  - `winerim_product_id` correcto;
  - `variant` correcta (`botella`, `copa`, `magnum`);
  - `stock_sync_log.SUCCESS`;
  - stock Winerim descontado en el `stock_id` de la variante correcta;
  - venta visible en historial Winerim si Winerim lo soporta para ese flujo.
- Si una venta entra por legacy no mapeado, no prometer descuento Winerim.

## 6. Obligatorio antes de `LIVE_AUTOMATIC`

- Sonda Agora OK.
- `provider_capabilities` en estado listo o equivalente documentado.
- `enabled=true`.
- `catalog_sync_enabled=true`.
- `write_mode=XML_IMPORT`.
- `auto_push_on_create=true` solo si el piloto de catalogo esta validado.
- `auto_push_on_update=true` solo si updates/precios no generan ruido o bucles.
- `auto_push_verified_ready=true` solo tras verificar familias/mappings.
- `auto_push_glass=true` y `write_glass=true` solo si copas estan validadas.
- `last_business_day_synced` avanza tras ventas reales.
- No hay cola abierta nueva.
- No hay errores recientes de stock sin clasificar.
- Rollback documentado.
- Cliente confirma que pantalla y buscador estan bien.

## 7. Opcional / segun cliente

- Importar historico de ventas como analitica sin descontar stock.
- Intradia cada 5 minutos o polling del dia actual.
- Mantener estructura legacy y hacer matching contra codigos existentes.
- Ocultar legacy reversible tras validacion.
- Reordenacion por codigo comercial.
- Reglas por region/denominacion.
- Vista `Vinos` + `Copas de Vino` en vez de familias raiz sueltas.
- Alertas automaticas si breaker > 2h.
- Alertas si hay `QUEUED` mas de 10-15 minutos.
- Backfill de ventas anteriores a la fecha de go-live sin stock.
- Export CSV/Excel de no-match para validacion manual.
- Bulk stock cuando Winerim confirme endpoint productivo.

## 8. Bloqueantes

- Agora no responde desde Lovable Cloud.
- Agora devuelve `401/403` por token/API.
- `Invoices` no funciona y no existe alternativa de ventas cerradas.
- Token Winerim invalido.
- No hay `stock_id` para la variante que se quiere descontar.
- El cliente no confirma estrategia visual/familias.
- Hay cola `QUEUED/RUNNING` de una prueba anterior.
- Hay `FAILED/BLOCKED` recientes sin clasificar en la misma conexion.
- La venta de prueba no genera `stock_sync_log.SUCCESS`.

## 9. Plantilla por cliente

```md
# Agora Checklist - [CLIENTE] - [FECHA]

## Estado
- Estado actual:
- Objetivo:
- Responsable:
- Rollback:

## Obligatorio
- [ ] URL/API Agora recibida
- [ ] Token Winerim recibido
- [ ] Sonda Agora OK
- [ ] Families OK
- [ ] Products OK
- [ ] Invoices OK
- [ ] Winerim fetch-catalog OK
- [ ] StockIds por variante capturados
- [ ] Estrategia visual decidida
- [ ] Defaults Agora confirmados
- [ ] Snapshot provider_config
- [ ] Snapshot legacy
- [ ] Dry-run XML OK
- [ ] Import XML OK
- [ ] Master data refrescado
- [ ] Mappings CONFIRMED
- [ ] Tracking VERIFIED
- [ ] Cola final 0 QUEUED / 0 RUNNING
- [ ] Validacion visual cliente
- [ ] Venta prueba botella
- [ ] Venta prueba copa, si aplica
- [ ] Venta prueba magnum, si aplica
- [ ] stock_sync_log.SUCCESS
- [ ] Historial Winerim validado
- [ ] Automatismos activados
- [ ] Monitor 24/48h OK

## Opcional
- [ ] Historico analitico sin stock
- [ ] Intradia
- [ ] Matching legacy
- [ ] Ocultacion legacy reversible
- [ ] Orden por codigo comercial
- [ ] Reglas por region/DO
- [ ] Alertas

## Incidencias
-

## Decision final
- [ ] READ_ONLY_AUDIT
- [ ] CATALOG_PILOT
- [ ] SALES_VALIDATION
- [ ] LIVE_AUTOMATIC
- [ ] PAUSED
- [ ] LEGACY_ONLY
```
