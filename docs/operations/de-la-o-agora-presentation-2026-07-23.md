# De la O - normalizacion controlada de presentacion Agora

Fecha: 2026-07-23

## Estado

Runbook preparado. En esta sesion no se ha escrito en Agora, Winerim,
Lovable Cloud, `provider_config` ni colas, y no se ha hecho ningun despliegue.

La operacion usa exclusivamente la accion compartida
`normalize-winerim-product-presentation`. El script local nunca llama de forma
directa a `/api/import/`.

## Alcance invariable

- Conexion exclusiva: De la O (`99f3a782-844f-4515-a570-662a111ced2e`).
- Allowlist formada con productos `source=WINERIM`, `sync_status=VERIFIED`,
  elegibles y exactos en la lectura fresh.
- Exclusion explicita permanente de este runbook: producto `680888`.
- Conservar `Product.Name`, IDs, familias, precios, IVA, preparacion,
  vendibilidad, mappings, ventas, stock y todo el legacy.
- Cambiar solo presentacion de los productos de la allowlist: `Color`,
  `ButtonText` y `Order`.
- No tocar otras conexiones.

## Configuracion objetivo

La configuracion se fusiona con el `provider_config` previo; no elimina otras
claves de la conexion.

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
  }
}
```

`Name` sigue conservando el prefijo tecnico. Solo cambia el texto visible:

- `B Prado Enea` -> `Prado Enea [B]`
- `C Prado Enea` -> `Prado Enea [C]`
- `M Prado Enea` -> `Prado Enea [M]`

La accion compartida limita `ButtonText` a 20 caracteres y resuelve
colisiones de forma determinista. El sufijo de formato queda visible incluso
cuando sea necesario truncar el nombre.

## Guardas obligatorias

Antes de cualquier escritura, el script exige:

1. `connection_id` y nombre exactos de De la O.
2. Auditoria fresh `expected=matched`, sin `missing`, `different`,
   `unownedExisting` ni incidencias de ownership.
3. Tracking estrictamente `VERIFIED` para todo el conjunto esperado.
4. Cola `QUEUED/RUNNING=0`.
5. Exclusión de `680888` en la allowlist enviada a la accion.
6. `provider_config` objetivo persistido exactamente.
7. Dry-run de la accion con XML propuesto y rollback validos mediante
   `xmllint`.
8. Confirmacion literal `NORMALIZE_WINERIM_PRESENTATION` para canary y apply.
9. Artefacto privado creado antes de escribir, con permisos `0600`, que
   contiene configuracion previa, allowlist y XML de rollback.
10. Las invocaciones de escritura no se reintentan desde el script. Si se
    pierde la respuesta, el artefacto queda como
    `APPLY_OUTCOME_UNKNOWN_VERIFY_FRESH_BEFORE_RETRY` y se exige lectura fresh
    antes de decidir cualquier repeticion.

## Matiz de orden con legacy

La accion no toca ni reordena legacy. Dentro de cada familia compartida:

- calcula el mayor `Order` de los productos fuera de la allowlist;
- coloca despues los productos Winerim autorizados;
- ordena alfabeticamente solo esos productos Winerim entre si.

Por tanto, el resultado es alfabetico dentro del bloque Winerim, no una mezcla
alfabetica global de Winerim y legacy. Esto es intencionado para mantener el
legacy intacto.

En un canary de un producto, los demas productos Winerim tambien quedan fuera
de la allowlist temporal y cuentan como elementos existentes. El `Order` del
canary sirve para validar escritura, color y etiqueta, pero es provisional. El
apply completo recalcula su posicion final respecto a toda la allowlist.

## Modos del script

### 1. Snapshot exacto, solo lectura

```bash
node scripts/de-la-o-agora-presentation-2026-07-23.mjs
```

Lee catalogo fresh, cola, tracking y `provider_config` previo. Si la
configuracion objetivo ya esta activa, ejecuta ademas el dry-run completo de
la accion. Si no lo esta, informa `TARGET_PROVIDER_CONFIG_NOT_STAGED` y no
escribe nada.

### 2. Configurar la conexion

Solo tras autorizacion expresa. Es una escritura en `provider_config`, aunque
todavia no modifica productos Agora.

```bash
node scripts/de-la-o-agora-presentation-2026-07-23.mjs \
  --mode configure \
  --confirm=CONFIGURE_DE_LA_O_PRESENTATION \
  --artifact-file /ruta/privada/de-la-o-config.json
```

El artefacto se crea antes del `PATCH`. Si falla la persistencia o el dry-run
posterior, el script intenta restaurar automaticamente el `provider_config`
exacto anterior y deja evidencia del resultado.

### 3. Dry-run completo

```bash
node scripts/de-la-o-agora-presentation-2026-07-23.mjs \
  --mode dry-run
```

Requiere que la configuracion objetivo ya este activa. Usa
`normalize-winerim-product-presentation` con `dryRun=true`,
`includeXml=true` y la allowlist estricta, sin `680888`.

### 4. Canary de un producto

El producto se elige de la preview revisada del dry-run. Debe pertenecer a la
allowlist y no puede ser `680888`.

```bash
node scripts/de-la-o-agora-presentation-2026-07-23.mjs \
  --mode canary \
  --product-id PRODUCT_ID \
  --confirm=NORMALIZE_WINERIM_PRESENTATION \
  --artifact-file /ruta/privada/de-la-o-canary.json
