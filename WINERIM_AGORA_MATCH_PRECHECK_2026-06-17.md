# Winerim vs Agora pre-match

Fecha: 2026-06-17

Alcance:

- El Bejeque
- Taberna de Elia

Fuentes:

- Excel Winerim exportado por el usuario.
- Catálogo Agora leído en modo solo lectura mediante `export-master`.

No se creó conexión, no se importó XML, no se modificó stock y no se escribieron credenciales.

## Criterio de análisis

- `Operativo Winerim`: vino `Activo=true` y con al menos un formato con precio.
- `Match automático`: coincidencia exacta normalizada, coincidencia compacta, contención muy clara o fuzzy seguro.
- `Review`: posible coincidencia, pero no suficientemente segura para confirmar mapping sin revisión humana.
- `No match`: no se encontró candidato útil en Agora.

El porcentaje seguro usa solo `Match automático`. Si se suman los `Review`, es cobertura potencial, no confirmada.

## El Bejeque

### Winerim

- Total filas Winerim: `75`
- Activos: `72`
- Inactivos: `3`
- Con algún precio: `75`
- Operativos (`Activo + precio`): `72`
- Activos sin precio: `0`
- Inactivos con precio: `3`

Formatos operativos con precio:

- Botella: `70`
- Copa: `21`
- Magnum: `6`
- Botella pequeña: `1`

### Agora

Familias de vino legacy seleccionadas:

| Familia | Visible | Productos | Vendibles |
|---|---:|---:|---:|
| `14 · TINTOS` | no | 48 | 34 |
| `15 · BLANCOS` | no | 21 | 10 |
| `16 · ROSADO` | no | 4 | 3 |
| `17 · ESPUMOSO` | no | 6 | 3 |
| `18 · FORTIFICADO` | no | 1 | 0 |
| `19 · POSTRE` | no | 6 | 2 |

Total productos de vino en esas familias: `86`, de los cuales `52` vendibles.

### Match

Sobre `72` vinos operativos Winerim:

- Match automático seguro: `54` (`75.0%`)
- Review: `9` (`12.5%`)
- No match: `9` (`12.5%`)
- Cobertura potencial si se revisan y aceptan los `Review`: `63/72` (`87.5%`)

Por tipo:

| Tipo | Operativos | Match seguro | Review | No match |
|---|---:|---:|---:|---:|
| Blanco | 16 | 11 | 3 | 2 |
| Espumoso | 5 | 5 | 0 | 0 |
| Fortificado | 2 | 2 | 0 | 0 |
| Postre | 6 | 2 | 2 | 2 |
| Rosado | 3 | 2 | 1 | 0 |
| Tinto | 40 | 32 | 3 | 5 |

No-match operativo detectado:

- `Verdejo 5000`
- `Edición Limitada Garnacha`
- `THM Crianza de Jorge Muga`
- `Néctar de Farruche`
- `Bassus Pinot Noir Dulce`
- `Balancines Garnacha y Garnacha`
- `Campos de Solana Marselán`
- `Vega Norte Albillo Criollo`
- `La Felisa`

### Interpretación

El Bejeque parece bastante apto para matching legacy inicial. El principal bloqueo no es el porcentaje de match, sino que las familias de vino Agora están ocultas; hay que confirmar si esa ocultación es intencionada antes de decidir si se reutiliza legacy o se publican familias Winerim dedicadas.

## Taberna de Elia

### Winerim

- Total filas Winerim: `484`
- Activos: `374`
- Inactivos: `110`
- Con algún precio: `478`
- Operativos (`Activo + precio`): `373`
- Activos sin precio: `1` (`Prima`, tinto)
- Inactivos con precio: `105`

Formatos operativos con precio:

- Botella: `343`
- Copa: `49`
- Magnum: `10`
- Botella pequeña: `10`
- Benjamin: `1`
- Media botella: `8`

### Agora

Familias de vino seleccionadas:

- Total productos en familias de vino seleccionadas: `1.061`
- Vendibles: `603`

Familias visibles principales:

| Familia | Productos | Vendibles |
|---|---:|---:|
| `16 · Vinos` | 45 | 38 |
| `27 · Ribera del Duero` | 115 | 33 |
| `28 · Rioja` | 98 | 19 |
| `29 · Toro` | 19 | 8 |
| `30 · Castilla y León` | 24 | 3 |
| `31 · Bierzo` | 13 | 1 |
| `32 · Madrid` | 21 | 15 |
| `33 · Otras Denominaciones` | 101 | 40 |
| `34 · Magnum y Medias Botellas` | 28 | 28 |
| `50 · Blancos` | 134 | 42 |
| `51 · Espumosos` | 44 | 44 |
| `52 · Otros Vinos` | 7 | 2 |
| `59 · frances blanco` | 43 | 17 |
| `62 · Priorato` | 19 | 9 |
| `63 · Jumilla` | 8 | 3 |
| `65 · D.O. Ribera Sacra` | 7 | 6 |

Además hay familias antiguas ocultas con vino: `Blancos Alemanes`, `Blancos nacionales`, `Cavas`, `Champagne`, `Jerez`, `Ribera del Duero`, `Rioja`, `Tintos Franceses`, `Blancos Franceses`.

### Match

Sobre `373` vinos operativos Winerim:

- Match automático seguro: `176` (`47.2%`)
- Review: `96` (`25.7%`)
- No match: `101` (`27.1%`)
- Cobertura potencial si se revisan y aceptan los `Review`: `272/373` (`72.9%`)
- Dentro del match seguro, `62` casos tienen duplicidad/ambigüedad de producto en Agora y conviene revisarlos antes de confirmar mapping.

Por tipo:

| Tipo | Operativos | Match seguro | Review | No match |
|---|---:|---:|---:|---:|
| Blanco | 94 | 31 | 32 | 31 |
| Espumoso | 32 | 4 | 15 | 13 |
| Fortificado | 26 | 13 | 11 | 2 |
| Postre | 16 | 3 | 8 | 5 |
| Rosado | 2 | 0 | 0 | 2 |
| Tinto | 203 | 125 | 30 | 48 |

Ejemplos de no-match operativo:

- `Julieta Trepat`
- `Becquer Cosecha`
- `Finca La Montesa`
- `Viña Bosconia Reserva`
- `Brezo Godello`
- `Silva Daponte Godello`
- `Niepoort Ruby`
- `Heri-Hodie Premier Cru Extra Brut`
- `Quinta do Bom Retiro 20 Year Old Tawny`

### Interpretación

Taberna de Elia no debe tratarse como volcado directo. Hay muchos productos Agora de bodega, pero también muchas familias duplicadas/ocultas y `62` matches seguros con duplicidad o ambigüedad. La estrategia más segura es:

1. Hacer una fase de matching legacy por nombre/código si existe.
2. Confirmar manualmente duplicados y `Review`.
3. No ocultar legacy ni crear familias Winerim masivas hasta validar la pantalla real.
4. Tratar producto genérico `Botella de Vino` como no mapeable a stock Winerim salvo cambio operativo.

## Recomendación

- El Bejeque: viable para matching inicial; revisar visibilidad oculta de familias antes de escribir.
- Taberna de Elia: viable para integración, pero necesita fase de matching/revisión más larga antes de cualquier publicación Winerim o ocultación legacy.
