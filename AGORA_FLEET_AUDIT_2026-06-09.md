# Auditoria flota Agora - 2026-06-09

> Alcance: todas las conexiones Agora salvo Sa Vida, por peticion expresa. No se documentan credenciales.

## Resumen ejecutivo

- `Sa Pedrera`: operativa y con stock reciente correcto. Se aplico ademas el volcado controlado de `TINTOS WINERIM`.
- `Casa Nene`: operativa; la cola nueva se dreno manualmente con exito (`20/20`, quedan `0` abiertas). Aun no hay ventas reales cerradas.
- `Kava`: operativa; tiene ventas de vino mapeadas y stock descontado esta semana (`20 SUCCESS`, `0 FAILED` ultimos 7 dias). Quedan tareas antiguas fallidas/bloqueadas de mayo.
- `Katsu Izakaya`: POS operativo y ventas bajan, pero no hay lineas de vino mapeadas en los ultimos 7 dias (`605` candidatas, `0` mapeadas). No se puede declarar stock automatico correcto hasta resolver mapping/clasificacion.
- `La Candela de Triana`: POS operativo y ventas bajan, pero no hay lineas de vino mapeadas en los ultimos 7 dias (`546` candidatas, `0` mapeadas). No se puede declarar stock automatico correcto hasta resolver mapping/clasificacion.
- `Luruna`: no responde ahora desde Lovable Cloud (`No route to host`) aunque tenia cache fresca del 2026-06-08. No esta operativa en este momento.
- `Restaurante Cienvinos Ecija`: ahora da timeout desde Lovable Cloud y mantiene `68` tareas en cola. No esta operativa hasta recuperar conectividad.
- `Baco Getafe`: responde al test, pero esta apagado por decision de rollback legacy (`enabled=false`, `write_mode=NONE`, auto-push off). No debe contarse como automatico Winerim.

## Pruebas vivas

- `agora-proxy test` OK: Baco, Casa Nene, Katsu, Kava, La Candela, Sa Pedrera.
- `agora-proxy test` fallo:
  - Luruna: `No route to the Agora server`.
  - Cienvinos: timeout.
- `sync-master-data` adicional:
  - Sa Pedrera: OK.
  - Luruna: fallo `No route to host`.
  - Cienvinos: timeout local de 60s.

## Estado por conexion

### Baco Getafe
- Estado: rollback legacy intencional.
- Hechos: `enabled=false`, `catalog_sync_enabled=false`, `write_mode=NONE`, cola `0`.
- Riesgo: no hay automatismo Winerim activo; cualquier afirmacion de catalogo/stock automatico seria incorrecta.
- Recomendacion: mantener asi salvo orden expresa de reactivar Winerim.

### Casa Nene
- Estado: operativo pendiente de primera venta real.
- Hechos: `READY/XML_IMPORT/YES`, 292 productos Winerim verificados, 0 direct-sale, 0 no vendibles. Cola nueva `20 QUEUED` procesada manualmente: `20/20 SUCCESS`, quedan `0 QUEUED/RUNNING/FAILED`.
- Riesgo: aun no hay `sales_events` ni `stock_sync_log` reales; falta validar primer cierre.
- Recomendacion: pedir validacion visual en tablet y revisar el primer cierre con producto Winerim.

### Katsu Izakaya
- Estado: catalogo/ventas operativo, stock no probado en los ultimos 7 dias por falta de mapping de lineas.
- Hechos: POS OK, cola 0, `128` ventas en 7 dias, `605` lineas candidatas de vino, `0` mapeadas, `0` stock success. Hay 23 productos Winerim no vendibles en cache.
- Riesgo: las ventas bajan a Lovable Cloud pero no descuentan stock Winerim si no se resuelven contra `product_mappings`.
- Recomendacion: revisar reglas de clasificacion/mapping de vinos Katsu y validar una venta/cierre de botella y copa Winerim.

### Kava
- Estado: operativo con deuda antigua.
- Hechos: POS OK, `17` ventas en 7 dias, `66` lineas candidatas, `20` mapeadas, `20` descuentos stock OK y `0` fallos en 7 dias.
- Riesgo: quedan `7 FAILED` y `9 BLOCKED` de cola antigua; no parecen fallos actuales, pero ensucian monitorizacion.
- Recomendacion: clasificar y cerrar deuda antigua con cuidado; no tocar legacy/restauraciones sin confirmacion.

### La Candela de Triana
- Estado: catalogo/ventas operativo, stock no probado en los ultimos 7 dias por falta de mapping de lineas.
- Hechos: POS OK, cola 0, `688` ventas en 7 dias, `546` lineas candidatas de vino, `0` mapeadas, `0` stock success.
- Riesgo: vinos como `Carraovejas Pago` o `Edulis Copa` aparecen como no mapeados; esas ventas no descuentan stock.
- Recomendacion: revisar mappings concretos de vinos vendidos y ejecutar cierre de prueba tras corregirlos.

### Luruna
- Estado: no operativa ahora por conectividad.
- Hechos: test vivo falla `No route to host`; master cache de 2026-06-08; `473` ventas en 7 dias; solo `1` linea mapeada y `1` stock success en 7 dias. Cola antigua `10 FAILED`, `58 BLOCKED`.
- Riesgo: mientras el puerto/host no responda, catalogo, ventas y cola no pueden sincronizar con normalidad.
- Recomendacion: pedir al cliente/instalador revisar router/firewall/servicio Agora. No reintentar cola masiva hasta recuperar 200.

### Restaurante Cienvinos Ecija
- Estado: no operativo ahora por timeout.
- Hechos: test vivo y master data timeout; cache de 2026-06-08; `68 QUEUED`, `4 BLOCKED`; sin ventas ni stock recientes.
- Riesgo: las tareas nuevas no se procesan mientras el POS no responda; comunicarlo como "activo" seria enganoso.
- Recomendacion: revisar conectividad del host externo y, cuando responda, drenar cola por conexion.

### Sa Pedrera
- Estado: operativo con modo hibrido/legacy y deuda antigua.
- Hechos: POS OK, master OK, `55` ventas en 7 dias, `21` lineas mapeadas y `21` stock success en 7 dias, `0` stock failed reciente. Tras la sesion, `TINTOS WINERIM` contiene `200` tintos.
- Riesgo: quedan `102 QUEUED`, `296 FAILED`, `144 BLOCKED`; incluyen updates/hides antiguos y no deben ejecutarse en bloque sin clasificar. Solo `2` familias Winerim estan visibles por politica visual (`DULCES WINERIM` y `TINTOS WINERIM`); el resto sigue oculto.
- Recomendacion: validar tablet con el cliente, revisar orden visual, y clasificar colas antiguas antes de limpiar/reintentar.

## Conclusiones

- No se puede decir que "todos menos Sa Vida estan perfectos".
- Si el criterio es conectividad + catalogo + ventas + stock, los sanos hoy son `Kava` y `Sa Pedrera` para lineas mapeadas recientes; `Casa Nene` esta listo pero sin primera venta; `Katsu` y `La Candela` requieren mapping; `Luruna` y `Cienvinos` requieren conectividad; `Baco` esta en rollback legacy.
