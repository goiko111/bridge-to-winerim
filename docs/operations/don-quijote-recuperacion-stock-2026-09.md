# Don Quijote Marbella (ERP839) — recuperación de historial **y stock** de las 24 líneas (sept. 2026)

Conexión `8466c229-773d-4ad9-a747-9bb862d7ae6b`. Ámbito estricto: las 24 líneas
`FALTA` del corte 01/09–19/09 (exclusivo, Europe/Madrid). 78 unidades, 2.611,40 €.

**Estado: SOLO LECTURA. Nada importado, ningún stock movido.** Pendiente de GO.

## 1. ¿Se descontaron ya? ¿Hubo regularización?

- Registro interno de descuentos de la conexión: **89 apuntes, todos del 18/09**
  (78 correctos, 11 fallidos). No existe ni un intento para el ticket T-42431
  (16/09) ni para ninguna línea del 11/09. Nuestro lado nunca descontó estas 78 uds.
- Historial de Winerim (incluido legado y manual): esas 24 líneas no tienen apunte,
  por tanto tampoco descuento asociado.
- Regularización posterior: la API de Winerim **no expone movimientos ni ajustes de
  stock** (`/stock/movements`, `/stock/history`, `/stock/adjustments` → 404). Sólo
  se puede leer el stock actual. Conclusión: no hay evidencia de descuento previo y
  no es posible certificar por API un recuento manual posterior.
- Señal indirecta: en **Conde de Haro Brut Rosé** el stock actual (29) es inferior a
  las unidades pendientes (30). O ya hubo un ajuste que cubrió parte, o el stock
  nunca reflejó esa entrada. Esa línea queda **separada** y no se aplica sin decisión.

## 2. Por vino: stock actual → descuento pendiente → stock resultante

### Botellas (descuento directo sobre el stock de botella)

| Vino | Winerim | stock_id | Stock actual | Descuento | Resultante | Estado |
|---|---|---|---:|---:|---:|---|
| Arzuaga Crianza | 232976 | 267320 | 58 | 6 | 52 | listo |
| Conde de Haro Brut Rosé | 366714 | 411415 | 29 | 30 | **−1** | **no confirmable** |
| El Rincón de Nekeas | 243863 | 280116 | 22 | 1 | 21 | listo |
| Gavi di Gavi Etiqueta Amarila | 243866 | 280121 | 27 | 11 | 16 | listo |
| Gran Reserva 904 | 235026 | 269825 | 6 | 1 | 5 | listo |
| Martivilli Verdejo | 243865 | 280120 | 22 | 1 | 21 | listo |
| Muga Crianza | 232962 | 267306 | 13 | 1 | 12 | listo |
| Muga Rosado | 232951 | 267290 | 24 | 12 | 12 | listo |
| Viña Ardanza Reserva | 232965 | 267309 | 6 | 1 | 5 | listo |

Total botellas: **64 uds** (34 listas para aplicar + 30 en revisión).

### Copas (14 uds) — mecanismo de copas de Winerim

No se convierte a botellas ni se descuenta a mano: se envía la venta con el
`stock_id` de copa y **Winerim aplica su ajuste copas/botella**. El stock de copa
de este restaurante está a 0 en todos los casos, así que el efecto final sobre la
botella lo calcula Winerim con su ratio, no nosotros.

| Vino | Winerim | stock_id copa | Copas pendientes | Stock copa actual | Efecto en botella |
|---|---|---|---:|---:|---|
| La Planta | 296655 | 340754 | 2 | 0 | lo calcula Winerim |
| Martínez Lacuesta Cuvée Crianza | 232971 | 267312 | 3 | 0 | lo calcula Winerim |
| Martivilli Verdejo | 243865 | 280119 | 1 | 0 | lo calcula Winerim |
| Muga Rosado | 232951 | 280541 | 7 | 0 | lo calcula Winerim |
| Viña Ardanza Reserva | 232965 | 268807 | 1 | 0 | lo calcula Winerim |

Las botellas de Muga Rosado, Martivilli y Viña Ardanza pueden recibir, además del
descuento de botella de la tabla anterior, el ajuste que Winerim derive de sus copas.

## 3. Cómo se aplicaría (pendiente de GO)

- `POST /api/v2/sales/import` con `mode: "history_and_stock"` (historial **y**
  stock en la misma operación certificada), claves deterministas actuales
  (`buildWinerimSalesImportOrderId` + `certifiedSourceLineId`), sin claves nuevas.
- `soldAt` con la fecha y hora originales: T-42431 → 16/09 17:45:16 (creación de
  línea 08/09 22:45:06 conservada como evidencia); día 11/09, hora de cada línea.
- Orden: primero **una línea completa** del ticket (Arzuaga, 6 botellas), lectura de
  verificación (`historyWritten=true`, `stockApplied=true`, stock 58 → 52) y después
  el resto en serie, reanudable, consultando el historial antes de cada lote para no
  chocar con la sincronización normal.
- Se excluyen de este pase las 30 botellas de Conde de Haro y nada más; el resto no
  se bloquea por ese caso.

Detalle línea a línea:
`/mnt/documents/don-quijote-recuperacion-historial-stock-2026-09.csv`.
