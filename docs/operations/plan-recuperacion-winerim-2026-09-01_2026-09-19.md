# Plan de recuperación Ágora ↔ Winerim — 2026-09-01 a 2026-09-19 (exclusivo)

Fase 3. **Solo diagnóstico**: no se importó ninguna venta ni se movió stock.
Reutiliza la captura de la fase 2 (`/mnt/documents/reconciliacion-winerim-historial-2026-09-01_2026-09-19.csv`); no se ha vuelto a leer Winerim.

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
| El Higuerón | 2270 | 153 | 139 | 916 | 24 | 215 | 823 | 969 | 86 | 1704 |
| Restaurante Cienvinos Ecija | 1675 | 339 | 33 | 106 | 52 | 558 | 587 | 735 | 57 | 702 |
| Ocean Club | 792 | 122 | 2 | 0 | 16 | 318 | 334 | 398 | 110 | 365 |
| Casa Nene | 381 | 109 | 5 | 18 | 8 | 55 | 186 | 306 | 96 | 208 |
| El Portón de Sorni | 577 | 84 | 76 | 178 | 19 | 84 | 136 | 180 | 68 | 331 |
| Albariza | 987 | 836 | 9 | 0 | 14 | 22 | 106 | 134 | 17 | 134 |
| Taberna de Elia | 289 | 68 | 26 | 66 | 9 | 20 | 100 | 133 | 23 | 185 |
| Don Bernardo Santander | 1524 | 166 | 15 | 57 | 3 | 1209 | 74 | 90 | 43 | 92 |
| Sa Vida | 1207 | 445 | 270 | 196 | 5 | 222 | 69 | 92 | 113 | 347 |
| De la O | 481 | 118 | 65 | 113 | 0 | 129 | 56 | 72 | 29 | 127 |
| Finca Eslava | 227 | 99 | 12 | 2 | 10 | 57 | 47 | 70 | 4 | 71 |
| Sa Pedrera | 478 | 133 | 128 | 102 | 0 | 77 | 38 | 51 | 87 | 190 |
| Casa Esteban | 302 | 229 | 12 | 18 | 5 | 4 | 34 | 54 | 0 | 65 |
| Chiquilla | 254 | 187 | 18 | 14 | 4 | 4 | 27 | 37 | 10 | 61 |
| Don Bernardo Ponzano | 528 | 180 | 9 | 11 | 4 | 305 | 19 | 24.5 | 29 | 37 |
| Tintorera | 403 | 134 | 96 | 78 | 0 | 81 | 14 | 23 | 57 | 119 |
| Restaurante Qtomas | 21 | 0 | 0 | 8 | 1 | 0 | 12 | 16 | 0 | 21 |
| El Bejeque | 55 | 10 | 10 | 12 | 0 | 12 | 11 | 13 | 6 | 21 |
| Restaurante Triana | 125 | 58 | 18 | 19 | 1 | 21 | 8 | 9 | 23 | 32 |
| Vinatea | 97 | 49 | 3 | 1 | 4 | 34 | 6 | 7 | 26 | 13 |
| Don Quijote Marbella | 109 | 69 | 14 | 10 | 1 | 10 | 5 | 48 | 8 | 16 |
| Katsu Izakaya | 58 | 50 | 0 | 0 | 0 | 6 | 2 | 3 | 1 | 5 |
| Restaurante Jardi | 50 | 36 | 1 | 0 | 0 | 11 | 2 | 2 | 19 | 4 |
| Abadía Yuste | 11 | 6 | 4 | 0 | 0 | 0 | 1 | 1 | 6 | 5 |
| Taberna del Clinic | 14 | 7 | 6 | 0 | 1 | 0 | 1 | 2 | 1 | 7 |
| Luruna | 46 | 46 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **TOTAL** | 12961 | 3733 | 971 | 1925 | 181 | 3454 | 2698 | 3469.5 | 919 | 4862 |

## Propuesta de recuperación (no aplicada)

- **Faltantes reales** → `history_and_stock` con `soldAt` = fecha y hora exactas
  del TPV: no existe ninguna entrada en el historial de Winerim ni otra
  representación identificada de esa línea.
- **A confirmar** → Winerim informa historial pero el efecto sobre stock es
  desconocido o negativo. No se propone `stock_only` de forma automática.
- **Misma línea ya registrada / representación previa / devoluciones / ambiguas**
  → no se recuperan.

Detalle línea a línea, con motivo y referencia cruzada: `/mnt/documents/plan-recuperacion-winerim-2026-09-01_2026-09-19.csv`.
