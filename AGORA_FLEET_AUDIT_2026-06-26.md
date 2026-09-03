# AGORA_FLEET_AUDIT_2026-06-26

> Auditoria viva ejecutada el 2026-06-26 desde Lovable Cloud. No se imprimen ni documentan tokens.

## Hechos

- Se revisaron `12` conexiones Agora con:
  - sonda viva `agora-proxy` action `test`;
  - estado de `pos_connections`;
  - ventas en `sales_events`;
  - lineas mapeadas en `sales_line_items`;
  - descuentos en `stock_sync_log`;
  - publicaciones Winerim -> Agora en `winerim_push_tracking`;
  - cola `outbound_tasks`;
  - alertas persistentes `connection_alerts`.
- Fecha de referencia:
  - hoy: `2026-06-26`;
  - ayer: `2026-06-25`;
  - ventana de lineas/stock: ultimos 14 dias.
- El chequeo de catalogo compara formatos publicables desde `winerim_wines` contra tracking `VERIFIED/PUSHED`.
- No se ejecuto `fetch-catalog` en bloque porque puede encolar escrituras reales si hay flags automaticos activos.

## Resumen por conexion

| Conexion | Estado | Sonda | Ultimo dia ventas | Ventas 2026-06-25 | Lineas mapeadas 14d | Stock 14d | Catalogo verificado | Auto create/update | Cola abierta | Incidencias |
|---|---:|---|---|---:|---:|---|---:|---|---|---|
| Baco Getafe | READ_ONLY/PAUSED | OK | 2026-05-28 | 0 | 0 | `{}` | 0/118 | off/off | - | Legacy/revertido; no automatico. |
| Casa Nene | REVISAR | OK | 2026-06-25 | 60 | 83 | `SUCCESS=84` | 307/307 | on/on | `FAILED=1` | Conectividad recuperada. Ventas y stock funcionan. Revisar 1 tarea fallida. |
| Don Bernardo Ponzano | READ_ONLY/PAUSED | OK | 2026-06-22 | 0 | 0 | `{}` | 0/93 | off/off | - | Onboarding read-only; historico analitico sin stock. |
| Don Bernardo Santander | READ_ONLY/PAUSED | OK | 2026-06-22 | 0 | 0 | `{}` | 0/144 | off/off | - | Onboarding read-only; historico analitico sin stock. |
| Katsu Izakaya | REVISAR | OK | 2026-06-24 | 18 | 7 | `SUCCESS=6, FAILED=1` | 137/137 | on/off | - | Ventas Winerim ya llegan y descuentan copas. Fallo puntual en `C Saiaz Rosado` por Winerim 404. |
| Kava | REVISAR | OK | 2026-06-25 | 1 | 46 | `SUCCESS=45` | 204/221 | on/on | `FAILED=7, BLOCKED=9` | Ventas/stock recientes OK. Faltan 17 formatos esperados y hay deuda historica de cola. |
| La Candela de Triana | REVISAR | OK | 2026-06-25 | 121 | 0 | `{}` | 78/78 | on/on | - | Ventas llegan, pero no hay lineas mapeadas ni descuentos. |
| Luruna | REVISAR | OK | 2026-06-25 | 89 | 0 | `{}` | 124/126 | on/on | `FAILED=10, BLOCKED=58` | Ventas llegan, pero se venden legacy/no mapeado; sin stock reciente. |
| Restaurante Cienvinos Ecija | REVISAR | OK | 2026-06-25 | 379 | 130 | `SUCCESS=34` | 499/499 | on/off | `FAILED=3, BLOCKED=7` | Ventas y stock funcionan; deuda de cola y updates existentes apagados. |
| Restaurante Jardi | REVISAR | OK | 2026-06-25 | 12 | 23 | `SUCCESS=22` | 173/180 | on/off | `FAILED=3` | Conectividad recuperada. Ventas/stock funcionan. Faltan 7 formatos, todos copa. |
| Sa Pedrera | REVISAR | OK | 2026-06-17 | 0 | 111 | `SUCCESS=90, FAILED=36` | 470/470 | on/on | `FAILED=310, BLOCKED=12556` | Sonda OK, pero cursor atrasado y deuda masiva. Fallo repetido `C B310- Albenc [copa]`. |
| Sa Vida | REVISAR | 401 | 2026-06-23 | 0 | 0 | `{}` | 398/962 | on/on | `FAILED=4208, BLOCKED=2030` | Agora rechaza token/API. No reintentar cola hasta corregir 401. |

