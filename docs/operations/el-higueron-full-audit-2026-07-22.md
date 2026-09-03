# El Higueron - auditoria integral y ocultacion reversible de legacy

Fecha de cierre: 2026-07-22

Conexion: `c2e41778-fd14-4a83-9b24-d4fd305fe490`

## Resultado ejecutivo

El catalogo Winerim de El Higueron queda reconciliado con la politica especifica
de este restaurante: ocho familias Winerim, orden alfabetico por nombre de vino y
texto visible sin los prefijos tecnicos `B`, `C` o `M`.

El legacy de vino ha quedado oculto de forma reversible tanto en la navegacion
como en el buscador de Agora. No se ha borrado ningun producto ni familia y no se
han tocado productos no relacionados con vino, genericos o ambiguos.

Estado final: `OPERATIVA / CATALOGO_CORREGIDO / LEGACY_OCULTO / PENDIENTE_FIRMA_EXTERNA`.

No se declara `100%_SIGNED_OFF` porque, por seguridad, no se ha generado una
venta ficticia ni se ha cambiado un precio comercial para cerrar el checklist.
La venta real de botella, la idempotencia y una cancelacion ya tienen evidencia;
siguen sin evidencia nueva una venta real de copa y la comprobacion visual del
cliente tras ocultar el legacy.

## Evidencia de seguridad y vuelta atras

Antes de escribir en Agora se genero el snapshot completo:

- `outputs/EL_HIGUERON_FULL_AUDIT_ROLLBACK_2026-07-22.json`
- generado a las `2026-07-22T05:56:49.969Z`;
- incluye configuracion de la conexion, estado original de las siete familias
  legacy, flags originales de sus 396 productos y XML de presentacion de los
  292 formatos Winerim.

La ejecucion de ocultacion y su verificacion fresh quedaron registradas en:

- `outputs/EL_HIGUERON_LEGACY_HIDE_APPLIED_2026-07-22.json`
- aplicada a las `2026-07-22T06:12:43.237Z`;
- verificacion fresh de Agora a las `2026-07-22T06:12:34.867Z`.

El rollback consiste en restaurar desde el snapshot los flags originales de
producto y el XML original de cada familia/producto. No requiere borrar datos,
ventas, mappings ni trazabilidad.

## Checklist cerrado

| Control | Estado | Evidencia obtenida |
|---|---|---|
| Conectividad Agora | PASS | Lectura fresh completa sin warnings: 96 familias, 2.415 productos, 6 listas de precio, 13 centros de venta, 5 IVAs, 17 tipos de preparacion y 10 ordenes de preparacion. Breaker cerrado y cero fallos consecutivos en la configuracion auditada. |
| Conexion y escritura | PASS | Conexion activa, modo `BIDIRECTIONAL`, escritura `XML_IMPORT` y sincronizacion de catalogo habilitada. |
| Familias Winerim | PASS | Ocho familias Winerim configuradas y preservadas. |
| Variantes y ownership | PASS | 292 formatos elegibles, 292 presentes, 0 ausentes y 0 productos sin ownership. |
| Precio, IVA, familia, orden y visibilidad | PASS | Tras la reparacion no quedan diferencias fresh en esos campos. |
| Presentacion exclusiva | PASS | Normalizador especifico: `changed=0` y `duplicateVisibleLabels=[]` sobre 292 productos. Orden alfabetico estable y texto visible sin `B/C/M`. |
| Auditor generico | PASS CON EXCEPCION DOCUMENTADA | Devuelve `287/292` porque espera cinco `ButtonText` genericos incompatibles con el limite de 20 caracteres. Son alias intencionados, no diferencias funcionales. |
| Legacy en familias | PASS | Siete familias legacy verificadas con `ShowInPos=false`. |
| Legacy en buscador | PASS | Los 396 productos legacy se verificaron con `UseAsDirectSale=false` y `SaleableAsMain=false`; quedan 0 vendibles. |
| No-vino y ambiguos | PASS | No se tocaron familias ni productos fuera del alcance puro de vino legacy. |
| Cola | PASS | Cero tareas activas al terminar la intervencion. |
| Alertas | PASS | La evidencia de cierre disponible no muestra alertas abiertas o reconocidas para esta conexion. |
| Alta/cambio automatico | PASS MEDIDO | Canary comercial real previo: `Pago de Carraovejas El Anejon` aparecio en Agora en 61 segundos. |
| Ventas de botella | PASS | Venta real `Domaine Vacheron Sancerre Blanc`, factura Agora `14401`, registrada una sola vez en ERP con hora original y stock final verificado en 6. |
| Idempotencia | PASS | Cero claves exactas duplicadas y segunda ejecucion sin nueva venta. |
| Cancelaciones | PASS | `La Vieille Ferme Rose Recolte`: retirada de venta provisional y restauracion de stock mediante ajuste sin generar otra venta. |
| Venta real de copa | PENDIENTE EXTERNO | No se creo una venta artificial. Falta observar una copa real reciente desde `Copas Winerim`. |
| Stock inactivo | PENDIENTE EXTERNO | La politica esta configurada, pero no se fabrico un canary real adicional con stock desactivado. |
| Horas historicas | WARN DOCUMENTADO | Una venta conserva la hora exacta; en dos muestras antiguas se observaron desfases aproximados de 55 y 4 minutos. No se reescribio historial. |

