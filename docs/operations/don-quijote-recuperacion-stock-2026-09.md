# Don Quijote Marbella (ERP839) — recuperación de historial **y stock** de las 24 líneas (sept. 2026)

Conexión `8466c229-773d-4ad9-a747-9bb862d7ae6b`. Ámbito estricto: las 24 líneas
`FALTA` del corte 01/09–19/09 (exclusivo, Europe/Madrid). 78 unidades, 2.611,40 €.

**Estado: SOLO LECTURA. Nada importado, ningún stock movido.** Pendiente de GO.

## 1. ¿Se descontaron ya? — evidencia disponible y sus límites

Estas ventas ocurrieron mientras el restaurante estaba en la infraestructura
anterior, así que los registros de Lovable **no** sirven para afirmar nada:
nuestro lado no tiene ni un dato antes del 12/09 y todos los apuntes de descuento
son del 18/09.

Lo único contrastable de la infraestructura anterior es el rastro que dejó en
Winerim (historial con apuntes de legado). Contando esos apuntes por día:

| Día | Apuntes del sistema anterior en Winerim |
|---|---|
| 1, 2, 3, 4, 5, 7, 8, 9, 10 | sí, todos los días de servicio |
| **11** | **ninguno** |
| 16 (ticket T-42431) | ninguno de estas 4 referencias |
| 17 | sí |

Es decir: el sistema anterior escribió en Winerim todos los días excepto el 11, y
el ticket T-42431 no aparece por ningún lado.

**Límites que hay que asumir, sin maquillarlos:**

- No tenemos acceso a los registros ni a los recibos propios de la
  infraestructura anterior. Sólo vemos lo que llegó a Winerim.
- Winerim **no expone movimientos ni ajustes de stock** por API
  (`/stock/movements`, `/stock/history`, `/stock/adjustments` → 404): sólo el
  stock actual. Una regularización manual posterior no se puede certificar.
- Hay 31 apuntes de Winerim sin fecha informada; no se les puede asignar día.

Por tanto el efecto de stock de las 24 líneas queda como **DESCONOCIDO**, no como
"no descontado". Lo que sí está probado es que **falta el historial**.

**Pendiente de confirmar con el restaurante:** si hicieron recuento o
regularización de existencias después de esas ventas (especialmente 11/09 y el
ticket del 16/09). Sin esa respuesta, aplicar descuento puede duplicar un ajuste
que ya hicieran a mano.

## 2. Por vino: stock actual → descuento pendiente → stock resultante

Stock leído el 19/09. Las copas no se convierten ni se descuentan a mano: se
envían con el `stock_id` de copa y **Winerim aplica su ajuste copas/botella**, así
que el resultado final de botella de Muga Rosado, Martivilli y Viña Ardanza
incluye además lo que Winerim derive de sus copas.

| Vino | Winerim | Stock botella | Botellas pendientes | Copas pendientes | Resultante botella |
|---|---|---:|---:|---:|---|
| Arzuaga Crianza | 232976 | 58 | 6 | — | 52 |
| Conde de Haro Brut Rosé | 366714 | 29 | 30 | — | **déficit de 1: ver §3** |
| El Rincón de Nekeas | 243863 | 22 | 1 | — | 21 |
| Gavi di Gavi Etiqueta Amarila | 243866 | 27 | 11 | — | 16 |
| Gran Reserva 904 | 235026 | 6 | 1 | — | 5 |
| La Planta | 296655 | 32 | — | 2 | 32 − ajuste Winerim |
| Martínez Lacuesta Cuvée Crianza | 232971 | 16 | — | 3 | 16 − ajuste Winerim |
| Martivilli Verdejo | 243865 | 22 | 1 | 1 | 21 − ajuste Winerim |
| Muga Crianza | 232962 | 13 | 1 | — | 12 |
| Muga Rosado | 232951 | 24 | 12 | 7 | 12 − ajuste Winerim |
| Viña Ardanza Reserva | 232965 | 6 | 1 | 1 | 5 − ajuste Winerim |

Totales: 64 botellas + 14 copas = 78 unidades. `stock_id` de copa usado:
La Planta 340754, Martínez Lacuesta 267312, Martivilli 280119, Muga Rosado 280541,
Viña Ardanza 268807 (todas con stock de copa a 0 hoy).

## 3. Conde de Haro Brut Rosé — la venta son 30 botellas

La venta del ticket T-42431 es de **30 botellas / 1.215,00 €** y así se registra:
no se reduce a 29. El stock actual (29) es inferior a lo vendido, lo que indica un
**déficit de inventario de al menos 1 botella** con origen propio (entrada no
registrada o ajuste anterior). Ese déficit se resuelve **por separado**, con el
restaurante, y no bloquea el resto de líneas.

## 4. Cómo se aplicaría (pendiente de GO)

- `POST /api/v2/sales/import` con las claves deterministas actuales
  (`buildWinerimSalesImportOrderId` + `certifiedSourceLineId`), sin claves nuevas.
- Modo: `history_only` de forma segura para todas las líneas; el descuento de
  stock (`history_and_stock`) sólo cuando el restaurante confirme que **no**
  regularizó. Sin esa confirmación no se mueve stock.
- `soldAt` con fecha y hora originales: T-42431 → 16/09 17:45:16 (creación de
  línea 08/09 22:45:06 conservada como evidencia); día 11/09, hora de cada línea.
- Orden: primero **una línea completa** del ticket (Arzuaga, 6 botellas), lectura
  de verificación (`historyWritten`, `stockApplied`) y después el resto en serie,
  reanudable, consultando el historial antes de cada lote para no chocar con la
  sincronización normal.

Detalle línea a línea:
`/mnt/documents/don-quijote-recuperacion-historial-stock-2026-09.csv`.
