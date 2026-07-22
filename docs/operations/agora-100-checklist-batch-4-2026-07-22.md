# Auditoria Agora 100% - Lote 4 - 2026-07-22

## Alcance y criterio

Auditoria estrictamente de solo lectura de estas conexiones:

- La Candela de Triana
- Luruna
- O Bistro
- Ocean Club
- PurOsushi

Se ha aplicado el checklist universal de diez bloques definido en
`AGORA_INTEGRATION_CHECKLIST.md`: conectividad, configuracion, catalogo,
cambios automaticos, estructura/legacy, ventas, stock, resiliencia,
monitorizacion y firma final.

Una marca `PASS` exige evidencia real. La ausencia de una prueba o de datos se
clasifica como `WARN`, salvo que exista un fallo reproducido, en cuyo caso se
clasifica como `FAIL`. Las conexiones deshabilitadas se clasifican
`NOT_ACTIVE` y no se han sondeado. Un catalogo `N/N` por si solo no concede la
firma final.

Las lecturas fresh de catalogo se ejecutaron aproximadamente entre las
09:24 y las 09:30 UTC del 22/07/2026, exclusivamente para conexiones activas.
No se modificaron precios, productos, flags, mappings, tracking, colas,
legacy ni datos operativos. No se imprimen credenciales.

## Resumen inicial

Abreviaturas: `CON` conectividad, `CFG` configuracion, `CAT` catalogo, `AUT`
cambios automaticos, `LEG` estructura/legacy, `VEN` ventas, `STK` stock,
`RES` resiliencia, `MON` monitorizacion y `SIG` firma final.

| Restaurante | CON | CFG | CAT | AUT | LEG | VEN | STK | RES | MON | SIG | Resultado global |
|---|---|---|---|---|---|---|---|---|---|---|---|
| La Candela de Triana | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | Deshabilitada; sin sonda fresh |
| Luruna | PASS | WARN | PASS | WARN | FAIL | FAIL | FAIL | WARN | WARN | FAIL | Catalogo correcto; circuito de ventas no operativo |
| O Bistro | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | NOT_ACTIVE | Deshabilitada; sin acceso exterior utilizable |
| Ocean Club | PASS | WARN | PASS | WARN | WARN | WARN | WARN | WARN | PASS | WARN | Catalogo correcto; falta canary real y cierre de estrategia legacy/categorias |
| PurOsushi | PASS | WARN | FAIL | FAIL | WARN | FAIL | FAIL | FAIL | FAIL | FAIL | Activa, pero con diferencias de precio y duplicacion funcional en historial |

Ninguna de las cinco conexiones queda `100%_SIGNED_OFF` en esta auditoria.

## 1. La Candela de Triana

**Estado global:** `NOT_ACTIVE`.

La conexion figura deshabilitada. Conforme al protocolo, no se ha ejecutado
ninguna sonda fresh contra Agora y no se usa informacion cacheada como prueba
del estado actual.

| Bloque | Marca | Evidencia y razonamiento |
|---|---|---|
| Conectividad | NOT_ACTIVE | `enabled=false`; no se realiza sonda de red a una conexion deshabilitada. |
| Configuracion | NOT_ACTIVE | La configuracion almacenada es BIDIRECTIONAL, pero catalog sync y los flags automaticos estan apagados. Ultimo sync registrado: 01/07/2026. |
| Catalogo | NOT_ACTIVE | No existe comparacion fresh autorizada. La ultima master data conocida es del 14/07/2026 y se considera obsoleta para firmar. |
| Cambios automaticos | NOT_ACTIVE | No pueden propagarse con la conexion y los flags desactivados; no hay latencia viva medible. |
| Estructura/legacy | NOT_ACTIVE | El cache historico mostraba 8 familias Winerim, 92 productos Winerim vendibles y 269 productos de vino legacy vendibles. Tambien mostraba 2 retirados todavia vendibles (`BOT. Valdehermoso Crianza` y `B Gago G`). Son indicios historicos, no evidencia live. No se ha probado el buscador actual. |
| Ventas | NOT_ACTIVE | No hay importaciones ni ledger recientes que permitan comparar Agora, middleware y ERP. |
| Stock | NOT_ACTIVE | No hay logs de stock desde el 12/07/2026. No se puede certificar botella, copa, magnum ni modo sales-only. |
| Resiliencia | NOT_ACTIVE | No procede canary de reconexion, idempotencia o recuperacion de cola mientras la conexion esta deshabilitada. |
| Monitorizacion | NOT_ACTIVE | No hay monitorizacion operativa que pueda firmarse sobre una conexion inactiva. |
| Firma final | NOT_ACTIVE | No cumple las condiciones para una auditoria operativa ni para `100%_SIGNED_OFF`. |

