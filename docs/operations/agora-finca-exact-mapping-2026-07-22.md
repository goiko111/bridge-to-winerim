# Finca Eslava - matching exacto de legacy pendiente - 2026-07-22

Fecha de operacion: 2026-07-22 13:47 CEST

Conexion: `d15af3ec-1225-4438-bb95-af672da43512`

Alcance: exclusivamente Finca Eslava y los dias definitivos pendientes
`2026-07-19..2026-07-21`.

## Garantias de la operacion

- Se hizo lectura fresh de las facturas de los tres dias y del catalogo Agora.
- Se tomo snapshot con permisos `0600` antes de considerar cualquier escritura.
- Se ejecuto un dry-run que solo admite codigo/SKU exacto o nombre normalizado
  exacto con variante unica demostrable.
- No se uso fuzzy matching, similitud semantica ni inferencia por familia.
- No se procesaron ventas, stock, cursor, flags, catalogo, cola ni legacy.
- El dry-run produjo `0` candidatos exactos, por lo que no se escribio ninguna
  fila en `product_mappings`.

## Evidencia fresh

| Dia | Facturas cerradas |
|---|---:|
| 2026-07-19 | 39 |
| 2026-07-20 | 46 |
| 2026-07-21 | 41 |

- Catalogo Agora fresh: `1.102` productos; SHA-256
  `39e7e3886c48b213f4c23c09e61a97b65ee5bea625d5173ddd9cd7c7670fd3f0`.
- Catalogo Winerim esperado: `123/123 MATCH`, `0 MISSING`, `0 DIFFERENT` y
  `0 UNOWNED`.
- Cola activa final: `0`.
- Breaker final: cerrado; `consecutive_failures=0`.
- Cursor antes y despues: `2026-07-18`.
- Sigue abierta la alerta `sales_stale`; es coherente con el bloqueo no
  resuelto y no se cerro artificialmente.

Snapshot:

`outputs/agora-finca-exact-mapping-2026-07-22/dry-run-2026-07-22T11-47-23-895Z.json`

- modo: `0600`;
- SHA-256 del snapshot serializado:
  `9be199296d736157c6b39e81dcdf432a73d95a6217d22748e4561be2161381c7`.

Resultado:

`outputs/agora-finca-exact-mapping-2026-07-22/dry-run-result-2026-07-22T11-47-23-895Z.json`

Operador reproducible:

`tmp/agora-finca-exact-mapping-2026-07-22.mjs`

## Resultado del matching

| Agora ID | Boton | Neto pendiente | Resultado |
|---:|---|---:|---|
| 755 | COPA TINTO | 13 | bloqueado: generico |
| 756 | COPA BLANCO | 9 | bloqueado: generico |
| 758 | COPA FRIZANTE | 9 | bloqueado: generico |
| 759 | COPA ROSADO | 1 | bloqueado: generico |
| 764 | COPA MALAGA VIRGEN | 2 | sin codigo/SKU ni nombre+variante exactos |
| 768 | COPA TIO PEPE | 1 | sin codigo/SKU ni nombre+variante exactos |
| 777 | COPA NPU | 2 | sin codigo/SKU ni nombre+variante exactos |

`TINTO LIMON` y `TINTO VERANO` tambien aparecieron como falsos positivos del
clasificador de vino; no tienen match exacto y no se mapearon.

La revision nominal adicional confirmo que Winerim contiene `Málaga
Trasañejo`, no `Málaga Virgen`, y no contiene una ficha exacta `Tío Pepe` ni
`NPU` con variante de copa. Tambien existe `Juan Gil Etiqueta Plata`, pero el
boton legacy vendido es `JUAN GIL 12 MESES`; no se considero equivalencia
exacta.

## Decision

No crear mappings. Hacerlo ahora atribuiria ventas reales a referencias que no
estan demostradas. El bloqueo del cursor se reduce solo cuando el cliente
confirme la referencia concreta servida por cada boton o cambie la operativa
para marcar botones Winerim nominales.

## Rollback

No aplica rollback de datos: la operacion realizo cero escrituras en
`product_mappings` y cero escrituras operativas. El snapshot demuestra que no
existia ninguna fila previa para los nueve IDs revisados. Si apareciera una
fila nueva para esos IDs, no procederia de este dry-run y deberia investigarse
antes de eliminarla.

## Siguiente paso seguro

1. Obtener del cliente la referencia Winerim exacta para cada copa nominal o
   generica que quiera conservar.
2. Exigir confirmacion explicita de variante `GLASS` y no aceptar una familia
   o color como equivalencia.
3. Repetir lectura fresh, snapshot `0600` y dry-run.
4. Crear solo mappings exactos confirmados.
5. Cuando el primer dia quede completamente resoluble, procesar los dias en
   orden cronologico y verificar el ERP Winerim antes de permitir que avance
   el cursor.
