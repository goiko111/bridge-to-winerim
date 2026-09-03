# De la O - auditoria integral y cierre operativo

Fecha: 2026-07-22

Conexion: `99f3a782-844f-4515-a570-662a111ced2e`

Estado final: `LIVE / WARN_LEGACY_AND_CANCELLATION_CANARY`

Esta auditoria no modifica `PROJECT_CONTEXT.md`, `CURRENT_STATE.md`,
`DECISIONS_LOG.md` ni `NEXT_STEPS.md`.

## Resumen ejecutivo

De la O esta conectado, con sincronizacion bidireccional habilitada y cadencia de
cinco minutos. Tras una indisponibilidad temporal del servidor Agora, el circuit
breaker y la cola se recuperaron automaticamente. La lectura fresh posterior
confirmo `119/119 MATCH`: no hay formatos Winerim ausentes, diferentes ni sin
ownership en el catalogo Agora esperado.

No se cambiaron precios comerciales, no se crearon productos de prueba, no se
oculto legacy y no se modificaron datos operativos para fabricar un resultado.

No se firma todavia `100%_SIGNED_OFF` por dos motivos:

1. El legacy sigue operativo por decision del piloto y existe evidencia de ventas
   recientes desde botones legacy.
2. Hay evidencia de ventas, stock y devoluciones en el middleware, pero no se
   completo en esta ejecucion un nuevo canary externo de cancelacion contra la
   pantalla ERP. Se conserva, por tanto, el riesgo conocido de reconciliacion entre
   tickets abiertos, factura definitiva y anulacion.

## 1. Conectividad y resiliencia

### Evidencia

- La primera sonda del 2026-07-22 devolvio `NETWORK_UNREACHABLE / No route to
  host` contra el servidor Agora.
- El breaker se abrio despues de ocho fallos consecutivos y habia 29 tareas de
  producto pendientes.
- Sin intervencion manual, Agora volvio a responder aproximadamente diez minutos
  despues.
- El breaker quedo limpio y la cola empezo a drenarse: `29 -> 26 -> 6` tareas
  activas en las observaciones realizadas.
- A las `2026-07-22T06:10:04Z`, con seis tareas todavia en drenaje, el catalogo
  fresh ya devolvia `119/119 MATCH`.

### Resultado

`PASS` para recuperacion automatica y consistencia final del catalogo.

`WARN` operativo hasta observar la cola en cero en una revision posterior. No se
eliminaron ni marcaron tareas manualmente porque el sistema estaba procesandolas y
el catalogo ya era exacto.

### Causa

La causa observada fue externa al codigo de catalogo: el servidor Agora no tenia
ruta de red temporalmente. No se encontro una diferencia determinista de producto
que exigiera reescritura.

## 2. Catalogo Winerim y Agora

### Winerim

- 117 vinos cacheados.
- 106 vinos activos y 11 inactivos.
- 119 formatos elegibles para Agora:
  - 90 botellas.
  - 29 copas.
  - 0 magnum.
- Ningun formato elegible carece del `stockId` de su variante.

### Agora fresh

- Esperados: 119.
- Coinciden exactamente: 119.
- Ausentes: 0.
- Diferentes: 0.
- Existentes sin ownership: 0.

La comparacion fresh cubre existencia, formato, nombre/boton, precio, IVA,
familia, orden, visibilidad y los flags de venta esperados por el middleware.

### Familias Winerim

Las familias configuradas siguen siendo:

| ID | Familia | Visibilidad actual |
|---|---|---|
| `900157` | TINTOS WINERIM | Visible |
| `901954` | COPAS WINERIM | Visible |
| `903516` | ROSADOS WINERIM | Visible |
| `903925` | DULCE WINERIM | Visible |
| `904241` | BLANCOS WINERIM | Visible |
| `904289` | MAGNUM WINERIM | Oculta; sin formatos elegibles |
| `908182` | FORTIFICADOS WINERIM | Visible |
| `908875` | ESPUMOSOS WINERIM | Visible |

### Ownership e inactivos

- 139 mappings `CONFIRMED`: 109 botella y 30 copa.
- 139 registros de tracking: 119 `VERIFIED` y 20 `HIDDEN`.
- No hay errores de mapping ni tracking registrados.

