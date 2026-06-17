# Jardí Parets · Winerim vs Agora pre-check

Fecha: 2026-06-17  
Alcance: Restaurante Jardi / El Jardí Parets  
Modo: solo lectura

## Qué se ha hecho

- Se leyó Agora directamente por `export-master`:
  - `Families`;
  - `Products`.
- Se leyó Winerim API v2:
  - listado `/api/v2/wines`;
  - detalles individuales `/api/v2/wines/{id}` para precios y formatos.
- Se comprobaron ventas cerradas recientes por `Invoices`.
- No se ejecutó import XML.
- No se creó ni modificó ninguna tarea.
- No se guardaron ventas.
- No se descontó stock.
- No se movió cursor de sincronización.
- No se cambiaron flags de la conexión.

## Foto Agora actual

- Familias totales: `61`.
- Familias visibles: `57`.
- Productos totales: `695`.
- Productos vendibles: `695`.
- Productos directos raíz: `1` total en todo el catálogo.

### Familias Winerim

Las 8 familias Winerim existen y están visibles:

- `TINTOS WINERIM`: `129` productos, `129` vendibles.
- `BLANCOS WINERIM`: `19` productos, `19` vendibles.
- `ROSADOS WINERIM`: `7` productos, `7` vendibles.
- `ESPUMOSOS WINERIM`: `11` productos, `11` vendibles.
- `COPAS WINERIM`: `1` producto, `1` vendible.
- `MAGNUM WINERIM`: `1` producto, `1` vendible.
- `DULCE WINERIM`: `0` productos.
- `FORTIFICADOS WINERIM`: `0` productos.

Total productos Winerim publicados en Agora: `168`.  
Todos están vendibles dentro de familia y ninguno aparece como botón raíz (`UseAsDirectSale=false`).

### Legacy de vino visible

El legacy de vino sigue visible y vendible. Estructura detectada:

- `VI NEGRE`: `28` nodos contando subfamilias, `208` productos vendibles.
- `VI BLANC`: `43` productos vendibles.
- `VI ROSAT`: `9` productos vendibles.
- `CAVA`: `19` productos vendibles.
- `CHAMPAGNE`: `2` productos vendibles.

Total legacy vino vendible: `281` productos.

## Foto Winerim actual

- Vinos leídos en Winerim: `174`.
- Vinos activos: `174`.
- Formatos actualmente publicables por la regla del middleware: `168`.
- Distribución publicable:
  - botella: `166`;
  - copa: `1`;
  - magnum: `1`.
- Activos sin precio/formato soportado: `6`, todos corresponden a fichas de `Vega Sicilia Único`; al no tener precio soportado, no deben publicarse como productos Winerim en Agora.

Nota técnica: una pasada masiva de detalles Winerim puede devolver `503` si se consulta demasiado rápido. En la auditoría se verificaron individualmente los tres casos dudosos (`La Trucha Blanco`, `Notes De Blanc`, `Viña Pomal`) y sí tienen precio de botella, por lo que forman parte de los `168` publicables. Para producción debe seguir usándose el flujo del middleware con reintentos/throttle.

## Cobertura Winerim -> Agora

Los `168/168` formatos Winerim actualmente publicables están ya publicados en Agora dentro de familias `... WINERIM`.

Esto significa:

- lo que hoy está activo y con precio soportado en Winerim está arriba en Agora;
- los productos Winerim están en familias Winerim visibles;
- no se detectan productos Winerim publicados como botón raíz;
- las familias `DULCE WINERIM` y `FORTIFICADOS WINERIM` están visibles pero vacías porque ahora no hay botellas publicables para esas familias; la copa dulce existente está en `COPAS WINERIM`.

## Match legacy -> Winerim publicado

Se cruzaron los `281` productos legacy de vino vendibles contra los `168` productos Winerim publicados en Agora.

Resultado:

- `103` match automático seguro.
- `15` review.
- `163` sin match fiable.

Interpretación: no todos los vinos legacy de Agora están en Winerim. Ocultar todo el legacy ahora ocultaría bastantes productos que no tienen equivalente Winerim claro.

## Match Winerim publicado -> legacy

Se cruzaron los `168` productos Winerim publicados contra los `281` legacy vendibles.

Resultado:

- `117` match automático seguro.
- `8` review.
- `43` sin match fiable.

Interpretación: una parte relevante de Winerim no existía igual en el legacy, o no se puede emparejar de forma segura por nombre.

## Ventas cerradas

Lectura directa por `Invoices`, sin guardar ni descontar stock:

- `2026-06-17`: HTTP 200, `0` facturas, `0` líneas.
- `2026-06-16`: HTTP 200, `8` facturas, `97` líneas.
- `2026-06-15`: HTTP 200, `4` facturas, `42` líneas.
- `2026-06-14`: HTTP 200, `0` facturas, `0` líneas.
- `2026-06-13`: HTTP 200, `8` facturas, `121` líneas.
- `2026-06-12`: HTTP 200, `12` facturas, `103` líneas.
- `2026-06-11`: HTTP 200, `15` facturas, `154` líneas.
- `2026-06-10`: HTTP 200, `5` facturas, `32` líneas.

Ventas cerradas siguen siendo viables por `Invoices`. El día actual puede venir vacío hasta cierre de jornada.

## Respuesta a la pregunta operativa

No, no todos los vinos Agora están en Winerim:

- hay `281` productos legacy de vino visibles/vendibles;
- solo `103` tienen match automático seguro contra productos Winerim publicados;
- `163` no tienen match fiable.

Sí, los vinos Winerim actualmente publicables están arriba en Agora:

- `168/168` formatos publicables encontrados;
- todos visibles/vendibles en familias Winerim.

## Riesgos

- Si se oculta legacy en bloque, el cliente puede perder acceso visual a `163` productos legacy sin equivalente Winerim claro.
- Si se mantienen legacy y Winerim visibles, puede haber duplicados visuales para los `103` matches seguros y los `15` review.
- Este cruce confirma coincidencia de catálogo/nombre, pero no sustituye una revisión de `product_mappings` en Lovable Cloud para stock. Un producto legacy vendido solo descuenta stock si está mapeado a Winerim con variante y `stock_id` correctos.
- `auto_push_on_update=false` sigue documentado para Jardí: las altas nuevas pueden subir automáticamente, pero cambios de precio/update no deben prometerse hasta corregir el falso update recurrente de `Dulce de Invierno`.

## Recomendación

Mantener Jardí como está por ahora:

1. Winerim publicado y visible en familias dedicadas.
2. Legacy visible como rollback operativo.
3. No ocultar legacy en bloque.
4. Revisar primero el CSV de legacy:
   - ocultables probables: `MATCH` seguro si el cliente valida que usa Winerim;
   - revisar manualmente: `REVIEW`;
   - no ocultar sin autorización: `NO_MATCH`.
5. Antes de declarar stock completo sobre legacy, revisar `product_mappings` reales en Lovable Cloud y validar una venta/cierre de producto Winerim.

## Artefactos

- `JARDI_WINERIM_PUBLISHED_PRODUCTS_2026-06-17.csv`
- `JARDI_LEGACY_TO_WINERIM_PUBLISHED_MATCH_2026-06-17.csv`
- `JARDI_WINERIM_PUBLISHED_TO_LEGACY_MATCH_2026-06-17.csv`

