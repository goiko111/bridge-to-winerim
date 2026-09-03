# Ocean Club / Amaii - auditoria read-only

Fecha de corte: 2026-09-03 (Europe/Madrid)

## Alcance y seguridad

Auditoria sin replay, escrituras de mapping, stock, cursores, colas, breakers,
scopes, writers ni cambios de produccion. No se han expuesto credenciales.

## Identidades

| Identidad | connection_id | Estado de identidad | Evidencia | Bloqueo |
|---|---|---|---|---|
| Ocean Club | `706b952e-767d-41af-9cba-8e225b16a877` | Identidad documentada | Menu Winerim `756`, alias administrativo `Oceans`/`Ocean Club` | Falta readback vivo en este corte |
| Amaii by OC | no localizado | No separada | No aparece una conexion Amaii/Cedric en la evidencia local compacta revisada | Requiere fila/ID/centro exacto antes de auditar o migrar |

## Ocean Club: ultima evidencia verificable

- Estado histórico documentado: `LIVE_PENDING_SALE_CANARY`.
- Catálogo: `113/113 MATCH`, `113 VERIFIED`, `113 CONFIRMED`.
- Distribución: 35 tintos, 20 blancos, 8 rosados, 22 espumosos y 28 magnum;
  no había copas activas con precio positivo en esa evidencia.
- Ciclo configurado: cinco minutos; último día cerrado documentado:
  `2026-07-19`.
- Cola, alertas y bloqueos documentados en ese corte: cero.
- Ventana histórica revisada: 889 documentos y 8.471 líneas; 566 unidades y
  57.377 EUR en familias legacy, sin líneas usando los 113 botones Winerim.
- Ventas Winerim/historial: no certificadas; el ERP Winerim estaba vacío.
- Stock: `0` receipts Winerim en esa evidencia, al no existir venta Winerim.
- Legacy: 164 productos conservados visibles, 162 vendibles; no se ocultó ni
  eliminó nada.

## Amaii by OC

No se puede extrapolar Ocean Club a Amaii. No hay evidencia local suficiente
para afirmar conexión, menú, centro, catálogo, facturas, mappings, stock,
writer, scope, cola o breaker de Amaii. Estado: `BLOCKED_IDENTITY_NOT_FOUND`.

## Lectura viva

Se preparó una consulta estrictamente SELECT sobre `pos_connections` y las
columnas de control plane. El comando vinculado no produjo respuesta dentro de
la ventana de lectura disponible; por tanto no se inventan contadores actuales
ni se sustituye el readback vivo por datos históricos.

## Scores certificables en este corte

| Identidad | Catálogo | Ventas/historial | Stock exactly-once | Own-infra gate | Resultado |
|---|---:|---:|---:|---|---|
| Ocean Club | 80/100 histórico | 0/100 certificado | 0/100 certificado | No verificable en vivo | `BLOCKED_LIVE_READBACK_REQUIRED` |
| Amaii by OC | N/D | N/D | N/D | N/D | `BLOCKED_IDENTITY_NOT_FOUND` |

Los porcentajes no son una certificación operativa: Ocean no tiene canary de
venta Winerim, y Amaii carece de identidad separada.

## Siguiente gate seguro

1. Obtener un readback vivo del inventario que devuelva el `connection_id` y
   centro/menu de Amaii, si existe.
2. Para cada identidad por separado, leer facturas y líneas recientes,
   mappings exactos, `sales_event`/`sales_line_item`, receipts de stock y
   writer/scope/cola/breaker.
3. Solo tras esa lectura, preparar canary de una venta Winerim; no migrar ni
   ejecutar backfill hasta demostrar idempotencia y ownership.
