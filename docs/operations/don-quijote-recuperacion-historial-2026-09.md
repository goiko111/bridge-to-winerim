# Don Quijote Marbella (ERP839) — historial septiembre 2026: propuesta de recuperación

Conexión `8466c229-773d-4ad9-a747-9bb862d7ae6b`.
Periodo: 2026-09-01 00:00:00 → 2026-09-19 00:00:00 (exclusivo), zona `Europe/Madrid`,
mismo corte en Ágora y en Winerim. Días 1 a 18 completos.

**Estado: SOLO LECTURA. No se ha importado ninguna venta, no se ha movido stock,
no se ha cambiado configuración ni se ha desplegado nada.** Queda pendiente del
GO explícito de Goiko sobre el listado de este documento.

## Fuentes

- Ágora: `GET /api/export/?business-day=<día>&filter=Invoices` para los 18 días,
  leído con las credenciales de la propia conexión. Cubre los días que faltaban en
  la captura local (solo tenía 12, 14, 15, 16, 17 y 18). 18 días leídos,
  152 documentos, 207 líneas de vino mapeadas (203 ventas + 4 devoluciones).
  Sin servicio los días 6 y 13.
- Winerim: `GET /api/v2/sales/history?from&to&includeLegacy=true`, todas las
  páginas. 174 apuntes: 59 de operación (canal certificado) y 115 de legado
  (sistema anterior y manuales).

## Resultado

| Estado | Líneas | Unidades | Importe | Unidades a incorporar |
|---|---:|---:|---:|---:|
| Registrada (cubierta en Winerim) | 131 | 198 | 5.352,50 € | 0 |
| Registrada por alias ticket↔factura | 3 | 3 | 21,50 € | 0 |
| Ambigua (hay historial, no se puede emparejar línea a línea) | 45 | 53 | 1.266,50 € | 0 |
| **Falta (sin ningún apunte en Winerim)** | **24** | **78** | **2.611,40 €** | **78** |
| Devolución (fuera del cómputo) | 4 | 4 | −154,00 € | 0 |

Además, 10 apuntes de Winerim no tienen línea del TPV que los respalde
(9 copas de legado del 10 y 17/09 con clave `mw:v1:agora:...` y 2 botellas de
Louis Latour del 17/09). No se tocan.

### Lo que falta (propuesta de recuperación, 24 líneas / 78 unidades)

**Ticket T-42431 — 16/09/2026 17:45:16 — 57 botellas / 2.160,90 €**
(descuento del 10 % ya aplicado en el importe)

| Vino | Winerim | Formato | Uds. | Importe |
|---|---|---|---:|---:|
| Arzuaga Crianza | 232976 | botella | 6 | 253,80 € |
| Muga Rosado | 232951 | botella | 11 | 287,10 € |
| Gavi di Gavi Etiqueta Amarila | 243866 | botella | 10 | 405,00 € |
| Conde de Haro Brut Rosé | 366714 | botella | 30 | 1.215,00 € |

Semántica de fecha: el documento tiene `Date` y `BusinessDay` = 16/09
(17:45:16) y sus líneas una `CreationDate` de 08/09 22:45:06. Se usa la fecha
documentada de venta **16/09 17:45:16** y se conserva la creación de línea como
evidencia. Ágora marca ese documento como de líneas fuera del día fiscal, y por
eso nunca entró en la sincronización: no existe ni un intento de envío registrado.
Producto del TPV 866714 → Winerim 366714 **Conde de Haro Brut Rosé**, botella,
mapeo confirmado (aclara el nombre truncado en la foto).

**Día 11/09/2026 — 20 líneas / 21 unidades / 450,50 €**
Winerim no tiene ningún apunte de ese día (ni de operación ni de legado): el
servicio completo se quedó fuera mientras el restaurante estaba en su propia
infraestructura.

