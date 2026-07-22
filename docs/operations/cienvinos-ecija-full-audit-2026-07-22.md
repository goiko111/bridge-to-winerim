# Auditoria integral - Restaurante Cienvinos Ecija

Fecha de cierre: 2026-07-22
Conexion: `21ee3345-1090-4e83-94f2-43126d6e7695`
Menu Winerim: `861`
Alcance: catalogo, automatizacion, ventas, idempotencia, cancelaciones, colas y observabilidad.

## Estado ejecutivo

**Estado final: OPERATIVO CON BLOQUEO DE CIERRE (WARN), no certificable todavia al 100%.**

- Catalogo Winerim -> Agora: **PASS**. Lectura fresh posterior a la correccion: `519/519` formatos elegibles coinciden; `missing=0`, `different=0`, `unownedExisting=0` y cola activa `0`.
- Conectividad y automatizacion: **PASS**. Conexion activa, breaker cerrado, contador de fallos `0`, escritura `XML_IMPORT`, alta y actualizacion automaticas activadas y cadencia configurada de 5 minutos.
- Inactivos/sin precio: **PASS tras correccion metadata**. Los 12 formatos retirados estan no vendibles en Agora y ahora constan `HIDDEN` en tracking.
- Ventas Agora -> Winerim: **FAIL de conciliacion, aunque el transporte esta activo**. El ledger no contiene claves idempotentes duplicadas, pero los totales cerrados de Agora, los envios del middleware y el historial ERP no cuadran en la ventana auditada.
- Navegacion/legacy: **WARN**. Existe un producto de vino no propiedad de Winerim que sigue vendible y en uso. Ademas, las ocho familias Winerim estan ocultas mientras una familia `VINOS` vacia esta visible; el export estandar no permite demostrar la estructura de categorias ni el comportamiento real del buscador.

## Evidencia y resultado por control

### 1. Conectividad

- `test`: respuesta correcta de Agora.
- `probe-open-tickets`: HTTP 200, parseo correcto y 3 tickets abiertos en la sonda del 2026-07-22.
- Breaker: sin pausa.
- Fallos consecutivos: `0`.
- Alertas abiertas: `0`.

Resultado: **PASS**.

### 2. Catalogo fresh, ownership y precios

La auditoria fresh posterior a la correccion obtuvo:

| Control | Resultado |
|---|---:|
| Formatos elegibles Winerim | 519 |
| Coincidencias exactas | 519 |
| Ausentes | 0 |
| Diferentes | 0 |
| Productos existentes sin ownership dentro del universo esperado | 0 |
| Cola activa | 0 |

La comparacion valida por formato el identificador de producto, nombre/boton, precio, IVA, familia, orden, visibilidad de venta y ownership. Las tres listas de precio detectadas son Barra, Sala y Terraza; el IVA configurado para los vinos es el reducido del 10 % (`VatId=3`).

Estructura fresh:

| Familia | Orden | Productos | Vendibles | Ownership Winerim | Visible |
|---|---:|---:|---:|---:|---|
| TINTOS WINERIM | 0 | 221 | 219 | 221 | no |
| COPAS WINERIM | 1 | 63 | 56 | 62 | no |
| ROSADOS WINERIM | 2 | 11 | 11 | 11 | no |
| DULCE WINERIM | 3 | 19 | 18 | 19 | no |
| BLANCOS WINERIM | 4 | 124 | 122 | 124 | no |
| MAGNUM WINERIM | 5 | 12 | 12 | 12 | no |
| FORTIFICADOS WINERIM | 6 | 34 | 34 | 34 | no |
| ESPUMOSOS WINERIM | 7 | 48 | 48 | 48 | no |
| VINOS | 8 | 0 | 0 | 0 | si |

Los 519 formatos activos/elegibles son vendibles. Los otros 12 formatos Winerim del tracking estan retirados y no vendibles.

Resultado: **PASS de datos; WARN de navegacion visual**.

### 3. Inactivos y formatos sin precio

