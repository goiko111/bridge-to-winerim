# Infraestructura propia Middleware Winerim

Indice operativo de los puntos 1-6. Corte: 2026-08-03, Europe/Madrid.

## Regla de seguridad

Este arbol es preparacion de staging. No autoriza produccion.

- Staging solo puede desplegarse por los scripts fail-closed revisados, con
  ejecucion apagada y sin consumers. Pages, Cron operativo y cambios DNS
  siguen fuera de este gate.
- No aplicar SQL a Lovable Cloud/backend ni a una base que no tenga identidad
  de staging confirmada.
- No usar el Hyperdrive `market-winerim-postgres`: pertenece a otro sistema.
- No copiar secretos a archivos, comandos persistidos, logs o frontend.
- Produccion, clientes, TPV, ventas, stock, historico, colas y cursores no se
  modificaron durante estos seis puntos.

## Estado remoto real

| Activo | Estado | Puede recibir trafico |
|---|---|---:|
| Pages `winerim-middleware-staging` | Proyecto creado, sin deployment ni custom domain | No |
| `winerim-staging-catalog` | Queue creada, sin consumer | No |
| `winerim-staging-sales` | Queue creada, sin consumer | No |
| `winerim-staging-stock` | Queue creada, sin consumer | No |
| `winerim-staging-outbound` | Queue creada, sin consumer | No |
| `winerim-staging-maintenance` | Queue creada, sin consumer | No |
| `winerim-staging-dead-letter` | Queue creada, sin consumer ni binding | No |
| Worker runtime y executor | Desplegados en staging, ejecucion `false`, sin consumers | No |
| Worker API | Desplegado en staging y protegido por Access | Solo trafico autenticado de control |
| Postgres staging | Supabase `qpbmqvfnunkylvtvnyyx`, sentinel `staging`, 30 tablas; backup cifrado restaurado antes del hardening | No por si solo |
| Hyperdrive API | Activo staging verificado `04bde119c3354a5b9be3fadbf3c0b46d`, principal API separado | Solo Worker API |
| Hyperdrive runtime/executor | Activo staging verificado `0adae4108e4241f19cf5ba2709cbc69f`, principal runtime separado | No con ejecucion apagada |
| DNS `api-staging` / `staging` | `api-staging` activo; dominio frontend `staging` no publicado | API autenticada solamente |
| Cloudflare Access | Activo para `api-staging`, con rechazo anonimo y Service Auth verificados | Si, autenticado |

Las seis Queues son activos de staging. Hay bindings producer declarados, pero
no existe ningun consumer y `RUNTIME_EXECUTION_ENABLED=false`; por tanto no se
procesa trabajo. `winerim-staging-dead-letter` queda deliberadamente sin
binding hasta que exista un consumer revisado.

Los IDs anteriores certifican el recurso Cloudflare y su asignacion al inventario
staging. Este documento no deduce de ellos el hostname o proyecto Postgres, el
principal LOGIN ni sus grants; esos datos deben validarse por URL, sentinel,
readiness y pruebas de permisos antes de autorizar un deploy.

La auditoria remota reproducible esta en
[`cloudflare/audit-staging-readonly.sh`](./cloudflare/audit-staging-readonly.sh).
La validacion final se ejecuto con Node `24.14.0`; CI queda fijado en Node 22,
compatible con Wrangler `4.118+`. No rebajar Wrangler para saltar el gate.

## Resumen de los puntos 1-6

| Punto | Alcance | Estado local | Bloqueo remoto |
|---:|---|---|---|
| 1 | Fuente limpia, toolchain y CI staging | Rama limpia, commit acotado, workflow fail-closed y validacion completa | Publicar el SHA revisado en PR; no hacer merge automatico |
| 2 | Bootstrap Postgres portable y endurecido | Validacion, replay y backup/restore PG17 OK | Aplicar hardening revisado en staging |
| 3 | Adaptador Worker -> Postgres/Hyperdrive | Bindings y principals staging verificados | Readback posterior al deploy inerte |
| 4 | Runtime, scheduler, envelopes, retry y Queues | Runtime/executor fail-closed; tests y bundles verdes | Sin consumers; canary pendiente |
| 5 | Handlers y adaptadores provider-neutral | Catalogo, ventas, stock, outbound y OpenTicket compuestos | Credenciales y canary de una conexion |
| 6 | Assets, seguridad, observabilidad y corte | API+Access activos; Pages bloqueado; QA documentada | DLQ/consumer/cutover siguen gateados |

## 1. Fuente limpia, toolchain y CI

### Artefactos

