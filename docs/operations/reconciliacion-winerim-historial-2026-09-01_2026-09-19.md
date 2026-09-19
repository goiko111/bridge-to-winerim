# Reconciliación Agora ↔ Winerim (historial completo) — 2026-09-01 a 2026-09-19 (exclusivo)

Fase 2. **Solo diagnóstico**: no se importó ninguna venta ni se movió stock.
Lectura: `GET /api/v2/sales/history?includeLegacy=true`, todas las páginas (límite 100).
Corte común con Ágora: desde 2026-09-01 00:00:00 hasta 2026-09-19 00:00:00, zona Europe/Madrid.

| Restaurante | Líneas Ágora | Clasificadas | Historial Winerim | Certificadas | Legado | Coinc. clave | Coinc. legado | Candidatas | Ambiguas | Faltantes comprobadas | Posibles duplicadas | Fuera de Ágora | Sin stock aplicado |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Don Quijote Marbella | 109 | 109 | 174 | 59 | 115 | 54 | 0 | 15 | 24 | 16 | 4 | 115 | 8 |

Cada línea de Ágora cae en exactamente un bucket, así que **Clasificadas = Líneas Ágora**.
*Posibles duplicadas*: entradas de Winerim del mismo vino, formato y día que una venta ya
registrada por el canal certificado (doble conteo probable). *Fuera de Ágora*: entradas sin
respaldo en el TPV (manuales u otro origen). Ninguna de las dos suma al total de Ágora.
Las *candidatas* se emparejan por vino, formato y día: son indicios, no certezas.
Historial y stock se informan por separado; lo que Winerim no informa figura como `desconocido`.

Detalle línea a línea: `/mnt/documents/reconciliacion-winerim-historial-2026-09-01_2026-09-19.csv`.
