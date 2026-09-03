# Yurest V2 · Blasco · Readiness 2026-07-14

## Objetivo

Integrar el local `Jenkin’s - Blasco Ibañez` con responsabilidades separadas:

- Agora: ventas cerradas y precios de venta.
- Yurest: stock, movimientos, compras y precios de compra.
- Winerim: fuente de catálogo de vinos que se publica en Agora.

La primera fase es estrictamente de lectura. No se escribe en Yurest ni se modifica stock hasta completar permisos, matching e idempotencia.

## Alcance confirmado

- API: Yurest V2 Customer Session.
- Base URL: `https://cliente.yurest.com/ws`.
- Autenticación real validada: HTTP `200`.
- Local objetivo confirmado por datos de coste e inventario:
  - nombre: `Jenkin’s - Blasco Ibañez`;
  - `store_id`: `2054`.
- Almacenes del local:
  - `8394 · COCINA`: activo;
  - `8398 · Cocina principal`: inactivo;
  - `8399 · Barra principal`: inactivo.

Las credenciales no se guardan en este documento, código ni `provider_config`. El proxy las resuelve desde secretos de Lovable Cloud. La configuración persistente solo contiene el `store_id`, el almacén elegido y los nombres de los secretos.

## Datos reales leídos

| Recurso | Resultado |
|---|---:|
| Autenticación | HTTP 200 |
| Productos activos del cliente/grupo | 2.906 |
| Registros de coste del cliente/grupo | 3.032 |
| Productos con algún coste en Blasco | 536 |
| Productos con precio de compra en Blasco | 216 |
| Productos con coste de ficha/escandallo en Blasco | 263 |
| Productos con coste de receta en Blasco | 1 |
| Proveedores visibles | 161 |
| Productos de proveedor visibles | 3.674 |
| Último inventario de Blasco visible | 2026-06-30 22:28:50 |
| Líneas del último inventario | 347 |

El usuario master puede obtener costes de 18 locales del grupo. Por ello, cualquier proceso debe filtrar y validar siempre `store_id=2054`; aceptar datos sin ese aislamiento mezclaría Blasco con otros centros.

## Matriz de permisos y fallos

| Endpoint V2 | Estado real | Impacto |
|---|---|---|
| `POST /v2/auth/login` | 200 | Autenticación disponible |
| `GET /v2/products` | 200 | Catálogo global disponible |
| `GET /v2/products/costs` | 200 | Costes disponibles; hay que filtrar Blasco |
| `GET /v2/stores/warehouse-locations` | 200 | Almacenes disponibles y filtrables por local |
| `GET /v2/stores` | 403 | Falta permiso/scope para listar locales |
| `GET /v2/stock` | 500 | Bloquea stock actual, incluso pasando un almacén válido |
| `GET /v2/stock/movements` | 500 | Bloquea movimientos de compra/venta/ajuste |
| `GET /v2/stores/warehouse-locations/inventories` | 200 | Inventarios históricos disponibles |
| `GET /v2/delivery-notes` | 403 | Falta permiso/scope de albaranes |
| `GET /v2/bills` | 500 | Facturas de compra no utilizables todavía |
| `GET /v2/providers` | 200 | Proveedores disponibles |
| `GET /v2/provider-products` | 200 | Catálogo y precios de proveedor disponibles |

La especificación V2 actual permite crear pedidos, consultar estados y obtener un pedido por ID, pero no documenta un listado paginado de pedidos de compra. Para importar pedidos existentes hace falta que Yurest exponga o confirme ese endpoint.

## Implementación preparada

- Cliente compartido: `supabase/functions/_shared/yurest/client.ts`.
- Proxy de solo lectura: `supabase/functions/yurest-proxy/index.ts`.
- Configuración tipada: `getYurestConfig` en `_shared/providerConfig.ts`.
- Acciones disponibles:
  - `test` / `list-warehouse-locations`;
  - `list-store-product-costs`;
  - `list-products`;
  - `list-stock`;
  - `list-stock-movements`;
  - `list-inventories`;
  - `get-inventory`;
  - `list-providers`;
  - `list-provider-products`.
- Protección multi-centro:
  - `store_id` se añade a todas las rutas que lo admiten;
  - costes de otros locales se eliminan de la respuesta;
  - un inventario o almacén ajeno a Blasco se rechaza con HTTP 403;
  - catálogo global, proveedores y productos de proveedor quedan bloqueados por defecto y exigen `allow_customer_scope_reads=true`;
  - renovación automática de Bearer una sola vez ante HTTP 401.

## Estado desplegado

- Los secretos `YUREST_EMAIL`, `YUREST_PASSWORD` y `YUREST_PROVIDER_TOKEN` están configurados en Lovable Cloud; sus valores no se guardan en código ni en la base de datos.
- `yurest-proxy` está desplegado y responde únicamente a las acciones de lectura enumeradas arriba.
- Existe una conexión operativa de preparación para `Jenkin’s - Blasco Ibañez`:
  - `connection_id=f519a61e-83a0-4814-bd8f-3b99a2a6cec6`;
  - `enabled=false`;
  - `sync_mode=PULL_ONLY`;
  - `write_mode=NONE`;
  - `store_id=2054`;
  - almacén `8394`.
- Validaciones de runtime:
  - autenticación y test de conexión: HTTP `200`;
  - costes de tienda paginados: `96` filas filtradas en las dos páginas comprobadas;
  - listado de inventarios: HTTP `200`;
  - detalle del inventario `101431`: HTTP `200`, correspondiente al inventario de `2026-06-30` del almacén `8394`.

La conexión permanece desactivada porque estas lecturas permiten ya analizar costes e inventarios, pero todavía no permiten sincronizar stock actual, movimientos, albaranes ni pedidos de compra de forma completa.

## Petición necesaria a Yurest

1. Habilitar para el usuario y token V2 los permisos/scopes de locales, stock, movimientos, albaranes y facturas de compra.
2. Corregir o revisar los HTTP 500 de `GET /v2/stock`, `GET /v2/stock/movements` y `GET /v2/bills`.
3. Confirmar el endpoint V2 para listar pedidos de compra existentes, con filtro por `store_id`, fechas, estado y paginación.
4. Confirmar que `store_id=2054` es el único local que debe consumir Winerim dentro de esta integración.
5. Confirmar la unidad que representa cada vino en Yurest y el identificador estable para el matching: producto Yurest, referencia de proveedor, EAN/SKU o pairing externo con Agora.

## Criterio para activar

No activar sincronización automática hasta que:

- stock actual y movimientos respondan sin HTTP 500;
- los datos estén limitados a `store_id=2054`;
- exista matching inequívoco Yurest ↔ Winerim para los vinos;
- el primer dry-run compare stock, último inventario y precios de compra sin escrituras;
- se haya validado un canary con rollback y claves idempotentes.