- [Workflow staging](../.github/workflows/deploy-middleware-staging.yml)
- [Wrangler API y Hyperdrive API staging `04bde119c3354a5b9be3fadbf3c0b46d`](../wrangler.middleware.toml)
- [Ejemplo Hyperdrive API sin ID real](../wrangler.middleware-api.hyperdrive.toml.example)
- [Wrangler runtime y Hyperdrive runtime staging `0adae4108e4241f19cf5ba2709cbc69f`](../wrangler.middleware-runtime.toml)
- [Ejemplo Hyperdrive sin ID real](../wrangler.middleware-runtime.hyperdrive.toml.example)
- Commits base del scaffold: `61fddb0` y `c303fb3`.

El trabajo quedo consolidado en la rama
`codex/own-infrastructure-20260802`. El SHA inmutable que se use en staging debe
ser siempre el devuelto por `git rev-parse HEAD` despues de revisión/CI; no se
debe copiar un hash escrito a mano dentro de este runbook. Antes de crear
release:

```sh
cd /private/tmp/winerim-own-infra-clean
node --version
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
git status --short
git diff --check
git rev-parse HEAD
npm ci
```

Gate: Node 22+, diff limitado a los artefactos aprobados, ningun secreto,
worktree limpio y commit inmutable. No usar el workflow mientras
`confirm_sha`, host y nombre de DB staging no sean verificables.

## 2. Postgres propio portable

### Artefactos

- [Runbook y limites del bootstrap](./postgres/README.md)
- [Manifest completo](./postgres/migration-manifest.tsv)
- [Hardening de roles](./postgres/0001_harden_runtime_roles.sql)
- [Addendum portable](./postgres/0002_release_schema_addendum.sql)
- [Aplicador fail-closed](./postgres/apply-staging.sh)

Validacion local exacta:

```sh
cd /private/tmp/winerim-own-infra-clean
infrastructure/postgres/validate.sh
infrastructure/postgres/build-bootstrap.sh /tmp/winerim-bootstrap-staging.sql
shasum -a 256 /tmp/winerim-bootstrap-staging.sql
infrastructure/postgres/test-empty-replay.sh
```

Resultado fresco: `STATIC_MANIFEST_OK_DATABASE_READONLY_SKIPPED` y
`EMPTY_REPLAY_HARDENED_OK`; 30 tablas, seis funciones, RLS en todas las tablas,
cero RPC `SECURITY DEFINER` ejecutables por `PUBLIC` y cero policies legacy.

Cuando exista una DB staging dedicada, primero lectura:

```sh
DATABASE_URL="$STAGING_READONLY_DATABASE_URL" infrastructure/postgres/validate.sh
```

Solo despues de snapshot, identidad de host/base y aprobacion:

```sh
infrastructure/postgres/apply-staging.sh "$STAGING_DATABASE_URL"
DATABASE_URL="$STAGING_READONLY_DATABASE_URL" infrastructure/postgres/validate.sh
```

Gate: Postgres 16/17 dedicado, TLS, backup/PITR, usuario de migracion y roles
`middleware_runtime`/`middleware_readonly` separados. El rollback no es una
migracion inversa: restaurar el snapshot o descartar la DB staging aislada.

## 3. Adaptador DB Worker / Hyperdrive

### Artefactos

- [Contrato y ejemplo del adaptador](../cloudflare/workers/middleware-api/src/db/README.md)
- [Codigo del adaptador](../cloudflare/workers/middleware-api/src/db/)
- [Tests SQL](../src/test/cloudflareDbSql.test.ts)
- [Tests adapter](../src/test/cloudflareDbAdapter.test.ts)
- [Integracion DB, apagada sin URL](../src/test/middlewareWorkerDb.integration.test.ts)

Comandos locales:

```sh
cd /private/tmp/winerim-own-infra-clean
npx vitest run \
  src/test/cloudflareDbAdapter.test.ts \
  src/test/cloudflareDbSql.test.ts \
  src/test/middlewareWorkerDb.integration.test.ts \
  --pool=forks --maxWorkers=1 --no-file-parallelism
```

Resultado fresco: los tests unitarios pasan y los `3/3` tests de integracion
pasan contra un PostgreSQL local desechable creado por
`infrastructure/postgres/smoke-local-worker.sh`. El adaptador parametriza
valores, exige allowlist para identificadores y soporta transacciones.

El typecheck global esta verde. Los Hyperdrive staging verificados en el
inventario Cloudflare son `04bde119c3354a5b9be3fadbf3c0b46d` para API y
`0adae4108e4241f19cf5ba2709cbc69f` para runtime/executor. El gate remoto que
queda es ejecutar los tres tests contra la DB staging y comprobar el principal
y sus privilegios antes de desplegar; no se afirma aqui una identidad de origen
que no haya pasado ese readback.