**Pendiente exacto para 100%:**

1. Resolver y documentar la identidad correcta frente a `Restaurante Triana` antes de reactivar.
2. Reactivar solo con autorizacion operativa y validar conectividad/API fresh.
3. Confirmar defaults, write mode, almacen, centros de venta y estrategia de stock.
4. Reconciliar fresh catalogo Winerim/Agora y corregir los retirados que sigan vendibles.
5. Decidir y ejecutar de forma reversible la estrategia de legacy, incluida su localizacion por buscador.
6. Ejecutar canary de alta, cambio de precio, retirada y reactivacion, midiendo latencia.
7. Ejecutar ventas reales de botella y copa; verificar `sold_at`, variante e historial ERP.
8. Probar stock activo y sales-only, cancelacion, idempotencia, recuperacion tras caida, cola y alertas.

## 2. Luruna

**Estado global:** `FAIL` - catalogo exacto, pero las ventas recientes de vino
no se mapean ni llegan al ERP.

### Matriz y evidencia

| Bloque | Marca | Evidencia y razonamiento |
|---|---|---|
| Conectividad | PASS | Conexion activa, breaker cerrado y `consecutive_failures=0`. Los cinco ultimos health checks respondieron HTTP 200, con latencias de 114 a 194 ms. Ultimo sync: 22/07/2026 09:30 UTC. |
| Configuracion | WARN | Modo BIDIRECTIONAL, ciclo de 5 min, catalog sync y flags create/update activos; bottle/glass write activos. IVA 10%, preparation 1/1 y formatos BOT/COPA presentes. No estan confirmados almacen ni centros de venta. Ademas `open_ticket_stock_sync_enabled=true` introduce riesgo mientras la cancelacion de ventas en Winerim no sea idempotente. |
| Catalogo | PASS | Lectura fresh: 140/140 formatos exactos, 0 ausentes, 0 diferentes y 0 sin ownership dentro de familias Winerim. Tracking: 149 VERIFIED, 4 NOT_PUSHED y 2 HIDDEN; mappings: 153 CONFIRMED, 1 DISABLED y 3 REJECTED. Cola activa: 0. Ningun retirado tracked seguia vendible en la lectura. |
| Cambios automaticos | WARN | La configuracion programa 5 min, pero no existe canary reciente con alta, precio, retirada y reactivacion que mida la latencia real de extremo a extremo. Un intervalo configurado no es evidencia de propagacion. |
| Estructura/legacy | FAIL | Aunque el barrido nominal no encontro legacy en familias de nombre vinicola, las ventas fresh contienen productos antiguos/no mapeados que siguen utilizables: `COPA LUIS ALEGRE CRIANZA` (ID Agora 1330), `Copia de RAMON BILBAO` (1164120), `COPA GRAN FEUDO NAVARRO` (676) y `COPA LUIS CANAS CARB. COSECHERO` (346). Esto prueba legacy operativo. No se ha ejecutado una prueba visual independiente del buscador, pero su venta en Agora demuestra que sigue localizable por la operativa. |
| Ventas | FAIL | En la ventana desde 12/07 se localizaron 1.939 lineas candidatas del clasificador, pero 0 mapeadas, 0 cards TPV en ERP y 0 escrituras middleware exitosas. El clasificador es amplio y no todas las 1.939 lineas son vino; los cuatro ejemplos anteriores si son evidencia explicita de vino no importado. Ejemplos: `COPA LUIS ALEGRE CRIANZA`, qty 1, `sold_at=22/07/2026 00:10:58`; `Copia de RAMON BILBAO`, qty 1, `sold_at=00:10:54`; `COPA GRAN FEUDO NAVARRO`, qty 1, `sold_at=00:10:25`; `COPA LUIS CANAS CARB. COSECHERO`, qty 2, `sold_at=21/07/2026 23:15:23`. Ninguna aparece asociada en ERP/ledger. |
| Stock | FAIL | No hay SUCCESS desde el 12/07. Ultimo SUCCESS observado: `ITSASMENDI 2022 [botella]`, qty 1, stock ID 182537, el 10/07 a las 00:00 UTC. Ultimo fallo: `CAMPILLO 2021 CRIANZA [botella]`, qty 1, Winerim 156687, 404/not accessible y sin stock ID, el 11/07 a las 03:00 UTC. No existe evidencia reciente suficiente de copa, magnum, sales-only o cancelacion correcta. |
| Resiliencia | WARN | Cola activa 0 y no se detectaron claves de exito duplicadas exactas. Hay 4 tareas BLOCKED del 17/07 con `PRODUCT_ALREADY_EXISTS_IN_AGORA`; el fresh actual ya coincide, pero falta cerrar/explicar ese residuo y ejecutar un canary de caida-recuperacion. La ausencia de duplicados en un periodo sin escrituras recientes no firma idempotencia. |
| Monitorizacion | WARN | No hay alerta abierta actual y los health checks son sanos, pero quedan 4 NOT_PUSHED y 4 tareas BLOCKED historico-recientes. El monitor de conectividad no detecta por si solo que el circuito de ventas esta a cero. |
| Firma final | FAIL | No puede firmarse mientras existan ventas reales de vino en Agora sin mapping, ledger ni ERP, y mientras stock/cancelaciones carezcan de evidencia reciente. |

