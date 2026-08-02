# Infraestructura propia Middleware Winerim

Indice operativo de los puntos 1-6. Corte: 2026-08-02, Europe/Madrid.

## Regla de seguridad

Este arbol es preparacion de staging. No autoriza produccion.

- No desplegar Workers o Pages, no enlazar consumers, no activar Cron y no
  cambiar DNS hasta que pasen los gates de este documento.
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
| Worker runtime nuevo | No desplegado | No |
| Worker API de esta fase | No desplegado; el Worker de control plane de junio es una version historica distinta | No para este rollout |
| Postgres propio | No provisionado | No |
| Hyperdrive propio | No creado ni enlazado | No |
| DNS `api-staging` / `staging` | Bloqueado, sin dominio operativo | No |
| Cloudflare Access | Bloqueado por permisos/configuracion de IdP y policy | No |

Las seis Queues son solo activos vacios. El TOML local declara productores para
cinco nombres, pero no se ha desplegado; por tanto no hay producer nuevo ni
consumer remoto. `winerim-staging-dead-letter` queda deliberadamente sin
binding hasta que exista un consumer revisado.

La auditoria remota reproducible esta en
[`cloudflare/audit-staging-readonly.sh`](./cloudflare/audit-staging-readonly.sh).
La validacion final se ejecuto con Node `24.14.0`; CI queda fijado en Node 22,
compatible con Wrangler `4.118+`. No rebajar Wrangler para saltar el gate.

## Resumen de los puntos 1-6

| Punto | Alcance | Estado local | Bloqueo remoto |
|---:|---|---|---|
| 1 | Fuente limpia, toolchain y CI staging | Rama limpia, commit acotado, workflow fail-closed y validacion completa | Publicar el SHA revisado en PR; no hacer merge automatico |
| 2 | Bootstrap Postgres portable y endurecido | Validacion estatica y replay vacio OK | Falta proveedor/base staging |
| 3 | Adaptador Worker -> Postgres/Hyperdrive | Adaptador y tests unitarios presentes | Falta DB, Hyperdrive y binding |
| 4 | Runtime, scheduler, envelopes, retry y Queues | Implementacion local fail-closed; suite, typecheck y bundle verdes | No hay Worker runtime desplegado ni consumers |
| 5 | Handlers y adaptadores provider-neutral | Catalogo, ventas, stock, outbound, transportes HTTP y executor presentes localmente | Falta componer el executor desplegable con credenciales cifradas, binding privado y canary |
| 6 | Assets, seguridad, observabilidad y corte | Pages/Queues creados de forma inerte; QA documentada | DB, Hyperdrive, DNS y Access bloqueados |

## 1. Fuente limpia, toolchain y CI

### Artefactos

- [Workflow staging](../.github/workflows/deploy-middleware-staging.yml)
- [Wrangler API](../wrangler.middleware.toml)
- [Ejemplo Hyperdrive API sin ID real](../wrangler.middleware-api.hyperdrive.toml.example)
- [Wrangler runtime](../wrangler.middleware-runtime.toml)
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
`EMPTY_REPLAY_HARDENED_OK`; 28 tablas, seis funciones, RLS en todas las tablas,
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

El typecheck global esta verde. El gate remoto que queda es ejecutar esos mismos
tres tests contra la DB staging real antes de crear/enlazar Hyperdrive.

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

Gate remoto: Postgres/Hyperdrive staging, principals LOGIN separados,
composicion privada del executor, persistencia atomica validada contra la DB
gestionada y DLQ/observabilidad. Un Cron declarado no se activa remotamente
antes de este gate.

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

El plan de activos fue escrito antes de crear Pages y las seis Queues; su frase
`No se creo ... Pages/Queue` esta superada por el estado remoto de este indice.
Sus runbooks de DNS, Access, Hyperdrive y rollback siguen vigentes.

## Gate serial de rollout

1. **SOURCE:** Node 22, SHA limpio, typecheck/tests/build/dry-run verdes.
2. **DB:** Postgres staging vacio, sentinel `environment=staging`, bootstrap,
   validacion read-only, backup y restore ensayado.
3. **HYPERDRIVE:** crear uno propio, binding solo staging, rol minimo y
   `/ready` fail-closed si DB no responde.
4. **ACCESS/DNS:** proteger Pages, API, `workers.dev` y previews; JWT/RBAC
   probado. No aceptar alta de plan o coste sin aprobacion.
5. **INERT DEPLOY:** desplegar API/runtime con ejecucion apagada, sin consumers
   y sin mensajes; registrar versiones anteriores y comprobar health/readiness.
6. **CANARY:** enlazar un solo consumer y una conexion no critica, primero
   lectura/dry-run; observar idempotencia, retry, DLQ y metricas. Escritura solo
   con snapshot/readback/rollback especificos.

El workflow solo puede invocarse cuando DB, DNS y Access existan:

```sh
BRANCH="$(git branch --show-current)"
SHA="$(git rev-parse HEAD)"
gh workflow run deploy-middleware-staging.yml \
  --ref "$BRANCH" \
  -f confirm_target=staging-only \
  -f confirm_sha="$SHA" \
  -f confirm_db_host="<STAGING_DB_HOST>" \
  -f confirm_db_name="<STAGING_DB_NAME>" \
  -f apply_migrations=true \
  -f deploy_worker=true \
  -f deploy_pages=false
```

No ejecutar hoy: DB, DNS y Access siguen bloqueados.

## Rollback obligatorio

Antes de cada rollout guardar SHA, Worker version, deployment Pages, esquema
DB, bindings y conteos de Queue.

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
4. Revertir dominio/Access solo despues de confirmar que no expone Pages/API.
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

- Crear Postgres staging y cerrar identidad, backups, roles y URL TLS.
- Crear dos Hyperdrive propios, API y runtime con LOGIN distintos, y probar los
  tres tests de integracion DB.
- Configurar DNS y Cloudflare Access con permisos/IdP aprobados.
- Desplegar primero una version inerte; no enlazar consumers en ese deploy.
- Componer el servicio privado `RUNTIME_EXECUTOR` sobre los adapters ya
  implementados, con credenciales cifradas y allowlists por conexion; despues
  cerrar observabilidad, limites, alertas, DLQ y canary no critico.
- Obtener export consistente de produccion antes de plantear un corte real.

`INFRASTRUCTURE_POINTS_1_6_STATUS=LOCAL_ADVANCED_REMOTE_INERT_BLOCKED_DB_ACCESS`