Antes de la reparacion habia cinco botellas inactivas correctamente ocultas en Agora pero con tracking `VERIFIED`:

- `239311` - Clos Alzina (`739311`)
- `239891` - Blanquito (`739891`)
- `239902` - El Aeronauta Godello (`739902`)
- `250797` - Heritage Reserva Convento Las Claras (`750797`)
- `255592` - Convento de las Claras Sweet Wine (`755592`)

Se corrigio exclusivamente `winerim_push_tracking.sync_status` a `HIDDEN` para esas cinco filas. No se cambio precio, nombre, stock ni visibilidad comercial porque los productos ya estaban no vendibles. Tras la correccion el tracking queda en `519 VERIFIED + 12 HIDDEN`, coherente con la lectura fresh.

Resultado: **PASS**.

### 4. Legacy, familias, producto y buscador

No se ha encontrado una familia historica de vinos que pueda ocultarse de forma segura. Los productos no Winerim restantes son principalmente comida, refrescos y destilados; las coincidencias textuales como `TINTO LIMON` o `COPA ANIS` no son vinos de la carta Winerim.

Existe una excepcion real:

- Agora `1181650` - `C MANZANILLA ZULETA`, dentro de `COPAS WINERIM`, vendible y sin ownership/mapping Winerim.
- Hay ventas cerradas de este boton los dias 15, 19, 20 y 21 de julio (cinco unidades en la ventana auditada).

No se oculto ni se reasigno: retirarlo cortaria una operativa que el restaurante sigue usando y no existe una referencia Winerim inequívoca para absorber esas ventas.

El export master confirma que las ocho familias Winerim tienen `ShowInPos=false` y que `VINOS` esta visible pero vacia. Esto puede corresponder a navegacion mediante categorias, pero el endpoint estandar de Agora no expone ese arbol. Por tanto, ni la navegacion fisica ni el resultado del buscador pueden certificarse con esta evidencia. No se cambio la visibilidad para evitar alterar una configuracion de sala no documentada.

Resultado: **WARN**.

### 5. Flags, cadencia y propagacion Winerim -> Agora

- Conexion activa: si.
- Modo: `BIDIRECTIONAL` / escritura `XML_IMPORT`.
- `auto_push_on_create=true`.
- `auto_push_on_update=true`.
- `auto_push_verified_ready=true`.
- Botella y copa habilitadas.
- Cadencia: 5 minutos.

La evidencia real ya disponible incluye altas y actualizaciones controladas verificadas el 2026-07-14, con latencias observadas de 50 a 82 segundos. La auditoria del 2026-07-21 tambien registro 16 formatos propagados dentro del primer minuto. Se cumple el objetivo de menos de 5 minutos.

No se creo un nuevo canary ni se modifico un precio comercial en esta auditoria, conforme a la instruccion de usar evidencia reciente segura.

Resultado: **PASS**, latencia demostrada `50-82 s`.

### 6. Ventas, variantes, stock/sales-only y hora real

La lectura de facturas cerradas y tickets abiertos funciona. Los flags activos son:

- `open_tickets_sync_enabled=true`.
- `intraday_sales_sync_enabled=true`.
- `open_tickets_stock_sync_enabled=false`.
- `sales_timezone=Europe/Madrid`.

El stock sobre tickets abiertos permanece desactivado deliberadamente: una venta provisional puede cancelarse y no existe una compensacion remota suficientemente segura para convertirla en escritor definitivo. Las facturas cerradas son la fuente definitiva.

Ventana auditada del 15 al 21 de julio:

| Fuente | Filas/tarjetas | Cantidad neta | Copa | Botella | Magnum |
|---|---:|---:|---:|---:|---:|
| Facturas cerradas canonicas Agora | 451 | 535 | 499 | 36 | 0 |
| Ledger exitoso middleware | 180 | 525 | 499 | 26 | 0 |
| Historial TPV expuesto por ERP Winerim | 184 | 447 | 375 | 72 | 0 |

