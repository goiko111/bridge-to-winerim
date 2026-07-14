# Winerim + Agora + tSpoonLab + Holded

Fecha: 2026-07-14  
Estado: base tecnica de lectura implementada; escrituras no activadas

## 1. Objetivo

Integrar cuatro sistemas sin mezclar responsabilidades ni duplicar movimientos:

| Sistema | Responsabilidad principal |
| --- | --- |
| Winerim | Catalogo de vinos, formatos, PVP, stock de vino, historial de venta y analitica |
| Agora | TPV operativo, comandas, lineas vendidas, cobro y cierre |
| tSpoonLab | Escandallos, recetas, menus, armonias, compras y stock teorico de cocina |
| Holded | Facturacion, contabilidad y documentos administrativos |

## 2. Flujos autorizados

### Catalogo de vino

`Winerim -> Agora`

- Crea o actualiza productos vendibles de botella, copa y magnum.
- Un formato sin precio o un vino inactivo se oculta de forma reversible.
- tSpoonLab y Holded no deben reescribir el PVP de vino en Winerim o Agora.

### Venta normal de vino

`Agora -> middleware -> Winerim`

- La linea vendida se resuelve por identificador estable y formato.
- Si el stock de la variante esta activo, se descuenta la cantidad absoluta.
- Si el stock no esta activo, se importa la venta sin modificar stock.
- La factura cerrada es la reconciliacion definitiva; los tickets abiertos son un piloto casi en tiempo real.

### Menu o armonia

`Agora sale line -> tSpoonLab composition snapshot -> Winerim wine consumption`

1. Agora entrega la linea de menu/armonia con identificador estable y cantidad.
2. El middleware resuelve el codigo TPV contra el menu o elaboracion de tSpoonLab.
3. Se guarda una instantanea versionada de los componentes aplicables a esa venta.
4. Solo los componentes de vino mapeados a Winerim generan consumo por variante.
5. La cancelacion o devolucion genera el movimiento inverso una sola vez.

No se debe usar la composicion actual de tSpoonLab para recalcular una venta historica sin conservar su version. Un cambio posterior del menu alteraria indebidamente consumos ya contabilizados.

### Contabilidad

`tSpoonLab purchases/sales documents -> middleware -> Holded`

- El piloto empieza en lectura para comparar proveedores, impuestos, series, productos y documentos.
- La escritura en Holded se activa solo tras validar serie, contacto, impuestos, moneda y politica de redondeo.
- Un documento se marca como contabilizado en tSpoonLab solo despues de recibir confirmacion persistida de Holded.
- Si falla Holded, tSpoonLab conserva el documento como pendiente.

## 3. Idempotencia

Claves recomendadas:

- Venta Agora: `connection_id + provider_doc_id + provider_line_id`.
- Consumo de menu: `agora_connection_id + provider_doc_id + provider_line_id + tspoon_component_id + composition_revision`.
- Documento Holded: `source_provider + source_connection_id + source_document_id + document_type`.
- Reversion: la misma clave original con `operation=REVERSAL`; nunca se borra el movimiento original.

Las claves deben persistirse con una restriccion unica antes de habilitar escrituras.

## 4. Contratos API verificados

### tSpoonLab

- Login: `POST /recipes/api/login` con formulario `username` y `password`.
- Token posterior: header `rememberme`.
- Centro de coste/restaurante: header `order` con `idOrderCenter`.
- Libro de elaboraciones: header `recipe` con su identificador o `all`.
- Centros: `GET /recipes/api/orderCenters`.
- Menus: `GET /recipes/api/listMenusPagedEx` y `GET /recipes/api/menu/ext/{id}`.
- Recetas/platos: `GET /recipes/api/listRecipesPaged`, `listDishesPaged`, `recipe/{id}`, `dish/{id}`.
- Albaranes de venta: `GET /integration/sales/deliveries/pending` o `/all` por rango de fecha.

### Holded API v2

- Base: `https://api.holded.com/api/v2`.
- Autenticacion: `Authorization: Bearer <API_TOKEN>`.
- Formato: REST/JSON.
- Paginacion: cursor.
- La API key debe limitarse a los modulos y acciones necesarios.

## 5. Base implementada

- Cliente tipado de tSpoonLab con autenticacion, contexto de restaurante/libro y acciones de lectura.
- Proxy `tspoonlab-proxy` con allowlist de acciones de lectura.
- Cliente tipado de Holded v2 con Bearer auth y cursor.
- Proxy `holded-proxy` con lectura de productos, facturas, contactos y almacenes.
- Timeout, reintento, contador de fallos y circuit breaker por conexion.
- HTTPS obligatorio y respuestas sin credenciales.

No se ha desplegado ni activado ninguna conexion. No existen escrituras a Holded, tSpoonLab, Agora o Winerim dentro de estos dos proxies nuevos.

## 6. Datos necesarios para el piloto

### tSpoonLab

- Usuario tecnico de integracion.
- Password del usuario tecnico.
- Centro de coste/restaurante autorizado.
- Libro de elaboraciones que contiene menus y armonias.
- Codigos TPV usados en Agora para menus, armonias y vinos.
- Confirmacion de si el stock de vino seguira en tSpoonLab durante el piloto.

### Holded

- API Token v2 con permisos minimos de lectura para el descubrimiento.
- Empresa/cuenta y entorno que se utilizara.
- Serie de facturacion, canal de venta, almacen y reglas fiscales del piloto.
- Decision sobre documentos destino: facturas, tickets, albaranes, compras o combinacion.

### Agora / partner

- Identificador estable de documento y linea.
- Codigo de producto y codigo padre/modificador cuando aplique.
- Fecha/hora real, cantidad, precio, descuento, IVA y estado de cancelacion.
- Confirmacion de si la exportacion incluye los componentes seleccionados de menus y armonias.
- Endpoint recomendado para tickets abiertos y endpoint de cierre para reconciliacion.

## 7. Plan de validacion

1. Test de autenticacion y lectura en tSpoonLab y Holded.
2. Inventario de centros, libros, menus, recetas, productos, impuestos y almacenes.
3. Matching solo lectura entre codigo TPV de Agora y codigo de tSpoonLab.
4. Reproduccion de una venta real de menu y comparacion de componentes esperados.
5. Simulacion `dry-run` del documento Holded y del consumo Winerim.
6. Canary con un menu/armonia y una venta normal de vino.
7. Cancelacion controlada y reintento para comprobar reversibilidad e idempotencia.
8. Reconciliacion del cierre antes de declarar la integracion operativa.

## 8. Criterios de no activacion

- No hay codigo TPV estable o el mismo codigo representa productos distintos.
- Agora no expone cancelaciones o no existe una reconciliacion por documento cerrado.
- El menu cambia sin revision o fecha efectiva recuperable.
- No se ha decidido que sistema controla el stock de vino.
- El token Holded tiene permisos mayores de los necesarios o faltan serie/impuestos.
- No se puede repetir una llamada sin duplicar movimientos o documentos.
