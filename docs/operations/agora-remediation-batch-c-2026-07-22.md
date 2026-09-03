# Agora remediation batch C - 2026-07-22

## Alcance y garantias

- Alcance exclusivo: Luruna, Restaurante Triana y Restaurante Cienvinos Ecija.
- Se leyeron `AGENTS.md`, `PROJECT_CONTEXT.md`, `CURRENT_STATE.md`, `DECISIONS_LOG.md` y `NEXT_STEPS.md` antes de operar.
- No se edito codigo compartido ni ningun documento de sesion.
- Todas las decisiones de escritura partieron de snapshot y dry-run y usaron precondiciones que abortaban ante cambios concurrentes.
- No se reprocesaron ventas, no se reimporto stock y no se ejecuto ninguna venta canary.
- No se modifico visibilidad de productos en Agora.

Artefactos:

- Snapshot anterior: `outputs/AGORA_REMEDIATION_BATCH_C_BEFORE_2026-07-22.json`
- Dry-run: `outputs/AGORA_REMEDIATION_BATCH_C_DRY_RUN_2026-07-22.json`
- Cambios aplicados: `outputs/AGORA_REMEDIATION_BATCH_C_APPLIED_2026-07-22.json`
- Verificacion posterior: `outputs/AGORA_REMEDIATION_BATCH_C_VERIFIED_2026-07-22.json`
- Rollback: `outputs/AGORA_REMEDIATION_BATCH_C_ROLLBACK_2026-07-22.json`
- Snapshot de politica de tickets abiertos: `outputs/AGORA_REMEDIATION_BATCH_C_OPEN_TICKETS_BEFORE_2026-07-22.json`
- Dry-run de politica de tickets abiertos: `outputs/AGORA_REMEDIATION_BATCH_C_OPEN_TICKETS_DRY_RUN_2026-07-22.json`
- Cambio de politica aplicado: `outputs/AGORA_REMEDIATION_BATCH_C_OPEN_TICKETS_APPLIED_2026-07-22.json`
- Verificacion de politica: `outputs/AGORA_REMEDIATION_BATCH_C_OPEN_TICKETS_VERIFIED_2026-07-22.json`
- Rollback de politica: `outputs/AGORA_REMEDIATION_BATCH_C_OPEN_TICKETS_ROLLBACK_2026-07-22.json`

## Resultado ejecutivo

| Conexion | Resultado | Catalogo fresh | Cambios aplicados | Pendiente seguro |
|---|---|---:|---|---|
| Luruna | WARN | 140/140, sin diferencias | Campillo remapeado al sustituto accesible | 4 legacy vendidos sin equivalencia exacta |
| Restaurante Triana | WARN | 129/129, sin diferencias | Copas activadas y 9 mappings exactos creados | Canary real y revision humana de legacy no inequívoco |
| Restaurante Cienvinos Ecija | PASS con observacion historica | 519/519, sin diferencias | Manzanilla Zuleta clasificada como ignorada | No reabrir dos intentos provisionales de 14/07 |

Las tres conexiones quedaron sin cola activa y sin alertas `OPEN` o `ACKED` al finalizar.

## Luruna

### Hechos

Se verificaron por ID los cuatro productos legacy vendidos sin mapping:

| Agora ID | Producto | Formato | Resultado de matching |
|---:|---|---|---|
| 1330 | COPA LUIS ALEGRE CRIANZA | GLASS | Sin candidato activo exacto |
| 1164120 | Copia de RAMON BILBAO | BOTTLE | Sin candidato activo exacto |
| 676 | COPA GRAN FEUDO NAVARRO | GLASS | Sin candidato activo exacto |
| 346 | COPA LUIS CAÑAS CARB. COSECHERO | GLASS | Sin candidato activo exacto |

No se creo ningun mapping para esos cuatro productos. Un mapping aproximado podria atribuir ventas al vino o variante incorrectos.

El producto Agora `818`, `CAMPILLO 2021 CRIANZA`, apuntaba al Winerim `156687`, rechazado por estar inactivo o inaccesible. Se encontro el sustituto activo exacto `156694`, mismo nombre y añada, botella con precio y stock ID `182578`. La consulta fresh de stock devolvio HTTP 200.

### Cambio aplicado

- Mapping `dc812e0e-23bc-40c9-b405-bf6d8ad090e8`:
  - antes: Winerim `156687`, `REJECTED`;
  - despues: Winerim `156694`, `CONFIRMED`, `BOTTLE`, `MANUAL_EXACT_REPLACEMENT`.
- No se hizo replay de la venta fallida ni de ningun documento historico.

### Verificacion

- Catalogo fresh: `140/140 MATCH`, `missing=0`, `different=0`, `unowned=0`.
- Sustituto Campillo accesible en Winerim: si, HTTP 200.
- Breaker: cerrado.
- Cola activa: 0.

### Pendiente

