# Plan de recuperación Ágora ↔ Winerim — 2026-09-01 a 2026-09-21 (exclusivo)

Fase 3. **Solo diagnóstico**: no se importó ninguna venta ni se movió stock.
Reutiliza la captura de la fase 2 (`/mnt/documents/reconciliacion-winerim-historial-2026-09-01_2026-09-21.csv`); no se ha vuelto a leer Winerim.

Correcciones aplicadas sobre las "faltantes comprobadas" de la fase 2:

1. **Ticket abierto ↔ factura**: Ágora conserva la identidad de línea
   (producto + formato de venta + hora de creación de la línea, guardada en
   `provider_sold_at`). Si la misma línea física aparece como ticket abierto y
   como factura, es **una sola venta**: basta que una de las dos esté
   identificada en Winerim para que la otra no sea faltante.
2. **Devoluciones**: los documentos `BasicRefund` salen del cómputo de ventas.
3. **Copas desglosadas**: cuando las unidades ya identificadas del mismo vino,
   formato y día cubren las pendientes, la línea queda *ambigua*, no faltante.
4. **Stock desconocido sigue desconocido**: ninguna línea con efecto de stock
   no informado se propone para descuento automático; va a *a confirmar*.

| Restaurante | Líneas Ágora | Identificadas | Misma línea ya registrada | Representación previa | Devoluciones | Ambiguas | Faltantes reales | Uds. faltantes | A confirmar | Faltantes fase 2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Restaurante Cienvinos Ecija | 2157 | 424 | 76 | 259 | 52 | 857 | 489 | 610 | 64 | 592 |
| Ocean Club | 1057 | 150 | 2 | 0 | 23 | 485 | 397 | 475 | 110 | 437 |
| El Higuerón | 2578 | 352 | 305 | 880 | 25 | 793 | 223 | 273 | 203 | 675 |
| Casa Nene | 449 | 118 | 13 | 41 | 8 | 62 | 207 | 347 | 96 | 252 |
| Sa Vida | 1345 | 499 | 297 | 222 | 5 | 220 | 102 | 141 | 107 | 437 |
| Don Bernardo Santander | 1696 | 181 | 28 | 121 | 3 | 1286 | 77 | 95 | 43 | 99 |
| Albariza | 1002 | 850 | 14 | 0 | 14 | 48 | 76 | 100 | 28 | 86 |
| Taberna de Elia | 691 | 428 | 59 | 66 | 9 | 63 | 66 | 85 | 40 | 152 |
| De la O | 615 | 172 | 103 | 131 | 1 | 144 | 64 | 82 | 29 | 181 |
| Finca Eslava | 291 | 104 | 17 | 21 | 12 | 82 | 55 | 80 | 4 | 84 |
| Sa Pedrera | 536 | 150 | 144 | 114 | 0 | 84 | 44 | 57 | 87 | 217 |
| Chiquilla | 778 | 697 | 21 | 18 | 4 | 8 | 30 | 40 | 10 | 67 |
| El Portón de Sorni | 651 | 127 | 112 | 171 | 23 | 189 | 29 | 31 | 86 | 162 |
| Don Bernardo Ponzano | 988 | 583 | 27 | 23 | 4 | 330 | 21 | 28.5 | 29 | 55 |
| Casa Esteban | 380 | 256 | 28 | 35 | 5 | 40 | 17 | 25 | 0 | 43 |
| Tintorera | 470 | 166 | 112 | 84 | 1 | 92 | 15 | 24 | 57 | 138 |
| El Bejeque | 354 | 294 | 13 | 17 | 0 | 19 | 11 | 13 | 6 | 24 |
| Vinatea | 175 | 70 | 23 | 17 | 4 | 51 | 10 | 11 | 26 | 37 |
| Don Quijote Marbella | 187 | 104 | 25 | 25 | 1 | 24 | 8 | 51 | 8 | 32 |
| Restaurante Triana | 401 | 334 | 18 | 19 | 1 | 21 | 8 | 8 | 23 | 32 |
| Restaurante Qtomas | 32 | 13 | 12 | 1 | 1 | 0 | 5 | 5 | 6 | 19 |
| Katsu Izakaya | 76 | 61 | 0 | 0 | 0 | 13 | 2 | 3 | 1 | 7 |
| Restaurante Jardi | 182 | 164 | 3 | 1 | 0 | 12 | 2 | 2 | 19 | 6 |
| Abadía Yuste | 92 | 86 | 5 | 0 | 0 | 0 | 1 | 1 | 6 | 6 |
| Luruna | 597 | 594 | 1 | 1 | 0 | 0 | 1 | 2 | 0 | 3 |
| Taberna del Clinic | 33 | 16 | 14 | 1 | 1 | 1 | 1 | 2 | 1 | 15 |
| **TOTAL** | 17813 | 6993 | 1472 | 2268 | 197 | 4924 | 1961 | 2591.5 | 1089 | 3858 |

## Propuesta de recuperación (no aplicada)

- **Faltantes reales** → `history_and_stock` con `soldAt` = fecha y hora exactas
  del TPV: no existe ninguna entrada en el historial de Winerim ni otra
  representación identificada de esa línea.
- **A confirmar** → Winerim informa historial pero el efecto sobre stock es
  desconocido o negativo. No se propone `stock_only` de forma automática.
- **Misma línea ya registrada / representación previa / devoluciones / ambiguas**
  → no se recuperan.

Detalle línea a línea, con motivo y referencia cruzada: `/mnt/documents/plan-recuperacion-winerim-2026-09-01_2026-09-21.csv`.
