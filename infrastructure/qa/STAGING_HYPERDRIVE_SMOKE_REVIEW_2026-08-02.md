# Staging Hyperdrive smoke review - 2026-08-02

## Veredicto

`NO_GO_STAGING_SMOKE_INCOMPLETE`

El adaptador `pg`/Hyperdrive y la validacion criptografica de Cloudflare Access
son una base valida, pero el smoke actual no demuestra el contrato de staging:

- no autentica por Cloudflare Access;
- puede ejecutarse contra un host distinto del dominio custom;
- solo prueba el sentinel de base de datos;
- no prueba el principal LOGIN, el rol heredado, los privilegios negativos ni
  el comportamiento de RLS;
- realiza una escritura de onboarding, por lo que no es el smoke minimo y
  read-only requerido tras deploy.

No se ha desplegado, consultado ningun secreto ni modificado codigo o
configuracion. Al comenzar, el worktree ya estaba modificado por otros agentes
en `wrangler.middleware.toml` y `wrangler.middleware-runtime.toml`. Durante el
cierre aparecieron ademas cambios concurrentes en runtime/executor, tests y
verificacion PostgreSQL. No se han leido como parte del alcance ni tocado. La
evidencia focalizada de este informe corresponde al estado anterior a esos
cambios posteriores.

## Hallazgos prioritarios

### P1-01 - El smoke no puede autenticar el staging configurado con Access

**Referencias:**

- `wrangler.middleware.toml:12-28`
- `scripts/smoke-middleware-api.mjs:1-3`
- `scripts/smoke-middleware-api.mjs:39-55`
- `scripts/smoke-middleware-api.mjs:55-82`
- `cloudflare/workers/middleware-api/src/index.ts:164-175`

Staging fija `REQUIRE_ACCESS_JWT="true"`. En ese modo el Worker ignora
`MIDDLEWARE_ADMIN_TOKEN` y exige un `CF-Access-Jwt-Assertion` valido. Sin
embargo, el smoke:

1. llama a `/health` y `/api/checklist` sin credenciales Access;
2. solo conoce `MIDDLEWARE_ADMIN_TOKEN` para la rama autenticada;
3. no envia `CF-Access-Client-Id`/`CF-Access-Client-Secret` al proxy Access;
4. usa el comportamiento por defecto de `fetch`, que sigue redirects. Una
   redireccion al login de Access puede terminar como HTML `200` y ocultar la
   naturaleza exacta del rechazo.

Consecuencia: `npm run cf:api:smoke:staging` no representa el despliegue real.
Puede fallar con Access correctamente configurado o validar por accidente una
superficie no protegida.

**Correccion requerida:** el smoke remoto debe usar exclusivamente un service
token Access, con `redirect: "manual"`, y separar dos pruebas:

- sin service token: Access bloquea antes de llegar al Worker;
- con service token: Access admite la llamada y el Worker valida el JWT
  inyectado.

Cloudflare documenta que Access envia al origen el JWT de aplicacion en
`Cf-Access-Jwt-Assertion`; los service tokens deben presentarse mediante sus
cabeceras de cliente:

- <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/>
- <https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>

### P1-02 - `/ready` no acredita el rol DB ni RLS y puede responder desde cache

**Referencias:**

- `cloudflare/workers/middleware-api/src/index.ts:613-627`
- `cloudflare/workers/middleware-api/src/index.ts:178-193`
- `wrangler.middleware.toml:26-28`

`/ready` ejecuta solo:

```sql
SELECT value FROM infrastructure_metadata WHERE key = 'environment'
```

Un `200 { database: "staging" }` demuestra que alguna credencial asociada al
Hyperdrive puede leer el sentinel. No demuestra:

- que el LOGIN sea el principal reservado para la API;
- que herede `middleware_api` y no `middleware_runtime`;
- que no sea superusuario ni tenga `BYPASSRLS`;
- que `row_security` este activo;
- que carezca de permisos de escritura sobre stock, colas y cursores;
- que RLS filtre una fila fuera del `connection_id` autorizado.

Ademas, Hyperdrive habilita cache de consultas de lectura por defecto. La query
del sentinel no contiene una funcion `STABLE`/`VOLATILE`, de modo que puede
servirse desde cache y mantener `/ready` verde brevemente aunque el origen no
este disponible. Cloudflare documenta `max_age=60s` y
`stale_while_revalidate=15s` como valores por defecto:

- <https://developers.cloudflare.com/hyperdrive/concepts/query-caching/>

**Correccion requerida:** ampliar un endpoint protegido y staging-only para que
ejecute una transaccion `READ ONLY` y devuelva solo booleanos, nunca el nombre
ni la cadena del LOGIN:

- sentinel `environment=staging`;
- `current_setting('row_security') = 'on'`;
- `pg_has_role(current_user, 'middleware_api', 'member') = true`;
- `pg_has_role(current_user, 'middleware_runtime', 'member') = false`;
- `rolsuper=false` y `rolbypassrls=false` para `current_user`;
- permiso esperado sobre `integration_onboarding_requests`;
- ausencia de `INSERT/UPDATE/DELETE` sobre `stock_sync_log`, `outbound_tasks`
  y `pos_connections`;
- una funcion no cacheable, por ejemplo `clock_timestamp()`, para obligar una
  lectura del origen en cada readiness.

Para lecturas que requieran consistencia inmediata, la alternativa mas clara
es un Hyperdrive separado con cache deshabilitada. No se debe afirmar readiness
fresh si no se adopta uno de estos dos mecanismos.

### P1-03 - El RLS actual no implementa aislamiento por `connection_id`

**Referencias:**

- `PROJECT_CONTEXT.md:17`
- `infrastructure/postgres/0001_harden_runtime_roles.sql:65-89`
- `infrastructure/postgres/0001_harden_runtime_roles.sql:130-170`

El contrato estructural exige aislamiento estricto por `connection_id`, pero
las policies creadas para `middleware_runtime`, `middleware_readonly` y
`middleware_api` usan `USING (true)` y, para escritura, `WITH CHECK (true)`.
RLS esta habilitado, pero no limita filas entre conexiones.

Esto puede ser intencional para un control plane interno que lista toda la
flota, pero entonces no debe presentarse como aislamiento multi-tenant probado.
Hay que elegir y documentar una de estas opciones:

1. separar un rol `middleware_control_plane` global, protegido por Access, de
   los roles operativos limitados por conexion;
2. introducir contexto transaccional `app.connection_id` y policies que exijan
   igualdad en todas las tablas con `connection_id`;
3. documentar formalmente que API/runtime son servicios trusted globales y que
   el aislamiento se aplica en handlers, con tests negativos por endpoint.

Hasta resolver esa decision, un smoke solo puede probar **RLS habilitado y
grants minimos**, no **aislamiento RLS por conexion**.

### P1-04 - El smoke no impide probar `workers.dev` o un origen equivocado

**Referencias:**

- `wrangler.middleware.toml:5`
- `wrangler.middleware.toml:12-17`
- `scripts/smoke-middleware-api.mjs:1-14`
- `package.json:13-14`

Wrangler fija correctamente `workers_dev=false` en staging, pero el script
acepta cualquier URL por argumento o `MIDDLEWARE_API_URL`. No valida esquema,
hostname ni puerto. Por tanto, una ejecucion manual puede apuntar a
`workers.dev`, localhost o una version distinta y aun informar `OK`.

**Correccion requerida:** en modo staging, rechazar todo destino que no sea
exactamente `https://api-staging.middleware.winerim.wine`, exigir puerto por
defecto y validar aparte que la URL conocida de `workers.dev` no responde con
el JSON del servicio. La prueba de no exposicion debe ser obligatoria, no una
suposicion derivada del TOML.

### P2-01 - El smoke remoto escribe una solicitud de onboarding

**Referencias:**

- `scripts/smoke-middleware-api.mjs:55-77`
- `cloudflare/workers/middleware-api/src/index.ts:411-452`

Cuando existe `MIDDLEWARE_ADMIN_TOKEN`, el smoke crea una fila real en
`integration_onboarding_requests` y no la elimina. Esa escritura no es
necesaria para probar Hyperdrive, roles o RLS y acumula datos de prueba.

**Correccion requerida:** el smoke post-deploy debe ser read-only. La escritura
sanitizada debe permanecer en una prueba de integracion contra una base
desechable o en un canary separado con identificador y limpieza explicitos.