Los cuatro legacy requieren identificacion del cliente o un dato fuerte adicional, como SKU/codigo compartido. Hasta entonces deben permanecer sin mapping.

## Restaurante Triana

### Hechos

- Hay 30 formatos GLASS con ownership verificado.
- La conexion estaba preparada para botella pero `auto_push_glass=false`.
- El dry-run posterior sobre Winerim `322983` devolvio `would_queue:BOTTLE+GLASS`, con `queued=0`; confirma que el flujo de copa es elegible sin ejecutar escritura.
- Se localizaron 9 legacy vendidos con nombre normalizado unico, vino Winerim activo y precio positivo en la variante solicitada.

### Cambios aplicados

- `auto_push_glass`: `false -> true`.
- Mappings `CONFIRMED`, todos `BOTTLE`, metodo `MANUAL_EXACT_PRODUCTION`:

| Agora ID | Legacy | Winerim ID | Winerim |
|---:|---|---:|---|
| 1709 | La Caprichosa | 248644 | La Caprichosa |
| 187 | Habla del Silencio | 248711 | Habla del Silencio |
| 1920 | Mar de Frades | 288884 | Mar de Frades |
| 1715 | Valduero 2 Maderas | 248702 | Valduero 2 Maderas |
| 1122 | Juan Gil Etiqueta Azul | 248688 | Juan Gil Etiqueta Azul |
| 1239 | Hito | 248691 | Hito |
| 1663 | Louro | 248647 | Louro |
| 1497 | Protos 27 | 248697 | Protos 27 |
| 1888 | Quinta del 67 | 288905 | Quinta del 67 |

No se mapearon genericos ni productos sin coincidencia exacta. El dry-run mantiene 84 candidatos no inequívocos como `NO_WRITE`.

### Contradiccion detectada en los dos supuestos retirados

Los IDs propuestos para ocultar no pertenecen fresh a los vinos retirados esperados:

| Agora ID | Propietario esperado por tracking antiguo | Producto fresh real | Estado fresh |
|---:|---|---|---|
| 1211359 | 311359 / MAGNUM | Dehesa Gago | Vendible |
| 1211360 | 311360 / MAGNUM | Dehesa Gago Copa | Vendible |

Es una colision historica de IDs. Ocultarlos habria retirado dos productos legacy distintos. Por ello no se realizo ninguna escritura de visibilidad. Antes de ocultar dos retirados debe recuperarse su ID fresh real o confirmar que ya no existen.

### Canary preparado

- Producto: `B La Caprichosa`
- Agora product ID: `748644`
- Winerim ID: `248644`
- Formato: `BOTTLE`
- Estado: ownership verificado, precio 20, stock ID `285521`.

El canary queda listo para una venta real controlada del cliente. No se ejecuto una venta sintetica.

### Verificacion

- Catalogo fresh: `129/129 MATCH`, `missing=0`, `different=0`, `unowned=0`.
- Nueve mappings exactos persistidos y verificados.
- Flujo GLASS habilitado y validado en dry-run sin cola.
- Breaker: cerrado.
- Cola activa: 0.

## Restaurante Cienvinos Ecija

### Diagnostico por documento

Se conservaron los fallos como evidencia y se comprobo su resultado por la misma clave idempotente. Los intentos definitivos fallidos ya tienen un `SUCCESS` posterior; no deben reimportarse.

| Dia | Documento | Producto | Resultado |
|---|---|---|---|
| 17/07 | 8719 | C Ramon Bilbao, 3 copas | Resuelto por SUCCESS posterior |
| 19/07 | 9277 | C NY Hood Moscato Blanco, 7 copas | Resuelto por SUCCESS posterior |
| 19/07 | 9273 | C Viña Caeira, 4 copas | Resuelto por SUCCESS posterior |
| 19/07 | 9297 | C SoHo'S Fino Spritz, 3 copas | Resuelto por SUCCESS posterior |
| 19/07 | 9297 | B Viña Caeira, 1 botella | Resuelto por SUCCESS posterior |
| 19/07 | 9297 | C Satinela Semidulce, 2 copas | Resuelto por SUCCESS posterior |
| 19/07 | 9297 | C Convento San Francisco Primer Año, 5 copas | Resuelto por SUCCESS posterior |
| 20/07 | 9511 | B Jose Pariente Verdejo, 1 botella | Resuelto por SUCCESS posterior |

Los dos fallos sin `SUCCESS` pertenecen a tickets abiertos provisionales del 14/07:

- `open_ticket:08dac010-dcb2-4a02-b45e-0f6f22d246eb`: C Ramon Bilbao, 3 copas.
- `open_ticket:6c596b89-53fb-4769-830a-0c5405ba65bb`: C Matsu El Picaro, 1 copa.

Las ventas aparecen despues en facturas definitivas del mismo dia. Ademas, la escritura de stock desde tickets abiertos esta desactivada en Cienvinos y las facturas cerradas son la autoridad. Se clasifican como intentos provisionales historicos y no se reproducen.

