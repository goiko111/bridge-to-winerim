# Reconciliación Agora ↔ Winerim (historial completo) — 2026-09-01 a 2026-09-19 (exclusivo)

Fase 2. **Solo diagnóstico**: no se importó ninguna venta ni se movió stock.
Lectura: `GET /api/v2/sales/history?includeLegacy=true`, todas las páginas (límite 100).
Corte común con Ágora: desde 2026-09-01 00:00:00 hasta 2026-09-19 00:00:00, zona Europe/Madrid.

| Restaurante | Líneas Ágora | Clasificadas | Historial Winerim | Certificadas | Legado | Coinc. clave | Coinc. legado | Candidatas | Ambiguas | Faltantes comprobadas | Posibles duplicadas | Sin stock aplicado |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Katsu Izakaya | 58 | 58 | 94 | 48 | 46 | 47 | 0 | 3 | 3 | 5 | 44 | 1 |

Cada línea de Ágora cae en exactamente un bucket, así que **Clasificadas = Líneas Ágora**.
Las *posibles duplicadas* son entradas de Winerim sin línea de Ágora que las respalde y no suman al total.
Las *candidatas* se emparejan por vino, formato y día: son indicios, no certezas.
Historial y stock se informan por separado; lo que Winerim no informa figura como `desconocido`.

Detalle línea a línea: `/mnt/documents/reconciliacion-winerim-historial-2026-09-01_2026-09-19.csv`.
