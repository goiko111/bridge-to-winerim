# Reconciliación Agora ↔ Winerim (historial completo) — 2026-09-01 a 2026-09-21 (exclusivo)

Fase 2. **Solo diagnóstico**: no se importó ninguna venta ni se movió stock.
Lectura: `GET /api/v2/sales/history?includeLegacy=true`, todas las páginas (límite 100).
Corte común con Ágora: desde 2026-09-01 00:00:00 hasta 2026-09-21 00:00:00, zona Europe/Madrid.

| Restaurante | Líneas Ágora | Clasificadas | Historial Winerim | Certificadas | Legado | Coinc. clave | Coinc. legado | Candidatas | Ambiguas | Faltantes comprobadas | Posibles duplicadas | Fuera de Ágora | Sin stock aplicado |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Abadía Yuste | 92 | 92 | 10 | 4 | 6 | 79 | 1 | 6 | 0 | 6 | 0 | 0 | 6 |
| Albariza | 1002 | 1002 | 2179 | 4 | 2175 | 0 | 830 | 20 | 66 | 86 | 619 | 1252 | 28 |
| Casa Esteban | 380 | 380 | 245 | 218 | 27 | 224 | 0 | 32 | 81 | 43 | 69 | 14 | 0 |
| Casa Nene | 449 | 449 | 201 | 46 | 155 | 7 | 0 | 111 | 79 | 252 | 25 | 58 | 96 |
| Chiquilla | 778 | 778 | 74 | 37 | 37 | 673 | 2 | 22 | 14 | 67 | 13 | 22 | 10 |
| De la O | 615 | 615 | 558 | 93 | 465 | 20 | 52 | 100 | 262 | 181 | 40 | 346 | 29 |
| Don Bernardo Ponzano | 988 | 988 | 699 | 95 | 604 | 439 | 51 | 93 | 350 | 55 | 154 | 372 | 29 |
| Don Bernardo Santander | 1696 | 1696 | 1842 | 182 | 1660 | 43 | 23 | 115 | 1416 | 99 | 526 | 1142 | 43 |
| Don Quijote Marbella | 187 | 187 | 221 | 106 | 115 | 74 | 0 | 30 | 51 | 32 | 36 | 103 | 8 |
| El Bejeque | 354 | 354 | 54 | 20 | 34 | 280 | 0 | 14 | 36 | 24 | 13 | 24 | 6 |
| El Higuerón | 2578 | 2578 | 1223 | 203 | 1020 | 38 | 0 | 314 | 1551 | 675 | 188 | 683 | 203 |
| El Portón de Sorni | 651 | 651 | 386 | 83 | 303 | 3 | 2 | 122 | 362 | 162 | 65 | 194 | 86 |
| Finca Eslava | 291 | 291 | 302 | 105 | 197 | 52 | 22 | 30 | 103 | 84 | 124 | 74 | 4 |
| Katsu Izakaya | 76 | 76 | 107 | 61 | 46 | 47 | 0 | 14 | 8 | 7 | 42 | 4 | 1 |
| Kava | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Luruna | 597 | 597 | 35 | 7 | 28 | 593 | 0 | 1 | 0 | 3 | 0 | 28 | 0 |
| Ocean Club | 1057 | 1057 | 563 | 192 | 371 | 0 | 0 | 150 | 470 | 437 | 154 | 259 | 110 |
| Restaurante Cienvinos Ecija | 2157 | 2157 | 1344 | 463 | 881 | 189 | 80 | 155 | 1141 | 592 | 791 | 129 | 64 |
| Restaurante Jardi | 182 | 182 | 70 | 19 | 51 | 131 | 3 | 30 | 12 | 6 | 11 | 17 | 19 |
| Restaurante Qtomas | 32 | 32 | 17 | 8 | 9 | 0 | 0 | 13 | 0 | 19 | 1 | 3 | 6 |
| Restaurante Triana | 401 | 401 | 49 | 13 | 36 | 309 | 5 | 20 | 35 | 32 | 5 | 13 | 23 |
| Sa Pedrera | 536 | 536 | 284 | 45 | 239 | 3 | 8 | 139 | 169 | 217 | 25 | 109 | 87 |
| Sa Vida | 1345 | 1345 | 1108 | 189 | 919 | 53 | 130 | 316 | 409 | 437 | 133 | 476 | 107 |
| Taberna de Elia | 691 | 691 | 340 | 96 | 244 | 315 | 50 | 63 | 111 | 152 | 65 | 149 | 40 |
| Taberna del Clinic | 33 | 33 | 117 | 21 | 96 | 1 | 0 | 15 | 2 | 15 | 6 | 95 | 1 |
| Tintorera | 470 | 470 | 335 | 93 | 242 | 43 | 9 | 114 | 166 | 138 | 41 | 128 | 57 |
| Vinatea | 175 | 175 | 162 | 46 | 116 | 3 | 5 | 62 | 68 | 37 | 32 | 60 | 26 |

Cada línea de Ágora cae en exactamente un bucket, así que **Clasificadas = Líneas Ágora**.
*Posibles duplicadas*: entradas de Winerim del mismo vino, formato y día que una venta ya
registrada por el canal certificado (doble conteo probable). *Fuera de Ágora*: entradas sin
respaldo en el TPV (manuales u otro origen). Ninguna de las dos suma al total de Ágora.
Las *candidatas* se emparejan por vino, formato y día: son indicios, no certezas.
Historial y stock se informan por separado; lo que Winerim no informa figura como `desconocido`.

Detalle línea a línea: `/mnt/documents/reconciliacion-winerim-historial-2026-09-01_2026-09-21.csv`.