Los 119 formatos actualmente publicables estan exactos. Los 20 formatos retirados
constan como `HIDDEN`; no se forzo una republicacion global de ocultaciones durante
el cierre porque el usuario pidio no ampliar el alcance ni esperar nuevos canaries.

Resultado: `PASS` para el catalogo activo y `WARN` de verificacion fisica diferida
para el conjunto historico oculto.

## 3. Automatizacion y latencia demostrada

### Configuracion

- Conexion habilitada.
- Modo `BIDIRECTIONAL`.
- Escritura `XML_IMPORT`.
- Frecuencia: cinco minutos.
- `auto_push_on_create=true`.
- `auto_push_on_update=true`.
- `auto_push_verified_ready=true`.
- Sin breaker abierto al finalizar la lectura fresh.

### Altas reales recientes

Se usaron altas reales, sin crear canaries artificiales:

| Vino | Formato | Visto en Winerim | Verificado en Agora | Latencia extremo a extremo |
|---|---|---:|---:|---:|
| Cepa Bosquet Tinto Dulce | Copa | 18:21:43Z | 18:22:15Z | 32,4 s |
| Memorias Mistela Tinta | Botella/copa | 16:11:02Z | 16:11:36Z | 33,9 s |
| Sauci Crianza | Copa | 10:00:13Z | 10:01:06Z | 53,1 s |

Tambien existe una tarea real de alta de botella verificada 11,4 segundos despues
de ser encolada.

### Cambios

La actualizacion de Fortuny Fabregas Brut Alex quedo verificada aproximadamente
11,5 segundos despues de crearse la tarea `AUTO_UPDATE`. Esto demuestra el tiempo
de ejecucion de la cola, pero no permite afirmar una latencia extremo a extremo del
cambio de precio porque no existe un timestamp independiente del instante exacto
en que el usuario guardo el cambio en Winerim.

Resultado: `PASS` para altas reales dentro del SLA de cinco minutos. `PASS` para
procesamiento de updates; la medicion estricta de extremo a extremo de un cambio
de precio queda sin firmar.

## 4. Ventas, stock e historial

### Evidencia del middleware desde el 15 de julio

- 139 eventos de venta:
  - 80 `OpenTicket`.
  - 57 `BasicInvoice`.
  - 2 `BasicRefund`.
- 23 operaciones de sincronizacion de venta/stock:
  - 17 `SUCCESS`.
  - 6 `SKIPPED`.
- Hay ventas reales recientes de botella y copa procesadas desde tickets abiertos.
- El flujo distingue stock activo de `sales-only`: si la variante tiene stock activo
  actualiza el stock absoluto; si no lo tiene, registra la venta mediante el endpoint
  de importacion sin forzar stock.
- La clave de idempotencia evita volver a aplicar una misma linea/evento.

### Riesgos conocidos

- `Viña Mein Val Do Avia`: una revision anterior encontro una unidad neta en Agora
  y dos en ERP por una cancelacion historica que no retiro la venta positiva.
- `Camarolos`: Agora tenia dos unidades y ERP una porque la venta supero el stock
  disponible. El middleware global ya incorpora el registro `sales-only` del
  residual no cubierto por stock, pero ese caso historico no se reescribio.
- El stock provisional de tickets abiertos puede requerir compensacion cuando el
  documento se cancela antes de convertirse en factura. En esta auditoria no se
  genero una cancelacion real nueva para validar el ciclo completo.

Resultado: `PASS` para recepcion de ventas de botella/copa, stock y `sales-only`.
`WARN` para firma final de cancelaciones y conciliacion historica ERP.

## 5. Legacy y buscador

El legacy se mantuvo sin cambios, tal como exige el piloto.

- No se ocultaron familias legacy.
- No se desactivaron productos legacy.
- No se cambiaron flags de venta de productos legacy.
- Existe evidencia del 16 al 18 de julio de al menos 56 unidades y 454,50 EUR
  vendidas desde 14 botones legacy.

Una familia oculta no garantiza que sus productos desaparezcan del buscador. Un
producto legacy con `SaleableAsMain=true` o `UseAsDirectSale=true` puede seguir
siendo localizable y vendible aunque su familia no aparezca en la raiz. Por ello,
una futura retirada debe hacerse de forma reversible tanto a nivel de familia como
de producto y solo despues de confirmar que todo el uso real ha migrado a los
botones Winerim.

