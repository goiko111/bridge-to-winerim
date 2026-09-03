# Agora - nueve conexiones llevadas a estado live-ready

Fecha de operación: `2026-07-16`

## Alcance

Conexiones incluidas:

- De la O
- El Portón de Sorní
- Ocean Club
- Finca Eslava
- Vinatea
- Don Quijote Marbella
- Abadía Yuste
- El Higuerón
- Restaurante Qtomas

Regla aplicada: mantener visible e intacto todo el catálogo legacy. Las
operaciones solo crean, verifican o actualizan familias y productos cuya
propiedad Winerim está demostrada mediante ID determinista, mapping confirmado
o tracking `source=WINERIM`.

## Resultado final

| Conexión | ID | Formatos elegibles | Mappings confirmados | Tracking verificado | Familias Winerim | Cola activa | Estado |
|---|---|---:|---:|---:|---:|---:|---|
| De la O | `99f3a782-844f-4515-a570-662a111ced2e` | 87 | 87 | 87 | 8 | 0 | `LIVE_PENDING_SALE_CANARY` |
| El Portón de Sorní | `a3bc8cbe-baf0-4b4c-b460-1baafd8cdbc2` | 174 | 175 | 175 | 8 | 0 | `LIVE_PENDING_SALE_CANARY` |
| Ocean Club | `706b952e-767d-41af-9cba-8e225b16a877` | 113 | 113 | 113 | 8 | 0 | `LIVE_PENDING_SALE_CANARY` |
| Finca Eslava | `d15af3ec-1225-4438-bb95-af672da43512` | 123 | 123 | 123 | 8 | 0 | `LIVE_PENDING_SALE_CANARY` |
| Vinatea | `e465872a-bff5-43de-8e4c-fe4986f0fd4f` | 132 | 132 | 132 | 8 | 0 | `LIVE_PENDING_SALE_CANARY` |
| Don Quijote Marbella | `8466c229-773d-4ad9-a747-9bb862d7ae6b` | 114 | 114 | 114 | 8 | 0 | `LIVE_PENDING_SALE_CANARY` |
| Abadía Yuste | `6402cc37-2f3f-4243-8d3c-1d2df7753dd1` | 281 | 281 | 281 | 8 | 0 | `LIVE_PENDING_SALE_CANARY` |
| El Higuerón | `c2e41778-fd14-4a83-9b24-d4fd305fe490` | 291 | 291 | 291 | 8 | 0 | `LIVE_PENDING_SALE_CANARY` |
| Restaurante Qtomas | `57e8acbe-5b5f-433c-a0c6-e760c211acd3` | 1014 | 1000 | 987 | 8 | 0 | `BLOCKED_EXTERNAL_POS_DOWN` |

El Portón conserva un tracking histórico adicional de un formato ya retirado.
La comprobación fresh confirma que ese producto no es vendible.

## Configuración común de las ocho conexiones alcanzables

- `enabled=true`
- `sync_mode=BIDIRECTIONAL`
- `sync_frequency_minutes=5`
- `catalog_sync_enabled=true`
- `auto_push_on_create=true`
- `auto_push_on_update=true`
- `auto_push_verified_ready=true`
- `intraday_sales_sync_enabled=true`
- `open_tickets_sync_enabled=true`
- `open_tickets_stock_sync_enabled=true`
- prueba de conexión Agora: `PASS`
- sonda de tickets abiertos: `PASS`
- `QUEUED/RUNNING=0`
- legacy: no ocultado ni modificado

Las guardas `stock_sync_not_before` y `stock_sync_not_before_at` evitan que la
activación descuente ventas anteriores al inicio operativo.

## Configuraciones específicas

### Vinatea

- Centros de venta: `4,12,15,16`.
- Preparación verificada contra sus botones legacy de vino:
  `PreparationTypeId=8 (BARRA)` y `PreparationOrderId=1 (BEBIDAS)`.

### Ocean Club

- Conexión creada durante esta operación.
- Centros normales incluidos: `1,2,4,5,6,7`.
- Las listas/centros especiales, staff y opening quedan fuera del alcance de
  precio Winerim.

### Abadía Yuste

- La auditoría final se dividió en cuatro bloques para evitar el límite de CPU.
- Resultado agregado: `281/281 MATCH`, `0 MISSING`, `0 DIFFERENT`,
  `0 UNOWNED`.

