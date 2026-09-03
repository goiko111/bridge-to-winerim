# Casa Nene - copas internas en Agora

Fecha: `2026-07-20`

Conexion: `e3cb6dbb-3474-4926-b740-706fbd0ef7e0`

Estado: `PUBLISHED_AND_VERIFIED / PENDING_REAL_SALE_CANARY`

## Objetivo

Casa Nene quiere mantener estas copas ocultas en la carta publica de Winerim,
pero disponibles y con precio en la familia `COPAS WINERIM` de Agora.

La excepcion es exclusiva de esta conexion y de la variante `GLASS`:

- no activa el vino en la carta publica de Winerim;
- no publica botella ni magnum de un vino inactivo;
- exige un precio de copa positivo y configurado expresamente;
- no inventa precios ni modifica stock;
- conserva la regla general del resto de restaurantes.

## Snapshot previo

- `provider_config` SHA-256:
  `0b3fc752b4b58b77a270137f553c04075162fbdc91e8c255e52428dcd1945bd2`
- `publish_hidden_glass_variants`: ausente.
- `agora_hidden_glass_variants`: ausente.
- `COPAS WINERIM`: familia Agora `901954`, visible y vacia.
- Editor publico Winerim con filtro copa: `0/31`; las 31 fichas estaban
  inactivas para el cliente final.

## Lista autorizada

| Winerim ID | Vino | Tipo | Precio copa |
|---:|---|---|---:|
| 242206 | Xion Albarino | blanco | 3,80 EUR |
| 242208 | Quinta de Couselo | blanco | 4,50 EUR |
| 242214 | A Teixa | blanco | 6,00 EUR |
| 242218 | Neno Sobre Lias | blanco | 4,00 EUR |
| 242219 | La Llorona | blanco | 6,00 EUR |
| 242210 | Sin Palabras Especial | blanco | 6,00 EUR |
| 242211 | Antonio Montero | blanco | 3,00 EUR |
| 242244 | Vina de Martin Os Pasas Blanco | blanco | 5,00 EUR |
| 242213 | Village | blanco | 4,70 EUR |
| 242217 | Algueira Brandan | blanco | 3,80 EUR |
| 242270 | Pazo de Senorans Coleccion | blanco | 5,50 EUR |
| 272013 | Valdamor | blanco | 4,30 EUR |
| 242283 | Tosca Cerrada Palomino Fino en Rama | blanco | 4,50 EUR |
| 242224 | Algueira Mencia Joven | tinto | 3,20 EUR |
| 242226 | Camino Real | tinto | 4,30 EUR |
| 242232 | Quite | tinto | 4,00 EUR |
| 242233 | Balbas Barrica 5 | tinto | 3,00 EUR |
| 242234 | Cillar de Silos Crianza | tinto | 4,20 EUR |
| 242235 | Antidoto | tinto | 5,00 EUR |
| 242227 | Lalama | tinto | 5,50 EUR |
| 242240 | Desvelo Garnacha | tinto | 4,50 EUR |
| 242248 | El Seque | tinto | 5,50 EUR |
| 257027 | Atrium Vitis SS Souson | tinto | 6,00 EUR |
| 257159 | Pizarras y Esquistos | tinto | 4,00 EUR |
| 257273 | Altun Crianza | tinto | 3,50 EUR |
| 257292 | Eidos Ermos | tinto | 4,20 EUR |
| 257276 | Antidoto | tinto | 5,00 EUR |
| 257199 | Harveys Palo Cortado | fortificado | 5,50 EUR |
| 247696 | Delicado | postre | 6,50 EUR |
| 270553 | Vi De Glass Riesling | postre | 7,50 EUR |
| 270679 | Bizi Goxo | postre | 7,50 EUR |

Los nombres y precios son una captura del editor de Casa Nene. La API v2
devuelve `404` para las fichas publicas inactivas, por lo que el middleware no
puede redescubrir automaticamente un cambio posterior en esos precios hasta
que Winerim exponga una vista de integracion que incluya variantes ocultas.

## Implementacion

La conexion utiliza:

- `publish_hidden_glass_variants=true`;
- `agora_hidden_glass_variants` con la lista anterior;
- marcador exclusivamente en memoria `_agora_allow_inactive_glass`;
- auditoria, verificacion, cola y reconciliador con la misma politica.

El verificador no debe reclasificar estas copas como retiradas. Cualquier otro
formato inactivo sigue quedando oculto.

Codigo publicado en `main`: commits `e10e1ac` y `5d30421`.

La configuracion de conexion se activo a `2026-07-20T14:02:48.734Z` con 31
variantes. Tras desplegar `5d30421`, la sonda segura de `270679` devolvio
`would_queue:GLASS` y la auditoria previa devolvio `31 MISSING`, sin
diferencias, fallos de validacion ni colisiones.

La publicacion se ejecuto en siete lotes de cinco referencias como maximo. Cada
lote exigio una lectura fresh y termino en `MATCH`. Resultado final:

- `348/348 MATCH` en el catalogo efectivo de Casa Nene;
- `31/31` copas en la familia `901954` con precio y vendibilidad exactos;
- `31` tracking `WINERIM/VERIFIED`;
- `31` mappings `CONFIRMED/XML_IMPORT`;
- cero tareas `QUEUED` o `RUNNING` y cero errores de la operacion.

Evidencia machine-readable:
`docs/operations/agora-catalog-reconciliation-2026-07-20T14-53-35-126Z/summary.json`.

La operacion no escribio en Winerim. Las fichas siguen ocultas para el cliente
final y botella/magnum inactivos siguen bloqueados.

Tras superar la siguiente ventana automatica de cinco minutos, una nueva
auditoria a `2026-07-20T15:00:45Z` mantuvo `31/31 MATCH`, cero tareas activas y
cero alertas abiertas. El automatico no revirtio la excepcion.

## Verificacion exigida

- [x] Auditoria fresh: las 31 copas son `MATCH` en Agora.
- [x] Familia `901954`: 31 productos vendibles, precios exactos.
- [x] Tracking: 31 filas `GLASS / VERIFIED`.
- [x] Cola: cero tareas activas y cero errores de esta operacion.
- [x] Carta publica Winerim: no fue modificada por la operacion.
- [ ] Venta real controlada: una copa debe entrar en historial ERP como `TPV`,
   con hora Agora y variante copa; si hay stock activo, debe descontar el
   `glass_stock_id` correspondiente.

## Rollback

1. Guardar un nuevo snapshot fresh de catalogo y tracking.
2. Desactivar `publish_hidden_glass_variants` conservando temporalmente la
   lista para trazabilidad.
3. Encolar ocultacion diferencial solo para los 31 productos `GLASS` de esta
   lista y procesar la cola.
4. Verificar que dejan de ser vendibles, sin tocar botellas, magnums, ventas,
   stock ni la carta publica Winerim.
5. Eliminar `agora_hidden_glass_variants` solo despues de validar el rollback.
