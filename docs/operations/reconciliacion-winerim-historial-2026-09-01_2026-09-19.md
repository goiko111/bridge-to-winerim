# Reconciliación Agora ↔ Winerim (historial completo) — 2026-09-01 a 2026-09-19 (exclusivo)

Fase 2. **Solo diagnóstico**: no se importó ninguna venta ni se movió stock.
Lectura: `GET /api/v2/sales/history?includeLegacy=true`, todas las páginas (límite 100).
Corte común con Ágora: desde 2026-09-01 00:00:00 hasta 2026-09-19 00:00:00, zona Europe/Madrid.

| Restaurante | Líneas Ágora | Clasificadas | Historial Winerim | Certificadas | Legado | Coinc. clave | Coinc. legado | Candidatas | Ambiguas | Faltantes comprobadas | Posibles duplicadas | Fuera de Ágora | Sin stock aplicado |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Abadía Yuste | 11 | 11 | 6 | 0 | 6 | 0 | 1 | 5 | 0 | 5 | 0 | 0 | 6 |
| Albariza | 987 | 987 | 2179 | 4 | 2175 | 0 | 830 | 6 | 17 | 134 | 91 | 1794 | 17 |
| Casa Esteban | 302 | 302 | 200 | 173 | 27 | 220 | 0 | 9 | 8 | 65 | 44 | 21 | 0 |
| Casa Nene | 381 | 381 | 180 | 25 | 155 | 7 | 0 | 102 | 64 | 208 | 13 | 58 | 96 |
| Chiquilla | 254 | 254 | 53 | 16 | 37 | 169 | 2 | 16 | 6 | 61 | 4 | 22 | 10 |
| De la O | 481 | 481 | 498 | 33 | 465 | 6 | 52 | 60 | 236 | 127 | 34 | 346 | 29 |
| Don Bernardo Ponzano | 528 | 528 | 637 | 33 | 604 | 62 | 51 | 67 | 311 | 37 | 137 | 372 | 29 |
| Don Bernardo Santander | 1524 | 1524 | 1765 | 105 | 1660 | 40 | 23 | 103 | 1266 | 92 | 463 | 1142 | 43 |
| Don Quijote Marbella | 109 | 109 | 174 | 59 | 115 | 54 | 0 | 15 | 24 | 16 | 16 | 103 | 8 |
| El Bejeque | 55 | 55 | 34 | 0 | 34 | 0 | 0 | 10 | 24 | 21 | 0 | 24 | 6 |
| El Higuerón | 2270 | 2270 | 1111 | 91 | 1020 | 26 | 0 | 127 | 413 | 1704 | 60 | 898 | 86 |
| El Portón de Sorni | 577 | 577 | 345 | 42 | 303 | 0 | 2 | 82 | 162 | 331 | 43 | 218 | 68 |
| Finca Eslava | 227 | 227 | 273 | 76 | 197 | 52 | 22 | 25 | 57 | 71 | 100 | 74 | 4 |
| Katsu Izakaya | 58 | 58 | 94 | 48 | 46 | 47 | 0 | 3 | 3 | 5 | 40 | 4 | 1 |
| Kava | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Luruna | 46 | 46 | 30 | 2 | 28 | 46 | 0 | 0 | 0 | 0 | 0 | 28 | 0 |
| Ocean Club | 792 | 792 | 423 | 52 | 371 | 0 | 0 | 122 | 305 | 365 | 42 | 259 | 110 |
| Restaurante Cienvinos Ecija | 1675 | 1675 | 1155 | 274 | 881 | 153 | 80 | 106 | 634 | 702 | 598 | 218 | 57 |
| Restaurante Jardi | 50 | 50 | 55 | 4 | 51 | 6 | 3 | 27 | 10 | 4 | 6 | 17 | 19 |
| Restaurante Qtomas | 21 | 21 | 11 | 2 | 9 | 0 | 0 | 0 | 0 | 21 | 2 | 9 | 0 |
| Restaurante Triana | 125 | 125 | 44 | 8 | 36 | 34 | 5 | 19 | 35 | 32 | 5 | 13 | 23 |
| Sa Pedrera | 478 | 478 | 257 | 18 | 239 | 2 | 8 | 123 | 155 | 190 | 15 | 109 | 87 |
| Sa Vida | 1207 | 1207 | 1012 | 93 | 919 | 28 | 130 | 287 | 415 | 347 | 114 | 453 | 113 |
| Taberna de Elia | 289 | 289 | 271 | 27 | 244 | 2 | 50 | 16 | 36 | 185 | 31 | 173 | 23 |
| Taberna del Clinic | 14 | 14 | 105 | 9 | 96 | 1 | 0 | 6 | 0 | 7 | 3 | 95 | 1 |
| Tintorera | 403 | 403 | 294 | 52 | 242 | 35 | 9 | 90 | 150 | 119 | 32 | 128 | 57 |
| Vinatea | 97 | 97 | 121 | 5 | 116 | 1 | 5 | 43 | 35 | 13 | 12 | 60 | 26 |

Cada línea de Ágora cae en exactamente un bucket, así que **Clasificadas = Líneas Ágora**.
*Posibles duplicadas*: entradas de Winerim del mismo vino, formato y día que una venta ya
registrada por el canal certificado (doble conteo probable). *Fuera de Ágora*: entradas sin
respaldo en el TPV (manuales u otro origen). Ninguna de las dos suma al total de Ágora.
Las *candidatas* se emparejan por vino, formato y día: son indicios, no certezas.
Historial y stock se informan por separado; lo que Winerim no informa figura como `desconocido`.

Detalle línea a línea: `/mnt/documents/reconciliacion-winerim-historial-2026-09-01_2026-09-19.csv`.
