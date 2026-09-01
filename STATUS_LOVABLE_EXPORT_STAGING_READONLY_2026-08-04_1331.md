# Lovable export / staging read-only - 2026-08-04 13:31 CEST

`LOVABLE_EXPORT_STAGING_READONLY_RESULT=EXPORT_VALID_CANONICAL_READY_STAGING_SCHEMA_GATE`

## Hechos

- Lovable Storage contiene un unico objeto en el bucket privado
  `database_export_04_08_26`:
  `bridge-to-winerim_260804.backup`, `97.6 MB`,
  `application/octet-stream`.
- Copia local privada, solo para inspeccion:
  `/private/tmp/winerim-lovable-export-readonly/bridge-to-winerim_260804.backup`.
  Tamano exacto `102386453` bytes, modo `0600`, SHA-256
  `4130f7cd59f515f126cad11ff36602eb2f5301790a02e044db036ba4e182785c`.
- `file` identifica un archive PostgreSQL custom `1.16-0`. El TOC confirma:
  creado `2026-08-04 11:14:19 CEST`, PostgreSQL origen `17.6`, generado por
  `pg_dump 18.4`, `812` entradas y compresion zstd.
- `pg_restore 16.14` no puede leer el formato `1.16`; `pg_restore 17.10`
  si lo lee. El cliente 17+ es obligatorio.
- Restore descartable local de `public` con PostgreSQL 17, `--no-owner`,
  `--no-privileges` y `--exit-on-error`: OK. No se escribio en Lovable ni en
  Supabase remoto. El cluster descartable se detuvo y el puerto quedo cerrado.
- El dump contiene las `20` tablas fuente obligatorias y tambien
  `provider_credentials`. Esta ultima no se transfiere. Las cuatro tablas
  opcionales nuevas no existen en la fuente.
- Desde el restore local se genero el artefacto exacto que acepta el tooling:
  `/private/tmp/winerim-lovable-export-readonly/tooling-artifact/` con
  `dump/`, `projected/pos_connections.copy` y `manifest.json` schema `2`.
- El manifest tiene SHA-256
  `6f3a383fa68b8706c24645e399a1314c5ee352699cc0badf394b8931bc5bf020`,
  `20` tablas, `31` conexiones sanitizadas en origen y pasa
  `RECONCILE_OFFLINE_ARTIFACT_OK`.
- El dry-run de import pasa sin writes: exige inventario target de `31`
  tablas y reemplazaria `30`; preserva `infrastructure_metadata`/sentinel.

## Staging Supabase read-only

- Proyecto: `qpbmqvfnunkylvtvnyyx` / `winerim-middleware-staging`.
- PostgreSQL `17`, sentinel `environment=staging`.
- Estado real observado por SELECT read-only: `30` tablas publicas,
  `0` conexiones y `0` conexiones activas.
- `provider_credentials`, `runtime_canary_connections`,
  `runtime_connection_credentials`, `runtime_execution_log` y
  `runtime_idempotency` estan vacias.
- Falta `public.runtime_catalog_source_scope`. Por tanto el target actual no
  cumple el inventario exacto de `31` tablas de `data-transfer/config.json` y
  un import live abortaria antes de reemplazar datos.
- No existe `STAGING_DATABASE_URL` en el entorno local. La CLI Supabase si
  ve el proyecto, pero `.env` apunta al proyecto Lovable
  `csiertktrefwewsmequr`, no a staging.

## Formato exacto

El `.backup` oficial es restaurable, pero no es importable directamente por
`lovable-export-reconcile.mjs`. El input aceptado es un directorio privado:

```text
tooling-artifact/
  manifest.json                  # schemaVersion=2, kind=lovable-source
  dump/                          # pg_dump directory format
  projected/pos_connections.copy # COPY binario con credenciales saneadas
```

Ese artefacto ya esta generado y verificado localmente. Antes del gate live
falta copiar el `.backup`, el artefacto y el futuro backup de staging a un
volumen cifrado/durable `0700`; `/private/tmp` no es ubicacion de retencion.

No se debe ejecutar `pg_restore` del archive completo directamente sobre
Supabase: el dump incluye objetos ajenos a la allowlist de negocio (entre
ellos esquemas gestionados por la plataforma). La ruta verificada es restore
descartable de `public` y export sanitizado con el tooling.

## Comandos preparados - no ejecutados contra remoto

### Conversion reproducible del export oficial

Estos comandos solo usan PostgreSQL local y regeneran el artefacto canonico:

```sh
export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH
export LOCAL_RESTORE=/private/tmp/winerim-lovable-restore-check
export LOCAL_PORT=64329
install -d -m 0700 "$LOCAL_RESTORE"
initdb -D "$LOCAL_RESTORE/data" --auth=trust
pg_ctl -D "$LOCAL_RESTORE/data" \
  -o "-p $LOCAL_PORT -h 127.0.0.1" -w start
createdb -h 127.0.0.1 -p "$LOCAL_PORT" lovable_restore_check
pg_restore \
  --dbname="postgresql://127.0.0.1:$LOCAL_PORT/lovable_restore_check" \
  --no-owner --no-privileges --exit-on-error --schema=public \
  /private/tmp/winerim-lovable-export-readonly/bridge-to-winerim_260804.backup
env LOVABLE_DATABASE_URL="postgresql://127.0.0.1:$LOCAL_PORT/lovable_restore_check" \
  npm run data:transfer:export -- \
    --artifact-dir /private/tmp/winerim-lovable-export-readonly/tooling-artifact \
    --apply --confirm-source lovable-production
pg_ctl -D "$LOCAL_RESTORE/data" -m fast -w stop
```