**Pendiente exacto para 100%:**

1. Identificar y mapear todos los botones de vino que realmente se venden, empezando por los cuatro IDs fresh documentados.
2. Definir si esos botones legacy se ocultan o se mantienen; comprobar expresamente el buscador tras la decision.
3. Corregir el acceso/mapping de `CAMPILLO 2021 CRIANZA` (Winerim 156687).
4. Confirmar almacen y centros de venta.
5. Ejecutar botella y copa reales y conciliar Agora -> canonical -> ledger -> ERP con `sold_at` y variante.
6. Verificar un caso con stock activo y otro sales-only; probar cancelacion sin card positiva residual.
7. Desactivar provisional stock en tickets abiertos o certificar una compensacion idempotente.
8. Ejecutar canaries de alta, precio, retirada y reactivacion, con latencia medida.
9. Resolver los 4 NOT_PUSHED y las 4 tareas BLOCKED sin republicacion masiva.
10. Probar recuperacion tras indisponibilidad y alerta por estancamiento de ventas, no solo salud HTTP.

## 3. O Bistro

**Estado global:** `NOT_ACTIVE`.

La conexion esta deshabilitada y el endpoint registrado historicamente es una
IP privada/local. No se ha sondeado.

| Bloque | Marca | Evidencia y razonamiento |
|---|---|---|
| Conectividad | NOT_ACTIVE | `enabled=false`; no se permite sonda fresh. La URL historica privada no es enrutable desde el middleware cloud. |
| Configuracion | NOT_ACTIVE | Modo PULL_ONLY, write mode NONE y flags automaticos apagados. No hay ultimo sync ni business day. |
| Catalogo | NOT_ACTIVE | No hay capabilities, master data, vinos, mappings ni tracking aprovechables para una firma. |
| Cambios automaticos | NOT_ACTIVE | No existe canal de escritura activo ni latencia medible. |
| Estructura/legacy | NOT_ACTIVE | Sin lectura fresh no se puede cuantificar estructura, retirados, legacy ni visibilidad en buscador. |
| Ventas | NOT_ACTIVE | Sin sales events, line items o ledger operativo atribuible a la integracion. |
| Stock | NOT_ACTIVE | Sin logs de stock; no se conoce stock activo frente a sales-only por variante. |
| Resiliencia | NOT_ACTIVE | No se puede certificar breaker, reanudacion, idempotencia o cancelaciones de una conexion no operativa. |
| Monitorizacion | NOT_ACTIVE | No hay senal operativa que permita alertas utiles de negocio. |
| Firma final | NOT_ACTIVE | No cumple precondiciones para `100%_SIGNED_OFF`. |

