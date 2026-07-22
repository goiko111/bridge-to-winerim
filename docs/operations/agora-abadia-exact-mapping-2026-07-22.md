# Abadia Yuste - mapping legacy exacto y univoco - 2026-07-22

## Alcance

La intervencion opero exclusivamente sobre la conexion Abadia Yuste:

- `connection_id`: `6402cc37-2f3f-4243-8d3c-1d2df7753dd1`;
- unica tabla modificada: `product_mappings`;
- no se procesaron ventas ni colas;
- no se modificaron stock, cursor, flags, catalogo, tracking, alertas o legacy;
- no se uso fuzzy matching como escritura.

El objetivo era reducir el backlog de ventas legacy mediante equivalencias
demostrables por codigo/SKU exacto o por nombre normalizado mas variante. En
este lote no aparecio ningun match por codigo/SKU. Los 16 matches aplicados son
por nombre exacto tras normalizar mayusculas, tildes, puntuacion y un sufijo
geografico explicito, siempre con variante `BOTTLE` y un unico vino Winerim
activo compatible.

## Protocolo y artefactos

Operador reproducible:

`tmp/agora-abadia-exact-mapping-2026-07-22.mjs`

El operador fija ID y nombre de la conexion, exige hash del dry-run revisado y
confirmacion explicita antes de escribir. Los tres artefactos tienen permisos
`0600`:

- dry-run revisado:
  `outputs/AGORA_ABADIA_EXACT_MAPPING_DRY_RUN_2026-07-22T11-45-28-359Z.json`;
- snapshot previo y resultado de aplicacion:
  `outputs/AGORA_ABADIA_EXACT_MAPPING_APPLY_2026-07-22T11-46-17-546Z.json`;
- auditoria fresh posterior:
  `outputs/AGORA_ABADIA_EXACT_MAPPING_DRY_RUN_2026-07-22T11-47-12-074Z.json`.

Hash aprobado:

`3e29b1094daafea2c55931919fa316d26c4df00f5d5886872bf0274cc00c2df7`

## Resultado aplicado

Se crearon 16 mappings `CONFIRMED`, todos de botella, que cubren 25 lineas y
26 unidades de la ventana fresh de 45 dias.

| Agora ID | Producto legacy | Winerim ID | Vino Winerim | Uds. observadas |
|---:|---|---:|---|---:|
| 2068 | Conde de Haro Brut Rose | 138642 | Conde de Haro Brut Rose | 1 |
| 2094 | Branco De Santa Cruz (DO Valdeorras) | 138869 | Branco de Santa Cruz | 2 |
| 2099 | Nadir (DO Ribera del Guadiana) | 138905 | Nadir | 5 |
| 2101 | Payva Crianza (DO Ribera del Guadiana) | 138906 | Payva Crianza | 2 |
| 2106 | Finca Resalso (DO Ribera Del Duero) | 138939 | Finca Resalso | 2 |
| 2115 | Habla Del Silencio (Vino de Extremadura) | 138933 | Habla del Silencio | 2 |
| 2123 | Marques De Riscal XR (DOCa Rioja) | 138925 | Marques de Riscal XR | 1 |
| 2135 | Tomas Postigo (DO Ribera del Duero) | 138913 | Tomas Postigo | 1 |
| 2143 | Aalto (DO Ribera del Duero) | 138960 | Aalto | 1 |
| 2146 | PSI (DO Ribera del Duero) | 138958 | PSI | 2 |
| 2147 | Malleolus (DO Ribera del Duero) | 138957 | Malleolus | 1 |
| 3250 | Buche verdejo | 140318 | Buche Verdejo | 1 |
| 3284 | Leneus Barrica (DO Ribera del Guadiana) | 138984 | Leneus Barrica | 1 |
| 3310 | Huno reserva (DO Ribera del Guadiana) | 138982 | Huno Reserva | 2 |
| 3390 | Ruiz Torres Verdejo | 192701 | Ruiz Torres Verdejo | 1 |
| 4458 | LA COCHINITA | 269606 | La Cochinita | 1 |

Cada vino estaba activo y tenia precio de botella y `bottle_stock_id`. La
verificacion fresh encontro las 16 filas con el ID Winerim y variante esperados.

## Descartes conservadores

Antes habia 46 IDs vendidos sin resolver. Tras el lote quedan 30 IDs, 189
lineas y 225 unidades sin equivalencia exacta. No se escribio ninguno.

Entre ellos hay:

- botones genericos: `Copa Ribera del duero`, `Copa Rioja`, `Copa semidulce`,
  `Copa vino BLANCO VERDEJO`, `Copa Vino extremeno`, `Copa Vino Rosado` y
  `Copa vino BLANCO Marq. Riscal`;
- falsos positivos no mapeables como vino concreto: `Mosto Tinto`, `Mosto
  Blanco`, `Tinto de Verano` y `Esparrago blanco`;
- nombres nominales sin igualdad exacta en el catalogo Winerim activo:
  `Marques de Riscal Suavignon`, `Macan cosecha magnum`, `Raventos I Blanc La
  Nit`, `Louis Roederer collection`, `Billecart Salmon Rose`, `ValdesiI
  Godello`, `Habla de la tierra`, `Nadir V Seleccion Especial`, `Vina Puebla
  Seleccion`, `Vina Puebla Madre Agua`, `Abadia Retuerta Seleccion`, `Habla de
  Mar`, `Habla de ti`, `Pazo Barrantes Albarino`, `El anden de la estacion
  Muga`, `Mastines de los balancines`, `Leneus Blanco`, `Muga Rosado Joven` y
  `Marques de Riscal Sobre lias finas`.

La lista completa, nombres originales, familias, formatos, cantidades y causa
de descarte esta en el dry-run posterior.

## Verificacion posterior

Antes y despues:

| Invariante | Antes | Despues |
|---|---:|---:|
| Catalogo fresh | 281/281 | 281/281 |
| Ausentes / diferentes / sin ownership | 0 / 0 / 0 | 0 / 0 / 0 |
| Tareas `QUEUED/RUNNING` | 0 | 0 |
| Breaker | cerrado | cerrado |
| Fallos consecutivos | 0 | 0 |
| Alerta previa | sin cambio | sin cambio |
| Cursor | `2025-03-16` | `2025-03-16` |

El dry-run posterior devuelve `candidateCount=0`: el operador no encuentra
ninguna escritura exacta adicional dentro de sus reglas.

## Rollback

Las 16 filas eran nuevas. El rollback elimina solo sus IDs de mapping, en
orden inverso, y vuelve a verificar catalogo, cola y breaker:

```bash
node tmp/agora-abadia-exact-mapping-2026-07-22.mjs \
  --rollback \
  --confirm-abadiayuste-exact-mapping-rollback \
  --snapshot=outputs/AGORA_ABADIA_EXACT_MAPPING_APPLY_2026-07-22T11-46-17-546Z.json
```

No se ejecuto el rollback porque el post-check fue correcto. El snapshot
contiene las filas creadas y la ausencia de fila previa para cada una.

## Estado y siguiente paso

La incidencia se ha reducido, pero Abadia no queda desbloqueada ni al 100 por
ciento. Permanecen:

1. 30 IDs vendidos sin mapping exacto;
2. el hueco no inspeccionado `2025-03-17..2026-06-06`;
3. tickets abiertos huerfanos desde 2025;
4. el fallo de stock Winerim `142911` pendiente de evidencia.

No se debe adelantar el cursor, procesar ventas, desactivar el guard de tickets
ni usar fuzzy matching. El siguiente lote necesita confirmacion humana para
los botones genericos y revision individual de los nombres nominales restantes.