## Hallazgos clave

### Ventas que estan llegando y descontando

- `Casa Nene`: ventas hasta `2026-06-25`, descuentos `SUCCESS` recientes el `2026-06-26`.
- `Katsu Izakaya`: ventas Winerim reales ya entran; el `2026-06-26 09:25 UTC` hay copas con `SUCCESS`.
- `Kava`: ventas y descuentos recientes OK.
- `Cienvinos`: ventas y descuentos recientes OK, incluidas copas.
- `Jardi`: vuelve a responder OK; ventas y descuentos recientes OK.
- `Sa Pedrera`: hay lineas mapeadas y descuentos correctos, pero tambien fallos repetidos y el cursor sigue atrasado.

### Ventas que llegan pero no descuentan stock

- `La Candela de Triana`: ventas llegan, catalogo Winerim esta publicado (`78/78`), pero `mapped=0` y `stock_sync_log=0`.
- `Luruna`: ventas llegan, pero lineas recientes de vino salen como legacy (`BEBIDAS`, copas legacy), sin mapping Winerim reciente.

### Conexiones bloqueadas o no automaticas

- `Sa Vida`: bloqueada por `401`; no hay que procesar deuda ni stock hasta corregir token/API.
- `Baco Getafe`: apagado/revertido a legacy por decision previa.
- `Don Bernardo Ponzano/Santander`: read-only onboarding, sin stock ni escritura por decision.

### Catalogo Winerim -> Agora

- Completos segun tracking: `Casa Nene`, `Katsu`, `Cienvinos`, `Sa Pedrera`.
- Casi completos:
  - `Jardi`: `173/180`, faltan `7` formatos esperados, todos de copa.
  - `Kava`: `204/221`, faltan `17` formatos esperados.
  - `Luruna`: `124/126`, faltan `2` formatos esperados.
- `Sa Vida`: incompleto (`398/962`) y no fiable mientras Agora devuelva `401`.

## Hipotesis

- `La Candela` y `Luruna` probablemente siguen vendiendo desde botones legacy o familias que no resuelven a productos Winerim, aunque el catalogo Winerim exista.
- `Katsu C Saiaz Rosado` y `Sa Pedrera C B310- Albenc` revelan un bug de resolucion: un producto/formato oculto en `winerim_push_tracking` podia seguir resolviendo por fallback de `product_mappings.CONFIRMED`.
- `Jardi` ya no esta caido desde Lovable Cloud; la incidencia anterior de ruta/DDNS parece recuperada.

## Cambio aplicado en codigo

- En `buildSalesResolutionMap`, si un producto aparece en `winerim_push_tracking` pero no esta `VERIFIED`/`PUSHED`, ya no se usa el fallback de `product_mappings.CONFIRMED`.
- Objetivo: evitar que productos/formats ocultos (`HIDDEN`) sigan entrando como descontables por ventas residuales.
- Validacion local:
  - `npm test -- --run` OK (`18` tests);
  - `npm run build` OK;
  - bundle/parse de `supabase/functions/agora-proxy/index.ts` OK con esbuild + `node --check`.

## Tareas recomendadas

1. Desplegar `agora-proxy` con el guard de mapping oculto.
2. Reejecutar monitor/ventas tras deploy y confirmar que ventas residuales de formatos `HIDDEN` ya no generan nuevos fallos de stock.
3. Katsu:
   - revisar `Saiaz Rosado` en Winerim/Agora;
   - si debe estar fuera, confirmar que no se vende y dejarlo oculto;
   - si debe venderse, reactivarlo/aclarar ID Winerim accesible.
4. Sa Pedrera:
   - bloquear o corregir la copa de `B310- Albenc`;
   - clasificar cola masiva antes de cualquier retry;
   - revisar por que el cursor esta en `2026-06-17` aunque hay lineas recientes importadas.
5. La Candela y Luruna:
   - confirmar en tablet si venden desde familias/botones Winerim;
   - si siguen vendiendo legacy, crear/migrar mappings o pedir cambio operativo.
6. Jardi:
   - investigar los 7 formatos copa faltantes.
7. Kava:
   - investigar 17 formatos faltantes y deuda historica de cola.
8. Cienvinos:
   - revisar `3 FAILED / 7 BLOCKED`;
   - decidir si se corrige idempotencia de updates y se reenciende `auto_push_on_update`.
9. Sa Vida:
   - corregir token/API 401 antes de tocar cola.