## 4. Runtime Cloudflare, Cron y Queues

### Artefactos

- [Runbook runtime](../cloudflare/workers/middleware-runtime/README.md)
- [Manifest de portado](./runtime/RUNTIME_PORT_MANIFEST_2026-08-02.md)
- [Worker fail-closed](../cloudflare/workers/middleware-runtime/src/worker.ts)
- [Scheduler](../cloudflare/workers/middleware-runtime/src/scheduler.ts)
- [Queue hooks](../cloudflare/workers/middleware-runtime/src/queue.ts)
- [Retry e idempotencia](../cloudflare/workers/middleware-runtime/src/retry.ts)

Comandos locales:

```sh
cd /private/tmp/winerim-own-infra-clean
npm run cf:runtime:test -- --pool=forks --maxWorkers=1 --no-file-parallelism
npx esbuild cloudflare/workers/middleware-runtime/src/worker.ts \
  --bundle --platform=browser --format=esm --target=es2022 \
  --outfile=/tmp/winerim-middleware-runtime.js
npm run cf:runtime:dry-run:staging
```

Estado fresco: suite completa `380/380` verde, con los tres tests remotos
omitidos cuando no hay `STAGING_DATABASE_URL`; el smoke PostgreSQL local los
ejecuta aparte y pasa `3/3`. TypeScript, ESLint focalizado, bundle y dry-run
Wrangler estan verdes. El runtime sigue configurado con
`RUNTIME_EXECUTION_ENABLED=false`, sin entorno production y sin consumers.

Los adapters PostgreSQL y HTTP reales ya existen y tienen pruebas: catalogo,
ventas, stock, outbound, allowlist de destino, bloqueo de redirects, timeouts,
limite de respuesta e idempotencia persistente. El Worker runtime aun exige un
binding privado `RUNTIME_EXECUTOR`; no se ha compuesto ni desplegado el servicio
que descifra credenciales y conecta esos adapters. Este limite es deliberado:
no se inventan secretos ni se habilita I/O exterior desde una fuente incompleta.

Gate remoto: origen Postgres staging y principals LOGIN de los Hyperdrive
existentes comprobados por readback, composicion privada del executor,
persistencia atomica validada contra la DB gestionada y DLQ/observabilidad. Un
Cron declarado no se activa remotamente antes de este gate.

## 5. Handlers provider-neutral

### Artefactos existentes

- [Catalogo](../cloudflare/workers/middleware-runtime/src/handlers/catalog/)
- [Ventas](../cloudflare/workers/middleware-runtime/src/handlers/sales/)
- [Stock](../cloudflare/workers/middleware-runtime/src/handlers/stock/)
- [Outbound](../cloudflare/workers/middleware-runtime/src/handlers/outbound/)
- [Adapters PostgreSQL y HTTP](../cloudflare/workers/middleware-runtime/src/adapters/)
- [Executor](../cloudflare/workers/middleware-runtime/src/executor/)
- Tests: [`src/test/cloudflareRuntime*.test.ts`](../src/test/)

No se presupone que un handler este terminado por existir. El criterio es:
contrato puro, validacion fail-closed, `dryRun` sin I/O, idempotencia estable,
puertos inyectados, tests y conexion explicita al executor. Catalogo tiene
`15/15` tests focalizados verdes; el gate conjunto sigue siendo el punto 4.

Comando focalizado de catalogo:

```sh
npx vitest run \
  src/test/cloudflareRuntimeCatalogValidation.test.ts \
  src/test/cloudflareRuntimeCatalogPlanning.test.ts \
  src/test/cloudflareRuntimeCatalogHandler.test.ts \
  --pool=forks --maxWorkers=1 --no-file-parallelism
```

Gate de rollout: primero fixtures y dry-run contra snapshot de staging; despues
una sola lectura real. Ningun puerto mutable se habilita hasta tener snapshot,
readback, credenciales cifradas y registro de idempotencia persistente.
Stock/ventas requieren un canary separado y reversible a nivel operativo.

## 6. Cloudflare staging, seguridad y corte

### Artefactos

- [Plan de activos y rollback](./cloudflare/STAGING_ASSET_PLAN_2026-08-02.md)
- [Auditoria read-only](./cloudflare/audit-staging-readonly.sh)
- [QA y gates de seguridad](./qa/INFRA_QA_SECURITY_2026-08-02.md)
- [Pages](../cloudflare/pages/README.md)

Inventario remoto, solo lectura y desde Node 22:

```sh
cd /private/tmp/winerim-own-infra-clean
bash infrastructure/cloudflare/audit-staging-readonly.sh
npx wrangler pages project list
npx wrangler queues list
npx wrangler hyperdrive list
npx wrangler deployments list --config wrangler.middleware.toml --env staging
npx wrangler deployments status --config wrangler.middleware.toml --env staging
```

El plan de activos fue escrito antes de crear Pages, las seis Queues y los dos
Hyperdrive staging. Sus pasos de creacion de esos activos son historicos y quedan
reemplazados por este inventario; los gates de DNS, Access, identidad DB y
rollback siguen vigentes.

## Gate serial de rollout

1. **SOURCE:** Node 22, SHA limpio, typecheck/tests/build/dry-run verdes.
2. **DB:** Postgres staging vacio, sentinel `environment=staging`, bootstrap,
   validacion read-only, backup y restore ensayado.
3. **HYPERDRIVE:** comprobar que API usa `04bde119c3354a5b9be3fadbf3c0b46d`
   y runtime/executor `0adae4108e4241f19cf5ba2709cbc69f`, con origen staging,
   principal minimo y `/ready` fail-closed si DB no responde.
4. **ACCESS/DNS:** el custom domain del API debe existir y superar el preflight
   anonimo/service-token antes del deploy; `workers.dev` y previews siguen
   desactivados. Pages queda bloqueado hasta tener gate y rollback propios.
5. **INERT DEPLOY:** desplegar API/runtime con ejecucion apagada, sin consumers
   y sin mensajes; registrar versiones anteriores y comprobar health/readiness.
6. **CANARY:** enlazar un solo consumer y una conexion no critica, primero
   lectura/dry-run; observar idempotencia, retry, DLQ y metricas. Escritura solo
   con snapshot/readback/rollback especificos.

El workflow solo puede invocarse con DB, DNS y Access ya verificados:

```sh
BRANCH="$(git branch --show-current)"
SHA="$(git rev-parse HEAD)"
gh workflow run deploy-middleware-staging.yml \
  --ref "$BRANCH" \
  -f confirm_target=staging-only \
  -f confirm_sha="$SHA" \
  -f apply_migrations=true \
  -f deploy_worker=true \
  -f deploy_pages=false
```

No usar este workflow para Pages, produccion ni canary. El runtime privado se
publica solo con `deploy-staging-runtime-component.sh`, que exige el contrato
DB completo, ejecucion apagada y ausencia de consumers.

## Rollback obligatorio

Pages no forma parte de este workflow mientras siga bloqueado. Antes de cada
rollout API guardar SHA, version Worker, esquema DB, bindings y conteos de Queue.

```sh
npx wrangler deployments list --config wrangler.middleware.toml --env staging --json
npx wrangler deployments list --config wrangler.middleware-runtime.toml --env staging --json
npx wrangler pages deployment list --project-name winerim-middleware-staging
npx wrangler queues list
```

Orden de rollback:

1. Deshabilitar ejecucion y retirar consumers/cron en configuracion revisada.
2. Volver al Worker anterior por ID exacto y verificar deployments.
3. Retirar binding Hyperdrive del Worker antes de eliminar Hyperdrive.
4. El workflow no crea ni reconfigura dominio/Access: exige ambos antes del
   deploy. Si derivan durante el rollout, mantener el API revertido y tratarlo
   como incidente manual; no intentar recrearlos desde este workflow.
5. Restaurar snapshot o descartar DB staging; nunca ejecutar SQL inverso a
   ciegas.
6. No borrar Queues hasta confirmar cero producers, consumers y mensajes. Las
   Queues vacias actuales pueden permanecer sin riesgo operativo.

Ejemplo Worker staging:

```sh
npx wrangler rollback "<PREVIOUS_VERSION_ID>" \
  --config wrangler.middleware.toml --env staging \
  --message "rollback middleware staging" --yes
npx wrangler deployments status --config wrangler.middleware.toml --env staging
```

Produccion no forma parte de este runbook. El cambio de trafico productivo
requiere otra decision, export consistente, doble lectura, canary por conexion
y rollback probado a la plataforma actual.

## Pendientes exactos

- Aplicar `0009`-`0011` y verificar columna, indice y trigger semanticos antes
  de actualizar runtime/executor staging.
- Mantener executor/runtime inertes y comprobar versiones, bindings y cero
  consumers despues del deploy.
- Cargar credenciales cifradas solo para una conexion canary aprobada; despues
  cerrar observabilidad, limites, alertas, DLQ e idempotencia live.
- Obtener export consistente de produccion antes de plantear un corte real.

`INFRASTRUCTURE_POINTS_1_6_STATUS=STAGING_INERT_READY_FOR_HARDENING_CANARY_BLOCKED`
