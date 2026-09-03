# Auditoría completa de El Bejeque - 2026-07-22

## Alcance y criterio

- Conexión: `El Bejeque`.
- `connection_id`: `ba44c13a-5f48-4a49-8b3f-04049b244d94`.
- Auditoría ejecutada contra catálogo Ágora fresh, datos operativos de Lovable Cloud y el historial ERP de Winerim.
- No se modificaron precios comerciales, vinos, familias ni credenciales.
- No se borró ni rectificó historial dudoso.
- No se editaron `PROJECT_CONTEXT.md`, `CURRENT_STATE.md`, `DECISIONS_LOG.md` ni `NEXT_STEPS.md`.

## Resultado ejecutivo

Estado final: **OPERATIVO, CATÁLOGO PASS, HISTORIAL EN REVISIÓN**.

El catálogo Winerim está publicado de forma exacta y el legacy está oculto tanto por familia como por producto. La conexión está sana, sin breaker ni alertas abiertas, y las últimas tareas outbound terminaron correctamente.

La auditoría confirmó la causa de los duplicados funcionales del historial: una venta provisional procedente de ticket abierto creaba una tarjeta en el ERP; la reversión posterior corregía el stock, pero no eliminaba esa tarjeta; al cerrar la factura se generaba otra venta definitiva. Se ha desactivado únicamente la escritura de tickets abiertos. Se mantiene su lectura para observabilidad y las facturas cerradas continúan siendo la fuente definitiva de ventas y stock.

No se declara `100%_SIGNED_OFF` porque permanecen siete discrepancias históricas que no deben corregirse automáticamente: seis duplicados exactos y una diferencia de cantidad fraccionaria en magnum.

## Checklist

### 1. Conectividad y breaker - PASS

- Prueba de conexión Ágora: correcta.
- Último health check observado: HTTP 200, `194 ms`, estado `OK`.
- `circuit_breaker_paused_until`: `null`.
- `consecutive_failures`: `0`.
- Último día de negocio sincronizado: `2026-07-21`.
- Último `last_sync_at` tras la validación: `2026-07-22T06:14:28.475Z`.
- Existieron cortes transitorios anteriores, pero sus alertas están resueltas y no hay alerta abierta.

### 2. Catálogo fresh - PASS

Master data fresh:

- 45 familias.
- 402 productos.
- 5 tipos de IVA.
- Lista de precio activa: `4 - General`.
- Las listas `1 - Barra`, `2 - Sala` y `3 - Terraza` están eliminadas y no forman parte del alcance productivo.
- Centros activos cubiertos por la lista General: Barra, Sala e Incidencias.
- IVA configurado para publicación Winerim: id `4`, tipo `7%`.

Auditoría canónica del catálogo Winerim:

- 76 vinos cacheados: 70 activos y 6 inactivos.
- 94 variantes elegibles: 69 botellas, 20 copas y 5 magnums.
- Resultado fresh: `94/94 MATCH`.
- Ausentes: `0`.
- Diferencias de nombre, botón, variante, precio, IVA, familia, orden o visibilidad: `0`.
- Productos sin ownership: `0`.
- Errores de mapping: `0`.

La acción `verify-products` revisó además las variantes retiradas:

- Revisados: `104`.
- Correctos: `104`.
- Fallidos: `0`.
- Tracking final: `94 VERIFIED` y `10 HIDDEN`.
- Errores de tracking: `0`.

El contador genérico de `missing_prices` del debug incluye precios ausentes en listas eliminadas. No constituye una discrepancia productiva porque la verificación canónica sobre la lista activa General pasa `94/94`.

### 3. Familias, orden y ownership - PASS

Las ocho familias Winerim están visibles, bajo el mismo padre y con orden consecutivo:

1. Tintos Winerim.
2. Copas Winerim.
3. Rosados Winerim.
4. Dulce Winerim.
5. Blancos Winerim.
6. Magnum Winerim.
7. Fortificados Winerim.
8. Espumosos Winerim.

Los 104 productos administrados conservan mapping confirmado y ownership Winerim. No se detectaron referencias huérfanas.

### 4. Inactivos y formatos sin precio - PASS

- Variantes retiradas, inactivas o sin precio: `10`.
- Variantes retiradas que continúan vendibles: `0`.
- Variantes elegibles que aparecen ocultas: `0`.
- El tracking de las diez retiradas quedó normalizado a `HIDDEN`.

### 5. Legacy y buscador - PASS

- Familias legacy identificadas: `12`.
- Todas tienen `ShowInPos=false`.
- Productos legacy de vino identificados: `8`.
- Todos tienen `SaleableAsMain=false` y `UseAsDirectSale=false`.

