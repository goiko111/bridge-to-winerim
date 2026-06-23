# Don Bernardo · Agora Read-Only Audit · 2026-06-23

> No incluir tokens ni credenciales en este documento.

## Alcance

- Clientes:
  - Don Bernardo Ponzano: `a700d425-9194-4758-95ff-7fee86419e14`
  - Don Bernardo Santander: `79280cb8-0fe7-4a57-93a4-04172205ac70`
- Objetivo: alta en modo solo lectura, auditoria Agora/Winerim y backfill historico de ventas sin descuento de stock.
- Rango historico importado: `2026-03-23` a `2026-06-23`.

## Hechos comunes

- Ambas URLs Agora responden correctamente a lectura.
- `Invoices` funciona en ambos clientes.
- Se refresco master data Agora (`Families`, `Products`, IVA, listas de precio, almacenes, centros de venta, preparacion) sin escribir en Agora.
- Se refresco catalogo Winerim en Lovable Cloud:
  - Ponzano: `95` vinos leidos.
  - Santander: `147` vinos leidos.
- Las conexiones quedaron en modo read-only:
  - `enabled=false`
  - `catalog_sync_enabled=false`
  - `write_mode=NONE`
  - `auto_push_on_create=false`
  - `auto_push_on_update=false`
  - `auto_push_verified_ready=false`
  - `provider_config.read_only_onboarding=true`
  - `provider_config.stock_sync_start_date=2026-06-23`
- Backfill historico guardado como analitica:
  - `raw_json._winerim_import_mode="historical_analytics"`
  - `raw_json._stock_sync_eligible=false`
  - `sales_line_items.mapped=false`
  - `sales_line_items.winerim_product_id=null`
- Verificacion tras backfill:
  - `stock_sync_log` nuevo para estas conexiones: `0`
  - muestras de `sales_events.raw_json`: `historical_analytics`, `stockEligible=false`
  - consulta `sales_line_items mapped=true limit 1`: `[]` en ambos clientes.

## Incidencia detectada y correccion

- Hecho: la accion historica `sync-master-data` del runtime actual promociono temporalmente `write_mode` de `NONE` a `XML_IMPORT` al detectar master data.
- Impacto: no escribio en Agora ni creo cola, pero no es deseable en modo auditoria/read-only.
- Correccion viva: se reseteo inmediatamente Ponzano y Santander a `write_mode=NONE`.
- Correccion en codigo: commit `d9aae7f` modifica `agora-proxy` para que `sync-master-data` no promocione `write_mode` si `payload.preserveWriteMode=true` o `provider_config.read_only_onboarding=true`.
- Estado deploy: el commit esta subido a GitHub; Lovable Cloud aun devolvia `Unknown action` para `backfill-sales-analytics` en la ultima sonda, por lo que el backfill historico se ejecuto directamente contra Lovable Cloud con las mismas garantias de no stock.

## Backfill historico

| Cliente | Dias escaneados | Dias con ventas | Facturas guardadas | Lineas guardadas | Lineas candidatas vino | Errores |
|---|---:|---:|---:|---:|---:|---:|
| Don Bernardo Ponzano | 93 | 92 | 3.400 | 11.797 | 3.720 | 0 |
| Don Bernardo Santander | 93 | 92 | 6.883 | 22.351 | 6.909 | 0 |

## Ponzano · Lectura Agora

- `test`: OK.
- `Invoices`: OK.
- Ultimos 14 dias: ventas cerradas hasta `2026-06-22`, `342` facturas encontradas.
- Master data:
  - `150` familias;
  - `139` familias visibles;
  - `1.832` productos;
  - `1.813` productos vendibles;
  - `5` productos direct-sale;
  - `4` IVAs;
  - `3` listas de precio;
  - `1` almacen;
  - `8` centros de venta;
  - `8` tipos de preparacion;
  - `8` ordenes de preparacion.

### Ponzano · Winerim