| Ticket | Hora | Vino | Formato | Uds. | Importe |
|---|---|---|---|---:|---:|
| T-42394 | 18:33:09 | La Planta | copa | 1 | 6,50 € |
| T-42394 | 19:14:19 | La Planta | copa | 1 | 6,50 € |
| T-42395 | 19:13:33 | Muga Rosado | copa | 1 | 7,50 € |
| T-42398 | 19:29:04 | Muga Rosado | botella | 1 | 29,00 € |
| T-42399 | 19:43:35 | Martínez Lacuesta Cuvée Crianza | copa | 1 | 7,50 € |
| T-42399 | 19:43:37 | Muga Rosado | copa | 1 | 7,50 € |
| T-42399 | 20:24:04 | Muga Rosado | copa | 1 | 7,50 € |
| T-42399 | 20:24:07 | Martínez Lacuesta Cuvée Crianza | copa | 2 | 15,00 € |
| T-42399 | 21:08:42 | Muga Rosado | copa | 1 | 7,50 € |
| T-42401 | 20:56:23 | El Rincón de Nekeas | botella | 1 | 27,00 € |
| T-42403 | 19:58:25 | Gavi di Gavi Etiqueta Amarila | botella | 1 | 45,00 € |
| T-42403 | 20:55:29 | Gran Reserva 904 | botella | 1 | 115,00 € |
| T-42404 | 20:59:16 | Martivilli Verdejo | botella | 1 | 29,00 € |
| T-42405 | 21:09:57 | Muga Crianza | botella | 1 | 39,00 € |
| T-42405 | 22:15:56 | Martivilli Verdejo | copa | 1 | 6,50 € |
| T-42406 | 21:25:47 | Muga Rosado | copa | 1 | 7,50 € |
| T-42406 | 21:25:53 | Viña Ardanza Reserva | botella | 1 | 59,00 € |
| T-42406 | 22:08:16 | Muga Rosado | copa | 1 | 7,50 € |
| T-42406 | 23:00:12 | Viña Ardanza Reserva | copa | 1 | 13,00 € |
| T-42406 | 23:04:15 | Muga Rosado | copa | 1 | 7,50 € |

### Ambiguas (no se importan)

45 líneas / 53 unidades de los días 3, 4, 5, 7, 8, 9, 10 y 17. Winerim sí tiene
apuntes de ese vino, formato y día que cubren las unidades, pero sin la clave
original no se puede demostrar qué apunte corresponde a qué línea. Se dejan como
registradas sin emparejamiento probado, no como faltantes.

## Efecto sobre stock (informado aparte, nunca inferido)

- Este pase sería **solo historial**: cero movimiento de stock previsto.
- De las líneas ya registradas: 76 con descuento de stock confirmado por Winerim,
  55 con efecto **desconocido** (Winerim no lo informa).
- De las ambiguas: 27 con stock confirmado, 18 desconocido.
- De las 24 líneas que faltan: no hay apunte, así que el efecto de stock es
  **desconocido** y queda registrado como pendiente de confirmar. No se convierte
  en "no descontado" ni se descuenta automáticamente.

## Cómo se haría la importación (pendiente de GO)

- `POST /api/v2/sales/import` con `mode: "history_only"`, es decir el contrato
  certificado que escribe historial sin mover stock
  (`certifiedModeForWinerimSalesImport` con `mode: "historical"`, `live: false`).
- Claves: el mecanismo actual de identificación en producción
  (`buildWinerimSalesImportOrderId` + `certifiedSourceLineId`), no claves nuevas.
- `soldAt`: fecha y hora reales según la semántica descrita.
- Prueba inicial: **una línea completa del ticket** (no una unidad separada),
  con lectura de verificación antes de continuar; después el resto en serie,
  reanudable, consultando el historial antes de cada lote para no chocar con la
  sincronización normal, que sigue funcionando sin cambios.
- Verificación posterior: recibo con `historyWritten = true` y
  `stockApplied = false`, y relectura del historial para comprobar cantidades,
  fechas/horas y ausencia de duplicados.

## Cobertura

Los 18 días de septiembre están leídos en ambos lados, así que la comparación es
completa para el 1–18. Septiembre no se declara cerrado: el 19 en adelante queda
fuera de este corte.

Detalle línea a línea: `/mnt/documents/don-quijote-recuperacion-historial-2026-09-01_2026-09-19.csv`.
Script de lectura: `scripts/don-quijote-history-recovery.mjs` (solo lectura).
