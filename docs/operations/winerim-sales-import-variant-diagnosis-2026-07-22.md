# Diagnostico de variante en Winerim `sales/import` - Vinatea

Fecha: `2026-07-22`

Conexion Vinatea: `e465872a-bff5-43de-8e4c-fe4986f0fd4f`

Alcance: investigacion de solo lectura del caso en que ventas Agora de copa,
mapeadas como `GLASS` y enviadas con stock IDs de copa, fueron descritas en una
auditoria anterior como botellas en el historial ERP de Winerim. No se han
creado ventas, repetido imports, modificado datos, desplegado codigo ni alterado
los documentos de sesion.

## Resultado ejecutivo

La evidencia disponible descarta como causa primaria el formato leido de Agora,
el mapping de producto, la seleccion de `stockId` en el middleware y la forma
documentada del payload. Los cinco productos se resuelven como `COPA/copa`, los
mappings son `CONFIRMED/GLASS` y los cinco IDs enviados pertenecen a filas
Winerim cuya variante es `copa`.

El contrato de `POST /api/v2/sales/import` no admite un campo `variant`: la
variante se expresa implicitamente mediante `stockId`. Por tanto, enviar solo
`stockId`, `qty`, `soldAt` y `orderId` es correcto conforme a la documentacion.

La observacion historica apunta a un defecto posterior a la peticion, dentro de
Winerim: resolucion/persistencia de la variante o serializacion/renderizado del
historial. Sin embargo, el defecto **no es reproducible hoy**: la lectura actual
de `https://app.winerim.com/erp/579/sales?p=1` solo muestra dos ventas de abril
de 2025 de `Greda Vermut Negre`, ambas como botella; las nueve tarjetas de julio
de 2026 citadas en el checklist ya no aparecen. Sin logs internos o filas de
auditoria de Winerim no se puede distinguir con rigor entre persistencia
incorrecta, read model/UI incorrecto, eliminacion posterior de las tarjetas o
una observacion visual anterior equivocada.

Diagnostico final:

- **No es un defecto demostrado del payload ni del mapping del middleware.**
- **Es una incidencia Winerim-side sospechada, pero actualmente no
  reproducible y no localizada entre persistencia y presentacion.**
- La afirmacion previa "Winerim persiste/renderiza copa como botella" debe
  conservarse como hipotesis fuerte historica, no como hecho vigente probado.

## Fuentes inspeccionadas

- `AGENTS.md` y los cuatro documentos de sesion del repositorio.
- `/Users/GOIKO/Downloads/API_TOKEN_V2_DOCUMENTATION.html`, seccion
  `Sales Import`, lineas 975-1087.
- `docs/operations/vinatea-100-percent-checklist-2026-07-20.md`.
- `docs/operations/agora-remediation-batch-d-2026-07-22.md`.
- `supabase/functions/agora-proxy/index.ts`, especialmente lineas 1058-1127 y
  2441-2564.
- `supabase/functions/_shared/stockSyncUtils.ts`, lineas 1-63.
- Snapshots de solo lectura de `product_mappings`, `sales_line_items`,
  `stock_sync_log` y catalogo Winerim utilizados durante la auditoria.
- Historial ERP actual de la entidad Winerim `579`, inspeccionado en modo lectura.
- Registro de la sesion operativa del 20/21 de julio. El registro conserva los
  totales de respuesta y metadatos de stock, pero no un artefacto durable con el
  cuerpo completo de cada una de las nueve peticiones y respuestas.

## Evidencia exacta de mapping y variante

Los cinco mappings relevantes estaban `CONFIRMED`, con
`match_method=LEGACY_EXACT_20260720` y `format_type=GLASS`:

| Agora | Producto Agora | Winerim | Vino Winerim | Glass stock ID | Bottle stock ID |
|---:|---|---:|---|---:|---:|
| `1153` | `COPA DE VILLARRICA` | `145575` | `Senorio de Villarrica Crianza` | `232130` | `169719` |
| `1154` | `COPA DE LAS PIZARRAS` | `202269` | `Las Pizarras` | `232231` | `232232` |
| `1155` | `COPA DE ARABARTE` | `198563` | `Arabarte Joven Maceracion Carbonica` | `228121` | `228122` |
| `1156` | `COPA DE MELIOR VERDEJO` | `198559` | `Melior Verdejo` | `228114` | `228115` |
| `1157` | `COPA DE REBELS DE BATEA BLANCO` | `198558` | `Rebels de Batea Blanc` | `232129` | `228113` |

