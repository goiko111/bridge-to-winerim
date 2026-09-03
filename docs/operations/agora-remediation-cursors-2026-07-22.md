# Remediacion de cursores Agora - 2026-07-22

## Alcance y garantias

Se revisaron exclusivamente:

- Abadia Yuste;
- El Higueron;
- Finca Eslava.

La operacion fue de diagnostico fresh y no produjo escrituras:

- no se ejecuto `save-sales`, `sync-stock`, `auto-sync-sales` ni una cola;
- no se adelantaron cursores por SQL;
- no se escribieron tickets provisionales;
- no se modificaron mappings, stock, historial Winerim ni configuracion;
- no se editaron funciones compartidas y no hubo despliegues.

Snapshot autoritativo previo:

`outputs/AGORA_CURSOR_REMEDIATION_SNAPSHOT_2026-07-22T2026-07-22T11-25-50-047Z.json`

Operador reproducible:

`tmp/agora-remediation-cursors-2026-07-22.mjs`

## Metodo

1. Se leyeron fresh las facturas cerradas mediante `fetch-day`.
2. Se reprodujo la precedencia de resolucion de produccion:
   `REJECTED` bloquea; tracking `VERIFIED/PUSHED` prevalece; mapping
   `CONFIRMED` solo completa productos no resueltos.
3. Se separaron los candidatos estrictos de vino de los productos con una
   puntuacion baja `NEEDS_REVIEW`. La heuristica actual puede marcar alimentos
   por rango de precio; esos falsos positivos no autorizan ni bloquean una
   escritura por si solos.
4. Se cruzaron alertas, cola activa, logs de stock y el estado reciente de
   tickets abiertos.
5. Se exigio que todos los vinos del primer dia pendiente tuvieran mapping
   univoco antes de permitir cualquier avance.

## Resultado ejecutivo

| Conexion | Cursor antes/despues | Ultimo cierre visto | Primer dia pendiente | Bloqueo seguro |
|---|---|---|---|---|
| Abadia Yuste | `2025-03-16` / sin cambio | `2026-07-20` | no demostrable: existe hueco desde `2025-03-17` | hueco no escaneado, ventas legacy sin mapping, tickets huerfanos y un fallo de stock |
| El Higueron | `2026-07-14` / sin cambio | `2026-07-22` | `2026-07-15` | el primer dia contiene ventas de vino legacy sin mapping; tickets abiertos antiguos fijan el techo en `2026-07-14` |
| Finca Eslava | `2026-07-18` / sin cambio | `2026-07-22` | `2026-07-19` | el primer dia contiene copas legacy genericas sin mapping; tickets antiguos fijan el techo en `2026-07-18` |

No se importo ningun delta. Es el resultado correcto: cualquier avance habria
omitido ventas reales o exigido inventar una equivalencia.

## Abadia Yuste

### Hechos fresh

- Cursor: `2025-03-16`.
- Ventana inspeccionada: `2026-06-07..2026-07-21`, 45 dias.
- Existe un hueco no demostrado entre `2025-03-17` y `2026-06-06`.
- En la ventana se detectaron 214 lineas candidatas estrictas no resueltas y
  46 IDs de producto distintos. La lista conservadora incluye algunos falsos
  positivos por nombre, pero contiene numerosos vinos legacy reales.
- Ejemplos de venta legacy real: `Copa Ribera del duero`, `Copa Vino
  extremeno`, `Copa vino BLANCO Marq. Riscal`, `Copa Rioja`, `Copa semidulce`,
  `Valdesil Godello`, `Nadir`, `Malleolus` y `Ruiz Torres Verdejo`.
- Agora sigue devolviendo como abiertos dias `2025-03-17`, `2025-03-26`,
  `2025-08-28`, `2026-05-17` y `2026-07-19`. Este endpoint no representa solo
  tickets vivos y no puede gobernar un avance de cursor.
- Existe un fallo de stock del `2026-07-17` para Winerim `142911`, botella,
  por un HTTP 500 de `/stock/wine/142911`. No se reintento porque una
  deduccion parcial previa no esta descartada.

### Decision operativa

