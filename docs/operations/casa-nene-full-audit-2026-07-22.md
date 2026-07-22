# Casa Nene - auditoria integral Agora/Winerim

Fecha de cierre: 2026-07-22

Conexion: `e3cb6dbb-3474-4926-b740-706fbd0ef7e0`

Menu Winerim: `871`

## Estado final

Casa Nene queda **operativa**, con catalogo, ownership, visibilidad, colas y flujo reciente de ventas coherentes. El catalogo publicable esta reconciliado al `100%` (`372/372`) y el legacy esta totalmente oculto tanto a nivel de familia como de producto.

No se etiqueta como `100%_SIGNED_OFF` estricto por dos motivos no bloqueantes:

1. La cadencia esta configurada a cinco minutos, pero la ultima evidencia real documentada de propagacion de catalogo fue inferior o igual a siete minutos. No se altero ningun precio comercial ni se creo un producto artificial para forzar una nueva medicion.
2. No se genero una venta externa nueva de copa o un caso sales-only durante esta auditoria. El flujo y la excepcion estan configurados, pero la evidencia reciente observada en el ERP corresponde a botellas reales.

## Alcance y seguridad

Antes de auditar se revisaron las cuatro fuentes de verdad del proyecto:

- `PROJECT_CONTEXT.md`
- `CURRENT_STATE.md`
- `DECISIONS_LOG.md`
- `NEXT_STEPS.md`

La comprobacion se realizo con lecturas frescas de Agora, Lovable Cloud y el ERP de Winerim. No se borraron ventas, no se inventaron operaciones, no se importo historico, no se modificaron precios comerciales y no se forzo ningun cursor de ventas.

## Checklist

### 1. Conectividad y resiliencia - PASS

- Conexion habilitada: `true`.
- Modo de escritura: `XML_IMPORT`.
- Modo de sincronizacion: `BIDIRECTIONAL`.
- Circuit breaker: cerrado.
- Fallos consecutivos: `0`.
- La prueba de conexion a Agora respondio correctamente.
- El catalogo completo y el endpoint de facturas cerradas respondieron correctamente.
- La sonda de tickets abiertos respondio correctamente.

### 2. Catalogo fresh Winerim/Agora - PASS

La reconciliacion fresca, sin depender de cache historica, devolvio:

- Formatos elegibles en Winerim: `372`.
- Productos esperados encontrados en Agora: `372`.
- Coincidencias exactas: `372/372`.
- Ausentes: `0`.
- Diferencias: `0`.
- Productos esperados sin ownership: `0`.

La comparacion cubrio variante, precio, IVA, familia, orden, nombre/boton, visibilidad y propiedades de venta. No fue necesaria una republicacion masiva ni diferencial.

### 3. Copas internas - PASS

Casa Nene tiene una excepcion explicita para conservar en Agora las copas que el restaurante oculta de la carta publica de Winerim:

- `publish_hidden_glass_variants`: `true`.
- Cantidad esperada: `31`.
- Presentes en Agora: `31`.
- Vendibles internamente en Agora: `31`.
- En familia incorrecta: `0`.
- Ausentes: `0`.

Esta excepcion afecta solo a la visibilidad operativa en Agora. No convierte esas copas en visibles para el cliente en la carta publica de Winerim.

### 4. Botellas recuperadas - PASS

- Botellas esperadas por la recuperacion controlada: `24`.
- Presentes en Agora: `24`.
- Vendibles: `24`.
- Mappings confirmados: `24`.
- Ausentes o no vendibles: `0`.

No se uso matching aproximado para estas recuperaciones: las 24 relaciones estan confirmadas.

### 5. Inactivos, formatos retirados y sin precio - PASS

La regla general se mantiene: un formato inactivo o sin precio publicable no debe seguir vendible en Agora. La unica excepcion es la politica explicita de las 31 copas internas descrita arriba.

En las familias Winerim se conservan fisicamente seis productos no vendibles por trazabilidad y rollback. Todos tienen desactivados `SaleableAsMain` y `UseAsDirectSale`:

- `B Balbas Barrica 5` (`742233`).
- `B Antidoto` (`742235`).
- `B L'Enclos...` (`742273`).
- `[INACTIVO] Albamar Albarino` (`757207`).
- `[INACTIVO] Allende Blanco` (`757220`).
- `M Valdamor` (`1172013`).

Los dos primeros tienen mapping rechazado de forma deliberada porque el vino ya no esta activo o accesible en Winerim. No se reactivaron ni se forzo su ownership.

### 6. Ownership y tracking - PASS

- Tracking `VERIFIED`: `372`.
- Tracking `HIDDEN`: `6`.
- Mappings `CONFIRMED`: `376`.
- Mappings `REJECTED`: `2`, ambos justificados por vinos inactivos/no accesibles.
- Productos elegibles sin ownership: `0`.
- Errores vivos de tracking: `0`.

### 7. Familias Winerim - PASS

Las ocho familias operativas estan visibles:

- Tintos Winerim.
- Blancos Winerim.
- Rosados Winerim.
- Espumosos Winerim.
- Dulce Winerim.
- Fortificados Winerim.
- Magnum Winerim.
- Copas Winerim.

Los `372` productos publicables estan dentro de estas familias con familia y orden reconciliados.

### 8. Legacy y buscador - PASS

Familias legacy revisadas:

- VINO.
- VINO FUERA DE CARTA.
- ESPUMOSO.
- BLANCO.
- TINTO.
- DULCES.

Resultado:

- Familias legacy visibles: `0`.
- Productos legacy conservados: `148`.
- Productos legacy vendibles: `0`.

El legacy se conserva para trazabilidad y rollback, pero no queda disponible como articulo de venta ni a traves del buscador operativo de Agora.

### 9. Automatizacion Winerim -> Agora - PASS con observacion de SLA

- `catalog_sync_enabled`: `true`.
- `auto_push_on_create`: `true`.
- `auto_push_on_update`: `true`.
- `auto_push_verified_ready`: `true`.
- Frecuencia configurada: `5` minutos.
- Tareas activas al auditar: `0`.
- Tareas `FAILED` o `BLOCKED` desde 2026-07-15: `0`.

Existe evidencia operativa previa de altas y cambios reales propagados en un maximo observado de siete minutos, y la reconciliacion fresca actual es exacta. No se cambio un precio real ni se creo un vino de prueba solo para reducir esa medicion a cinco minutos.

### 10. Ventas Agora -> Winerim - PASS con observacion de cursor

Configuracion:

- Sincronizacion intradia: activa.
- Tickets abiertos: activos.
- Stock de tickets abiertos: activo.
- Intervalo: `5` minutos.
- Zona horaria: `Europe/Madrid`.
- Edad minima de linea abierta: `2` minutos.

Evidencia observada en el ERP:

- `26` registros reales con origen `TPV` entre el 16, 17, 18 y 21 de julio.
- El 21 de julio aparecen nueve ventas TPV de botella y coinciden con las operaciones de stock de tickets abiertos del backend.
- La hora de venta se conserva en hora local. Por ejemplo, una venta de `Vinas de Gain` a las `21:57` aparece asociada a la operacion del backend de las `19:57 UTC`, el mismo minuto en `Europe/Madrid`.
- Las filas manuales con origen `Venta` y hora `00:00` se mantuvieron separadas; no se trataron como duplicados del TPV.

Lovable Cloud contiene facturas definitivas posteriores al ultimo cursor diario visible, incluidas ventas de los dias 17, 18 y 21. Por ello, el valor `last_business_day_synced = 2026-07-16` se considera un marcador atrasado, no evidencia de perdida de ventas. No se forzo el cursor porque hacerlo sin una reconciliacion transaccional podria saltar documentos.

### 11. Stock, sales-only e idempotencia - PASS / NO CANARY NUEVO

Desde el 15 de julio:

- Operaciones de stock revisadas: `37`.
- `SUCCESS`: `37`.
- `FAILED`: `0`.
- Claves de idempotencia no nulas duplicadas: `0`.

El flujo contempla dos comportamientos:

- Con stock activo, descuenta la variante correcta por su `stockId`.
- Sin stock activo, registra la venta mediante el flujo sales-only sin inventar una deduccion.

La auditoria encontro evidencia reciente real de botellas con stock. No se genero una venta artificial sin stock para producir una nueva prueba sales-only.

### 12. Cancelaciones - PASS

Se encontro una reversion real y exitosa para `Bancales Olvidados`:

- Operacion provisional registrada.
- Reversion posterior con cantidad `-1`.
- Estado `SUCCESS`.
- Clave de idempotencia especifica de `open_ticket_reversal`.

No se editaron ni eliminaron historicos para ajustar este caso.

### 13. Colas y alertas - PASS

- Cola activa: `0`.
- Fallos o bloqueos recientes: `0`.
- Circuit breaker: cerrado.
- Fallos consecutivos de conexion: `0`.
- Fallos recientes de stock: `0`.

No se encontro una causa determinista pendiente que justificase escribir en produccion durante el cierre de esta auditoria.

## Correcciones verificadas

Las siguientes correcciones/configuraciones estaban efectivamente aplicadas y se validaron contra Agora fresh:

1. Excepcion controlada de `31` copas internas.
2. Recuperacion de `24` botellas con mapping confirmado.
3. Ownership completo de los `372` formatos publicables.
4. Legacy oculto a nivel de familia y producto, sin elementos vendibles en buscador.
5. Reversion idempotente de cancelaciones de tickets abiertos.
6. Automatizacion bidireccional habilitada con cadencia de cinco minutos.

No fue necesaria una correccion adicional de catalogo: una escritura habria introducido riesgo sin resolver ninguna diferencia real.

## Elementos dejados sin tocar por seguridad

1. No se modificaron precios comerciales para fabricar un canary.
2. No se crearon vinos ni ventas de prueba.
3. No se borraron registros manuales o historicos potencialmente dudosos.
4. No se reactivaron los dos mappings rechazados de vinos inactivos/no accesibles.
5. No se eliminaron fisicamente los seis productos ocultos ni los 148 productos legacy; permanecen no vendibles para permitir rollback y conservar trazabilidad.
6. No se forzo `last_business_day_synced`, porque el backend ya contiene facturas posteriores y mover el cursor manualmente podria omitir documentos.
7. No se ejecuto backfill historico ni reproceso de colas.

## Conclusion

Casa Nene queda operativa y estable. Catalogo, familias, variantes, precios, IVA, orden, visibilidad, ownership, copas internas, botellas recuperadas, legacy, cola e idempotencia pasan la auditoria. Las ventas reales recientes de botella aparecen en el ERP con origen TPV y hora local coherente.

Las dos observaciones residuales son de certificacion, no de funcionamiento observado: no se indujo un canary nuevo de copa/sales-only y no se forzo una prueba comercial para medir un SLA estricto inferior a cinco minutos. El cursor diario atrasado debe tratarse como deuda de observabilidad, no corregirse manualmente.