Por tanto, el legacy no aparece navegando por familias ni mediante el buscador de venta. La ocultación es reversible; no se eliminó ningún producto histórico.

La configuración documental estaba desactualizada y afirmaba que el legacy seguía visible. Se corrigió a `LEGACY_HIDDEN_REVERSIBLE_FAMILY_AND_PRODUCT` para que el estado operativo coincida con el catálogo real.

### 6. Automatización Winerim -> Ágora - PASS con límite de medición

Flags activos:

- catálogo automático: activo;
- alta automática: activa;
- actualización automática: activa;
- botella, copa y magnum: activos según elegibilidad;
- frecuencia configurada: `5 minutos`.

Evidencia real reciente, sin cambiar precios durante esta auditoría:

- Alta `AUTO_CREATE`, Winerim id `272141`: tarea solicitada a las `16:35:49.832Z` y verificada fresh a las `16:35:55.495Z`; latencia de cola a verificación: aproximadamente `5,7 s`.
- Cambio `AUTO_UPDATE`, Winerim id `220979`: tarea solicitada a las `14:22:43.486Z` y verificada fresh a las `14:22:47.921Z`; latencia de cola a verificación: aproximadamente `4,4 s`.
- Ambos productos siguen exactos en la lectura fresh del 22 de julio.

Estas cifras demuestran la latencia desde que la tarea queda encolada hasta su verificación en Ágora. No demuestran por sí solas el tiempo desde el clic del usuario en Winerim hasta la detección del cambio; ese tramo está sujeto al ciclo configurado de cinco minutos.

### 7. Cola y tracking - PASS

- Últimas 20 tareas: `20 SUCCESS`.
- Fallos o bloqueos dentro de esas tareas recientes: `0`.
- Intentos de las dos evidencias más recientes: `1`.
- Tracking: `94 VERIFIED`, `10 HIDDEN`, sin `last_error`.

La consulta REST agregada de todos los estados de `outbound_tasks` llegó a timeout por volumen. Para no ampliar el alcance ni ejecutar mantenimiento de base de datos, la validación se realizó con el bundle operacional limitado y con las veinte tareas más recientes. Esto no impide el PASS operativo, pero señala una futura mejora de índice/consulta para auditorías masivas.

### 8. Ventas, ERP, hora y stock - REVIEW

Ventana reconciliada: siete días desde `2026-07-15`.

- Líneas canónicas de facturas cerradas en Ágora: `40`.
- Tarjetas TPV observadas en el ERP Winerim: `45`.
- Claves de idempotencia exitosas exactamente duplicadas: `0`.
- Estado de idempotencia técnica: `PASS`.
- Estado de reconciliación funcional: `REVIEW`.

El flujo conserva `provider_sold_at` de Ágora para la hora de la venta. Algunas tarjetas definitivas antiguas aparecen creadas posteriormente en el ERP por la conciliación ejecutada el 20 de julio; no se reinterpretaron ni reescribieron esas horas durante esta auditoría.

El flujo definitivo distingue:

- stock activo: registra venta y descuenta la variante correspondiente;
- stock no activo: registra la venta mediante el flujo sales-only, sin forzar stock;
- histórico: se importa por `sales/import` sin modificar stock.

No se ejecutó una venta comercial nueva como canary. La mejor latencia segura previamente observada para una factura definitiva fue de aproximadamente `66 minutos`. La frecuencia de sondeo es de cinco minutos, pero una factura no está disponible para escritura definitiva hasta que Ágora la expone como cerrada; por eso no se puede prometer cinco minutos desde la comanda en este restaurante.

### 9. Cursor e idempotencia - PASS

- El cursor de negocio permanece en `2026-07-21`.
- Se ejecutaron dos lecturas consecutivas de tickets abiertos: ambas devolvieron cero eventos y cero líneas.
- Se ejecutaron dos sincronizaciones intradía consecutivas: ambas devolvieron cero eventos y cero líneas; `cursorAdvanced=false`.
- Las cuatro ejecuciones generaron `0` filas nuevas en `stock_sync_log`.

Esto demuestra que repetir el ciclo sin datos nuevos no genera ventas ni descuentos adicionales.

### 10. Cancelaciones y duplicados funcionales - CAUSA CORREGIDA, HISTÓRICO CONSERVADO

Diagnóstico confirmado:

1. El ticket abierto escribía una venta provisional en Winerim.
2. Al cambiar o cerrar el ticket se generaba una reversión de stock.
3. La reversión no podía eliminar idempotentemente la tarjeta visible del historial ERP.
4. La factura cerrada volvía a registrar la venta definitiva.