El `pg_restore` de Homebrew PostgreSQL 16 no sirve para este archive; hay que
mantener el cliente 17+ al principio de `PATH`.

### 0. Gate de esquema staging

Aplicar primero `0014` con URL directa o Session Pooler segura. Esto es una
escritura remota separada y no se ejecuto:

```sh
export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH
export STAGING_DATABASE_URL='[secure direct/session URL for qpbmqvfnunkylvtvnyyx]'
psql "$STAGING_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f infrastructure/postgres/0014_runtime_catalog_source_scope.sql
unset STAGING_DATABASE_URL
```

Readback obligatorio: `31` tablas, sentinel `staging`,
`runtime_catalog_source_scope=0`, resto de tablas runtime vacias.

### 1. Fijar artefactos en almacenamiento cifrado

```sh
install -d -m 0700 /encrypted/winerim-transfer/lovable-20260804
install -m 0600 \
  /private/tmp/winerim-lovable-export-readonly/bridge-to-winerim_260804.backup \
  /encrypted/winerim-transfer/lovable-20260804/
cp -R /private/tmp/winerim-lovable-export-readonly/tooling-artifact \
  /encrypted/winerim-transfer/lovable-20260804/source
shasum -a 256 \
  /encrypted/winerim-transfer/lovable-20260804/bridge-to-winerim_260804.backup
```

No ejecutar hasta disponer de una ruta realmente cifrada y durable.

### 2. Revalidacion offline

```sh
export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH
npm run data:transfer:reconcile -- \
  --artifact-dir /encrypted/winerim-transfer/lovable-20260804/source
```

Esperado: `RECONCILE_OFFLINE_ARTIFACT_OK` y manifest
`6f3a383fa68b8706c24645e399a1314c5ee352699cc0badf394b8931bc5bf020`.

### 3. Plan sin conexion

```sh
npm run data:transfer:import -- \
  --artifact-dir /encrypted/winerim-transfer/lovable-20260804/source \
  --backup-dir /encrypted/winerim-transfer/staging-before-YYYYMMDDTHHMMSSZ \
  --confirm-manifest 6f3a383fa68b8706c24645e399a1314c5ee352699cc0badf394b8931bc5bf020
```

Esperado: `IMPORT_DRY_RUN`, `writes=false`, `30` tablas de reemplazo sobre
un inventario target exacto de `31`.

### 4. Import staging gateado

Solo con runtime, consumers y cron inertes durante todo el intervalo:

```sh
export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH
export STAGING_DATABASE_URL='[secure direct/session URL for qpbmqvfnunkylvtvnyyx]'
npm run data:transfer:import -- \
  --artifact-dir /encrypted/winerim-transfer/lovable-20260804/source \
  --backup-dir /encrypted/winerim-transfer/staging-before-YYYYMMDDTHHMMSSZ \
  --confirm-manifest 6f3a383fa68b8706c24645e399a1314c5ee352699cc0badf394b8931bc5bf020 \
  --confirm-target-ref qpbmqvfnunkylvtvnyyx \
  --apply
unset STAGING_DATABASE_URL
```

Esperado: `IMPORT_RECONCILED`. Ante drift WAL/conteos o lock ocupado: parar,
no reutilizar el backup invalidado y no reintentar a ciegas.

### 5. Readback posterior

```sh
export STAGING_DATABASE_URL='[secure direct/session URL for qpbmqvfnunkylvtvnyyx]'
npm run data:transfer:reconcile -- \
  --artifact-dir /encrypted/winerim-transfer/lovable-20260804/source \
  --confirm-target-ref qpbmqvfnunkylvtvnyyx \
  --read-live
unset STAGING_DATABASE_URL
```

## Contradicciones

- `DATA_TRANSFER_RUNBOOK.md` dice seis tablas staging-owned, pero enumera
  cinco; la configuracion actual exige siete. El contrato ejecutable correcto
  es `20` obligatorias + hasta `4` opcionales + `7` propias = `31` target.
- El mismo runbook aun habla de locks sobre `29` tablas reemplazables; el
  dry-run actual devuelve `30`.
- `verify-staging.sh` conserva el contrato antiguo de `30` tablas, mientras
  `data-transfer/config.json` e import exigen `31`.
- Los docs declaraban staging preparado para `31`, pero el readback fresh
  demuestra `30`; falta materializar `0014`.

## Pendientes y gate exacto

1. Disponer de almacenamiento cifrado/durable para los tres artefactos.
2. Obtener `STAGING_DATABASE_URL` directa/Session Pooler por canal seguro.
3. Aplicar y verificar solo `0014` para llevar staging de `30` a `31`.
4. Mantener staging completamente quiescente y ejecutar import serial.
5. Reconciliar antes de provisionar credenciales o activar cualquier runtime.

## No produccion confirmado

- Cero writes en Lovable, Supabase remoto, Agora, Winerim, colas, cursores,
  stock, historico o configuracion.
- Solo hubo descarga local privada, restore PostgreSQL descartable, generacion
  de artefacto sanitizado, dry-run y SELECT read-only en staging.
