# Agora pre-onboarding read-only audit

Fecha: 2026-06-17

Alcance:

- El Bejeque
- Taberna de Elia

Objetivo: revisar qué tienen actualmente en Agora antes de crear conexión, subir productos Winerim, ocultar legacy o tocar stock.

No se ejecutó ninguna escritura. No se creó `pos_connection`. No se usaron imports XML.

## El Bejeque

Base URL validada: `https://elbejeque.infogral.es`

### Hechos

- `export-master` funciona:
  - `Families`: HTTP 200
  - `Products`: HTTP 200
  - `Vats`: HTTP 200
  - `PriceLists`: HTTP 200
  - `PreparationTypes`: HTTP 200
  - `PreparationOrders`: HTTP 200
  - `Warehouses`: HTTP 200
  - `SaleCenters`: HTTP 200
- `SalePoints` devuelve HTTP 500.
- `/api/` devuelve HTTP 404, pero esto no bloquea la integración porque los endpoints reales de exportación funcionan.
- `Invoices` funciona:
  - `2026-06-10`: HTTP 200, `3` facturas, `34` líneas.
  - `2026-06-17`, `2026-06-16`, `2026-06-15`: HTTP 200 sin facturas en la muestra.
- Endpoints de tiempo real probados para hoy (`Tickets`, `Orders`, `OpenInvoices`, `Receipts`): HTTP 500.
- Catálogo:
  - `28` familias.
  - `277` productos.
  - `191` productos vendibles.
  - `0` productos con `UseAsDirectSale=true`.
  - `10` productos sin `FamilyId`.
- Familias de vino legacy detectadas:
  - `14` · `TINTOS`: `48` productos, `34` vendibles, familia oculta.
  - `15` · `BLANCOS`: `21` productos, `10` vendibles, familia oculta.
  - `16` · `ROSADO`: `4` productos, `3` vendibles, familia oculta.
  - `17` · `ESPUMOSO`: `6` productos, `3` vendibles, familia oculta.
  - `18` · `FORTIFICADO`: `1` producto, `0` vendibles, familia oculta.
  - `19` · `POSTRE`: `6` productos, `2` vendibles, familia oculta.
- Solo una familia sale como `ShowInPos=true`: `28` · `ARROCENADO EN CASA`, hija de `NUESTROS ARROCES`.
- No hay familias `WINERIM`.
- Referencias útiles:
  - IVA: `Exento`, `Super reducido`, `Reducido`, `General (7%)`.
  - Listas de precio: `Barra`, `Sala`, `Terraza`, `General`.
  - Preparación: `Barra`, `Cocina`, `Postres`.
  - Órdenes preparación: `Entrantes`, `Primeros`, `Segundos`, `Marche y Pase`, `Bebidas`, `Postres`.
  - Almacenes: `Almacén General`, `Bodega`.
  - Centros de venta: `Barra`, `Sala`, `Terraza`, `Incidencias`.

### Interpretación

- Viable para lectura de catálogo y ventas cerradas.
- No viable para tiempo real con la API probada; el patrón debe ser D-1/post-cierre vía `Invoices`, como Kava.
- La carta de vino legacy existe pero las familias están ocultas. Antes de subir Winerim hay que validar con el cliente si esa ocultación es intencionada, si la pantalla real usa otra capa/layout de Agora o si hay caché/terminal distinto.
- Si se publica Winerim, lo más seguro es crear familias Winerim dedicadas y no reactivar legacy sin autorización.

### Riesgos

- `SalePoints` HTTP 500 puede limitar configuración fina por punto de venta; `SaleCenters` sí está disponible.
- La visibilidad actual es anómala: casi todas las familias aparecen ocultas pese a tener productos vendibles.
- No hay endpoint de tickets en curso; prometer visibilidad intradía sería incorrecto.

## Taberna de Elia

Base URL validada: `https://elia.tpvrent.net`

### Hechos

- `export-master` funciona:
  - `Families`: HTTP 200
  - `Products`: HTTP 200
  - `Vats`: HTTP 200
  - `PriceLists`: HTTP 200
  - `PreparationTypes`: HTTP 200
  - `PreparationOrders`: HTTP 200
  - `Warehouses`: HTTP 200
  - `SaleCenters`: HTTP 200
- `SalePoints` devuelve HTTP 500.
- `/api/` devuelve HTTP 404, pero esto no bloquea la integración porque los endpoints reales de exportación funcionan.
- `Invoices` funciona:
  - `2026-06-16`: HTTP 200, `8` facturas, `86` líneas.
  - `2026-06-10`: HTTP 200, `32` facturas.
  - `2026-06-17` y `2026-06-15`: HTTP 200 sin facturas en la muestra.
- Endpoints de tiempo real probados para hoy (`Tickets`, `Orders`, `OpenInvoices`, `Receipts`): HTTP 500.
- Catálogo:
  - `117` familias.
  - `67` familias visibles.
  - `20` subfamilias.
  - `2.940` productos.
  - `2.118` productos vendibles.
  - `8` productos con `UseAsDirectSale=true`.
  - `321` productos sin `FamilyId`.