**Pendiente exacto para 100%:**

1. Obtener URL publica DDNS/NAT, VPN o agente local estable; no sirve una IP LAN desde cloud.
2. Validar API HTTP, permisos de lectura/escritura y credenciales sin exponerlas.
3. Definir BIDIRECTIONAL/PULL_ONLY, defaults, familias/categorias, almacen, centros y estrategia legacy.
4. Activar de forma controlada y ejecutar lectura fresh de capabilities y catalogo.
5. Sincronizar catalogo y demostrar N/N, retirados ocultos y buscador sin legacy no deseado.
6. Medir alta, precio, retirada y reactivacion.
7. Ejecutar ventas reales por variante, stock activo y sales-only, y verificar ERP con `sold_at` real.
8. Probar cancelacion, idempotencia, caida-recuperacion, cola, alertas y firma final.

## 4. Ocean Club

**Estado global:** `WARN` - catalogo Winerim exacto; falta validar la operativa
de venta y cerrar la estrategia de categorias/legacy.

### Matriz y evidencia

| Bloque | Marca | Evidencia y razonamiento |
|---|---|---|
| Conectividad | PASS | Activa, breaker cerrado y 0 fallos consecutivos. Los cinco ultimos health checks dieron HTTP 200 con 104-149 ms. Ultimo sync: 22/07/2026 09:15 UTC; master fresh alrededor de 09:30 UTC. |
| Configuracion | WARN | BIDIRECTIONAL, 5 min, create/update/catalog e intradia activos. IVA 10%, warehouse 1, preparation 11/1, BOT/COPA y centros 1,2,4,5,6,7 configurados. `open_ticket_stock_sync_enabled=true` no puede firmarse hasta demostrar cancelacion idempotente. |
| Catalogo | PASS | Fresh: 113/113 exactos, 0 ausentes, 0 diferentes y 0 sin ownership en familias Winerim. 89 vinos y 113 formatos: 85 botella, 0 copa y 28 magnum; todos con stock ID. Tracking 113 VERIFIED y mappings 113 CONFIRMED. No hay retirados tracked vendibles. |
| Cambios automaticos | WARN | Flags y ciclo de 5 min presentes, pero no hay canary real reciente de alta/precio/retirada/reactivacion ni latencia medida. |
| Estructura/legacy | WARN | Las 8 familias Winerim existen con `ShowInPos=false`, siguiendo la estrategia de navegacion por categorias. La API de categorias/grupos no esta certificada y previamente devolvio HTTP 500. Siguen al menos 162 productos legacy vendibles no owned en familias de vino (`GLASS WINE`, `WHITE WINE`, `ROSE WINE`, `RED WINE`, `CHAMPAGNE`). Ejemplos fresh: `GLS VERDEJO`, `GLS LA CUESTA`, `GLS CHAMPAGNE`. La visibilidad por buscador no se ha probado en UI; ventas recientes prueban que dichos botones siguen operativos. |
| Ventas | WARN | No existe canary con un boton Winerim. En la ventana de diez dias hay 6.749 lineas candidatas del clasificador, 0 mapeadas, 0 cards ERP y 0 logs de stock; el clasificador incluye productos no vinicolas, por lo que no se interpreta todo el volumen como vino. Evidencia concreta de legacy: `GLS CHAMPAGNE`, ID 443, vendido el 21/07 a las 23:29:07; `WHISP. ANGEL 1,5L`, ID 529, a las 22:56:23; `GLS VERDEJO`, ID 440, qty 2, a las 22:46:35. Una auditoria previa 11-20/07 contabilizo 1.018 lineas legacy, 1.113 unidades y 121.091,50 EUR, y ninguna venta con ID Winerim. Esto es ausencia de prueba de la ruta Winerim, no prueba de que falle un boton Winerim no usado. |
| Stock | WARN | No hay logs que certifiquen botella, magnum o sales-only. Hay 0 formatos copa Winerim actuales. Tampoco existe una cancelacion Winerim verificada; dos cancelaciones legacy netean en Agora, pero no prueban compensacion en Winerim. |
| Resiliencia | WARN | Cola activa 0, sin FAILED/BLOCKED recientes y health checks sanos. Falta evidencia de idempotencia con venta real, recuperacion tras caida y cancelacion provisional/definitiva. |
| Monitorizacion | PASS | Sin alertas abiertas, sin cola activa y sin tareas fallidas recientes; salud HTTP estable. La firma operativa de negocio sigue pendiente en otros bloques. |
| Firma final | WARN | No hay fallo demostrado en el catalogo, pero falta una venta Winerim de extremo a extremo y la aprobacion de la estructura por categorias/legacy. |

