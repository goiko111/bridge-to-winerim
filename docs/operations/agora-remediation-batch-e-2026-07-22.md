# Remediacion Agora batch E - 2026-07-22

## Alcance y garantias

Alcance exclusivo: El Porton de Sorni, Finca Eslava, El Higueron y
Tintorera.

- No se ha editado codigo compartido.
- No se han editado `PROJECT_CONTEXT.md`, `CURRENT_STATE.md`,
  `DECISIONS_LOG.md` ni `NEXT_STEPS.md`.
- Todas las escrituras se limitaron a datos/configuracion de cada conexion.
- Antes de escribir se ejecuto dry-run fresh, se guardo snapshot y se genero
  un rollback completo.
- No se crearon ventas ficticias, no se tocaron precios y no se modifico el
  historico cancelado de Winerim.
- Las ocultaciones aplicadas son reversibles y usan los flags originales
  guardados en el rollback.

Artefactos:

- Snapshot previo: `outputs/AGORA_REMEDIATION_BATCH_E_SNAPSHOT_2026-07-22T10-20-29-936Z.json`
- Dry-run: `outputs/AGORA_REMEDIATION_BATCH_E_DRY_RUN_2026-07-22T10-29-54-986Z.json`
- Plan aplicado: `outputs/AGORA_REMEDIATION_BATCH_E_APPLY_2026-07-22T10-30-20-672Z.json`
- Rollback previo a escrituras: `outputs/AGORA_REMEDIATION_BATCH_E_ROLLBACK_2026-07-22T10-30-20-672Z.json`
- Verificacion fresh final: `outputs/AGORA_REMEDIATION_BATCH_E_FRESH_VERIFICATION_2026-07-22T10-33-44-052Z.json`
- Dry-run de guardia provisional: `outputs/AGORA_REMEDIATION_BATCH_E_PROVISIONAL_GUARD_DRY_RUN_2026-07-22T10-39-19-827Z.json`
- Rollback de guardia provisional: `outputs/AGORA_REMEDIATION_BATCH_E_PROVISIONAL_GUARD_ROLLBACK_2026-07-22T10-39-44-924Z.json`
- Resultado de guardia provisional: `outputs/AGORA_REMEDIATION_BATCH_E_PROVISIONAL_GUARD_RESULT_2026-07-22T10-40-02-076Z.json`

## Invariante transversal de tickets abiertos

Las cuatro conexiones del lote quedan con la misma politica segura:

- `open_tickets_sync_enabled=true`: los tickets abiertos se leen para
  observabilidad y diagnostico.
- `open_tickets_stock_sync_enabled=false`: un ticket provisional no escribe
  stock ni historial comercial en Winerim.
- Stock e historial se escriben solo desde facturas cerradas/definitivas.

La razon es evitar que una misma consumicion aparezca una vez como ticket
provisional y otra como factura cerrada, o que una cancelacion deje un
historico irreversible.

Verificacion de la aplicacion:

| Conexion | Observacion open tickets | Escritura provisional | Cola antes/despues |
|---|---|---|---:|
| El Porton de Sorni | Activa | Desactivada | `0 -> 0` |
| Finca Eslava | Activa | Desactivada | `0 -> 0` |
| El Higueron | Activa | Desactivada | `0 -> 0` |
| Tintorera | Activa | Desactivada | `0 -> 0` |

El dry-run y el rollback adicional incluyen el `provider_config` completo de
las cuatro conexiones. La aplicacion no genero tareas outbound ni altero el
catalogo.

## Resultado ejecutivo

| Conexion | Catalogo fresh | Cambio aplicado | Estado al cierre |
|---|---:|---|---|
| El Porton de Sorni | `175/175` | 38 equivalencias exactas confirmadas y 38 productos sustituidos ocultos | Catalogo OK; pendiente revisar legacy vendido no inequívoco y aceptar la latencia sales-only |
| Finca Eslava | `123/123` | 43 botellas exactas confirmadas/ocultas; escritura provisional de stock desactivada | Catalogo OK; 24 copas genericas y 72 botellas no sustituidas conservadas |
| El Higueron | `287/292` generico; `292/292` funcional | Config duplicada normalizada; orden y botones especiales preservados; canaries preparados | Cinco aliases intencionales; alerta de ventas reconocida, no resuelta |
| Tintorera | `313/313` | Dos tareas `POS_DOWN` superseded cerradas; alerta de cola resuelta | Monitor OK; legacy preservado; pendiente primera venta real |

## El Porton de Sorni

### Dry-run y clasificacion

- Cobertura Winerim fresh: `175/175`, sin ausentes, diferencias ni productos
  Winerim sin ownership.
- Se localizaron 38 productos legacy con nombre normalizado exacto, un unico
  vino Winerim elegible y formato compatible.
