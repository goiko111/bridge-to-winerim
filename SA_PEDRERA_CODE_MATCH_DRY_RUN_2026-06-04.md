# Sa Pedrera - Dry-run matching por código

Fecha: 2026-06-04 12:20 CEST

## Contexto
- El usuario aporta captura de Winerim donde los vinos llevan código correlativo en el nombre: `G801-Península Palo Cortado`, `G802-Papirusa`, `G803-Sa Cudia Oxidativo`.
- El usuario aporta captura de Agora donde se ven botones con el mismo patrón de código, por ejemplo `B T31-Semele`, `B T42-Tomás Postigo`, `B T41-Abadía Retuert`, `B T43-Mauro`.
- Interpretación técnica: en Agora, el prefijo `B`, `C` o `M` identifica formato publicado en TPV (`botella`, `copa`, `magnum`); el código Winerim real es `T31`, `G801`, `B303`, `MAGNUM21`, etc.

## Regla segura propuesta
- Priorizar matching por código comercial exacto antes que fuzzy.
- Extraer código solo cuando el nombre tiene patrón de código con separador:
  - Sí: `G801-Península Palo Cortado` -> `G801`.
  - Sí: `B T31-Semele` -> `T31`.
  - Sí: `C B303-Binitord Blanc` -> `B303`.
  - Sí: `MAGNUM 21 - Finca La Montesa` -> `MAGNUM21`.
  - No: `Magnum 4 Kilos` no es código `MAGNUM4`; es un nombre legacy con número en el nombre.
  - No: `As 2 Ladeiras` no es código `AS2`.
- Si el código exacto apunta a un único vino Winerim, el match puede ser `CODE_EXACT`.
- Si el código aparece duplicado en Winerim, el match queda ambiguo y no debe auto-confirmarse.

## Resultado del dry-run contra Lovable Cloud
- Cache Agora usada: `agora_master_data.fetched_at=2026-06-04T10:15:07.846+00:00`.
- Productos de vino visibles detectados: `872`.
- Productos legacy visibles: `479`.
- Productos Winerim visibles/publicados: `393`.
- Productos Winerim visibles con código extraíble: `390`.
- Productos Winerim visibles sin código extraíble: `3`:
  - `B Doña Palaueta`.
  - `B Moscatel de la Marina`.
  - `C Moscatel de la Marina`.
- Legacy visible con código extraíble: `1`.
- Matches legacy exactos por código: `1`.
- Conflictos de código detectados: `0`.

## Match exacto encontrado en legacy
| Agora ID | Legacy Agora | Familia | Código | Formato | Winerim |
| --- | --- | --- | --- | --- | --- |
| 235 | T1-Iamontanum Garnacha | Vinos Tintos > T Baleares | T1 | BOTTLE | T1 - Iamontanum Garnacha - Isla de Menorca |

## Conclusión
- La captura de Agora muestra sobre todo productos Winerim ya publicados, no necesariamente el legacy antiguo del cliente.
- En la cache actual, el legacy antiguo visible no trae códigos comerciales en casi ningún caso; por eso no se puede convertir toda la carta legacy a matching perfecto solo por código.
- El problema visual de Sa Pedrera es convivencia de dos capas:
  - Legacy arriba/sin código, por ejemplo `Victorino`, `Pintia`, `El Nogal`, `Dominio del Aguila`.
  - Winerim publicado abajo/con código, por ejemplo `B T31-Semele`, `B T42-Tomás Postigo`.
- Próxima acción segura: aplicar política `legacy-first` solo donde el legacy tenga mapping inequívoco; para el resto, decidir con el cliente si quiere:
  1. Ocultar legacy sin mapping y operar con los productos Winerim codificados.
  2. Mantener legacy visible y mapear manualmente los más usados.
  3. Reorganizar los productos Winerim codificados en la estructura regional y ocultar legacy duplicado.

## Cambio de código preparado
- Añadido helper `productCodeMatching.ts`.
- `winerim-proxy` ahora prioriza `CODE_EXACT` antes que fuzzy cuando el nombre de POS trae código comercial exacto.
- Si hay varios vinos Winerim con el mismo código, devuelve `CODE_AMBIGUOUS` con score bajo para impedir confirmación automática.
- Tests añadidos para códigos Winerim/Agora y falsos positivos de nombres con números.