### El Higuerón

- Se ignoró un fallo de detalle exclusivamente para `351586 - Abadia Retuerta`,
  porque está inactivo y sin precio.
- Los `291` formatos activos se actualizaron y verificaron bajo el alcance
  final de centros/preparación.

### Finca Eslava, Vinatea y Don Quijote

- Cinco tareas con `NAME_MISMATCH` por tabuladores fueron contrastadas contra
  catálogo fresh.
- Los productos coincidían exactamente en ID, familia, precio y atributos.
- Tras recuperar ownership y tracking, esas tareas se reclasificaron como
  `SUCCESS`.

## Qtomas

Hechos:

- El backend y esta máquina devuelven `NETWORK_UNREACHABLE / No route to host`.
- El puerto `8984` no acepta conexión.
- Se bloquearon de forma reversible `59` tareas repetidas.
- Se desactivaron solo las escrituras automáticas de catálogo:
  `catalog_sync_enabled=false`, `auto_push_on_create=false`,
  `auto_push_on_update=false`.
- La conexión y los flags de lectura de ventas permanecen activos para que
  pueda recuperarse cuando vuelva el POS.

Acción al recuperar conectividad:

1. Ejecutar tres probes sanos consecutivos.
2. Refrescar master data.
3. Auditar los `1014` formatos elegibles contra catálogo fresh.
4. Reencolar únicamente `MISSING` o `DIFFERENT` con ownership Winerim.
5. Confirmar cola cero y tracking verificado.
6. Reactivar los flags de catálogo.
7. Resolver la alerta solo después de evidencia fresh.

## Corrección de código

- `agora-proxy` normaliza espacios de control en la verificación postimport:
  `decodeXmlAttribute` seguido de normalización de whitespace.
- El runbook recupera ownership únicamente cuando:
  - el ID es el determinista esperado;
  - el catálogo fresh devuelve `MATCH`;
  - existe tracking previo `source=WINERIM` para el mismo vino/formato.
- Evaluación diferencial reducida a lotes de `10`.
- Los fallos de detalle de vinos inactivos no bloquean una activación; cualquier
  fallo de un vino activo sigue abortando.

El código está en GitHub `main` desde `1427141`. Hubo dos observaciones runtime
contradictorias: El Portón llegó a devolver `173/173` tras un despliegue, pero
una sonda posterior de Finca reprodujo la comparación literal anterior. Hasta
demostrar varias invocaciones coherentes, es obligatorio redesplegar únicamente
`agora-proxy` desde el `main` más reciente y repetir el canary de whitespace.

## Verificación local

- `npm test`: `74/74` pruebas.
- `npm run build`: correcto.
- `node --check scripts/activate-agora-live-ready.mjs`: correcto.
- ESLint dirigido al runbook y su test: correcto.
- El lint global conserva una deuda previa de `919` errores y `85` avisos,
  principalmente `no-explicit-any`; no procede de esta operación.

## Rollback

Rollback común, sin tocar legacy:

1. Poner `enabled=false`.
2. Poner `catalog_sync_enabled=false`.
3. Poner `auto_push_on_create=false`, `auto_push_on_update=false` y
   `auto_push_verified_ready=false`.
4. Ocultar solo las ocho familias Winerim.
5. Marcar no vendibles solo los productos con ownership Winerim confirmado.
6. No borrar `product_mappings`, `winerim_push_tracking` ni histórico: son la
   trazabilidad necesaria para reactivar sin duplicados.
7. No modificar familias ni productos legacy.

Para Ocean Club, que no existía antes de la operación, el rollback completo es
dejar la conexión desactivada y ocultar sus familias Winerim. No se elimina la
fila ni la evidencia.

## Firma operativa pendiente

`LIVE_PENDING_SALE_CANARY` no equivale a `100%_SIGNED_OFF`.

Para cada restaurante falta una prueba real controlada:

- una botella desde un botón Winerim;
- una copa desde `COPAS WINERIM`;
- comprobar hora, mapping e historial ERP Winerim;
- con stock activo, confirmar deducción de la variante correcta;
- con stock inactivo, confirmar `sales/import` sin movimiento de inventario;
- confirmar visualmente las familias en el terminal.