El 21 de julio muestra la discrepancia con claridad:

- Facturas cerradas Agora: 60 unidades netas (`57 copa + 3 botella`).
- Ledger middleware: campo cantidad agregado 67 (`64 copa + 3 botella`).
- Historial ERP: 30 unidades, todas expuestas como botella en la respuesta auditada.

No faltan `stockId` en ninguna linea canonica mapeada. Se han observado botella y copa; no hubo una venta magnum real en la ventana y esa variante queda sin canary especifico. El flujo sales-only existe para stock no activo, pero esta auditoria no aporta una evidencia Cienvinos aislada que permita certificar esa rama por separado.

La hora real de Agora si se conserva en `provider_sold_at` (por ejemplo, `2026-07-21T13:10:51`, `22:35:13` y `23:19:23`). Sin embargo, el endpoint de historial ERP auditado devolvio `time=null`, por lo que la hora no queda certificada de extremo a extremo en la interfaz.

Resultado: **FAIL de conciliacion**.

### 7. Idempotencia, cancelaciones y errores 503

- Claves idempotentes exactamente duplicadas: `0`.
- Riesgos de ticket abierto convertido en escritura definitiva: `0`.
- Lineas negativas/cancelaciones detectadas en facturas cerradas: 6, cantidad neta `-6`.
- No se observo un 503 vivo en la conexion durante el cierre de esta auditoria.
- No hay tareas FAILED/BLOCKED recientes desde el 2026-07-21.

La ausencia de duplicados del ledger es **PASS**, pero no resuelve por si sola los excesos o faltas ya presentes en el historial ERP. Las cancelaciones historicas y las tarjetas repetidas por huella no se han eliminado: una misma huella puede representar ventas reales distintas y la API no ofrece una cancelacion idempotente por identificador externo suficientemente fiable.

Resultado: **PASS tecnico de idempotencia; WARN funcional de cancelaciones/historial heredado**.

### 8. Colas, tracking, alertas y observacion

- Cola activa: `0`.
- Tareas FAILED/BLOCKED recientes: `0`.
- Alertas abiertas: `0`.
- Tracking final: `519 VERIFIED`, `12 HIDDEN`.
- `last_business_day_synced=2026-07-21`.
- Ultima sincronizacion observada: madrugada del 2026-07-22.

Resultado: **PASS**.

## Correcciones aplicadas

1. Se alineo el tracking de cinco botellas inactivas con su estado real `HIDDEN`.
2. Se ejecuto una auditoria fresh despues de la escritura: `519/519`, sin diferencias ni cola.
3. No se modifico codigo ni configuracion comercial; no fue necesario desplegar.

## Elementos dejados sin tocar por seguridad

1. No se borraron, compensaron ni reimportaron ventas historicas dudosas.
2. No se oculto `C MANZANILLA ZULETA`: sigue vendiendose y no tiene mapping seguro.
3. No se cambio la visibilidad de las familias ni la estructura de categorias sin confirmar el flujo real de la pantalla de venta.
4. No se renombro el producto retirado `[INACTIVO] Clos Alzina`, para no alterar documentos historicos o mesas abiertas.
5. No se modifico ningun precio comercial ni se genero un canary artificial.
6. No se activo escritura de stock desde tickets abiertos.

## Cierre y siguiente condicion de aceptacion

Cienvinos queda con catalogo, ownership, automatizacion, conectividad, colas y alertas en estado correcto. No debe declararse al 100 % mientras el historial ERP no concilie con las facturas cerradas y no se confirme la navegacion/buscador en el TPV.

Para cerrar el 100 % en otra intervencion hacen falta dos pruebas controladas, sin corregir historia automaticamente:

1. Una venta cerrada conocida de botella y otra de copa, comparadas por documento, producto, cantidad y hora entre Agora, ledger y ERP.
2. Confirmacion visual en el terminal de que las categorias actuales permiten encontrar los 519 formatos Winerim y decision expresa sobre `C MANZANILLA ZULETA`.