- Solo esas 38 equivalencias se confirmaron. No se aplico matching fuzzy ni
  por parecido parcial.
- Se conservaron todos los productos genericos, ambiguos, de comida y bebida
  no vinicola.

Legacy vendido con equivalencia exacta:

| Producto Agora original | Cantidad observada | Sustituto Winerim | Accion |
|---|---:|---|---|
| A COROA LIAS | 2 | A Coroa Lias, botella | Mapping confirmado y producto original oculto |
| Copa DULCE DE INVIERNO | 4 | Dulce de Invierno, copa | Mapping confirmado y producto original oculto |

Legacy vendido sin equivalencia inequívoca, conservado visible/buscable:

- Copa Verdejo Javier Sanz: 30 unidades observadas.
- Copa Dominio de Basconcillos: 12.
- Copa de Chivite 125 Moscatel: 12.
- Copa Godello Triay Tres Mulleres: 9.
- Javier Sanz Verdejo: 8.
- Copa de cava y otras copas genericas o abreviadas: sin tocar.

La lista completa y las cantidades estan en el snapshot. Estos productos no
se ocultaron porque el nombre no permite demostrar una equivalencia unica.

### Latencia de copa

La latencia no procede del rate limiter ni de una caida de Agora. El ticket
abierto detecta la copa, pero las variantes revisadas tienen stock Winerim
desactivado. En ese caso el middleware usa el modo
`open_ticket_sales_only_deferred_to_invoice`: observa la linea provisional,
pero no crea un historico irreversible hasta disponer de factura definitiva.

Ejemplo: Marques de Murrieta, copa, fue detectado como ticket abierto y se
importo definitivamente al llegar la factura; la diferencia observada fue de
aproximadamente 64 minutos. Es el comportamiento seguro actual frente a
cancelaciones. La guardia transversal extiende ahora esa proteccion a todas
las variantes del lote: el ticket abierto se observa, pero cualquier escritura
queda reservada a la factura definitiva.

### Verificacion fresh

- 38 mappings `CONFIRMED`, metodo `MANUAL_EXACT_REVIEWED_BATCH_E`.
- 38 productos originales con `UseAsDirectSale=false` y
  `SaleableAsMain=false` verificados contra Agora.
- Catalogo Winerim posterior: `175/175`.

## Finca Eslava

### Dry-run y clasificacion de los 139 buscables

La estructura original contenia:

- 115 productos en `BOTELLA`.
- 24 productos en `COPA`.

Se demostraron 43 sustituciones exactas y univocas, todas de botella. Se
confirmaron los mappings y se ocultaron unicamente esos 43 productos
originales.

Entre los sustituidos con venta reciente estaban Bosque de Matasnos,
Emilio Moro, Matarromera, Pago de Carraovejas y Gross Rosado, con 16 unidades
observadas en conjunto.

Se conservaron buscables:

- Las 24 copas originales, incluidas `COPA TINTO`, `COPA BLANCO`,
  `COPA ESPUMOSO` y el resto de copas genericas/especificas no demostradas.
- Las 72 botellas originales restantes sin sustituto exacto confirmado.

Fresh posterior: familia `COPA` con `24/24` productos vendibles y familia
`BOTELLA` con `72/115` vendibles. Los 43 retirados son exactamente los 43
sustituidos.

### Neutralizacion provisional

- `open_tickets_sync_enabled=true`: se siguen observando tickets abiertos.
- `open_tickets_stock_sync_enabled=false`: los tickets abiertos no escriben
  stock ni historial provisional.
- Las facturas definitivas son la unica fuente para stock/historial.

No se modifico el historico cancelado de Emilio Moro ni ninguna tarjeta de
venta ya importada, porque no existe un identificador determinista de
cancelacion que permita corregirla sin riesgo.

### Verificacion fresh

- Catalogo Winerim: `123/123`.
- 43 mappings exactos confirmados.
- 43 productos sustituidos no vendibles.
- 24 copas legacy preservadas.
- La alerta `sales_stale` permanece abierta: el cursor definitivo continua
  en 2026-07-18. No se ha silenciado una alerta aun real.

## El Higueron

### Configuracion corregida

Se limpiaron las contradicciones entre columnas autoritativas y
`provider_config`:

- `auto_push_on_create=true`
- `auto_push_on_update=true`
- `auto_push_verified_ready=true`
- `catalog_write_enabled=true`
- politica legacy `HIDDEN_REVERSIBLE`

Se preservaron sin cambios las dos reglas particulares del cliente:

- `agora_product_sort_mode=ALPHABETICAL_WINE_NAME`
- `agora_product_button_text_mode=WINE_NAME_ONLY`

La aplicacion de la guardia provisional se volvio a verificar despues de esta
normalizacion y mantuvo ambas reglas exactamente iguales.