Para las cinco referencias:

- las lineas canonicas de `sales_line_items` usan `format=COPA` y
  `mapped=true`;
- el catalogo Winerim identifica las filas de stock indicadas como
  `variant=copa`;
- las filas de copa tienen `stockActive=false` y stock `0` en el snapshot;
- los IDs de copa y botella son distintos, por lo que no existe colision de ID;
- el checklist registra nueve lineas, cantidad total `16`, primera pasada
  `9 imported / 0 failed`, segunda pasada `0 imported / 9 skipped / 0 failed`
  y stock sin cambios.

Existe una carencia de trazabilidad secundaria: algunas lineas canonicas
conservan `winerim_wine_id=null` aunque `mapped=true`. La resolucion usada en
este caso procede de `product_mappings`, que contiene las cinco decisiones
explicitas. Esto no explica la conversion copa-botella, pero conviene que futuras
lineas persistan tambien el vino y la variante resueltos para que una auditoria
no dependa del estado posterior del mapping.

## Contrato y payload

La documentacion oficial define el body por linea como:

```json
{
  "stockId": 232130,
  "qty": 1,
  "soldAt": "2026-07-16T...",
  "orderId": "..."
}
```

Puntos relevantes del contrato:

1. `stockId` es el ID de stock de la **variante vendida**.
2. No existe un campo `variant` en la peticion.
3. `qty` debe ser entero positivo.
4. `soldAt` debe ser una fecha o datetime ISO-8601 no futuro.
5. La idempotencia se resuelve por `orderId + variant`.
6. El endpoint no modifica stock.
7. La respuesta documentada repite `stockId`, `qty`, `soldAt`, `orderId` y
   estado, pero no devuelve `wineId`, variante resuelta, ID de venta persistida
   ni representacion final del historial.

El middleware construye exactamente esos cuatro campos en
`importWinerimSalesOnly`. Antes de llamar al endpoint:

- normaliza la fila de `GET /stock/wine/{wineId}` a `copa`, `botella` o
  `magnum`;
- selecciona con `.find(stock => stock.variant === claim.variant)`;
- para el claim `copa`, pasa `match.id` a `sales/import`;
- incluye la variante en el `orderId`, aunque no la envia como campo separado.

No se debe intentar corregir este caso anadiendo un campo `variant` no
documentado ni sustituyendo el stock ID de copa por el de botella. Eso rompe el
contrato y ocultaria el defecto real.

## Veredicto por capa

| Capa | Veredicto | Evidencia |
|---|---|---|
| Lectura Agora | Descartada | Los cinco productos son botones `COPA DE ...`; las lineas canonicas conservan `COPA`. |
| Data mapping | Descartada como causa | Cinco mappings explicitos `CONFIRMED/GLASS` hacia los vinos correctos. |
| Seleccion de stock ID | Descartada | Los IDs enviados son los IDs de las filas `variant=copa`, distintos de botella. |
| Construccion del payload | Conforme al contrato | Se envian los cuatro campos documentados; no existe `variant` separado. |
| Contrato API | Funcional pero insuficientemente observable | La variante es implicita y la respuesta no confirma la variante ni la venta persistida. |
| Persistencia Winerim | Posible causa | Una resolucion interna incorrecta de `stockId` podria persistir botella o perder `qty/soldAt`; no hay acceso a la fila interna para confirmarlo. |
| Read model/render ERP | Posible causa | Una venta persistida como copa podria mostrarse con fallback `botella` o cantidad `1`; no hay endpoint de lectura que exponga la fila persistida. |
| Estado actual | No reproducible | Las nueve tarjetas auditadas anteriormente ya no estan en el historial de la entidad `579`. |

## Limitaciones de evidencia

No existe hoy un artefacto durable que contenga, linea por linea, los nueve
bodies historicos y las respuestas completas. El checklist conserva los cinco
stock IDs, cantidad agregada, contadores de dos pasadas y ausencia de cambios de
stock. Los logs actuales de `stock_sync_log` solo conservan entradas posteriores
de tickets abiertos diferidos, con `variant=copa` y stock IDs de copa; esas
entradas no llamaron a `sales/import` y no sirven para reconstruir el import
historico.

La desaparicion actual de las nueve tarjetas impide verificar si:

- fueron canceladas o eliminadas despues;
- la vista anterior correspondia a un read model temporal o cacheado;
- la variante se persistio mal;
- la variante se persistio bien y solo se renderizo mal;
- la observacion anterior se hizo sobre otra agrupacion o contexto de UI.

