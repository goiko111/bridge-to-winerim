# Casa Nene - checklist 100% Agora

Fecha: `2026-07-20`

Conexion: `e3cb6dbb-3474-4926-b740-706fbd0ef7e0`

Estado: `LIVE_AUTOMATIC / PENDING_HISTORY_CLEANUP_APPROVAL_AND_GLASS_CANARY`

## Checklist

| Area | Estado | Evidencia |
|---|---|---|
| Conexion y autenticacion Agora | PASS | Lecturas fresh de API, catalogo, facturas y tickets HTTP `200`; breaker cerrado. |
| Configuracion general | PASS | `enabled=true`, `BIDIRECTIONAL`, `XML_IMPORT`, frecuencia `5 min` y zona `Europe/Madrid`. |
| Catalogo Winerim -> Agora | PASS | Auditoria fresh `348/348 MATCH`, `0 MISSING`, `0 DIFFERENT`, `0 UNOWNED`. |
| Automatizacion de catalogo | PASS | Alta, cambio y verified-ready activos; `Remirez de Ganuza Gran Reserva` se verifico en `50 s`. |
| Cola y alertas | PASS | `0` tareas activas, `0` diferencias fresh y `0` alertas abiertas. |
| Familias Winerim | PASS | Ocho familias creadas y visibles; contienen exactamente los `348` formatos vendibles esperados. |
| Legacy | PASS | `VINO`, `VINO FUERA DE CARTA`, `ESPUMOSO`, `BLANCO`, `TINTO` y `DULCES` estan ocultas. Sus `148` productos no son vendibles. |
| Retirados | PASS | Los otros `30` formatos Winerim inactivos o sin precio siguen presentes como trazabilidad, pero no son vendibles. Tracking `30 HIDDEN`. |
| Copas | PASS_CATALOG / PENDING_EXTERNAL | Las `31` copas internas estan vendibles en `COPAS WINERIM`, con precio exacto, mapping `CONFIRMED/XML_IMPORT` y tracking `WINERIM/VERIFIED`; falta una venta real. |
| Captura intradia | PASS | Invoices y tickets se consultan cada `5 min`; edad minima de linea `2 min`. Ultimo ciclo correcto del `20/07`. |
| Cierre diario | PASS | Cursor en `2026-07-19`; el dia en curso se consulta sin avanzar el cursor. |
| Hora de venta | PASS | Las tarjetas TPV recientes conservan la hora de la linea Agora. |
| Idempotencia actual | PASS | Cero claves exactas repetidas; el codigo conserva claims de stock al refrescar snapshots de tickets. No se repite el patron desde el parche. |
| Historial ERP | FAIL | Quedan `17` tarjetas incorrectas creadas por el piloto antiguo: `16` duplicadas del 15/07 y `1` provisional cancelada del 17/07. |
| Stock | FAIL | El stock refleja esas tarjetas antiguas. La correccion esta calculada, pero requiere anular datos productivos y autorizacion expresa. |
| Venta real botella | PASS | Hay ventas reales Winerim/Agora conciliadas y visibles como `TPV` con hora real. |
| Venta real copa | PENDING_EXTERNAL | Falta marcar una de las nuevas copas en Agora y comprobar historial `TPV`, hora, variante, stock e idempotencia. |
| Venta real magnum | PENDING_EXTERNAL | Hay `14` magnums elegibles, pero no aparece una venta real reciente de magnum en la ventana auditada. |

## Estructura Winerim actual

| Familia | Total en Agora | Vendibles | Retirados ocultos |
|---|---:|---:|---:|
| TINTOS WINERIM | 169 | 155 | 14 |
| BLANCOS WINERIM | 127 | 112 | 15 |
| ROSADOS WINERIM | 5 | 5 | 0 |
| ESPUMOSOS WINERIM | 27 | 27 | 0 |
| FORTIFICADOS WINERIM | 1 | 1 | 0 |
| DULCE WINERIM | 3 | 3 | 0 |
| MAGNUM WINERIM | 15 | 14 | 1 |
| COPAS WINERIM | 31 | 31 | 0 |

## Conciliacion de la incidencia antigua

Agora contiene una sola venta cerrada de cada referencia siguiente el 15/07.
El piloto intradia anterior al parche creo tarjetas Winerim repetidas cada cinco
minutos. Se conservara la primera tarjeta que representa la venta real y se
anularan exclusivamente las posteriores.