## Catalogo corregido

La primera lectura fresh devolvia:

- `292` formatos elegibles;
- `282 MATCH`;
- `10 DIFFERENT`;
- `0 MISSING`;
- `0 UNOWNED`.

Se procesaron solo diferencias concluyentes de nombre/texto, con verificacion
fresh tras cada lote. La cola se dreno por completo.

La lectura final del auditor generico devuelve:

- `292` formatos elegibles y presentes;
- `287 MATCH`;
- `5` diferencias exclusivamente `BUTTONTEXT_MISMATCH`;
- `0 MISSING`;
- `0 UNOWNED`;
- ninguna diferencia de nombre tecnico, variante, precio, IVA, familia, orden
  o flags de venta.

Los cinco alias visibles preservados son:

- producto Agora `782002`: Conde de San Cristobal;
- producto Agora `782003`: Conde de San Cristobal Reserva Especial;
- producto Agora `852475`: Pago de Carraovejas El Anejon;
- producto Agora `781864`: Juve & Camps Milesime;
- producto Agora `781865`: Juve & Camps Milesime Rose.

No se forzaron los textos ingenuos del auditor porque el limite de Agora
provocaria truncados o colisiones, especialmente entre las dos referencias de
Juve & Camps. La autoridad para esta conexion es el normalizador de presentacion
especifico, cuya segunda pasada fresh fue idempotente: cero cambios pendientes y
cero etiquetas visibles duplicadas.

## Legacy ocultado

Alcance exacto:

| Familia Agora | Nombre | Productos legacy |
|---:|---|---:|
| 105 | VINO BLANCO | incluido en el total auditado |
| 106 | VINO POR COPAS | incluido en el total auditado |
| 107 | VINO ESPUMOSO | incluido en el total auditado |
| 108 | VINO GENEROSO | incluido en el total auditado |
| 109 | VINO ROSADO | incluido en el total auditado |
| 110 | VINO TINTO | incluido en el total auditado |
| 111 | VINO POSTRE | incluido en el total auditado |

Hechos:

- 396 productos legacy auditados;
- 326 seguian vendibles y se ocultaron;
- 70 ya estaban ocultos y no necesitaron escritura;
- 0 pertenecian a Winerim;
- 9 lotes aplicados y verificados: ocho de 40 productos y uno de 6;
- resultado fresh final: 0 productos legacy vendibles.

La ocultacion es deliberadamente reversible: se conservaron identificadores,
familias, nombres, precios, historico y XML. Esto elimina su aparicion en el
buscador sin destruir la posibilidad de volver atras.

## Automatizacion y latencia

La configuracion efectiva auditada mantiene:

