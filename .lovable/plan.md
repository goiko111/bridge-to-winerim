# Revisión de septiembre (solo lectura) — Luruna y Cienvinos Écija

Ámbito exclusivo: Luruna (`c9b23830`) y Restaurante Cienvinos Écija (`21ee3345`),
periodo `[2026-09-01 00:00, 2026-09-20 00:00)` Europe/Madrid (días 1–19 completos).
Don Quijote no se toca. **Sin GO**: nada de importar historial, mover stock,
cambiar configuración ni desplegar. Solo lectura y propuesta.

## Lo ya comprobado antes de este plan

- **Cobertura local del TPV**: Cienvinos tiene capturados los días **02–19/09**
  (falta **01/09**). Luruna tiene **solo 18 y 19/09**; los días **01–17/09 no
  están capturados** y hay que leerlos del TPV.
- **Alerta de Luruna explicada en parte**: en la captura anterior las 46 líneas de
  Luruna comparten la misma marca de tiempo `2026-09-18T21:53:48` y el mismo
  bucket; es repetición de un snapshot, no 46 ventas distintas. Falta leer el resto
  de septiembre para poder afirmar algo de todo el mes.
- **Alerta de Cienvinos confirmada con datos reales** (ejemplo El Pacto 239321,
  12/09): el documento `186` (StandardInvoice) tiene **dos** líneas (13:34:52 y
  14:42:11), el `26556` (BasicInvoice) tiene **las mismas dos**, y existe además un
  documento de **devolución** `refund:2026-09-12:td:224` con **las dos líneas en
  negativo**. La conciliación anterior propuso esa línea como faltante; con la
  devolución delante el efecto económico neto puede ser cero. Tomás Postigo 239870
  (02/09 14:22:06, 1 bot / 49 €) aparece una sola vez, en la factura `23187`.
- Las dos conexiones están activas, sin circuit breaker, con token de Winerim.

Conclusión: las cifras anteriores (45 de Luruna, 702 / 587 de Cienvinos) **no se
reutilizan como resultado**. Se recalculan.

## Qué haré (una sola pasada, solo lectura)

1. **Leer el TPV** de los días que faltan: Luruna 01–17/09 y Cienvinos 01/09, más
   relectura de 19/09 en ambos para cerrar el corte nuevo. Un intento acotado por
   restaurante y día; si el TPV no responde, se anota el día como "lectura
   pendiente" y se sigue, sin reintentos en bucle ni cifras antiguas.
2. **Refrescar el historial completo de Winerim** por conexión:
   `GET /api/v2/sales/history?from=...&to=...&includeLegacy=true`, todas las
   páginas, mismo corte. Se guarda la captura con su hora de lectura.
3. **Normalizar el lado TPV a líneas económicas únicas** antes de comparar:
   - identidad de línea = documento + id de línea real + producto + formato + hora
     de creación de línea;
   - ticket abierto y factura de la misma venta = **una** línea;
   - devoluciones (`BasicRefund`) se restan del neto y se informan aparte, nunca
     como venta ni como faltante;
   - importe = **neto del TPV**, no precio de catálogo del receptor.
4. **Emparejar con Winerim por asignación de unidades**, no por igualdad
   vino/día: cada apunte de Winerim se consume una sola vez y puede cubrir varias
   líneas del TPV (muchas líneas → un recibo). Un apunte ya consumido no confirma
   una segunda venta.
5. **Clasificar por día y restaurante**: ya registradas, representaciones
   duplicadas, ambiguas (con motivo), faltantes probadas, devoluciones.
6. **Stock**: leer el stock actual por vino con su hora de lectura y el
   `stockApplied` que informe Winerim. Si Winerim no expone movimientos ni ajustes
   (hoy devuelve 404 en esos endpoints), se declara la limitación. Stock no
   informado queda **DESCONOCIDO**, nunca "no descontado". Las copas las convierte
   Winerim; no resto botellas a mano. Cualquier déficit se lista aparte.

## Entrega

- Resumen corto por restaurante y por día: cobertura del TPV y del historial,
  líneas económicas únicas, ya registradas, duplicadas, ambiguas, faltantes,
  devoluciones, unidades por formato e importe neto.
- CSV con la propuesta exacta, una fila por faltante: fecha y hora original,
  documento + id de línea, vino + id + formato, unidades, importe neto, motivo y
  evidencia, estado de historial, `stockApplied` (conocido/desconocido) y stock
  actual leído con su hora.
- Informe durable en `docs/operations/` por restaurante.

Nada se aplica hasta que Goiko apruebe ese listado.

## Detalle técnico

Reutilizo el conciliador existente (`scripts/don-quijote-history-recovery.mjs`
como base de lectura y la sonda `winerim-sales-probe` ya desplegada) con dos
cambios de lógica, sin crear infraestructura ni desplegar funciones: identidad de
línea real del documento en lugar de claves reconstruidas, y emparejamiento por
consumo de unidades con devoluciones netadas. Las claves deterministas del
contrato actual (`buildWinerimSalesImportOrderId`) solo se usan para comprobar
presencia; no se inventan claves nuevas.
