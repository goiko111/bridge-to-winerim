# Auditoría completa de Chiquilla

Fecha de cierre: 2026-07-22
Conexión: Chiquilla · Agora
ERP Winerim: menú `140`
Resultado final: **OPERATIVA CON UNA EXCEPCIÓN DOCUMENTAL EN CANCELACIONES**

## Alcance y criterio de seguridad

Se revisaron conectividad, configuración automática, catálogo, mapeos,
visibilidad, ventas, stock, idempotencia, colas y alertas. La comprobación se
cerró con la evidencia disponible, sin crear productos de prueba, modificar
precios comerciales ni esperar nuevos canaries del cliente.

No se realizó ninguna escritura en Agora, Winerim ni Lovable Cloud durante
este cierre. Por tanto, no fue necesario ejecutar rollback. La venta cancelada
que continúa como positiva en el historial no se tocó porque no quedó
identificado de forma inequívoca el documento original y el endpoint disponible
no permite eliminar o anular esa tarjeta de manera idempotente.

## Resumen ejecutivo

- La conexión está activa y el panel la clasifica como `Healthy`.
- Cadencia configurada: `5 min`.
- Última sincronización observada: `2026-07-22 07:50:16`.
- Último día comercial procesado: `2026-07-21`.
- Cola viva: `0 QUEUED`, `0 RUNNING`, `0 BLOCKED` y `0 FAILED` en 24 horas.
- Fallos consecutivos: `0`.
- El último error visible, `[POS_DOWN] AbortError`, es histórico: no tiene
  contador vivo ni breaker asociado en el momento de la revisión.
- Catálogo: `73` vinos Winerim, `86` formatos confirmados y `0` pendientes de
  revisión. El asistente muestra además `82` productos verificados en Agora.
  Son contadores de entidades distintas, no una prueba de productos perdidos.
- La última auditoría fresh previa, del 2026-07-21, validó `75/75` productos
  elegibles y confirmó que los `9` formatos retirados ya no eran vendibles.
- Legacy: ocultación reversible aplicada a familia y producto; evidencia
  operativa previa: `0` familias legacy visibles y `0` productos legacy
  vendibles. No se borró ningún registro.
- Propagación Winerim -> Agora demostrada anteriormente sobre `34` formatos:
  entre `0,9` y `3,5 min`, dentro del SLA de cinco minutos.
- El ERP muestra ventas reales con fuente `TPV`, formato y hora de venta para
  botella y copa hasta el 2026-07-21.
- Idempotencia actual: `PASS`; no se detectaron claves `SUCCESS` duplicadas en
  la auditoría de ledger. Existe deuda histórica de conciliación en `5`
  `stockId`, que no equivale automáticamente a duplicados.

## Checklist

| Control | Estado | Evidencia y conclusión |
|---|---|---|
| Conectividad | PASS | Conexión activa, `Healthy`, sin fallos vivos ni breaker. |
| Cadencia | PASS | Cron configurado cada `5 min`. |
| Autoalta | PASS | `Auto-push on Create` habilitado. |
| Actualización | PASS | `Auto-push on Update` habilitado. |
| Variantes | PASS | Escritura de botella y copa habilitada; `86` formatos confirmados. |
| Catálogo fresh | PASS con observación UI | Auditoría fresh previa `75/75`; asistente actual: `82 verified`, `73` vinos y `86` formatos. Los contadores no miden la misma unidad. |
| Precio, IVA y familia | PASS operativo | Sin tareas diferenciales pendientes ni fallos vivos. La reconciliación previa dejó el catálogo elegible alineado. |
| Orden | PASS según última auditoría fresh | No se lanzó una nueva escritura ni se alteró el orden en este cierre. |
| Ownership | PASS | `86` formatos confirmados y `0` pendientes/rechazados. |
| Inactivos o sin precio | PASS en Agora | Los `9` formatos retirados ya no son vendibles. Su tracking conserva estado `VERIFIED`, una inconsistencia de metadatos sin impacto de venta. |
| Legacy familia | PASS | Oculto reversiblemente con `ShowInPos=false`. |
| Legacy producto/buscador | PASS por flags de producto | Oculto con `UseAsDirectSale=false` y `SaleableAsMain=false`; no se borró. |
| Alta/cambio Winerim -> Agora | PASS | Evidencia real sobre `34` formatos; latencia `0,9–3,5 min`. |
| Ventas ERP | PASS | Historial `erp/140/sales` con fuente `TPV`, botella y copa, y hora real. |
| Hora de venta | PASS para ventas recientes | Ejemplos: Asúa Crianza `21/07 14:55` y `15:25`; ventas de copa el `18/07` entre `14:03` y `15:04`. |
| Stock activo | PASS de flujo | La integración de tickets abiertos y mutación de stock está habilitada; la variante se conserva. |
| Stock inactivo / sales-only | PASS de flujo | Se registra la venta mediante importación y se omite solo la mutación de stock. |
| Idempotencia | PASS | Sin claves de éxito duplicadas en la auditoría del ledger. |
| Cancelaciones | WARN | El stock puede restaurarse una sola vez mediante clave de reversión, pero una tarjeta positiva ya importada no puede eliminarse con seguridad con la API actual. |
| Cola y tracking | PASS con deuda menor | Cola vacía. Queda por normalizar el tracking de los `9` retirados de `VERIFIED` a estado oculto; no exige reescritura en Agora. |
| Alertas | PASS operativo / WARN UI | `0` críticas, `0` errores y `0` warnings vivos. La vista de alertas muestra `LAST CHECK Never`, por lo que su indicador de ejecución no debe usarse como única evidencia. |

