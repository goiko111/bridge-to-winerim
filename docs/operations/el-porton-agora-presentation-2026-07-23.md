# El Porton de Sorni - normalizacion de presentacion Agora

Fecha: 2026-07-23

Conexion: `a3bc8cbe-baf0-4b4c-b460-1baafd8cdbc2`

Estado: `PREPARED / READ_ONLY / NOT_APPLIED`

No se ha escrito en Agora, no se ha modificado `provider_config` y no se ha
desplegado ninguna funcion durante esta preparacion.

## Evidencia fresh actual

- Conexion activa en `XML_IMPORT`.
- Breaker cerrado.
- Cola `QUEUED/RUNNING`: `0`.
- Auditoria fresh: `173/173 MATCH`.
- Ausentes: `0`.
- Diferentes: `0`.
- Sin ownership: `0`.
- Productos con tracking `VERIFIED` y prueba fresh completa: `173`.
- Estan presentes los ocho mappings requeridos:
  - `botella_tinto` -> `900157 · TINTOS WINERIM`;
  - `botella_blanco` -> `904241 · BLANCOS WINERIM`;
  - `botella_rosado` -> `903516 · ROSADOS WINERIM`;
  - `botella_espumoso` -> `908875 · ESPUMOSOS WINERIM`;
  - `botella_dulce` -> `903925 · DULCE WINERIM`;
  - `botella_fortificado` -> `908182 · FORTIFICADOS WINERIM`;
  - `copa` -> `901954 · COPAS WINERIM`;
  - `magnum` -> `904289 · MAGNUM WINERIM`.

## Accion compartida

El script ya no genera ni importa por su cuenta el plan principal. Delega
dry-run, canary, escritura y verificacion a:

```text
normalize-winerim-product-presentation
```

La accion:

1. selecciona productos con ownership Winerim probado;
2. lee Products mediante `fetchAgoraProductsXmlCached(..., forceFresh=true)`;
3. conserva el XML completo y el `Name` tecnico;
4. cambia solo `FamilyId`, `ButtonText`, `Color` y `Order`;
5. crea o actualiza las familias geograficas necesarias;
6. escribe mediante `fetchWithRetry`;
7. invalida cache y verifica Products y Families fresh;
8. devuelve el XML exacto de rollback.

El script reduce aun mas el alcance pasando exclusivamente los `173`
`productIds` que simultaneamente estan `VERIFIED` y en estado fresh `MATCH`.
Legacy, precios, IVA, preparacion, visibilidad, stock, ventas y mappings quedan
fuera del cambio.

## Configuracion objetivo

El requisito funcional `presentation_enabled=true` se persiste con el nombre
canonico que consume el runtime:

```json
{
  "agora_product_presentation_enabled": true,
  "agora_product_sort_mode": "ALPHABETICAL_WINE_NAME",
  "agora_product_button_text_mode": "WINE_NAME_WITH_FORMAT_SUFFIX",
  "agora_product_color_by_wine_type": {
    "tinto": "#800040",
    "blanco": "#FFFFFF",
    "rosado": "#DC82EF",
    "espumoso": "#FF8080",
    "dulce": "#F5A623",
    "fortificado": "#F1C097"
  },
  "family_structure_mode": "WINE_TYPE_SPAIN_DO_FOREIGN_COUNTRY"
}
```

Estas claves se fusionan sobre el `provider_config` anterior; el resto de la
configuracion de El Porton se conserva byte a byte a nivel de valores JSON.

El `provider_config` actual no contiene todavia ninguna de estas cinco claves.
Por eso el modo de lectura informa `PENDING_TARGET_CONFIG`: la accion lee la
configuracion viva y no admite override en el payload. Ejecutar ahora su
dry-run exacto exigiria modificar temporalmente produccion, algo expresamente
prohibido en esta sesion.

## Resultado esperado

- `ButtonText`: nombre alfabetico con `[B]`, `[C]` o `[M]`.
- `Name`: tecnico y estable, sin cambios.
- Productos ordenados alfabeticamente dentro de cada familia.
- Productos coloreados por tipo, tambien dentro de Copas y Magnum.
- Copas permanecen en `COPAS WINERIM`.
- Magnum permanece en `MAGNUM WINERIM`.
- Botellas espanolas: familia de tipo > DO/region estructurada.
- Botellas extranjeras: familia de tipo > pais.
- Fallbacks: `OTRAS DO ESPAÑA` y `OTROS PAÍSES`.
- Una nueva DO o pais se crea deterministamente en futuras altas.

## Modo de lectura

```bash
node scripts/el-porton-agora-presentation-2026-07-23.mjs
```

Este modo solo comprueba conexion, breaker, cola, mappings, ownership, auditoria
fresh y diferencia entre configuracion actual y objetivo. Si la configuracion
objetivo ya estuviera aplicada, tambien ejecutaria la accion en dry-run con
`includeXml=true`, sin escribir.

