# Ocean Club - checklist 100 % 2026-07-20

Fecha de revision: 2026-07-20 17:38 CEST

Conexion: `706b952e-767d-41af-9cba-8e225b16a877`

Menu Winerim: `756` (`Oceans` en administracion)

Estado: `LIVE_PENDING_SALE_CANARY`

## Resultado

| Control | Estado | Evidencia |
|---|---|---|
| Conexion Agora | PASS | API HTTP operativa, breaker cerrado y ultima sincronizacion reciente. |
| Frecuencia | PASS | Catalogo y ventas cada cinco minutos. |
| Catalogo | PASS | Lectura fresh `113/113 MATCH`, sin ausentes, diferentes o productos sin ownership. |
| Familias Winerim | PASS | Las ocho familias estan visibles y conservan el orden `0-7`. |
| Tracking y mappings | PASS | Los `113` formatos esperados estan verificados y confirmados. |
| Cola | PASS | Cero tareas `QUEUED` o `RUNNING`; cero fallos o bloqueos en siete dias. |
| Alertas | PASS | Cero alertas abiertas. |
| Intradia | PASS tecnico | Tickets abiertos, intradia y stock intradia activos; edad minima dos minutos. |
| Idempotencia | PASS | Cero claves idempotentes exactas repetidas en siete dias. |
| Historial ERP | PENDIENTE | El ERP no contiene ventas TPV porque aun no se ha vendido con un boton Winerim. |
| Botella real | PENDIENTE | Falta una venta real no anulada desde una familia Winerim. |
| Copa real | BLOQUEADA POR DATOS | Winerim no tiene ninguna variante de copa activa con precio; `COPAS WINERIM` esta correctamente vacia. |
| Legacy | VISIBLE | Se mantienen visibles cinco familias con producto para la prueba y el rollback. |

## Catalogo Winerim visible

| Familia | Formatos |
|---|---:|
| TINTOS WINERIM | 35 |
| BLANCOS WINERIM | 20 |
| ROSADOS WINERIM | 8 |
| ESPUMOSOS WINERIM | 22 |
| MAGNUM WINERIM | 28 |
| COPAS WINERIM | 0 |
| DULCE WINERIM | 0 |
| FORTIFICADOS WINERIM | 0 |
| **Total** | **113** |

Los `113` formatos son `85` botellas y `28` magnum. La ausencia de copas no
es un fallo de publicacion: las `89` fichas activas del cache Winerim tienen
`0` precios de copa positivos.

## Catalogo anterior conservado

Antes de esta revision las familias Winerim y las familias anteriores estaban
ocultas. Se restauraron de forma controlada ambas superficies para poder hacer
la prueba sin retirar la operativa previa.

| Familia anterior | Productos | Vendibles |
|---|---:|---:|
| GLASS WINE | 16 | 16 |
| WHITE WINE | 33 | 32 |
| ROSE WINE | 26 | 25 |
| RED WINE | 38 | 38 |
| CHAMPAGNE | 51 | 51 |
| **Total** | **164** | **162** |

Las familias vacias `VINOS`, `COPAS DE VINO`, `TINTOS`, `BLANCOS` y
`ROSADOS` permanecen ocultas porque no contienen productos.

## Evidencia de ventas

- Ventana revisada: del `2026-07-13` al `2026-07-20`.
- Agora entrego `889` documentos y `8.471` lineas.
- Las cinco familias anteriores acumulan `566` unidades netas y `57.377 EUR`.
- Ninguna de esas lineas esta mapeada a Winerim.
- No aparece ningun ID de los `113` productos Winerim en las ventas cerradas.
- El ERP Winerim de Ocean (`/erp/756/sales`) muestra cero ventas.

Esto demuestra que la lectura de ventas funciona, pero no valida el circuito
Winerim porque el personal todavia no ha utilizado un boton Winerim.

## Cierre con el cliente

1. Actualizar o reiniciar la pantalla de venta para cargar las familias.
2. Marcar una botella real desde una familia Winerim y no anularla.
3. Comunicar la hora exacta y el nombre del vino.
4. Verificar en menos de cinco minutos la tarjeta `TPV`, su hora, cantidad,
   variante e idempotencia durante dos ciclos.
5. Si el vino tiene stock activo, comprobar la deduccion; si no lo tiene,
   comprobar que se registra la venta sin modificar stock.
6. Para probar copa, asignar primero un precio de copa positivo en Winerim y
   verificar que el nuevo boton aparece automaticamente en `COPAS WINERIM`.
7. Solo despues decidir si se oculta el catalogo anterior de forma reversible.

## Rollback

La correccion de esta sesion solo cambio `ShowInPos`:

- Familias Winerim: `900157`, `901954`, `903516`, `903925`, `904241`,
  `904289`, `908182`, `908875` pasaron de `false` a `true`.
- Familias anteriores con producto: `41`, `49`, `50`, `51`, `52` pasaron de
  `false` a `true` para respetar la decision de conservar legacy.

Si fuera necesario volver al estado anterior, cambiar exclusivamente esas
trece familias a `ShowInPos=false`. No tocar productos, precios, mappings,
tracking ni ventas.