### Manzanilla Zuleta

- Agora product ID: `1181650`.
- Nombre: `C MANZANILLA ZULETA`.
- Familia: `COPAS WINERIM`, pero sin ownership Winerim.
- Actividad observada: 12 lineas recientes.
- Candidatos exactos activos en Winerim: 0.

Se creo una clasificacion explicita `IGNORED`, formato `GLASS`, metodo `MANUAL_CLASSIFICATION`, sin `winerim_wine_id`. Esto evita que el producto se reintente o se asigne por fuzzy matching. No registra ni descuenta estas ventas en un vino incorrecto.

### Verificacion

- Catalogo fresh: `519/519 MATCH`, `missing=0`, `different=0`, `unowned=0`.
- Fallos definitivos vivos pendientes de replay: 0.
- Reimportaciones o escrituras de stock ejecutadas: 0.
- Breaker: cerrado.
- Cola activa: 0.

## Cierre transversal: tickets abiertos solo como observabilidad

### Motivo

La lectura del runtime confirma que `sync-open-tickets` siempre conserva los tickets y sus lineas en el ledger interno cuando `open_tickets_sync_enabled=true`. La llamada que escribe historial o stock en Winerim solo se ejecuta si `open_tickets_stock_sync_enabled=true`.

Mantener esa escritura provisional introduce un riesgo funcional: una reduccion, cancelacion o cierre posterior del ticket puede dejar una tarjeta provisional en el historial y otra definitiva procedente de la factura. Mientras no exista una anulacion de venta idempotente, la politica segura es:

- tickets abiertos: lectura y observabilidad;
- facturas intradia/cerradas: unica fuente de escritura en Winerim;
- cierre diario: catch-up definitivo e idempotente.

### Snapshot y dry-run

Las dos conexiones cumplian antes de escribir:

| Precondicion | Luruna | Restaurante Triana |
|---|---|---|
| Conexion activa | si | si |
| `open_tickets_sync_enabled=true` | si | si |
| `open_tickets_stock_sync_enabled=true` | si | si |
| `intraday_sales_sync_enabled=true` | si | si |
| Ultimo intradia satisfactorio | si | si |
| Breaker cerrado | si | si |
| Cola activa vacia | si | si |

El dry-run aprobo una unica mutacion por conexion y cero replay de ventas, stock o cola.

### Cambio aplicado

Solo se modifico por conexion:

```text
provider_config.open_tickets_stock_sync_enabled: true -> false
```

Se conservaron todos los demas campos fresh de `provider_config`. No se edito codigo ni se desplego ninguna Edge Function.

### Verificacion fresh posterior

| Flag/estado | Luruna | Restaurante Triana |
|---|---|---|
| `open_tickets_sync_enabled` | `true` | `true` |
| `open_tickets_stock_sync_enabled` | `false` | `false` |
| `intraday_sales_sync_enabled` | `true` | `true` |
| Ultimo intradia satisfactorio | si | si |
| Cola activa | 0 | 0 |
| Alertas `OPEN`/`ACKED` | 0 | 0 |
| Breaker | cerrado | cerrado |

Resultado: tickets abiertos siguen visibles para diagnostico, pero Luruna y Triana ya no pueden escribir venta ni stock provisional en Winerim. Las facturas cerradas permanecen como fuente autoritaria.

## Rollback

El rollback completo esta descrito en `outputs/AGORA_REMEDIATION_BATCH_C_ROLLBACK_2026-07-22.json` e incluye:

1. Restaurar el mapping Campillo de Luruna a su fila anterior.
2. Eliminar exclusivamente los nueve mappings Triana creados por este lote.
3. Restaurar `auto_push_glass=false` en Triana.
4. Eliminar exclusivamente la clasificacion `IGNORED` de Manzanilla Zuleta.

El cambio transversal tiene un rollback independiente en `outputs/AGORA_REMEDIATION_BATCH_C_OPEN_TICKETS_ROLLBACK_2026-07-22.json`: leer cada `provider_config` fresh y fusionar solamente `open_tickets_stock_sync_enabled=true`, sin reemplazar el resto de claves.

No existe rollback de visibilidad, catalogo Agora, ventas o stock porque este lote no realizo esas escrituras.

## Estado final y siguientes validaciones

- Luruna: reparacion segura aplicada. Falta identificacion humana para cuatro legacy sin correspondencia exacta.
- Triana: publicacion automatica de copas habilitada y mappings exactos aplicados. Falta ejecutar y observar el canary real; los dos supuestos retirados deben reidentificarse por ID fresh antes de ocultarlos.
- Cienvinos: divergencia operativa viva reducida a cero fallos definitivos pendientes; Manzanilla Zuleta queda clasificada, no mapeada. No debe hacerse replay de los dos tickets provisionales del 14/07.
- Luruna y Triana: tickets abiertos en observabilidad, sin escritura provisional; facturas intradia y cerradas como unica fuente de escritura Winerim.