## Ventas verificadas en el ERP

La vista real del ERP de Chiquilla muestra, entre otras, estas entradas `TPV`:

- `2026-07-21`: dos botellas de Asúa Crianza, a las `14:55` y `15:25`.
- `2026-07-20`: tres botellas y una copa, con horas entre `15:45` y `21:05`.
- `2026-07-18`: seis copas repartidas entre cuatro referencias, con horas
  `14:03`, `14:14`, `14:30` y `15:04`.
- `2026-07-17`: una botella y cuatro copas con hora real.

Esto demuestra recepción de botellas y copas, fuente `TPV` y conservación de
hora. La tabla global de stock del monitor solo expone las últimas entradas de
toda la flota; Chiquilla no estaba dentro de esa ventana, por lo que esa tabla
no se usó para negar ventas ya visibles en el ERP.

## Cancelación diagnosticada

### Hecho

Existe una venta cancelada que continúa visible como positiva en el historial
ERP. El runtime actual sí dispone de restauración idempotente para tickets
provisionales cancelados o desaparecidos:

- crea una clave de reversión estable por conexión, línea y cantidad;
- restaura el stock una sola vez cuando el stock está activo;
- registra el caso sin mutar inventario cuando el stock está inactivo.

### Riesgo

La API de ventas disponible no ofrece una operación documentada e idempotente
para anular o eliminar una tarjeta positiva ya importada. Crear una venta
negativa artificial o pulsar `Anular venta` sin conocer el documento Agora
exacto podría reponer stock por segunda vez o anular otra venta legítima.

### Decisión

No se modificó la venta. La corrección queda limitada a la parte inequívoca e
idempotente: impedir una segunda mutación de stock mediante la clave de
reversión existente. Para retirar la tarjeta histórica será necesario disponer
de una identidad completa y comprobada: `connection_id`, documento Agora,
línea, formato, cantidad, hora, `saleId` ERP y efecto de stock ya aplicado.

### Snapshot y rollback

No aplica en esta ejecución: no hubo escritura. La evidencia de estado previa
a cualquier corrección futura es este informe más la tarjeta ERP y el ledger de
reversión. Una futura reparación deberá guardar primero esas filas exactas y
definir el movimiento inverso antes de ejecutarse.

## Correcciones vigentes comprobadas

1. Legacy oculto de forma reversible tanto en familia como en producto.
2. Catálogo elegible reconciliado; retirados o sin precio no siguen vendibles.
3. Autoalta y autoactualización activas para botella y copa.
4. Mapeo sin pendientes: `86` confirmados, `0` pendientes y `0` rechazados.
5. Cola limpia y sin fallos vivos en las últimas 24 horas.
6. Ventas `TPV` con formato y hora visibles en el ERP.
7. Protección idempotente activa para ventas y restauraciones de tickets.

## Estado final

Chiquilla queda **operativa para catálogo y ventas**, con SLA de publicación
demostrado dentro de cinco minutos y sin cola ni error activo. No se firma como
`100%_SIGNED_OFF` únicamente por la tarjeta positiva de una cancelación ya
importada y por la inconsistencia de metadatos de tracking de los nueve formatos
retirados. Ninguna de esas dos observaciones hace que el legacy vuelva a ser
vendible ni bloquea las ventas nuevas.

No se modificaron `PROJECT_CONTEXT.md`, `CURRENT_STATE.md`, `DECISIONS_LOG.md`
ni `NEXT_STEPS.md`.

## Addendum operativo posterior - 2026-07-22 08:44 CEST

Una segunda comprobacion independiente, ejecutada despues del cierre anterior,
detecto una incidencia nueva y posterior a aquella fotografia:

- la cola activa sigue vacia: `0 QUEUED` y `0 RUNNING`;
- no hay breaker abierto y `consecutive_failures=0`;
- existe una tarea `AGORA_XML_UPSERT_PRODUCT` fallida el 2026-07-22 a las
  `06:28 UTC` para el vino Winerim `139811`, con
  `[POS_DOWN] AbortError: The signal has been aborted`;
- diez de los once vinos presentes en los fallos historicos revisados tienen
  una tarea `SUCCESS` posterior al fallo correspondiente;
- la portada del servidor Agora responde desde red local con HTTP 200, pero
  tanto `/api/export/` como `/api/export-master/?filter=Products` agotan un
  timeout de 20 segundos;
- la sonda desde Lovable Cloud tambien termina por timeout, por lo que no fue
  posible completar una lectura fresh nueva del catalogo.

El estado operativo queda temporalmente degradado a
`WARN_AGORA_HTTP_API_TIMEOUT`: no hay backlog que drenar ni una correccion
segura que ejecutar desde el middleware mientras la API HTTP no responda. No
se reencolo la tarea fallida para evitar carga repetida sobre el servidor. En
cuanto la API se recupere se debe repetir la lectura fresh y reconciliar solo
el vino `139811` si sigue existiendo una diferencia real.