Por ello no es seguro reparar datos existentes ni repetir el import en
produccion para obtener mas evidencia.

## Ubicacion mas segura de la correccion

La primera correccion debe hacerse en el backend Winerim que implementa
`POST /api/v2/sales/import`, no en el proxy Agora:

1. Resolver `stockId` a una fila de stock y a su `winePrice.variant` dentro de
   la misma transaccion.
2. Persistir explicitamente `wineId`, `stockId`, `variant`, `qty`, `soldAt` y
   `orderId` en la venta o en su linea inmutable.
3. Hacer fallar la linea si el stock no tiene una variante canonica resoluble;
   nunca usar `botella` como fallback silencioso.
4. Devolver por cada linea importada `saleId`, `wineId`, `stockId`,
   `resolvedVariant`, `storedQty` y `storedSoldAt`.
5. Leer el historial ERP desde la variante persistida. Si la fila interna ya
   contiene `copa`, entonces la correccion se limita al serializer/read model o
   componente de historial.

El orden seguro de investigacion dentro de Winerim es:

1. consultar auditoria/DB de las nueve `orderId` historicas;
2. comparar variante persistida con variante mostrada;
3. corregir endpoint si la persistencia es incorrecta;
4. corregir read model/UI si la persistencia es correcta;
5. reparar datos solo con una migracion auditada y reversible.

Como mejora defensiva posterior, el middleware puede guardar una copia
redactada de cada request/response de `sales/import` en un log inmutable,
incluyendo la variante que esperaba resolver. Esa mejora aumenta
observabilidad, pero no corrige una representacion incorrecta dentro de
Winerim.

## Pruebas de regresion obligatorias

### Backend Winerim

1. Crear un vino de prueba con IDs distintos para `botella` y `copa`.
2. Dejar `copa.stockActive=false` y stock `0`.
3. Importar `qty=3` usando el stock ID de copa.
4. Verificar en DB/read model: `variant=copa`, `qty=3`, `soldAt` exacto,
   `stockId` de copa y stock inalterado.
5. Verificar que la respuesta devuelve `resolvedVariant=copa`, `storedQty=3`
   y un `saleId` consultable.
6. Repetir el mismo `orderId`: debe devolver `skipped` y no crear otra venta.
7. Repetir con botella y magnum para impedir regresiones cruzadas.
8. Rechazar un `stockId` de otro menu y un stock sin variante canonica.
9. Probar un mismo ticket con dos lineas del mismo vino y variantes distintas.
10. Probar `soldAt` con fecha y con datetime/offset y conservar el instante.

### Historial ERP Winerim

1. Una importacion de copa debe mostrar `Copa`, cantidad `3` y sumar tres
   copas, no una botella.
2. Una importacion de botella debe mostrar `Botella` y sumar botellas.
3. El total debe usar el precio actual de la variante correcta, tal como
   documenta el contrato.
4. La vista, CSV y PDF deben devolver la misma variante, cantidad y fecha.
5. La venta debe seguir visible tras refresco, cambio de pagina y nueva sesion.

### Middleware

1. `format=COPA` debe producir `variant=copa`.
2. Con dos filas de stock del mismo vino, debe seleccionar solo el stock ID de
   copa.
3. El body enviado debe conservar `stockId`, `qty`, `soldAt` y `orderId`.
4. El `orderId` debe ser determinista y separar copa, botella y magnum.
5. La segunda ejecucion debe aceptar `skipped` como exito idempotente.
6. Debe existir un test directo de `sales/import`; actualmente no se encontro
   cobertura especifica de este flujo en los tests del repositorio.

## Criterio para desbloquear Vinatea

No repetir la importacion historica en produccion. Vinatea puede considerarse
desbloqueada para este punto cuando Winerim aporte:

1. evidencia de la fila persistida para al menos una `orderId` afectada o
   explicacion de por que desaparecieron las nueve tarjetas;
2. un test de staging con stock ID de copa, `qty > 1` y stock inactivo;
3. respuesta enriquecida que confirme `resolvedVariant` y la venta creada;
4. verificacion del historial ERP, CSV y/o endpoint de lectura mostrando copa;
5. confirmacion de idempotencia y stock inalterado.

Hasta entonces, el estado correcto del hallazgo es:

`WARN_WINERIM_SALES_IMPORT_VARIANT_NOT_REPRODUCIBLE`