La duplicidad no procede de repetir una misma clave de idempotencia; procede de dos fuentes funcionales distintas para la misma operación: ticket abierto y factura final.

Corrección aplicada:

- `open_tickets_sync_enabled=true`: se mantienen lectura y observabilidad.
- `open_tickets_stock_sync_enabled=false`: los tickets abiertos ya no escriben venta ni stock.
- `intraday_sales_sync_enabled=true`: las facturas cerradas siguen siendo la fuente definitiva.
- `live_sales_mode=OPEN_TICKETS_OBSERVABILITY_INVOICES_DEFINITIVE`.

Discrepancias históricas conservadas:

| Stock id | Ágora factura | ERP | Interpretación |
|---|---:|---:|---|
| 106637 | 1 | 2 | duplicado funcional exacto |
| 254964 | 2 | 4 | duplicado funcional exacto |
| 369496 | 1 | 2 | duplicado funcional exacto |
| 305605 | 1 | 2 | duplicado funcional exacto |
| 252848 | 1 | 2 | duplicado funcional exacto |
| 90614 | 1 | 2 | duplicado funcional exacto |
| 119373 | 1,5 | 2 | diferencia fraccionaria de magnum; no asumir duplicado exacto |

No se borraron tarjetas, no se repuso stock y no se emitieron cancelaciones compensatorias. Corregirlas sin una operación de cancelación idempotente podría alterar el stock actual o eliminar una venta legítima.

### 11. Alertas - PASS

- Alertas abiertas: `0`.
- Último health: `OK`.
- Los avisos previos de conectividad, ventas estancadas, cola y stock están resueltos.
- No se silenciaron alertas ni se borró su histórico.

## Cambios realizados

1. Se refrescó master data sin cambiar el modo de escritura.
2. Se verificaron fresh las 104 variantes administradas.
3. Se normalizó tracking: 94 `VERIFIED`, 10 `HIDDEN`.
4. Se desactivó la escritura de ventas/stock desde tickets abiertos.
5. Se mantuvieron tickets abiertos como lectura y facturas como fuente definitiva.
6. Se corrigieron los metadatos de legacy y estado operativo para reflejar la realidad.
7. Se repitieron sincronizaciones sin datos nuevos para comprobar idempotencia.

No fue necesario editar código ni desplegar una Edge Function para estas correcciones.

## Elementos no tocados por seguridad

- Las siete discrepancias históricas del ERP.
- Stock actual de ninguna variante.
- Precios comerciales.
- Productos o familias Ágora.
- Credenciales y URL de la conexión.
- Historial de alertas.
- Los cuatro documentos compartidos de estado del proyecto.

## Rollback

Valores anteriores relevantes:

- `open_tickets_stock_sync_enabled=true`.
- `live_sales_mode=INVOICES_AFTER_CLOSE_ONLY_TEMPORARY_IDEMPOTENCY_GUARD`.
- `legacy_policy=keep_legacy_visible_until_controlled_sale_ok`.
- `integration_status=CONTROLLED_GO_LIVE_NO_LEGACY_HIDE`.

Valores posteriores:

- `open_tickets_stock_sync_enabled=false`.
- `live_sales_mode=OPEN_TICKETS_OBSERVABILITY_INVOICES_DEFINITIVE`.
- `legacy_policy=LEGACY_HIDDEN_REVERSIBLE_FAMILY_AND_PRODUCT`.
- `integration_status=LIVE_HISTORY_RECONCILIATION_PENDING`.

No se recomienda restaurar la escritura desde tickets abiertos hasta que Winerim disponga de una cancelación de venta provisional idempotente que retire también la tarjeta de historial, no solo que compense stock.

## Estado final y siguiente validación permitida

- Conectividad: `PASS`.
- Catálogo, variantes, precios, IVA, familias, orden, visibilidad y ownership: `PASS`.
- Inactivos y sin precio: `PASS`.
- Legacy, incluida búsqueda: `PASS`.
- Alta y actualización automáticas: `PASS` con latencia de cola demostrada de `4,4-5,7 s` y detección configurada cada cinco minutos.
- Cola, tracking y alertas: `PASS`.
- Idempotencia sin datos nuevos: `PASS`.
- Ventas futuras: causa determinista de duplicado corregida; solo escribe la factura definitiva.
- Histórico ERP: `REVIEW`, sin cambios por seguridad.
- Estado global: **OPERATIVO, no `100%_SIGNED_OFF` hasta conciliar las siete discrepancias históricas o aceptar formalmente conservarlas**.