### P2-02 - Los tests DB existentes pueden pasar con una credencial privilegiada

**Referencias:**

- `src/test/middlewareWorkerDb.integration.test.ts:4-13`
- `src/test/middlewareWorkerDb.integration.test.ts:15-53`
- `infrastructure/postgres/smoke-local-worker.sh:49`

Los tests reciben una URL directa en `MIDDLEWARE_TEST_DATABASE_URL` y usan el
fallback de `MIDDLEWARE_ADMIN_TOKEN`. No comprueban el usuario efectivo ni sus
membresias. Si la URL pertenece a `postgres`, a un propietario de tablas o a
un rol con `BYPASSRLS`, los tres tests pasan y generan una falsa certificacion
de minimo privilegio.

**Tests faltantes:** ejecutar la misma suite con el LOGIN real de la API y
añadir asserts de rol, privilegios negativos y RLS. El test de escritura de
onboarding debe usar una base desechable; el smoke remoto no debe reutilizarlo.

### P2-03 - Las conexiones DB no tienen timeout explicito ni log de readiness

**Referencias:**

- `cloudflare/workers/middleware-api/src/index.ts:178-187`
- `cloudflare/workers/middleware-api/src/index.ts:617-627`
- `scripts/smoke-middleware-api.mjs:3,10-19`

El cliente `pg` no fija `connectionTimeoutMillis`, `query_timeout` ni
`statement_timeout`. El timeout del script aborta el cliente HTTP, pero no
cancela de forma demostrada la consulta que el Worker ya inicio. Ademas,
`/ready` descarta el error sin un evento sanitizado, lo que dificulta separar
DNS, Hyperdrive, auth DB, grants y timeout.

**Correccion requerida:** timeout corto en cliente/consulta de readiness,
respuesta publica generica y log estructurado con clase de error/latencia, sin
host, usuario ni cadena de conexion.

### P2-04 - Configuracion y test han derivado durante el trabajo paralelo

**Referencias:**

- `wrangler.middleware-runtime.toml` (modificado antes de esta auditoria)
- `src/test/cloudflareRuntimeConfig.test.ts:44-53`

La ejecucion focalizada deja `25/26` tests verdes. Falla
`keeps Hyperdrive out of the deployable config until a real ID exists` porque
otro agente ya ha añadido un binding Hyperdrive real al TOML runtime mientras
el test sigue exigiendo su ausencia.

No se ha corregido para no editar trabajo ajeno. Antes de merge/deploy, el
agente propietario debe actualizar el test al nuevo gate o retirar el binding;
no se debe ignorar el fallo.

## Controles positivos

- `pg` esta fijado en `8.16.3`, compatible con Hyperdrive segun la documentacion
  actual de Cloudflare.
- `nodejs_compat` esta activo y la fecha de compatibilidad es posterior al
  minimo requerido por `pg`/Hyperdrive.
- El cliente `pg` se crea dentro de cada request y se cierra en `finally`,
  patron recomendado para Hyperdrive.
- Staging y produccion fijan `workers_dev=false` y
  `REQUIRE_ACCESS_JWT="true"`.
- `verifyAccessJwt` valida algoritmo RS256, `kid`, audiencia, issuer,
  expiracion, `nbf` y firma.
- El adaptador parametriza valores y encapsula transacciones.
- Los errores DB expuestos por `/ready` son genericos.

Referencia de compatibilidad `pg`/Hyperdrive:

- <https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/>

## Smoke minimo propuesto tras deploy

El smoke debe ser **read-only**, ejecutarse solo contra el custom domain y
fallar ante cualquier `SKIP`.

### Entradas obligatorias

- `MIDDLEWARE_API_URL=https://api-staging.middleware.winerim.wine`
- `MIDDLEWARE_WORKERS_DEV_URL` con el hostname directo conocido del Worker
- `CF_ACCESS_CLIENT_ID`
- `CF_ACCESS_CLIENT_SECRET`
- `EXPECTED_ENVIRONMENT=staging`
- `EXPECTED_RELEASE` con SHA/version inmutable del deploy
- timeout total y por request

No necesita ni debe aceptar `MIDDLEWARE_ADMIN_TOKEN`, URL DB o credenciales
Postgres.

