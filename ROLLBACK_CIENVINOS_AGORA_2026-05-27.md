# ROLLBACK_CIENVINOS_AGORA_2026-05-27

> Punto de control para `Restaurante Cienvinos Ecija`.
> No incluir tokens ni credenciales en este archivo.

## Estado actual documentado

- `connection_id`: `21ee3345-1090-4e83-94f2-43126d6e7695`.
- Conexión creada y probada contra Agora.
- Catálogo Winerim leído: 378 vinos.
- StockIds por variante backfilled como metadatos:
  - Botella: 372.
  - Copa: 49.
  - Magnum: 7.
- Master data Agora cacheado:
  - 177 productos existentes.
  - 4 IVAs.
  - 3 price lists: Barra, Sala, Terraza.
  - 1 almacén.
  - 3 sale centers.
- XML validado e importado:
  - 428 productos WINERIM importados.
  - 8 familias WINERIM creadas.
  - 0 productos esperados faltantes tras verificación.
- La importación global falló con HTTP 500; se completó por formato/lotes pequeños.
- 12 botellas con nombres duplicados en Winerim se importaron con sufijo corto en Agora para evitar conflicto de nombre único.
- No se detectaron productos/familias legacy de vino fuera de WINERIM; no se ocultaron productos preexistentes.
- La conexión queda `enabled=false`.

## Rollback de catálogo importado

El rollback operativo recomendado tras la importación completa no borra productos: oculta las familias WINERIM y marca sus productos como no vendibles para conservar histórico.

Familias WINERIM actuales:

- `900157` — `TINTOS WINERIM`.
- `901954` — `COPAS WINERIM`.
- `903516` — `ROSADOS WINERIM`.
- `903925` — `DULCE WINERIM`.
- `904241` — `BLANCOS WINERIM`.
- `904289` — `MAGNUM WINERIM`.
- `908182` — `FORTIFICADOS WINERIM`.
- `908875` — `ESPUMOSOS WINERIM`.

Procedimiento recomendado:

1. En Lovable Cloud, usar el panel de visibilidad de familias para archivar esas familias WINERIM.
2. Verificar con `sync-master-data` que:
   - `ShowInPos=false` en las familias WINERIM.
   - Sus productos tienen `UseAsDirectSale=false` y `SaleableAsMain=false`.
3. Mantener la conexión `enabled=false`.

## Rollback local completo

Si además hay que limpiar la conexión local en Lovable Cloud:

1. Mantener o restaurar la conexión como deshabilitada:

```sql
update public.pos_connections
set
  enabled = false,
  write_mode = 'NONE',
  auto_push_on_create = false,
  auto_push_on_update = false,
  auto_push_verified_ready = false,
  require_manual_review_before_push = true
where id = '21ee3345-1090-4e83-94f2-43126d6e7695';
```

2. Borrar primero datos derivados y después la conexión:

```sql
delete from public.stock_sync_log
where connection_id = '21ee3345-1090-4e83-94f2-43126d6e7695';

delete from public.sales_line_items
where sales_event_id in (
  select id from public.sales_events
  where connection_id = '21ee3345-1090-4e83-94f2-43126d6e7695'
);

delete from public.sales_events
where connection_id = '21ee3345-1090-4e83-94f2-43126d6e7695';

delete from public.outbound_tasks
where connection_id = '21ee3345-1090-4e83-94f2-43126d6e7695';

delete from public.product_mappings
where connection_id = '21ee3345-1090-4e83-94f2-43126d6e7695';

delete from public.provider_products
where connection_id = '21ee3345-1090-4e83-94f2-43126d6e7695';

delete from public.agora_master_data
where connection_id = '21ee3345-1090-4e83-94f2-43126d6e7695';

delete from public.winerim_wines
where connection_id = '21ee3345-1090-4e83-94f2-43126d6e7695';

delete from public.pos_connections
where id = '21ee3345-1090-4e83-94f2-43126d6e7695';
```

## Rollback manual vía XML

Si no se usa el panel de visibilidad, no borrar filas locales sin revisar Agora. Primero:

1. Deshabilitar la conexión con el SQL del rollback inmediato.
2. Identificar exactamente los productos WINERIM importados.
3. Generar un XML de reversión para esos IDs con:
   - Familias generadas `ShowInPos="false"` si fueron creadas solo para el piloto.
   - Productos generados con `UseAsDirectSale="false"` y `SaleableAsMain="false"`.
4. Enviar ese XML por `/api/import/`.
5. Ejecutar `sync-master-data` y comprobar que los productos piloto ya no son vendibles.

Rangos de IDs generados por el middleware:

- Botella: `500000 + winerim_id`.
- Copa: `700000 + winerim_id`.
- Magnum: `900000 + winerim_id`.

Familias generadas/importadas:

- `TINTOS WINERIM`.
- `BLANCOS WINERIM`.
- `ROSADOS WINERIM`.
- `ESPUMOSOS WINERIM`.
- `DULCE WINERIM`.
- `FORTIFICADOS WINERIM`.
- `COPAS WINERIM`.
- `MAGNUM WINERIM`.

## Condiciones antes de activar automático

- Migraciones P0 aplicadas en Lovable Cloud.
- Edge functions actuales desplegadas.
- `winerim-proxy fetch-catalog` confirma captura nativa de stockIds.
- Import piloto pequeño verificado en Agora.
- Primer cierre de ventas probado con stock Winerim idempotente por variante.
- Reejecución del mismo día confirmada sin doble deducción.