El auditor generico muestra `287/292`. Las cinco diferencias son solo
`BUTTONTEXT_MISMATCH` en los productos 782002, 782003, 852475, 781864 y
781865. Son aliases abreviados intencionales por limite de caracteres y
colisiones; nombre, precio, familia, orden y visibilidad coinciden. La
verificacion funcional especifica sigue siendo `292/292`.

### Monitor

La alerta `sales_stale` se dejo en `ACKED`, no en `RESOLVED`:

- Los tickets abiertos siguen avanzando y se observaron dias 2026-07-15 y
  2026-07-21.
- El cursor de factura definitiva permanece en 2026-07-14.

Actualizar artificialmente ese cursor podria saltarse facturas posteriores,
por lo que no se hizo. La alerta se resolvera solo cuando avance la fuente
definitiva.

### Canaries preparados

No hay actualmente una copa publicada con stock activo. Por eso el canary de
copa tambien valida el flujo sales-only.

| Canary | Winerim | Agora | Stock |
|---|---:|---:|---|
| Copa sales-only: Alfonso Oloroso | 282133 | 982133 | Desactivado |
| Botella sales-only: Almijara Jarel Moscatel Afrutado | 282123 | 782123 | Desactivado |
| Control con stock: Aalto botella | 281989 | 781989 | Activado |

Los tres quedaron registrados en la configuracion de la conexion, pero no se
genero ninguna venta artificial.

La lectura de tickets abiertos seguira mostrando la operativa del canary, pero
la comprobacion de stock/historial se hara al cerrar la factura.

## Tintorera

### Cola y alerta

Las dos tareas fallidas eran actualizaciones de los vinos 247843 y 247913 que
agotaron reintentos durante una caida `POS_DOWN` del 21 de julio. Antes de
cerrarlas se verifico fresh que el catalogo ya contenia el estado esperado:
`313/313`, sin diferencias ni ausentes.

Por convergencia demostrada se marcaron `SUCCESS` con la trazabilidad
`SUPERSEDED_CATALOG_ALREADY_MATCHES_AFTER_POS_RECOVERY`. La alerta de cola se
resolvio y se ejecuto de nuevo el monitor sin emails:

- estado `OK`;
- cero problemas activos;
- cero tareas antiguas/fallidas accionables.

### Catalogo, legacy y primera venta

- Catalogo fresh: `313/313`.
- El legacy no se oculto ni se modifico.
- Tickets abiertos en observacion y escritura provisional desactivada.
- Las 35 coincidencias exactas detectadas se mantuvieron como propuesta, sin
  mapping ni ocultacion, hasta validar sustitucion y operativa real.

Primera venta recomendada:

- Control con stock: `25 anni Sagrantino di Montefalco`, botella, Winerim
  248193, producto Agora 748193.
- Control sales-only opcional: `Alturis Pinot Nero`, copa, Winerim 273647,
  producto Agora 973647.

La conexion queda preparada, pero no se declara completa hasta que el cliente
marque la primera venta real y se contraste Agora frente al historial de
Winerim.

## Rollback

El rollback previo a las escrituras esta en:

`outputs/AGORA_REMEDIATION_BATCH_E_ROLLBACK_2026-07-22T10-30-20-672Z.json`

Contiene:

- flags originales de cada producto ocultado en Porton y Finca;
- mappings previos de esos productos;
- `provider_config` previo de Finca e Higueron;
- estados previos de alertas;
- las dos tareas fallidas originales de Tintorera.

El rollback complementario
`AGORA_REMEDIATION_BATCH_E_PROVISIONAL_GUARD_ROLLBACK_2026-07-22T10-39-44-924Z.json`
contiene el `provider_config` inmediatamente anterior a la guardia transversal
para las cuatro conexiones, junto con cola y alertas activas.

Secuencia de vuelta atras, si fuera necesaria:

1. Restaurar `UseAsDirectSale` y `SaleableAsMain` producto por producto con
   `set-product-visibility` y verificar fresh.
2. Eliminar los mappings del batch E que no existian en el snapshot y
   restaurar cualquier mapping previo incluido en el artefacto.
3. Restaurar el `provider_config` completo de Finca/Higueron.
4. Restaurar estado, error y metadata originales de tareas/alertas de
   Tintorera.
5. Repetir auditoria fresh y no continuar si aparece cualquier diferencia.

## Pendientes externos

1. Porton: revisar con el cliente las copas legacy vendidas que no tienen
   equivalencia exacta y decidir si se renombran/mapean.
2. Finca: validar visualmente los 43 sustituidos y decidir el tratamiento de
   las 24 copas y 72 botellas originales restantes.
3. Higueron: ejecutar los tres canaries y esperar avance de factura definitiva
   antes de resolver `sales_stale`.
4. Tintorera: ejecutar la primera venta real y comparar Agora, evento canonico
   e historial Winerim antes de ocultar cualquier legacy.
