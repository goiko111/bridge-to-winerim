# Katsu Izakaya · lectura Winerim vs Agora

> Fecha: 2026-06-17. Alcance: auditoria solo lectura. No se hizo import XML, no se encolo nada, no se guardaron ventas, no se descontó stock y no se cambio ningun flag.

## Resumen ejecutivo

- Katsu responde correctamente por API Agora (`Families`, `Products`, `Invoices`) y Winerim API v2 responde con detalle de los 67 vinos vivos.
- La conexion esta activa: `enabled=true`, `catalog_sync_enabled=true`, `write_mode=XML_IMPORT`, breaker limpio y cola abierta `0`.
- Politica actual Katsu: botellas si (`auto_push_bottle=true`), copas no (`auto_push_glass=false`, `write_glass=false`), magnum si hay precio, y `auto_push_verified_ready=false`.
- Con esa politica, Winerim deberia aportar `66` formatos publicables: `64` botellas y `2` magnums. En Agora hay `52` visibles/vendibles correctamente, `3` existen pero estan en familia legacy oculta, y `11` faltan.
- Hay `8` familias Winerim visibles y `0` productos Winerim como boton raiz, lo cual respeta la politica visual.
- Las familias legacy de vino detectadas estan ocultas: `0` legacy real visible/vendible. No se borro legacy.
- Stock/ventas: desde 2026-06-01 hay `283` ventas guardadas y `2554` lineas, pero `0` lineas mapeadas y `0` `stock_sync_log`. Por tanto Katsu baja ventas, pero hoy no se puede declarar descuento automatico de stock correcto hasta resolver mappings/venta de prueba.

## Datos de conexion

- POS: `Katsu Izakaya` (`http://setup.ath.cx:9049`).
- Ultimo dia sincronizado: `2026-06-16`; ultimo sync: `2026-06-17T11:00:24.286+00:00`.
- Capacidades Lovable Cloud: `READY` / `XML_IMPORT` / write `YES`.
- Breaker: `None`; fallos consecutivos: `0`.
- Cola abierta (`QUEUED/RUNNING/FAILED/BLOCKED`): `{}`.

## Catalogo Agora vivo

- Familias: `42` (`11` visibles).
- Productos: `1212` (`771` vendibles, `0` botones raiz).
- Familias Winerim: `8`; productos Winerim con evidencia mapping/tracking/familia Winerim: `85`; vendibles: `62`; raiz: `0`.

| Familia Winerim | Visible | Productos | Vendibles | Raiz |
|---|---:|---:|---:|---:|
| TINTOS WINERIM | True | 24 | 14 | 0 |
| COPAS WINERIM | True | 3 | 2 | 0 |
| ROSADOS WINERIM | True | 1 | 0 | 0 |
| DULCE WINERIM | True | 6 | 4 | 0 |
| BLANCOS WINERIM | True | 26 | 20 | 0 |
| MAGNUM WINERIM | True | 2 | 2 | 0 |
| FORTIFICADOS WINERIM | True | 4 | 4 | 0 |
| ESPUMOSOS WINERIM | True | 11 | 8 | 0 |

## Winerim vivo y cobertura esperada

- Winerim API v2: `67` vinos vivos, `67` activos, `0` fallos de detalle.
- Activos con precio: botella `64`, copa `64`, magnum `2`.
- Copas con precio no se cuentan como faltantes porque Katsu tiene `auto_push_glass=false` y `write_glass=false`.
- Cobertura por politica actual: `52` visibles/vendibles, `3` en familia oculta, `11` faltantes.

### Faltan en Agora segun politica actual

- `277094` `BOTTLE` · Abad Dom Bueno Rosado (rosado) → esperado `777094`.
- `277100` `BOTTLE` · Finca Martelo Reserva (tinto) → esperado `777100`.
- `277148` `BOTTLE` · Luis XIV Ánforas (tinto) → esperado `777148`.
- `275753` `BOTTLE` · Château Cristi Chardonnay (blanco) → esperado `775753`.
- `277143` `BOTTLE` · Biu Blanc (blanco) → esperado `777143`.
- `277144` `BOTTLE` · Private Collection Chardonnay (blanco) → esperado `777144`.
- `277146` `BOTTLE` · Lawson's Dry Hills Riesling (blanco) → esperado `777146`.
- `277149` `BOTTLE` · Chablis 1er Cru 'Fourchaume' (blanco) → esperado `777149`.
- `277151` `BOTTLE` · Chablis 1er Cru 'Vaulorent' (blanco) → esperado `777151`.
- `277153` `BOTTLE` · Malagousia (blanco) → esperado `777153`.
- `277154` `BOTTLE` · Lawson's Dry Hills Gewürztraminer (blanco) → esperado `777154`.

### Existen, pero en familia legacy oculta

- `272870` `BOTTLE` · Dulas Rosé → `B. DULAS ROSÉ` en `VINOS` (`FamilyId=33`), familia no visible.
- `272890` `BOTTLE` · Saiaz Rosado → `B. SAIAZ ROSADO` en `VINOS` (`FamilyId=33`), familia no visible.
- `272845` `BOTTLE` · Abad Dom Bueno Godello Esencia → `B. ABAD DOM BUENO GODELLO ESENCIA` en `VINOS` (`FamilyId=33`), familia no visible.

## Productos Winerim no esperados ahora

