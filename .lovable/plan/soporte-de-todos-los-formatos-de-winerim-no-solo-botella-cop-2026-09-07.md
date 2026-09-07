# Soporte de todos los formatos de Winerim (no solo botella, copa y magnum)

## Qué pasa hoy

El middleware solo entiende tres formatos: **botella, copa y magnum**. Winerim, en cambio, ya
maneja muchos más y con stock propio. Mirando los catálogos reales de las 29 conexiones:

| Formato en Winerim | Fichas | Conexiones |
|---|---|---|
| botella | 7.060 | 29 |
| copa | 1.251 | 29 |
| magnum | 269 | 21 |
| botella-tienda | 250 | 1 |
| botella-pequena | 65 | 13 |
| media-botella | 47 | 12 |
| doble-magnum | 16 | 4 |
| jeroboam | 14 | 1 |
| matusalem | 9 | 1 |
| benjamin | 8 | 4 |
| litro / botella-grande / media-copa / salmanzar / nabucodonosor / rehoboham / baltasar | 1 cada uno | 1 |

Consecuencias actuales:

1. Los formatos grandes y pequeños **no se publican** en el TPV. Si el local los vende, usa
   botones antiguos que **no descuentan stock** (el caso de Ocean Club: 27 botones 3L/6L/9L/12L/15L).
2. Peor aún, hay un fallo silencioso: **media-botella y botella-pequena se tratan como botella**,
   así que una media botella vendida descuenta una botella entera de stock (12 y 13 conexiones
   afectadas hoy).

## Qué se va a construir

Dejar de tener formatos cableados en el código y pasar a un **catálogo de formatos dirigido por
los datos de Winerim**: cualquier formato que Winerim devuelva con precio y stock se publica en el
TPV y descuenta contra su propio stock.

Alcance: todas las conexiones Agora. El comportamiento actual de botella/copa/magnum no cambia
(mismos identificadores, mismos botones, mismas familias); lo nuevo se añade encima.

### 1. Catálogo de formatos

Un único registro de formatos con: clave canónica, alias que llegan de Winerim, etiqueta para el
botón del TPV y capacidad. Nada más se cablea en el código.

### 2. Precios y stock por formato

Hoy los precios y los identificadores de stock viven en columnas fijas de la ficha de vino
(`bottle_*`, `glass_*`, `magnum_*`). Se añade una tabla hija por (vino, formato) con precio de
venta, coste, identificador de stock y si está activo. Las columnas actuales se mantienen
sincronizadas para no romper nada de lo que ya funciona.

### 3. Publicación en el TPV

Cada formato adicional se publica como formato de venta del mismo vino, con identificador
determinista y estable por formato (igual que hoy 2M/3M/4M para botella/copa/magnum, extendido al
resto de formatos con su propio rango). La familia de destino sigue las reglas de cada local
(en Ocean Club, sus familias de siempre). Regla fail-closed intacta: sin precio positivo o vino
inactivo, no se publica y no se descuenta.

### 4. Ventas y descuento de stock

La resolución de ventas devuelve el formato exacto del par (producto, formato de venta) y el
descuento va contra el stock de ese formato. Esto corrige de paso el descuento erróneo de las
medias botellas.

### 5. Despliegue por fases

1. Migración + catálogo de formatos + relleno de la tabla de formatos (sin cambio de conducta).
2. Corrección del descuento de media-botella / botella-pequena.
3. Publicación de formatos nuevos activada primero solo en Ocean Club como canario, verificación en
   vivo, y después extensión al resto de conexiones.

## Qué contarle a la infraestructura propia (Winerim)

Nada bloqueante, pero conviene confirmar cuatro cosas con el equipo de la API de Winerim:

1. **Lista cerrada de variantes.** Hoy vemos 17 valores distintos en producción, algunos con
   erratas evidentes (`salmanzar` por salmanazar, `rehoboham` por rehoboam). Pedir la lista
   canónica y estable, y que no se creen variantes nuevas por escritura libre.
2. **Capacidad explícita por variante** (litros o número de botellas equivalentes), para poder
   mostrar y auditar formatos sin adivinar por el nombre.
3. **Confirmar que cada variante tiene su propio stock** (`erpStock.id` independiente) y que el
   descuento por variante es absoluto, como en botella/copa/magnum.
4. **Aviso de altas de variantes nuevas**, para no descubrirlas leyendo el catálogo.

## Detalles técnicos

- Nuevo `supabase/functions/_shared/winerimFormats.ts`: registro canónico (clave, alias,
  etiqueta TPV, capacidad, rango de identificador determinista) y `normalizeWinerimVariant`
  genérico. `stockSyncUtils.ts` deja de exponer el tipo cerrado `"copa" | "botella" | "magnum"`.
- Migración: tabla `winerim_wine_formats` con `unique (connection_id, winerim_id, format_key)`,
  más `GRANT`s y RLS igual que `winerim_wines`. Relleno desde `raw_payload->'prices'`.
- `winerim-proxy`: escribe la tabla hija además de las columnas actuales; el fingerprint de
  auto-push incluye los formatos nuevos para que un alta o cambio de precio dispare publicación.
- `agoraVinotecaNativeFormats.ts`: `VinotecaFormat` pasa a ser la clave del catálogo; rangos de
  identificador determinista por formato, reservando los actuales 2M/3M/4M.
- `agora-proxy`: `format_type` en `product_mappings`, `agora_sales_variant_mappings` y
  `winerim_push_tracking` acepta las claves nuevas; `canonicalAgoraSalesLineFormat` resuelve el
  formato desde el par exacto; el descuento usa el `stock_id` de ese formato.
- Tests: normalización de alias y erratas, identificadores deterministas sin colisión con 2M/3M/4M,
  descuento correcto de media-botella, fail-closed sin precio o vino inactivo.
- Sin cambios de frontend en esta fase salvo etiquetas de formato en los paneles de Agora.
