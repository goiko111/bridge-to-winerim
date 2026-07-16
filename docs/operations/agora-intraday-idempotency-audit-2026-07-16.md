# Auditoría Agora: intradía e idempotencia

Fecha: 2026-07-16  
Modo: solo lectura  
Ventana de conciliación ERP: 14 días

## Resultado ejecutivo

- Conexiones Agora registradas: `28`.
- Conexiones activas: `15`.
- Activas con captura de tickets abiertos: `15/15`.
- Activas con sincronización intradía: `15/15`.
- Activas con mutación de stock desde tickets abiertos: `13/15`.
- Escrituras `SUCCESS` con clave idempotente revisadas: `1.808`.
- Claves idempotentes exactas repetidas: `0`.
- Historiales ERP Winerim auditados: `15/15`.
- Conciliación de 14 días sin diferencias agregadas: `El Higuerón` y `Restaurante Triana`.
- Conexiones con deuda histórica a revisar: `13`.

## Flags de conexiones activas

| Restaurante | Tickets abiertos | Intradía | Stock desde ticket | Idempotencia actual | Histórico 14 días |
|---|---:|---:|---:|---|---|
| Casa Nene | Sí | Sí | Sí | PASS | REVIEW |
| Chiquilla | Sí | Sí | Sí | PASS | REVIEW |
| El Bejeque | Sí | Sí | Sí | PASS | REVIEW |
| El Higuerón | Sí | Sí | Sí | PASS | PASS |
| Katsu Izakaya | Sí | Sí | Sí | PASS | REVIEW |
| Kava | Sí | Sí | Sí | PASS | REVIEW |
| Luruna | Sí | Sí | Sí | PASS | REVIEW |
| PurOsushi | Sí | Sí | Sí | PASS | REVIEW |
| Restaurante Cienvinos Ecija | Sí | Sí | No | PASS | REVIEW |
| Restaurante Jardi | Sí | Sí | No | PASS | REVIEW |
| Restaurante Qtomas | Sí | Sí | Sí | PASS | REVIEW |
| Restaurante Triana | Sí | Sí | Sí | PASS | PASS |
| Sa Pedrera | Sí | Sí | Sí | PASS | REVIEW |
| Sa Vida | Sí | Sí | Sí | PASS | REVIEW |
| Taberna de Elia | Sí | Sí | Sí | PASS | REVIEW |

Cienvinos y Jardi mantienen la captura intradía, pero esperan a la factura definitiva para la mutación. No es un flag olvidado.

## Evidencia antiduplicado

- El ledger completo no contiene dos filas `SUCCESS` con la misma `idempotency_key`.
- Sa Pedrera generó tres objetivos diferentes y ninguno se repitió en ciclos posteriores.
- Kava generó un objetivo de botella y tampoco se repitió.
- Después del refresco, los claims conservaron su clave aunque `sales_line_item_id` pasase a `null`.
- Esto demuestra que el reemplazo de snapshots ya no elimina la memoria de lo enviado a Winerim.

## Deuda histórica

El número siguiente es la cantidad de `stockId` cuyo total de facturas cerradas no coincide con el total visible en el ERP durante la ventana. No equivale automáticamente a ventas duplicadas.

| Restaurante | StockIds a conciliar |
|---|---:|
| Sa Pedrera | 53 |
| Cienvinos Ecija | 39 |
| Sa Vida | 27 |
| El Bejeque | 16 |
| Casa Nene | 15 |
| Katsu Izakaya | 8 |
| Chiquilla | 5 |
| Taberna de Elia | 5 |
| Kava | 2 |
| Luruna | 2 |
| PurOsushi | 1 |
| Restaurante Jardi | 1 |
| Restaurante Qtomas | 1 |

Huellas ERP idénticas candidatas a revisión documental: El Bejeque `1`, Cienvinos `3`, Sa Pedrera `3` y Taberna de Elia `1`.

## Repetición

```bash
WINERIM_ADMIN_EMAIL="..." \
WINERIM_ADMIN_PASSWORD="..." \
AUDIT_DAYS=14 \
AUDIT_OUTPUT="/tmp/agora-intraday-history-audit.json" \
node scripts/audit-agora-intraday-history.mjs
```

El auditor no cambia flags, catálogo, stock, historial ni colas.