- Estructura visible de vino:
  - familia raíz `47` · `Bodega`, visible, sin productos directos;
  - subfamilias visibles bajo `Bodega`: `Ribera del Duero`, `Rioja`, `Toro`, `Castilla y León`, `Madrid`, `Otras Denominaciones`, `Magnum y Medias Botellas`, `Blancos`, `Espumosos`, `Otros Vinos`, `Tintos franceses`, `frances blanco`, `Priorato`, `Jumilla`, `D.O. Ribera Sacra`.
  - familia raíz `16` · `Vinos`, visible, `45` productos (`38` vendibles).
  - familia raíz `64` · `Vermuth y Vinos de jerez`, visible, sin productos directos.
- Familias legacy ocultas con vino:
  - `77` · `Blancos Alemanes`
  - `82` · `Blancos nacionales`
  - `85` · `Cavas`
  - `86` · `Champagne`
  - `89` · `Blancos Franceses`
  - `91` · `Jerez`
  - `102` · `Ribera del Duero`
  - `103` · `Rioja`
  - `111` · `Tintos Franceses`
- Direct-sales relevantes:
  - `Botella de Vino` aparece como producto directo.
  - También hay directos genéricos de copas/licores.
- No hay familias `WINERIM`.
- Referencias útiles:
  - IVA: `Exento`, `Super reducido`, `Reducido`, `General`.
  - `16` listas de precio, incluidas `Barra`, `Sala`, `Terraza`, `Copas`, `Restaurante`, `Tienda`, `Sala B`, `Terraza B`.
  - Preparación: `Barra`, `Cocina`, `Menú Degustación`, `Parrilla`, `Plato frío`, `Postre`.
  - Órdenes preparación: `Bebidas`, `Primeros`, `Segundos`, `Postres`, `Cafés`, `Parrilla`, `Menú Degustación`, `Bebida`, `Terceros`.
  - Almacén: `Almacén General`.
  - `17` centros de venta.

### Interpretación

- Viable para lectura de catálogo y ventas cerradas.
- No viable para tiempo real con la API probada; el patrón debe ser D-1/post-cierre vía `Invoices`.
- La estructura de vino está muy trabajada por regiones/denominaciones dentro de `Bodega`. Si el cliente quiere conservar operativa visual, conviene hacer primero matching legacy por código/nombre y no reemplazar la pantalla de golpe.
- Si se quiere publicar Winerim en paralelo, debe ser en familias Winerim dedicadas y con validación visual antes de ocultar legacy.

### Riesgos

- Catálogo muy grande y con mucha deuda legacy/oculta: `2.940` productos, `321` sin familia.
- Varias familias duplicadas entre visibles bajo `Bodega` y ocultas antiguas.
- `Botella de Vino` directo puede ser una venta genérica imposible de mapear a stock Winerim salvo que se cambie operativa o se capture detalle adicional.

## Firesoft

### Hechos

- La web pública de Firesoft muestra producto TPV de hostelería con monitor de cocina, comanderos Android y control de stock, pero no se localizó documentación pública de API.
- Hay indicios públicos de que Firesoft trabaja con ventas, compras, stock e informes, pero no se puede confirmar desde fuera si dispone de API REST, export programable o webhooks.

### Interpretación

- Viabilidad técnica: posible, pero pendiente de que Firesoft confirme el mecanismo de integración.
- Integración mínima necesaria:
  - lectura de catálogo/artículos;
  - lectura de ventas cerradas con líneas y cantidades;
  - escritura o actualización de artículos/precios si quieren catálogo Winerim -> Firesoft;
  - identificación estable de artículo/variante;
  - mecanismo de autenticación;
  - entorno de pruebas.

## BDP NET

### Hechos

- La integración existente del proyecto asume BDP NET Weblink REST API.
- Fuentes públicas de integradores describen activación de `Servicio Web` y pestaña `Weblink Rest API`, con puerto, login obligatorio, usuario/clave y plantilla de exportación para ventas.
- BDP Software publica BDP NET como TPV configurable para ventas, gestión y stock; Weblink REST API aparece como módulo o interfaz externa en documentación de terceros/distribuidores.

### Interpretación

- Viable si el cliente/SAT activa Weblink REST API y facilita URL, usuario, contraseña, puerto, clave/audiencia si aplica, código de plantilla de exportación y permisos.
- Para catálogo Winerim -> BDP hay que confirmar endpoints de alta/actualización de artículos, precios, familias/departamentos y formatos.

## Pendiente

- No crear conexiones todavía.
- No usar tokens Winerim hasta que se apruebe el siguiente paso de lectura/cross-check.
- El Bejeque: confirmar con cliente/SAT por qué casi todas las familias aparecen `ShowInPos=false`.
- Taberna de Elia: decidir si se respeta `Bodega` legacy por matching o se hace piloto con familias Winerim dedicadas.
- Firesoft: enviar correo técnico a Pascual solicitando documentación/API/export y alcance soportado.
- BDP: enviar correo técnico solicitando Weblink REST API y plantilla de exportación.