- `95` vinos totales.
- `95` activos.
- `95` activos con algun precio.
- `93` con precio botella.
- `35` con precio copa.
- `0` con precio magnum.

### Ponzano · Estructura vino en Agora

Familias visibles principales:

| Familia Agora | Path | Productos | Vendibles |
|---|---|---:|---:|
| 22 · Vinos Barra | Vinos Barra | 34 | 34 |
| 117 · RIOJA | VINOS > RIOJA | 30 | 30 |
| 118 · RIBERA | VINOS > RIBERA | 25 | 25 |
| 142 · ESPUMOSOS | ESPUMOSOS | 20 | 20 |
| 141 · VINOS | VINOS | 10 | 10 |
| 71 · BOTELLAS RIOJA | BEBIDAS > BOTELLAS RIOJA | 9 | 9 |
| 73 · BOTELLAS RIBERA | BEBIDAS > BOTELLAS RIBERA | 8 | 8 |
| 53 · Vinos Botella | Vinos Botella | 6 | 6 |
| 75 · BOTELLAS BLANCO | BEBIDAS > BOTELLAS BLANCO | 6 | 6 |
| 146 · TORO | VINOS > TORO | 5 | 5 |

Familias ocultas de vino detectadas:

| Familia Agora | Path | Productos | Vendibles |
|---|---|---:|---:|
| 153 · MADRID | VINOS > MADRID | 1 | 1 |
| 157 · Valle de liebana (CANTABRIA) | VINOS > Valle de liebana (CANTABRIA) | 1 | 1 |
| 119 · VERDEJO | VERDEJO | 0 | 0 |
| 120 · ALBARINO | ALBARINO | 0 | 0 |
| 121 · GODELLO | GODELLO | 0 | 0 |
| 122 · CHAMPAGNE | CHAMPAGNE | 0 | 0 |
| 123 · CAVA | CAVA | 0 | 0 |

### Ponzano · Pre-match preliminar Winerim vs Agora

- Winerim operativos con precio: `95`.
- Match exacto por nombre normalizado: `58`.
- Match por codigo comercial: `0`.
- Sin match claro: `37`.
- Cobertura segura preliminar: `61,1%`.

Ejemplos con match:

- Ruinart Brut Rose
- Krug Brut Rose
- Krug Grande Cuvee
- Perrier-Jouet Grand Brut
- Perrier-Jouet Blanc de Blancs
- Perrier-Jouet Belle Epoque
- Belle Epoque Rose
- Bollinger Special Cuvee

Ejemplos sin match claro:

- Ruinart Blanc de Blancs Brut
- Dom Perignon Brut Vintage
- P2 Plenitude
- Gran Reserva Penas Aladas
- Castillo Ygay Gran Reserva Especial
- Benjamin Romeo Coleccion Nº1 la Vina de Andres Romeo
- Benjamin Romeo Coleccion Nº2 Carmen Hilera
- Benjamin Romeo Coleccion Nº4 Garnacha de la Dehesa
- Contador

## Santander · Lectura Agora

- `test`: OK.
- `Invoices`: OK.
- Ultimos 14 dias: ventas cerradas hasta `2026-06-22`, `1.158` facturas encontradas.
- Master data:
  - `126` familias;
  - `122` familias visibles;
  - `1.569` productos;
  - `1.550` productos vendibles;
  - `5` productos direct-sale;
  - `4` IVAs;
  - `2` listas de precio;
  - `1` almacen;
  - `8` centros de venta;
  - `8` tipos de preparacion;
  - `4` ordenes de preparacion.

### Santander · Winerim

- `147` vinos totales.
- `147` activos.
- `147` activos con algun precio.
- `144` con precio botella.
- `48` con precio copa.
- `0` con precio magnum.

### Santander · Estructura vino en Agora

Familias visibles principales:

| Familia Agora | Path | Productos | Vendibles |
|---|---|---:|---:|
| 113 · RIOJA | VINOTECA ABIERTA > RIOJA | 67 | 67 |
| 114 · RIBERA | VINOTECA ABIERTA > RIBERA | 37 | 37 |
| 22 · Vinos Barra | Vinos Barra | 34 | 34 |
| 122 · CHAMPAGNE | VINOTECA ABIERTA > CHAMPAGNE | 17 | 17 |
| 75 · BOTELLAS BLANCO | BEBIDAS > BOTELLAS BLANCO | 10 | 10 |
| 71 · BOTELLAS RIOJA | BEBIDAS > BOTELLAS RIOJA | 9 | 9 |
| 73 · BOTELLAS RIBERA | BEBIDAS > BOTELLAS RIBERA | 8 | 8 |
| 53 · Vinos Botella | Vinos Botella | 6 | 6 |
| 129 · Toro | VINOTECA ABIERTA > Toro | 5 | 5 |
| 126 · JEREZ | VINOTECA ABIERTA > JEREZ | 4 | 4 |
| 133 · PRIORAT | VINOTECA ABIERTA > PRIORAT | 4 | 4 |

Familias ocultas de vino detectadas: ninguna relevante.

### Santander · Pre-match preliminar Winerim vs Agora

- Winerim operativos con precio: `147`.
- Match exacto por nombre normalizado: `42`.
- Match por codigo comercial: `0`.
- Sin match claro: `105`.
- Cobertura segura preliminar: `28,6%`.

Ejemplos con match:

- Picon del Barroso
- San Roman
- Mirto
- Tomas Postigo 3º Ano
- Cristal Rose Brut
- Belle Epoque Rose
- Quinon de Valmira 2023
- PSI

Ejemplos sin match claro:

- Castillo Ygay Gran Reserva Especial Blanco
- Tumba del Rey Moro
- Contador
- Vina Tondonia Gran Reserva Rosado
- Sector 2.8
- Kalamity
- Clos Erasmus
- Lanzaga Las Beatas
- Trasnocho
- Vino Fino de Paraje Calizo
- El Corner del Puntido

## Hipotesis / riesgos

- El match preliminar usa nombre normalizado/codigo comercial, no una revision humana. Puede infra-contar matches si Agora usa abreviaturas internas o sobre-contar si hay nombres duplicados.
- Santander tiene un match inicial bajo (`28,6%`), por lo que no conviene activar autopush ni stock sin revisar mappings.
- Ponzano tiene estructura mixta: familias de `VINOS`, `VINOTECA ABIERTA`, `BEBIDAS > BOTELLAS...` y `Vinos Barra`. Hay que decidir donde deben caer nuevos vinos de Winerim.
- El historico importado no descuenta stock y no crea historial Winerim por API; queda guardado en Lovable Cloud para analitica/matching.

## Recomendacion

- Mantener ambos en read-only hasta validar con cliente/SAT:
  - si quieren conservar estructura Agora existente;
  - reglas para vinos nuevos de Winerim por tipo/region;
  - si `Vinos Barra` representa copas/operativa especial;
  - si las familias `BEBIDAS > BOTELLAS...` son operativas o residuales;
  - lista de no-match antes de confirmar stock.
- No ocultar legacy ni subir familias Winerim dedicadas todavia.
- Si todos los vinos a la venta estan en Winerim, preparar una propuesta de matching a familias existentes y solo despues activar catalogo automatico.

## Rollback

- POS: no hay rollback POS porque no se escribio en Agora.
- Conexiones: mantener `enabled=false`, `catalog_sync_enabled=false`, `write_mode=NONE` o eliminar las dos filas si se cancela el onboarding.
- Historico analitico: reversible eliminando `sales_events` de cada `connection_id` entre `2026-03-23` y `2026-06-23`; las lineas cuelgan por `ON DELETE CASCADE`.
- Stock: no hay rollback de stock porque `stock_sync_log=0` y no hubo llamadas Winerim stock.

## Borrador de correo · Ponzano

Buenos dias a todos,

Os comento lo que hemos visto tras la integracion en modo solo lectura para Don Bernardo Ponzano.