### Secuencia

1. **Target fail-closed**: validar URL exacta HTTPS, sin userinfo, query, puerto
   alternativo ni redirect.
2. **Access negativo**: `GET /health` y `GET /ready` sin service token, con
   redirects deshabilitados. Ninguna puede devolver el JSON del Worker ni
   estado `200`.
3. **Sin `workers.dev`**: llamar al hostname directo y exigir que no devuelva
   `service=winerim-middleware-api` con `200`.
4. **Access positivo**: repetir `/health` con las dos cabeceras del service
   token. Exigir `200`, `environment=staging` y `release=EXPECTED_RELEASE`.
5. **Hyperdrive fresh**: llamar dos veces al readiness DB protegido. Exigir
   `200`, sentinel staging, timestamp de origen creciente y latencia dentro del
   limite.
6. **Rol minimo**: exigir booleanos `api_role=true`, `runtime_role=false`,
   `superuser=false`, `bypassrls=false`, `row_security=true` y los grants
   positivos/negativos previstos.
7. **RLS**: ejecutar un test de comportamiento con dos fixtures de conexiones.
   Bajo contexto A, A debe ser visible y B invisible. La transaccion debe ser
   `READ ONLY` y no devolver IDs ni datos de cliente.
8. **Cierre**: imprimir solo estados, release, latencias y un request ID. Nunca
   imprimir cabeceras Access, connection strings, nombres LOGIN ni resultados
   de negocio.

### Contrato de respuesta sugerido

El Worker puede devolver este resumen desde un endpoint protegido y habilitado
solo en staging:

```json
{
  "ok": true,
  "environment": "staging",
  "release": "<expected>",
  "database": {
    "sentinel": true,
    "fresh": true,
    "apiRole": true,
    "runtimeRole": false,
    "superuser": false,
    "bypassRls": false,
    "rowSecurity": true,
    "leastPrivilege": true,
    "connectionIsolation": true
  }
}
```

`connectionIsolation=true` no puede implementarse honestamente con las
policies actuales `USING (true)`. Debe permanecer como gate rojo hasta decidir
y probar el modelo de aislamiento descrito en P1-03.

## Tests que faltan

1. Unit test del smoke que rechace `workers.dev`, HTTP, redirects y host
   distinto.
2. Unit test con Access negativo y positivo usando service token, sin admin
   token estatico.
3. Test de `/ready` con LOGIN `middleware_api` real y asserts de membresia,
   `rolsuper`, `rolbypassrls` y `row_security`.
4. Test negativo que confirme SQLSTATE `42501` al intentar leer/escribir una
   superficie no concedida al rol API.
5. Test RLS de comportamiento A/B por `connection_id`; no basta contar policies.
6. Test que demuestre que readiness no se sirve desde cache cuando el origen
   deja de responder.
7. Test de timeout DB y log sanitizado.
8. Test CI que falle si el smoke remoto omite credenciales Access o cualquier
   comprobacion queda en `SKIP`.
9. Actualizar el test de configuracion runtime tras resolver el cambio
   concurrente de Hyperdrive.

## Evidencia ejecutada

- `node --check scripts/smoke-middleware-api.mjs`: `OK`.
- Vitest focalizado:
  - `middlewareWorkerSecurity`: `6/6` OK;
  - `cloudflareDbAdapter`: `7/7` OK;
  - `cloudflareDbSql`: `9/9` OK;
  - `cloudflareRuntimeConfig`: `3/4` OK, un fallo por deriva concurrente del
    binding Hyperdrive runtime.
- Total focalizado: `25/26` tests OK.
- Cero deploys, cero llamadas a staging, cero lectura de secretos y cero
  cambios en codigo/config.

## Gate recomendado

No desplegar la API como staging certificado hasta que:

1. el smoke use Access service token y custom domain exclusivamente;
2. readiness sea fresh y compruebe rol/grants negativos;
3. se decida el alcance real de RLS por `connection_id` y exista un test de
   comportamiento;
4. el test de configuracion concurrente vuelva a verde.

`STAGING_HYPERDRIVE_SMOKE_REVIEW_RESULT=NO_GO_ROLE_RLS_ACCESS_SMOKE_INCOMPLETE`