**Pendiente exacto para 100%:**

1. Acordar con SAT/cliente la navegacion final: categorias por TPV, familias no visibles y alcance del legacy.
2. Certificar la API o el procedimiento de categorias/grupos y validar visualmente orden, visibilidad y buscador.
3. Ejecutar alta, cambio de precio, retirada y reactivacion con latencia medida.
4. Marcar una botella y un magnum desde botones Winerim y conciliar `sold_at`, variante, ledger y ERP.
5. Probar un producto con stock activo y otro sales-only.
6. Probar cancelacion/idempotencia sin card positiva residual y decidir si se mantiene open-ticket stock.
7. Probar caida, recuperacion y reanudacion de cola.
8. Repetir la firma tras confirmar que no se venden botones legacy fuera del alcance acordado.

## 5. PurOsushi

**Estado global:** `FAIL` - conexion activa, pero hay dos discrepancias de
precio y el flujo intradia produce duplicacion funcional en el historial.

### Matriz y evidencia

| Bloque | Marca | Evidencia y razonamiento |
|---|---|---|
| Conectividad | PASS | Activa, breaker cerrado y 0 fallos consecutivos. Health checks HTTP 200 con 119-151 ms. Ultimo sync alrededor de 22/07/2026 09:26 UTC y master fresh alrededor de 09:27 UTC. |
| Configuracion | WARN | BIDIRECTIONAL, 5 min y flags create/update/catalog/intradia activos. IVA 10%, warehouse 1, preparation null/null y centro 12. `open_ticket_stock_sync_enabled=true` esta generando ciclos provisionales que no son seguros para el historial ERP actual. |
| Catalogo | FAIL | Fresh: 355/357 exactos, 0 ausentes y 2 diferentes. `B Boissonneuse` (Winerim 209944 / Agora 709944) y `B Keller Kirchspiel Riesling GG` (Winerim 209986 / Agora 709986) tienen diferencias de precio en las listas 8 y 14. Hay 348 vinos activos y 357 formatos: 332 botella, 20 copa y 5 magnum, todos con stock IDs. Tracking 357 VERIFIED + 3 HIDDEN; mappings 360 CONFIRMED. Existe ademas 1 producto vendible no owned dentro de familia Winerim (`Keller Hubacker GG 2024`, segun la auditoria completa anterior). No hay retirados tracked vendibles. |
| Cambios automaticos | FAIL | Se midieron altas anteriores entre 30 y 70 s, pero las dos diferencias de precio fresh demuestran que update no esta convergiendo al 100%. No hay canary firmado de retirada/reactivacion. |
| Estructura/legacy | WARN | Legacy se mantiene visible de forma intencionada. El barrido fresh localiza al menos 275 productos legacy vendibles en familias de vino; la auditoria completa del 21/07 encontro 282 candidatos (246 en familias visibles y 36 en familias ocultas). Ejemplos: `Predicador Tinto` y familia `Vinos copa`. No se ha ejecutado una prueba visual independiente de buscador, aunque su vendibilidad confirma que siguen disponibles para Agora. |
| Ventas | FAIL | En diez dias: 10 lineas cerradas mapeadas, 12 SUCCESS del middleware y 13 cards TPV en ERP, de las que 12 eran cerradas. Hay 4 diferencias de ventana: stock 247115 (Agora 0, ERP 3), 255758 (Agora 2, ERP 0), 240894 (Agora 1, ERP 2) y 252928 (Agora 0, ERP 1); tambien 4 diferencias diarias y 5 agregados de log distintos. Ejemplo real: `Keller Riesling Kabinett Limestone [botella]`, vendido en Agora el 21/07 a las 22:54:19; provisional de stock a las 22:56:38 (latencia ~2m19s), reversal posterior y definitivo a las 02:00:56 del 22/07. ERP conserva card provisional y definitiva. `La Estrada` se vendio a las 22:08:01 y tuvo provisional a las 22:11:22 (~3m21s). `C Quintaluna [copa]`, qty 2, se vendio a las 20:39:29; no se encontro card de copa equivalente en la comparacion. |
| Stock | FAIL | Desde 12/07 hay 12 SUCCESS: 11 botella y 1 copa, todos con stock ID; no hay evidencia sales-only y existe 1 SKIPPED de copa. Se observan ciclos `+1/-1/+1` para Winerim 209890 (18/07) y 220996 (21/07). La compensacion de stock puede netear, pero la card positiva provisional permanece en ERP: cancelacion funcional incompleta. |
| Resiliencia | FAIL | No hay claves de idempotencia exactas duplicadas y la cola activa esta a 0, pero los ciclos provisional/reversal/definitivo generan duplicacion funcional visible. La unicidad tecnica de la clave no basta para certificar idempotencia de negocio. Falta canary de recuperacion tras caida. |
| Monitorizacion | FAIL | Hay 1 alerta warning abierta `sales_stale`; los cinco health checks mas recientes marcan STALE pese a HTTP 200. `last_business_day=17/07/2026`, incompatible con ventas posteriores observadas. No hay FAILED/BLOCKED recientes ni cola activa. |
| Firma final | FAIL | Las diferencias de precio, la conciliacion desigual y las cards duplicadas impiden `100%_SIGNED_OFF`. |