Resultado: `WARN_LEGACY_ACTIVE`, esperado y deliberado. No es un fallo accidental.

## 6. VINOS > TINTOS WINERIM > producto

### Familias y categorias no son lo mismo

La Guia del Integrador documenta jerarquia de familias mediante
`ParentFamilyId`. Tambien documenta `ShowInPos` y `Order`, y el middleware ya
soporta `familyParentId` al generar el XML de una familia.

Por tanto, la ruta de tres niveles puede construirse de forma soportada como:

1. Familia padre `VINOS`.
2. Subfamilias `TINTOS WINERIM`, `BLANCOS WINERIM`, etc. con
   `ParentFamilyId=<id de VINOS>`.
3. Productos dentro de cada subfamilia.

Esto es jerarquia de **familias**, no una categoria padre.

Agora tiene ademas categorias, y la API permite filtrar productos por un ID de
categoria conocido mediante `where-product-category-id`. Sin embargo, la guia no
incluye `Categories` entre los maestros importables/exportables. Ese filtro no
permite descubrir, crear ni mantener categorias o sus asociaciones.

### Recomendacion

- Para De la O, la opcion automatizable y documentada es una familia padre `VINOS`
  con las familias Winerim como subfamilias.
- No se aplico durante esta auditoria para no alterar la pantalla de venta del
  piloto.
- Antes de activarla debe hacerse un piloto con una subfamilia y comprobar en el
  modelo/version de terminal que la navegacion efectiva es
  `VINOS > TINTOS WINERIM > producto` y que el buscador sigue mostrando los
  productos correctamente.
- Si el cliente exige categorias en lugar de familias, el SAT debe proporcionar un
  mecanismo oficial soportado para crearlas y mantener sus asociaciones. No se
  usaran endpoints administrativos no documentados.

## 7. Cambios realizados y cambios evitados

### Corregido o recuperado

- La conexion salio del breaker de forma automatica al volver Agora.
- La cola reanudo su procesamiento sin reset manual.
- El catalogo quedo validado fresh en `119/119 MATCH` durante el drenaje.
- Se confirmaron flags, cadencia, mappings, tracking, variantes y stockIds.
- Se obtuvo evidencia real de altas Winerim -> Agora con latencia inferior a un
  minuto.
- Se determino la solucion soportada para la navegacion jerarquica usando
  `ParentFamilyId`.

### No tocado por seguridad

- Precios comerciales.
- Productos o vinos de prueba.
- Legacy, tanto familia como producto.
- Estado de tareas pendientes mediante SQL o cambios manuales.
- Metadato `activation_status`, que sigue en `LIVE_PENDING_SALE_CANARY`; no se
  promociona a `100%_SIGNED_OFF` mientras existan los avisos anteriores.
- Jerarquia de familias en la pantalla de venta.
- Ventas historicas y compensaciones manuales de cancelaciones.

## 8. Estado final

| Area | Estado |
|---|---|
| Conectividad actual | PASS |
| Recuperacion tras caida | PASS |
| Catalogo activo fresh | PASS - 119/119 |
| Variantes, precio, IVA, familia, orden y visibilidad | PASS |
| Ownership | PASS |
| Inactivos/sin precio | WARN - tracking oculto correcto, sin canary fisico nuevo |
| Alta automatica | PASS - 32,4 a 53,1 s demostrados |
| Cambio automatico | PASS de cola; latencia extremo a extremo no firmada |
| Ventas botella/copa | PASS |
| Stock activo y sales-only | PASS |
| Idempotencia | PASS de mecanismo |
| Cancelaciones | WARN - falta canary externo nuevo y queda discrepancia historica |
| Cola | WARN - drenando; ultima observacion: 6 activas |
| Legacy/buscador | WARN deliberado - legacy preservado y usado |
| Navegacion padre VINOS | VIABLE como familia padre; no aplicada |

Conclusion: De la O esta operativo en `LIVE`, con catalogo exacto y automatizacion
demostrada. No debe declararse todavia al 100% mientras el legacy siga en uso y no
se cierre el canary de cancelacion/ERP. La indisponibilidad observada se recupero
sola y no dejo deriva de catalogo.