No hemos subido vinos, no hemos ocultado familias, no hemos tocado stock y no hemos escrito nada en Agora.

La URL API responde correctamente y las ventas cerradas por `Invoices` funcionan. Hemos localizado ventas cerradas hasta el 2026-06-22 y, en los ultimos 14 dias, vimos 342 facturas.

A nivel de estructura, Agora tiene 150 familias y 1.832 productos, con 1.813 productos vendibles. La bodega ya esta organizada en varias familias visibles, entre ellas `Vinos Barra`, `VINOS > RIOJA`, `VINOS > RIBERA`, `ESPUMOSOS`, `VINOS`, `BEBIDAS > BOTELLAS RIOJA`, `BEBIDAS > BOTELLAS RIBERA` y `BEBIDAS > BOTELLAS BLANCO`.

En Winerim hay 95 vinos activos con precio. El pre-match automatico por nombre detecta 58 coincidencias seguras y 37 vinos sin match claro, es decir, una cobertura preliminar del 61,1%.

Tambien hemos importado el historico de ventas desde el 2026-03-23 hasta el 2026-06-23 en modo analitico, sin descontar stock. Han entrado 3.400 facturas y 11.797 lineas, con 0 errores.

Antes de hacer cualquier escritura, necesitamos confirmar con vosotros:

1. Si queréis mantener la estructura actual de Agora.
2. En que familia deben caer los vinos nuevos que se creen en Winerim.
3. Si `Vinos Barra` se usa para copas u otra operativa especial.
4. Si las familias `BEBIDAS > BOTELLAS...` siguen siendo operativas o son residuales.
5. Revisar los 37 vinos sin match claro antes de activar stock automatico.

Nuestra recomendacion es conservar de momento vuestra estructura de Agora y hacer matching/control de familias, no subir familias Winerim en paralelo sin revisar.

Saludos,
GOIKO

## Borrador de correo · Santander

Buenos dias a todos,

Os comento lo que hemos visto tras la integracion en modo solo lectura para Don Bernardo Santander.

No hemos subido vinos, no hemos ocultado familias, no hemos tocado stock y no hemos escrito nada en Agora.

La URL API responde correctamente y las ventas cerradas por `Invoices` funcionan. Hemos localizado ventas cerradas hasta el 2026-06-22 y, en los ultimos 14 dias, vimos 1.158 facturas.

A nivel de estructura, Agora tiene 126 familias y 1.569 productos, con 1.550 productos vendibles. La bodega ya esta organizada principalmente dentro de `VINOTECA ABIERTA`, con familias como `RIOJA`, `RIBERA`, `CHAMPAGNE`, `Toro`, `JEREZ`, `PRIORAT`, `VERDEJO`, `AlBARINO`, `BIERZO`, etc. Tambien existen familias como `Vinos Barra` y `BEBIDAS > BOTELLAS...`.

En Winerim hay 147 vinos activos con precio. El pre-match automatico por nombre detecta 42 coincidencias seguras y 105 vinos sin match claro, es decir, una cobertura preliminar del 28,6%.

Tambien hemos importado el historico de ventas desde el 2026-03-23 hasta el 2026-06-23 en modo analitico, sin descontar stock. Han entrado 6.883 facturas y 22.351 lineas, con 0 errores.

Antes de hacer cualquier escritura, necesitamos confirmar con vosotros:

1. Si queréis mantener la estructura actual de `VINOTECA ABIERTA`.
2. En que familia deben caer los vinos nuevos que se creen en Winerim.
3. Si `Vinos Barra` se usa para copas u otra operativa especial.
4. Si las familias `BEBIDAS > BOTELLAS...` siguen siendo operativas o son residuales.
5. Revisar los 105 vinos sin match claro antes de activar stock automatico.

Nuestra recomendacion es no hacer un volcado directo todavia. Primero haria matching contra la estructura existente, porque el porcentaje de coincidencia segura inicial es bajo y la organizacion de Agora parece bastante trabajada.

Saludos,
GOIKO