- alta automatica de referencias: activa;
- actualizacion automatica diferencial: activa;
- catalogo: ciclo de 5 minutos;
- ventas intradia: ciclo de 5 minutos;
- tickets abiertos: activos, con antiguedad minima de 2 minutos;
- ventas y stock: zona horaria `Europe/Madrid`;
- stock: `PUT` cuando esta activo y `sales/import` cuando esta desactivado.

La latencia real demostrada de alta/cambio es 61 segundos para un canary
comercial inequívoco. Esa medida demuestra funcionamiento, no garantiza por si
sola que todas las ejecuciones futuras terminen antes de cinco minutos. Existe
evidencia historica de una cola excepcional mas lenta; por eso no se eleva la
medicion aislada a SLA absoluto.

Hay claves duplicadas antiguas dentro de `provider_config` que conservan valores
previos (`auto_push_on_create/update=false` y notas de legacy visible). Los
campos autoritativos de la conexion estan activos y el runtime real ya demostro
la publicacion automatica. No se reescribio ese metadato historico durante este
cierre para no ampliar el alcance ni alterar configuracion operativa sin una
migracion dedicada.

## Ventas, stock, horas y cancelaciones

Evidencia conservada:

- venta real de botella recibida desde Agora y visible en ERP una sola vez;
- `orderId` determinista e idempotencia verificada;
- stock de la variante correcta actualizado cuando estaba activo;
- cancelacion de ticket provisional compensada con ajuste de stock sin crear
  una segunda venta;
- restauracion stale endurecida para consultar IDs en lotes de 100 y fallar de
  forma cerrada ante errores de base de datos;
- facturas cerradas se mantienen como fuente autoritativa.

No se corrigieron retrospectivamente las horas de ventas antiguas con desfase,
porque hacerlo sin una fuente inequívoca podria falsear historial fiscal u
operativo. Tampoco se amplio la escritura provisional desde tickets abiertos:
la ultima evidencia mostraba que el endpoint respondia, pero podia devolver
tickets antiguos y lineas sin resolver.

## Cambios aplicados

1. Snapshot completo y reversible antes de cualquier escritura.
2. Reconciliacion diferencial del catalogo; ninguna publicacion masiva ciega.
3. Correccion de diferencias concluyentes de nombre/presentacion.
4. Verificacion de las 292 variantes bajo la politica especifica de El
   Higueron.
5. Ocultacion reversible de 326 productos legacy que seguian vendibles.
6. Verificacion fresh de las siete familias y los 396 productos legacy.
7. Drenaje de la cola hasta cero tareas activas.

## Aspectos dejados sin tocar por seguridad

- No se cambio ningun precio comercial para fabricar un canary.
- No se genero ninguna venta ficticia de botella, copa o magnum.
- No se modificaron productos no-vino, genericos o ambiguos.
- No se borraron familias, productos, mappings, ventas, logs ni trazabilidad.
- No se reescribieron horas historicas con desfase.
- No se forzaron cinco textos de boton que provocarian colisiones o peor
  legibilidad en Agora.
- No se cambio el estado a `100%_SIGNED_OFF` sin prueba real de copa y
  confirmacion visual del cliente.

## Estado final

**Catalogo activo Winerim:** PASS bajo la politica configurada de El Higueron.

**Presentacion:** PASS, alfabetica y sin prefijos `B/C/M` en el texto visible.

**Legacy:** PASS, oculto en familias y productos, reversible y fuera del
buscador.

**Automatizacion:** OPERATIVA; canary real medido en 61 segundos y ciclos de 5
minutos configurados.

**Ventas:** OPERATIVAS para botella, con idempotencia, stock y cancelacion
demostrados. Copa real, stock inactivo y confirmacion visual quedan como
validaciones externas, no como correcciones tecnicas pendientes ejecutables sin
actividad del cliente.

**Firma global:** `PENDIENTE_FIRMA_EXTERNA`, sin bloqueos tecnicos conocidos en
el catalogo ni en la cola.