**Pendiente exacto para 100%:**

1. Corregir diferencialmente los precios de Winerim 209944 y 209986 en listas 8 y 14, y verificar fresh 357/357.
2. Resolver el producto no owned `Keller Hubacker GG 2024` sin crear duplicado.
3. Evitar que open tickets creen una card de venta definitiva en ERP; usar un ledger provisional o esperar al cierre, con compensacion idempotente.
4. Reconciliar y corregir las cuatro diferencias de ventana, las cuatro diarias y los cinco agregados de log.
5. Verificar la copa `C Quintaluna` y el SKIPPED de copa con variante/stock ID correctos.
6. Probar explicitamente sales-only, ademas de stock activo.
7. Corregir `sales_stale` y el `last_business_day` atrasado.
8. Acordar el alcance final del legacy y validar buscador/visibilidad en UI.
9. Ejecutar canaries de precio, retirada y reactivacion y registrar latencias; el alta ya tiene evidencia de 30-70 s.
10. Probar cancelacion, idempotencia y recuperacion tras caida sin cards residuales.

## Conclusion del lote

- `PASS` de catalogo fresh: Luruna y Ocean Club.
- `FAIL` de catalogo fresh: PurOsushi, por 2 diferencias de precio.
- `NOT_ACTIVE`: La Candela de Triana y O Bistro; no se realizaron sondas.
- Ninguna conexion dispone de evidencia completa para los diez bloques.
- El riesgo mas urgente es de integridad de ventas: Luruna no esta importando
  vinos vendidos y PurOsushi conserva duplicados funcionales por el ciclo de
  tickets abiertos.

Esta auditoria fue de solo lectura. No se altero ningun estado de produccion.