```

Secuencia automatizada:

1. dry-run exclusivo del producto;
2. persistencia del snapshot y rollback;
3. apply con `confirm=NORMALIZE_WINERIM_PRESENTATION`;
4. verificacion fresh de la accion;
5. auditoria exacta completa;
6. segundo dry-run del canary, que debe devolver `changedProducts=0`.

### 5. Apply completo

Exige indicar el canary ya aplicado. Antes de continuar prueba que ese canary
es idempotente.

```bash
node scripts/de-la-o-agora-presentation-2026-07-23.mjs \
  --mode apply \
  --product-id CANARY_PRODUCT_ID \
  --confirm=NORMALIZE_WINERIM_PRESENTATION \
  --artifact-file /ruta/privada/de-la-o-apply.json
```

Tras el apply se repiten lectura fresh, auditoria exacta y dry-run completo.
El cierre correcto es `changedProducts=0`, `changedFamilies=0` y cero fallos
de verificacion.

### 6. Verificacion posterior, solo lectura

```bash
node scripts/de-la-o-agora-presentation-2026-07-23.mjs \
  --mode verify
```

Sale con codigo `2` si el dry-run ya no es idempotente.

## Rollback

Cada artefacto mutable contiene:

- `providerConfigBefore` y `providerConfigRollback` exactos;
- `provider_config` objetivo;
- allowlist y exclusion explicita;
- XML propuesto y XML de rollback del dry-run;
- respuesta del apply y su `rollbackXml`, cuando exista;
- hashes SHA-256 y resultado de verificacion posterior.

La presentacion y la configuracion pueden restaurarse con:

```bash
node scripts/de-la-o-agora-presentation-2026-07-23.mjs \
  --mode rollback-config \
  --confirm=ROLLBACK_DE_LA_O_PRESENTATION_CONFIG \
  --artifact-file /ruta/privada/de-la-o-apply.json
```

El script valida primero version, conexion, ownership y hashes del artefacto.
Despues envia el XML exacto anterior mediante la accion protegida
`restore-winerim-product-presentation`, que limita el alcance a productos
Winerim verificados, usa transporte resiliente y exige lectura fresh. Solo
cuando la restauracion de productos queda verificada repone el
`provider_config` exacto anterior. No se ejecuta ningun `curl` local contra
Agora.

La restauracion de productos requiere que el servidor Agora sea alcanzable. Si
la red del TPV falla, el artefacto privado conserva el XML y la configuracion
exactos para reintentar el mismo rollback protegido cuando vuelva la conexion.

## Producto excluido `680888`

`B Stars Touch Of Rose Brut`, ID `680888`, comparte una familia objetivo pero
no tiene ownership autorizado para esta operacion. La allowlist se construye
antes de cada llamada y lo elimina expresamente incluso si apareciera en una
fila de tracking futura. No cambia color, etiqueta, orden ni visibilidad.

## Criterio de cierre

La operacion solo puede declararse completa cuando:

- el canary tenga verificacion fresh e idempotencia;
- el apply completo termine sin fallos;
- un nuevo dry-run devuelva cero cambios;
- `680888` y todo el legacy conserven sus atributos;
- el artefacto privado permita recuperar tanto configuracion como XML.

Hasta recibir autorizacion posterior, solo se pueden ejecutar `snapshot`,
`dry-run` y `verify`; `configure`, `canary`, `apply` y `rollback-config` quedan
descritos y protegidos, pero no se ejecutan.

## Snapshot fresh de preparacion

Lectura realizada el `2026-07-23T09:41:12.053Z`, sin escrituras:

| Comprobacion | Resultado |
|---|---:|
| Cola activa `QUEUED/RUNNING` | `0` |
| Catalogo fresh | `120/120 MATCH` |
| Missing / different / unowned | `0 / 0 / 0` |
| Incidencias de auditoria | `0` |
| Tracking estrictamente `VERIFIED` | `120/120` |
| Productos en allowlist | `120` |
| Producto `680888` dentro de la allowlist | `No` |

La configuracion previa no contiene ninguna de las cuatro claves de
presentacion objetivo:

- `agora_product_presentation_enabled`: ausente;
- `agora_product_sort_mode`: ausente;
- `agora_product_button_text_mode`: ausente;
- `agora_product_color_by_wine_type`: ausente.

Hashes de control, sin exponer el contenido completo de `provider_config`:

| Configuracion | SHA-256 |
|---|---|
| Previa | `2efd7a3719c5712af0972e1d7974adda9c34041fde492e2f8d465e820ff84bab` |
| Objetivo fusionado | `5dee6f833eabde482b8631446da53116a19bc06ee791cbe2a672aff2f2f29987` |

El normalizador no se invoco porque la accion exige que la configuracion
objetivo ya este persistida. El resultado fue
`TARGET_PROVIDER_CONFIG_NOT_STAGED`. Activarla requiere una autorizacion
posterior y el modo `configure`; no se ha simulado mediante una escritura
temporal.
