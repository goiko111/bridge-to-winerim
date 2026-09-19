# Don Quijote Marbella — propuesta de recuperación de historial (septiembre 2026)

Ámbito: solo conexión `8466c229-773d-4ad9-a747-9bb862d7ae6b` (ERP839), ventas
desde 01/09/2026 00:00 hasta 19/09/2026 00:00 (exclusivo), hora de España.
Ningún otro restaurante, ningún día de agosto.

**Estado: nada ejecutado.** En este turno solo se han hecho lecturas
(consultas a la base de datos y lectura de ficheros del proyecto). No se ha
enviado ninguna venta a Winerim, no se ha tocado stock, ni configuración, ni
se ha desplegado nada. No había ningún lote en vuelo que cancelar, así que no
existe ningún recibo de escritura de este turno. La sincronización normal sigue
funcionando tal cual (conexión activa, último refresco hoy 08:32 UTC).

## Lo que ya sabemos con certeza

1. **El ticket 42431 se vendió el 16/09 a las 17:45**, no el 08/09. La cabecera
   del documento en el TPV dice `Date = 2026-09-16T17:45:16` y
   `BusinessDay = 2026-09-16`, y coincide con tu foto. Las líneas llevan una
   hora de creación del 08/09 22:45:06 (la mesa/encargo se abrió antes), y por
   eso el informe anterior las fechaba el 8. El propio TPV marcó ese documento
   como "líneas fuera del día fiscal", y por eso nunca entró en la
   sincronización: no hay ni un solo intento de envío registrado para él.
2. **Los cuatro vinos del ticket están correctamente identificados** (mapeos
   confirmados, formato botella):
   - Arzuaga Crianza → 232976, botella, 6 uds, 253,80 €
   - Muga Rosado → 232951, botella, 11 uds, 287,10 €
   - Gavi di Gavi Etiqueta Amarila → 243866, botella, 10 uds, 405,00 €
   - Conde de Haro **Brut Rosé** → 366714, botella, 30 uds, 1.215,00 €
     (producto del TPV 866714, mapeo confirmado a ese vino; queda confirmado
     el nombre que aparecía truncado en la foto)
   Total del ticket: 57 botellas, 2.160,90 € (descuento del 10 % ya aplicado).
3. **La coincidencia de Muga Rosado no vale como identificación.** La venta
   174889 de Winerim era 1 botella de 29 € del 08/09 22:48, y tu export del
   editor no tiene ningún apunte del 16/09 de estas cuatro referencias. Una
   venta ajena no cubre el ticket.
4. **La cobertura del TPV en local está incompleta**: solo hay documentos de los
   días 12, 14, 15, 16, 17 y 18 de septiembre. Don Quijote estuvo en
   infraestructura propia hasta el 18/09, así que del 1 al 11 (y el 13) no hay
   captura local. Septiembre **no** se podrá declarar cerrado en este pase.

## Qué propongo hacer (y nada más)

Todo en modo **solo historial**: se escribe la venta en el histórico de Winerim
con su fecha y hora reales y **sin ningún movimiento de stock**. Efecto de stock
previsto en este pase: **ninguno**.

### Paso 1 — Lectura fresca antes de proponer cifras finales
- Refresco acotado del TPV para los 18 días de esta conexión (solo lectura) para
  medir la cobertura real y detectar documentos no capturados.
- Lectura completa y paginada del histórico de Winerim del periodo, incluyendo
  ventas antiguas y manuales, con el mismo corte horario.
- Reconciliación por identidad de documento y línea, con reparto de cantidades
  (incluido varios-a-uno), alias ticket abierto ↔ factura como una sola venta y
  devoluciones aparte.

### Paso 2 — Propuesta cerrada para tu OK
Entregaré, antes de escribir nada: referencia del ticket, fecha y hora, vino,
formato, unidades e importe de cada línea a incorporar; qué ya existe en Winerim;
qué queda ambiguo y por qué; y los totales.

Cifras de partida (a confirmar con la lectura fresca del paso 1):
- **Candidatas claras a incorporar**: las 4 líneas del ticket 42431 (57 botellas,
  2.160,90 €) con fecha 16/09 17:45:16, más 3 líneas del 17/09 de La Misión
  Menade (1 botella, 52 € cada una) pendientes de contraste.
- **Ya presentes**: 54 líneas identificadas por su referencia original y 14 más
  resueltas como la misma línea física ya registrada.
- **Ambiguas (no se tocan)**: 10 líneas del 18/09, copas y magnums repetidos del
  mismo vino y día donde no se puede emparejar sin la referencia original.

### Paso 3 — Solo con tu GO explícito
Enviar las líneas inequívocas en modo solo historial, empezando por una unidad
suelta y comprobándola antes de seguir, con claves deterministas compatibles con
el contrato actual (sin claves nuevas para esquivar conflictos) y consulta previa
al histórico antes de cada lote para no chocar con la sincronización normal.

## Semántica de la fecha (decisión a validar por ti)

Para documentos marcados por el TPV como "líneas fuera del día fiscal"
(el caso del 42431), propongo usar la **fecha y hora de la cabecera del
documento** (16/09 17:45:16) en lugar de la hora de creación de la línea
(08/09 22:45:06). No se inventa ninguna hora ni se reasigna nada en silencio:
queda anotado documento a documento en el informe. Si prefieres conservar la hora
de creación de línea, dilo y se mantiene.

## Riesgos y validación

- Riesgo de duplicado: se consulta el histórico completo justo antes de escribir
  y se usan claves deterministas, de forma que un reenvío no puede duplicar.
- Riesgo de descuento doble: nulo en este pase, porque el modo elegido no mueve
  stock. Las líneas cuyo efecto de stock sea desconocido se registran como
  **pendiente de confirmar**, nunca como "no descontado".
- Ningún cambio de configuración, ni despliegue, ni parada de la sincronización.

## Detalle técnico

- Lectura: `GET /api/v2/sales/history?from&to&includeLegacy=true`, paginado
  (límite 100), vía la sonda de solo lectura ya existente.
- Escritura (paso 3, pendiente de GO): `POST /api/v2/sales/import` con
  `mode: "history_only"`, `sourceSystem: "agora"`, `soldAt` real, `orderId`
  determinista con el formato ya en producción
  (`agora:<conn8>:<día>:<wineId>:<variante>:<hash>`) y `sourceLineId`.
  Verificación posterior por recibo: `historyWritten = true`,
  `stockApplied = false`.
- Stock IDs de botella ya verificados en el catálogo vivo: Arzuaga 267320,
  Muga Rosado 267290, Gavi di Gavi 280121, Conde de Haro Brut Rosé 411415,
  La Misión Menade 267286.
- Informe durable: `docs/operations/don-quijote-recuperacion-historial-2026-09.md`
  más hoja de detalle línea a línea en Archivos.
