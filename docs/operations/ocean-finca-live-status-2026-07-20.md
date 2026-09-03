# Ocean Club y Finca Eslava - estado live 2026-07-20

Fecha de auditoria: 2026-07-20 17:25 CEST

## Metodo

- Sonda fresh de conexion Agora.
- Sonda fresh de tickets abiertos.
- Auditoria read-only del XML esperado Winerim contra Products fresh de Agora.
- Revision de tracking, mappings, cola, alertas y health checks.
- Cruce por ID exacto de producto de todas las ventas entre el 16 y el 20 de
  julio; no se uso `is_wine_candidate` como criterio comercial.
- Comprobacion live del stock Winerim de la unica venta Winerim encontrada en
  Finca Eslava.

## Ocean Club

Estado: `LIVE_PENDING_SALE_CANARY`.

### PASS

- Conexion Agora HTTP 200 y breaker cerrado.
- Ciclo configurado cada 5 minutos.
- Catalogo, altas y cambios automaticos activos.
- Intradia, tickets abiertos y stock intradia activos.
- Catalogo fresh: `113/113 MATCH`, `0 MISSING`, `0 DIFFERENT`, `0 UNOWNED`.
- Las ocho familias Winerim estan visibles y conservan su orden `0-7`.
- Distribucion: `35` tintos, `20` blancos, `8` rosados, `22` espumosos y
  `28` magnum. `COPAS`, `DULCE` y `FORTIFICADOS` estan vacias porque Winerim
  no tiene formatos elegibles para ellas.
- Tracking: `113 VERIFIED`.
- Mappings: `113 CONFIRMED`.
- Cola activa: `0`.
- Fallos o bloqueos de los ultimos siete dias: `0`.
- Alertas abiertas: `0`; las alertas `sales_stale` anteriores estan resueltas.
- Ultimo dia cerrado sincronizado: `2026-07-19`.

### Venta y catalogo anterior

- Entre el 13 y el 20 de julio se revisaron `889` documentos y `8.471` lineas:
  no hay ninguna venta realizada con los `113` botones Winerim.
- En esa ventana se vendieron por las cinco familias anteriores `566`
  unidades netas / `57.377 EUR`; ninguna linea esta mapeada a Winerim.
- Se restauraron visibles `GLASS WINE`, `WHITE WINE`, `ROSE WINE`, `RED WINE`
  y `CHAMPAGNE`: `164` productos, de los cuales `162` son vendibles. No se
  oculto ni elimino ningun producto.
- No existe ningun `stock_sync_log`, porque todavia no se ha producido una
  venta Winerim que deba registrarse o descontarse.
- El ERP Winerim (`menu 756`) sigue vacio, coherente con la ausencia de ventas
  realizadas con botones Winerim.
- Winerim tiene `0` variantes activas con precio de copa, por lo que
  `COPAS WINERIM` esta correctamente vacia.

### Cierre necesario

1. Marcar una botella real desde una familia Winerim y no anularla.
2. Verificarla en el ERP Winerim, con hora real y variante correcta.
3. Verificar stock activo o `sales/import` cuando el stock este inactivo.
4. Para probar una copa, poner primero precio de copa a un vino en Winerim y
   comprobar su alta automatica antes de venderla.
5. Decidir despues si se oculta legacy de forma reversible.

## Finca Eslava

Estado: `LIVE_PENDING_SALE_CANARY`.

### PASS

- Conexion Agora HTTP 200 y breaker cerrado.
- Ciclo configurado cada 5 minutos.
- Catalogo, altas y cambios automaticos activos.
- Intradia, tickets abiertos y stock intradia activos.
- Catalogo fresh: `123/123 MATCH`, `0 MISSING`, `0 DIFFERENT`, `0 UNOWNED`.
- Tracking: `123 VERIFIED`.
- Mappings: `123 CONFIRMED`.
- Cola activa: `0`.
- Fallos o bloqueos de los ultimos siete dias: `0`.
- Alertas abiertas: `0`; `sales_stale` y la alerta antigua de cola estan
  resueltas.
- Ultimo dia cerrado sincronizado: `2026-07-19`.

### Prueba del 17/07

- Factura `T-27681`: `B Emilio Moro`, una botella, `30 EUR`, vendida a las
  `15:42:43` desde `TINTOS WINERIM`.
- Devolucion `TD-930`: la misma botella, `-1`, `-30 EUR`, a las `15:43:43`.
- Neto Agora del producto: `0` unidades / `0 EUR`.
- El flujo Winerim proceso la venta positiva y cambio el stock de `83` a `82`.
- La devolucion esta marcada como no elegible para stock automatico y no hubo
  movimiento compensatorio.
- Tras comprobar que Agora no registra otra venta de Emilio Moro entre el 17 y
  el 20 de julio, se restauro el stock de `82` a `83` mediante `No, solo
  ajuste`. No se creo otra venta ni se modificaron las cuatro tarjetas de
  historial ya existentes.
- La lectura posterior de Winerim confirma `stockId 328484 = 83` y stock
  activo.

### Conciliacion posterior

- Auditoria de siete dias: cero claves idempotentes exactas repetidas.
- Agora cerrado netea `0` unidades de Emilio Moro; el ERP conserva una tarjeta
  TPV positiva de una unidad. Por eso la conciliacion de historial queda en
  `WARN`, aunque el inventario ya sea correcto.
- Catalogo fresh posterior a la correccion: `123/123 MATCH`, cero ausentes,
  diferentes o sin ownership.
- Sondas de conexion y tickets abiertos: HTTP 200. Cola activa y alertas
  abiertas: cero.

### Pendiente

- Cerrar el soporte de anulacion de factura definitiva antes de aceptar este
  canary como valido. No compensarlo con `PUT /stock`, porque crearia otra
  venta.
- El 19 de julio se usaron botones legacy genericos (`COPA BLANCO`, `COPA
  TINTO`, `COPA FRIZANTE`, `COPA MALAGA VIRGEN`): `13` unidades netas /
  `46,50 EUR`.
- No hay ninguna venta Winerim neta posterior a la prueba anulada.
- El legacy sigue visible, tal como se decidio al activar la conexion.

### Cierre necesario

1. Marcar una botella Winerim real y no anularla.
2. Marcar una copa Winerim real y no anularla.
3. Verificar ERP, hora, idempotencia y stock activo/inactivo durante dos
   ciclos de cinco minutos.
4. Resolver el tratamiento de devoluciones de facturas definitivas sin crear
   ventas compensatorias.
5. Decidir despues si se ocultan los botones legacy genericos.

## Conclusion

- **Catalogo:** ambas conexiones estan al 100 % fresh.
- **Automatizacion:** ambas estan activas y sanas.
- **Aceptacion de ventas:** ninguna esta firmada al 100 %.
- **Prioridad:** hacer el canary doble real en Finca y Ocean y cerrar el
  tratamiento de devoluciones definitivas.