No desactivar aun el guard de tickets ni ejecutar el cron. Al retirar el techo,
el flujo intentaria atravesar un backlog de mas de un ano con mappings
incompletos. Antes se necesita:

1. fijar una fecha de go-live demostrable o inspeccionar todo el hueco;
2. mapear manualmente los vinos legacy univocos;
3. clasificar como no-vino los falsos positivos sin convertirlos en mapping;
4. resolver el fallo de `142911` con evidencia de stock e historial, no por
   replay ciego.

## El Higueron

### Hechos fresh

- Cursor: `2026-07-14`.
- Se revisaron todos los dias `2026-07-15..2026-07-21`.
- Hay facturas cerradas en 15, 16, 17, 18, 19 y 21 de julio.
- El primer dia pendiente, `2026-07-15`, contiene 65 lineas estrictas de vino
  legacy sin mapping.
- En toda la ventana hay 520 lineas estrictas sin resolver y 80 IDs distintos.
  Entre los mas usados: `C EMILIO MORO`, `C JOSE PARIENTE`, `C CANECO`,
  `C TRIAY`, `C GRIMAU`, `C VALDELAINOS`, `C VALLE DE NABAL`, `C EYA
  BLANCO` y `C VIÑA ZORZAL CHARDONNAY`.
- Tambien hay falsos positivos no vinicolas como tinto de verano, vermut y
  brandy; se conservaron separados y no se mapearon.
- Cinco ventas desde productos Winerim si estan resueltas en 16, 17, 18 y 21
  de julio, pero no pueden procesarse saltando el resto del mismo ciclo.
- El endpoint abierto devuelve dias `2026-07-15`, `2026-07-21` y
  `2026-07-22`; el dia 15 fija el techo exactamente en `2026-07-14`.

### Decision operativa

No avanzar ni importar solo las cinco lineas resueltas. La unidad idempotente
es la factura/grupo definitivo, no una seleccion parcial sin garantia. El
siguiente paso es revisar por SKU/nombre unico los 80 IDs, confirmar mappings
de botella/copa y mantener genericos sin mapping. Despues se procesara desde
`2026-07-15` en orden cronologico.

## Finca Eslava

### Hechos fresh

- Cursor: `2026-07-18`.
- Se revisaron todos los dias `2026-07-19..2026-07-21`.
- El primer dia pendiente, `2026-07-19`, ya contiene copas legacy sin mapping.
- Hay 46 lineas candidatas estrictas no resueltas. De ellas, 17 son falsos
  positivos de `TINTO LIMON` o `TINTO VERANO`; las 29 restantes corresponden
  a siete botones de copa legacy.
- Los botones de vino pendientes son `COPA TINTO`, `COPA BLANCO`, `COPA
  FRIZANTE`, `COPA MALAGA VIRGEN`, `COPA NPU`, `COPA ROSADO` y `COPA TIO
  PEPE`, con formatos genericos o no univocos.
- Una venta Winerim, `B Pago de Los Capellanes`, esta resuelta el 21 de julio,
  pero no se puede importar saltando los dias 19 y 20.
- El endpoint abierto devuelve dias `2026-07-19`, `2026-07-21` y
  `2026-07-22`; el dia 19 fija el techo exactamente en `2026-07-18`.

### Decision operativa

No mapear una copa generica a una referencia concreta y no avanzar el cursor.
El cliente debe indicar que vino real representa cada boton generico, o cambiar
la operativa para marcar una referencia Winerim. Solo entonces se procesaran
los dias 19, 20 y 21 en orden.

## Recuperacion segura pendiente

La secuencia autorizable cuando existan mappings completos es:

1. snapshot fresh de conexion, facturas, mappings, eventos y logs;
2. desactivar la observacion de tickets huerfanos manteniendo
   `open_tickets_stock_sync_enabled=false`;
3. procesar el primer dia pendiente mediante el flujo definitivo normal;
4. verificar en Winerim hora, variante, stock e idempotencia;
5. continuar dia por dia, sin saltos;
6. resolver la alerta solo cuando el cursor avance realmente.

No se debe adelantar el cursor por SQL, procesar solo una linea de una factura,
usar fuzzy matching como escritura ni compensar stock para fabricar historia.