- Total no esperados por politica/live actual: `30`.
- `mapping_rejected_terminal_or_deleted_winerim`: `27`.
- `glass_product_present_but_auto_push_glass=false`: `3`.
- Vendibles relevantes:
  - `772846` `BOTTLE` · B. SAN SALVADOR GODELLO → `VINOS` visible=False · mapping=REJECTED tracking=FAILED · mapping_rejected_terminal_or_deleted_winerim.
  - `772848` `BOTTLE` · B ALPHA ESTATE MALAGOUZIA TURTLES VINEYARD → `VINOS` visible=False · mapping=REJECTED tracking=FAILED · mapping_rejected_terminal_or_deleted_winerim.
  - `772855` `BOTTLE` · B. CROCODILE´S LAIR KAAIMANSGAT CHARDONNAY → `VINOS` visible=False · mapping=REJECTED tracking=FAILED · mapping_rejected_terminal_or_deleted_winerim.
  - `772862` `BOTTLE` · B. CHAVY-CHOUET LES FEMELOTTES BOURGOGNE BLANC → `VINOS` visible=False · mapping=REJECTED tracking=FAILED · mapping_rejected_terminal_or_deleted_winerim.
  - `972845` `GLASS` · C. SAN SALVADOR GODELLO → `VINOS POR COPAS` visible=False · mapping=CONFIRMED tracking=VERIFIED · glass_product_present_but_auto_push_glass=false.
  - `972883` `GLASS` · C Majuelo del Chiviritero La Seca → `COPAS WINERIM` visible=True · mapping=CONFIRMED tracking=VERIFIED · glass_product_present_but_auto_push_glass=false.
  - `975433` `GLASS` · C Forster Pechstein Riesling GG Dry → `COPAS WINERIM` visible=True · mapping=CONFIRMED tracking=VERIFIED · glass_product_present_but_auto_push_glass=false.

## Legacy

- Familias legacy de vino detectadas por heuristica: `5`.
- Productos legacy reales: `239`; vendibles: `225`; visibles+vendibles: `0`.
- Pre-match legacy contra Winerim vivo: `26` match, `8` review, `205` no-match.
- Lectura: el legacy no molesta visualmente porque las familias estan ocultas, pero sigue siendo material de rollback/matching. No conviene borrar.

## Ventas y stock

- Ventas en Lovable Cloud desde 2026-06-01: `283` documentos y `2554` lineas.
- Lineas mapeadas desde 2026-06-01: `0`.
- Lineas marcadas como candidatas vino desde 2026-06-01: `1390`; este contador sigue contaminado por clasificacion y no equivale a vinos pendientes reales.
- `stock_sync_log` desde 2026-06-01: `0`.
- Probe `Invoices` lectura directa reciente:
  - `2026-06-16`: `16` facturas, `154` lineas.
  - `2026-06-13`: `45` facturas, `430` lineas.
  - `2026-06-12`: `37` facturas, `353` lineas.
  - `2026-06-11`: `22` facturas, `228` lineas.
  - `2026-06-10`: `16` facturas, `149` lineas.
  - `2026-06-09`: `19` facturas, `174` lineas.

## Interpretacion

- Katsu esta conectado y lee ventas; no hay problema de conectividad ni breaker.
- Katsu no esta al dia como catalogo automatico Winerim: hay 11 botellas activas con precio que deberian estar publicadas y no estan, probablemente porque `auto_push_verified_ready=false` mantiene pausado el autopush seguro.
- Tres vinos Winerim existen en Agora pero estan en `VINOS`, que esta oculta. Para sala equivalen a no visibles aunque el producto exista.
- Las copas no estan configuradas para auto-publicacion, aunque hay 3 copas Winerim historicas confirmadas. Hay que decidir si Katsu debe vender copas Winerim o mantenerlas apagadas.
- Stock no debe prometerse como automatico en Katsu todavia: no hay ventas recientes mapeadas ni descuentos registrados.

## Recomendacion

1. Mantener este resultado como pre-check solo lectura y no activar cambios masivos sin dry-run.
2. Preparar un dry-run controlado para publicar los 11 faltantes y mover/republicar los 3 que estan en familia oculta hacia sus familias Winerim correctas.
3. Antes de activar `auto_push_verified_ready=true`, validar que el runtime diferencial ya esta desplegado y que `fetch-catalog` no genera cola masiva.
4. Decidir politica de copas en Katsu: si quieren copas automaticas, activar `auto_push_glass/write_glass` solo tras prueba; si no, dejar las existentes documentadas o ocultarlas de forma reversible.
5. Para stock, ejecutar fase de matching/venta de prueba: primero botella Winerim, luego copa si se activa, y validar `sales_line_items.mapped=true` + `stock_sync_log.SUCCESS` con `variant` y `stock_id`.

## Artefactos

- `KATSU_WINERIM_EXPECTED_POLICY_TO_AGORA_2026-06-17.csv` — formatos esperados por politica Katsu vs Agora.
- `KATSU_AGORA_WINERIM_PRODUCTS_2026-06-17.csv` — productos Winerim detectados por familia/mapping/tracking.
- `KATSU_AGORA_WINERIM_NOT_EXPECTED_2026-06-17.csv` — residuos/no esperados actuales.
- `KATSU_LEGACY_TO_WINERIM_LIVE_MATCH_2026-06-17.csv` — pre-match legacy contra Winerim vivo.
- `KATSU_AGORA_FAMILY_STRUCTURE_2026-06-17.csv` — estructura de familias Agora.