## Aplicacion controlada futura

Solo tras autorizacion expresa del orquestador:

```bash
node scripts/el-porton-agora-presentation-2026-07-23.mjs \
  --apply \
  --confirm=NORMALIZE_WINERIM_PRESENTATION \
  --snapshot-output /ruta/privada/el-porton-presentation.json
```

Opcionalmente puede fijarse el producto canary:

```bash
  --canary-product-id PRODUCT_ID
```

Si no se indica, se selecciona deterministicamente el primer producto botella
con cambio dentro del preview de la accion.

La operacion ejecuta, en este orden:

1. Repite preflight fresh y exige cola cero, breaker cerrado, ocho mappings y
   `173/173` productos verificados.
2. Guarda antes de tocar produccion un snapshot privado `0600` con el
   `provider_config` anterior exacto y su hash.
3. Aplica solo la configuracion objetivo y verifica su hash leyendo de nuevo la
   fila de conexion.
4. Ejecuta `normalize-winerim-product-presentation` con `dryRun=true`, los 173
   IDs e `includeXml=true`.
5. Guarda plan XML y rollback XML completos, hashes, resumen y familias antes
   de la primera escritura en Agora.
6. Ejecuta un dry-run especifico del canary.
7. Escribe solo el canary con:

```json
{
  "dryRun": false,
  "confirm": "NORMALIZE_WINERIM_PRESENTATION"
}
```

8. Repite el canary en dry-run y exige `changedProducts=0` y
   `changedFamilies=0`.
9. Vuelve a exigir cola cero y aplica los 173 productos mediante la misma
   accion y confirmacion.
10. Exige verificacion fresh de Products y Families sin fallos.
11. Ejecuta auditoria fresh `173/173` y un ultimo dry-run completo; ambos deben
    quedar exactos y el segundo debe ser idempotente con cero cambios.
12. Comprueba cola cero y que `provider_config` conserva exactamente el hash
    objetivo.

El snapshot registra cada estado: `SNAPSHOT_CREATED`,
`TARGET_CONFIG_STAGED`, `DRY_RUN_VERIFIED`, `CANARY_VERIFIED` y `COMPLETE`.

## Rollback automatico

Si cualquier paso falla despues de activar la configuracion objetivo, el
script intenta automaticamente:

1. comprobar que el `provider_config` sigue siendo exactamente el objetivo;
2. restaurar el `provider_config` anterior exacto;
3. importar el rollback XML capturado antes del canary;
4. exigir de nuevo una auditoria fresh exacta;
5. dejar el snapshot como `ROLLED_BACK_AFTER_FAILURE`.

Si el rollback automatico no pudiera completarse, el snapshot queda como
`FAILED_ROLLBACK_REQUIRED` y conserva todo lo necesario para intervenir.
Nunca pisa silenciosamente una configuracion modificada externamente durante
la operacion.

## Rollback manual

```bash
node scripts/el-porton-agora-presentation-2026-07-23.mjs \
  --rollback /ruta/privada/el-porton-presentation.json \
  --confirm=NORMALIZE_WINERIM_PRESENTATION
```

El rollback manual:

- valida version, conexion, perfil y hashes del snapshot;
- exige cola cero;
- exige que la configuracion viva siga coincidiendo con el objetivo del
  snapshot, para no pisar cambios posteriores de otra persona;
- restaura el `provider_config` anterior exacto;
- importa el XML anterior de familias y productos;
- ejecuta auditoria fresh;
- actualiza el snapshot a `ROLLED_BACK`.

El snapshot contiene el `provider_config` anterior sin redaccion porque debe
poder restaurarlo exactamente. Debe guardarse siempre fuera del repositorio y
el script fuerza permisos `0600`.

## Riesgos y limites

- No existe un lock transaccional de catalogo por conexion. El script exige
  cola cero antes del dry-run, canary y apply, pero permanece una ventana de
  carrera minima entre la ultima comprobacion y la llamada HTTP.
- `raw_payload.region` es metadata estructurada, pero puede representar una DO
  o una region comercial. No se infieren ni corrigen etiquetas.
- `ALPHABETICAL_WINE_NAME` ordena productos dentro de cada familia. La accion
  no promete ordenar alfabeticamente los botones de las familias hijas; este
  punto debe validarse visualmente en el TPV.
- El blanco `#FFFFFF` necesita validacion de contraste en el terminal real.
- El cierre tecnico no sustituye la comprobacion visual de navegacion,
  buscador, sufijos y colores por parte del cliente.

## Verificaciones de esta sesion

- `node --check`: superado.
- Modo read-only: ejecutado, `173/173`, cola cero, breaker cerrado, ocho
  mappings y `productionWrites=0`.
- Produccion: no ejecutada.
- Deploy: no ejecutado.
