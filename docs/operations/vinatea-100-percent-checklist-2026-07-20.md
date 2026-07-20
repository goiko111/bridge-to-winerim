# Vinatea - checklist Agora

Fecha: `2026-07-20`

Conexion: `e465872a-bff5-43de-8e4c-fe4986f0fd4f`

Estado: `LIVE_AUTOMATIC / WARN_WINERIM_SALES_IMPORT / PENDING_RUNTIME_DEPLOY`

## Checklist

| Area | Estado | Evidencia |
|---|---|---|
| Conexion y autenticacion Agora | PASS | Conexion habilitada, breaker cerrado y lectura fresh disponible. |
| Configuracion general | PASS | `BIDIRECTIONAL`, frecuencia `5 min`, IVA `10 %`, almacen `1` y centros `4,12,15,16`. |
| Catalogo Winerim -> Agora | PASS | Reconciliacion fresh `132/132 MATCH`, cero ausentes, diferencias, productos sin ownership o tareas activas. |
| Familias Winerim | PASS | Copas `23`, tintos `61`, blancos `34`, rosados `4`, espumosos `9` y magnum `1`; dulce y fortificados no tienen referencias elegibles. |
| Tracking y mappings Winerim | PASS | Los `132` formatos Winerim estan verificados y sin cola pendiente. |
| Legacy visible | CONTROLADO | Se conservan visibles `16 CAVAS` y `22 BODEGA` hasta la validacion del cliente. No se restaura ninguna familia que ya estuviera oculta antes del onboarding. |
| Legacy oculto pero buscable | WARN CORREGIDO | Las familias `50-55` conservan producto vendible. Se anadieron `110` mappings exactos y reversibles para que sus ventas puedan resolverse mientras sigan accesibles. |
| Ventas botella | PASS PARCIAL | Cinco ventas reales llegaron al ERP con hora y decrementos correctos: Casa Masas, 12 Lunas Garnacha, Hado, La Clota y Libre y Salvaje Garnacha Blanca. |
| Ventas copa con stock inactivo | BLOCKED WINERIM | Se recuperaron `9` lineas / `16` copas mediante `/api/v2/sales/import`, con segunda pasada idempotente y stock inalterado. El ERP las representa como `9` botellas de cantidad `1`, pese a recibir stockIds de copa y cantidades correctas. |
| Idempotencia | PASS | Cero claves exactas repetidas; la segunda importacion historica devolvio `9 skipped`, `0 imported`, `0 failed`. |
| Stock historico | PASS | Snapshot antes y despues de las dos pasadas: cero cambios. Las botellas antiguas ya estaban registradas manualmente y no se duplicaron. |
| Tickets abiertos | PASS CON PARCHE PENDIENTE | Siete tickets abiertos del dia `2026-07-19`; el parche conserva ese dia por delante del cursor de cierres. |
| Dispatcher | PASS LOCAL / PENDIENTE RUNTIME | Orden local: tickets abiertos, intradia y cierre diario. `22` tests, TypeScript y build pasan; falta publicar las dos Edge Functions. |
| Alta/cambio de precio automatico | PENDIENTE CANARY | El catalogo esta exacto, pero no existe una alta o cambio real posterior a la activacion que permita medir propagacion. |
| Alertas | PASS | No se ha detectado cola activa ni fallo de catalogo actual. |

## Mappings legacy aplicados

- `105` coincidencias unicas y exactas de botella.
- `5` coincidencias de copa revisadas manualmente:
  - `1153` -> Winerim `145575`, `GLASS`.
  - `1154` -> Winerim `202269`, `GLASS`.
  - `1155` -> Winerim `198563`, `GLASS`.
  - `1156` -> Winerim `198559`, `GLASS`.
  - `1157` -> Winerim `198558`, `GLASS`.
- Metodo comun: `LEGACY_EXACT_20260720`.

No se modificaron familias, productos, precios ni visibilidad de Agora al
crear estos mappings.

## Correcciones de runtime preparadas

1. `agora-cron-dispatcher` atiende primero `sync-open-tickets`, despues
   `sync-intraday-sales` y por ultimo `auto-sync-sales`.
2. `sync-open-tickets` guarda los dias de negocio que siguen abiertos.
3. `auto-sync-sales` impide que `last_business_day_synced` avance por encima
   del dia abierto; si ya habia avanzado, lo retrocede al ultimo dia cerrado
   seguro y vuelve a escanear el cierre tardio.
4. El guard expira a los `30 min` por defecto y puede configurarse mediante
   `open_tickets_active_cursor_guard_minutes`.

## Incidencia Winerim API

La llamada historica uso los stockIds de copa `232231`, `232130`, `232129`,
`228114` y `228121`. `GET /stock/wine/{wineId}` confirma que todos pertenecen
a la variante `copa` y que el stock esta desactivado. El endpoint devolvio:

- primera pasada: `9 imported`, `0 failed`;
- segunda pasada: `0 imported`, `9 skipped`, `0 failed`;
- cantidad enviada: `16`;
- cambios de stock: `0`.

Sin embargo, el historial ERP muestra una tarjeta de botella y cantidad `1`
por linea importada. No se ejecutaran mas importaciones historicas de variantes
hasta que Winerim confirme y corrija la persistencia/renderizado de `stockId`,
`qty` y `soldAt`. Tampoco se cancelaran esas nueve tarjetas sin conocer el
efecto exacto de la cancelacion sobre el inventario.

## Rollback

### Mappings legacy

Eliminar exclusivamente los mappings de esta conexion cuyo `match_method` sea
`LEGACY_EXACT_20260720`. No tocar mappings XML/Winerim ni tracking.

### Runtime

Revertir los cambios de:

- `supabase/functions/agora-proxy/index.ts`;
- `supabase/functions/agora-cron-dispatcher/index.ts`;

y redesplegar solo esas dos funciones. No modificar manualmente el cursor sin
una lectura fresh de tickets e invoices.

## Pendiente para firmar el 100 %

1. Publicar las dos Edge Functions y verificar el orden real del dispatcher.
2. Confirmar que, mientras queden tickets del `19/07`, el cursor termina en
   `18/07`; al cerrarse, debe procesar el `19/07` una sola vez.
3. Corregir en Winerim `/sales/import` y reparar las nueve tarjetas importadas
   sin alterar stock.
4. Ejecutar una venta real de copa legacy y una desde `COPAS WINERIM`; ambas
   deben aparecer con variante, cantidad y hora correctas.
5. Hacer una alta o cambio de precio real en Winerim y medir propagacion en
   Agora dentro de la ventana de cinco minutos.
6. Acordar con el cliente si `CAVAS` y `BODEGA` siguen visibles o se ocultan de
   forma reversible.