| Vino | Venta real Agora | Conservar | Anular |
|---|---|---:|---|
| Pazo de Senorans | Factura `19310`, linea `14:57:55`, 1 botella | `140531` | `140539`, `140547`, `140551`, `140556`, `140562`, `140640`, `140641` |
| Silius Mimosa | Factura `19317`, linea `18:02:39`, 1 botella | `140669` | `140661`, `140666`, `140668` |
| Raices das Bouzas Tinto | Factura `19331`, linea `20:22:30`, 1 botella | `140826` | `140832`, `140835`, `140844`, `140856` |
| Veigamoura Triopo | Factura `19333`, linea `21:21:53`, 1 botella | `140940` | `140918`, `140929` |

`Bancales Olvidados` (`142290`) procede de un ticket abierto del 17/07 que
desaparecio antes del cierre. El middleware ya restauro su unidad y el stock
actual es `22`; por eso la correccion segura consta de dos pasos:

1. Anular `142290`, lo que elevara temporalmente el stock a `23`.
2. Ajustar `23 -> 22` con `No, solo ajuste`, sin crear una nueva venta.

## Snapshot previo a la limpieza

Capturado a `2026-07-20T13:23:30Z`:

| Vino | StockId | Stock antes | Incremento por anulaciones | Stock esperado |
|---|---:|---:|---:|---:|
| Pazo de Senorans | `295343` | 138 | +7 | 145 |
| Silius Mimosa | `367411` | 0 | +3 | 3 |
| Raices das Bouzas Tinto | `331718` | 7 | +4 | 11 |
| Veigamoura Triopo | `369138` | 0 | +2 | 2 |
| Bancales Olvidados | `313191` | 22 | +1 y ajuste -1 | 22 |

Los valores esperados solo son validos si no hay nuevas ventas reales de esas
referencias durante la intervencion. La verificacion final debe basarse en el
delta de cada anulacion, no en sobrescribir el stock con estos numeros.

## Rollback

- No se modifica Agora ni se elimina ningun documento proveedor.
- La lista anterior conserva todos los IDs, horas, cantidades y precios de las
  tarjetas afectadas.
- Si una anulacion se demostrara incorrecta, la venta se debe restaurar con
  `sales/import` usando un identificador externo determinista y sin crear una
  segunda deduccion manual.
- No usar un PUT de stock como sustituto de la historia. Bancales es la unica
  excepcion calculada y debe marcarse expresamente como `solo ajuste`.

## Criterio de cierre

Tras autorizacion:

1. Anular las `17` tarjetas listadas y verificar cada delta de stock.
2. Ejecutar el ajuste `solo ajuste` de Bancales.
3. Repetir la auditoria Agora vs ERP y exigir cero diferencias, salvo la linea
   Pepe Luis cuyo `CreationDate` real es 27/06 aunque la factura cerro el 16/07.
4. Ejecutar dos ciclos de cinco minutos y confirmar que no reaparece ninguna
   tarjeta.
5. Mantener `LIVE_AUTOMATIC`; firmar `100%_SIGNED_OFF` solo con la limpieza,
   una venta real de copa y una venta real de magnum si el cliente utiliza ese
   formato.

## Excepcion de copas internas solicitada el 20/07

Casa Nene confirma que necesita 31 botones de copa en Agora para el equipo,
pero no quiere mostrar esas copas al cliente en la carta publica de Winerim.
La lista, precios, guardas y rollback estan en
`docs/operations/casa-nene-hidden-glass-policy-2026-07-20.md`.

Lovable Cloud ejecuta `agora-proxy` desde `5d30421`. Una sonda segura confirmo
`would_queue:GLASS` para la referencia ausente de cache y la auditoria previa
devolvio exactamente `31 MISSING`, sin diferencias ni colisiones.

Las `31` variantes se publicaron exclusivamente como `GLASS` en siete lotes
de cinco como maximo. Cada lote termino en `MATCH`; la auditoria final devolvio
`348/348 MATCH`, la cola quedo vacia y botella/magnum inactivos continuan
bloqueados. La evidencia machine-readable queda en
`docs/operations/agora-catalog-reconciliation-2026-07-20T14-53-35-126Z/`.
La auditoria posterior a la siguiente ventana automatica mantuvo `31/31 MATCH`,
cero tareas activas y cero alertas. Falta una venta real de copa para cerrar el
flujo de ventas.
