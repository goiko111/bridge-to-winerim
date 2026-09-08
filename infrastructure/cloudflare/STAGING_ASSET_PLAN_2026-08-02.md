# Cloudflare staging asset plan - 2026-08-02

> **Estado actualizado:** este documento conserva el inventario previo y el
> runbook de creacion. Despues de ese corte se crearon de forma inerte el
> proyecto Pages `winerim-middleware-staging` y seis Queues
> `winerim-staging-*`, todas sin deployment, producer ni consumer. La fuente de
> verdad actual es `infrastructure/README.md`. No se crearon DNS, Access,
> Hyperdrive, secrets ni Workers nuevos.
>
> Alcance de este corte: auditoria remota en solo lectura y plan de ejecucion.
> En el corte original no se creo, modifico ni elimino ningun recurso remoto.

## Veredicto

`STAGING_ASSETS_PARTIAL / REMOTE_WRITES_NOT_EXECUTED`

La cuenta permite administrar Workers, Pages, Queues y Hyperdrive, pero el
staging del middleware no esta completo. Existe un Worker accesible por
`workers.dev`; faltan el dominio resoluble, Pages, Access, secretos, colas y un
Hyperdrive propio. El Worker remoto tampoco coincide con el codigo local.

## Hechos verificados

| Activo | Estado remoto | Evidencia | Resultado |
|---|---|---|---|
| Cuenta y zona | OAuth Wrangler valido; `winerim.wine` activo en Cloudflare, plan de zona Free | `wrangler whoami`; API de zona; NS `april`/`nash` | OK para staging limitado |
| Worker | `winerim-middleware-api-staging`, 8 versiones; activa `6af1c6ed-fc3a-4d29-aa55-84cb81fbe915` del 2026-06-16 | `wrangler deployments status/list` | EXISTE |
| Endpoint Worker | `/health` en `workers.dev` devuelve 200 | probe GET | VIVO |
| Codigo remoto | `/api/checklist?provider=agora` devuelve 404 aunque existe localmente | probe GET + codigo local | DRIFT |
| Bindings remotos | Solo variables de entorno no secretas; `ONBOARDING_REQUESTS_ENABLED=false` | `wrangler versions view` | INCOMPLETO |
| Secrets Worker | Lista vacia | `wrangler secret list --env staging` | FALTAN |
| Route Worker | Existe `api-staging.middleware.winerim.wine/*` -> Worker staging | Workers Routes API | EXISTE SIN DNS |
| DNS | No resuelven `api-staging`, `staging`, `api` ni `middleware` | `dig` y `curl` | FALTA |
| Pages | No existe `winerim-middleware-staging` | `wrangler pages project list` | FALTA |
| Access | No verificable con el OAuth actual: falta permiso efectivo `Access: Apps and Policies Read` | Access API devuelve auth error | GATE DE PERMISOS |
| Queues | Cero queues en la cuenta | `wrangler queues list` | FALTAN |
| Hyperdrive | Solo existe `market-winerim-postgres`, ajeno al middleware | `wrangler hyperdrive list` | FALTA EL PROPIO |

## Contradicciones y deriva

1. `wrangler.middleware.toml` declara `compatibility_date=2026-06-12`; la
   version remota activa usa `2026-05-03`.
2. La version remota tiene `ALLOWED_ORIGINS`,
   `ONBOARDING_REQUESTS_ENABLED` y
   `ONBOARDING_REQUESTS_REQUIRE_ACCESS_EMAIL`, que no aparecen en el TOML
   local actual.
3. El TOML local declara una Route con `/*`. Cloudflare exige un registro DNS
   proxied para ese modelo; la route existe, pero el hostname no tiene DNS y
   por eso no puede recibir trafico.
4. El Worker es el origen del API. Para este caso un Custom Domain es mas
   apropiado que una Route delante de un origen inexistente: Cloudflare crea
   DNS y certificado al desplegarlo.

## Permisos observados

El OAuth actual incluye escritura de Workers, Worker Routes, Pages y Queues,
ademas de administracion de Connectivity/Hyperdrive. La lectura de la zona
funciona, pero la consulta directa de DNS y Access por API devuelve error de
autenticacion. Antes de automatizar DNS o Access se necesita un API token
acotado con:

- `Zone: Read` y `DNS: Read/Edit` para `winerim.wine` si se usa DNS API.
- `Workers Scripts: Write` y `Workers Routes: Write` para Worker/domino.
- `Pages: Write` para Pages y su custom domain.
- `Access: Apps and Policies Read/Write` para Access.
- `Queues: Write` y permiso de Hyperdrive/Connectivity para esos activos.

No usar Global API Key. No guardar el token en el repo.

## Coste y plan

- Pages estatico y el Worker pueden validarse bajo el plan Free existente.
- Queues Free incluye 10.000 operaciones/dia y retencion fija de 24 horas. Es
  suficiente para staging, pero no para una politica productiva que requiera
  rescate de varios dias.
- Hyperdrive Free incluye hasta 100.000 consultas/dia. La base Postgres
  gestionada se factura por separado por su proveedor.
- Access requiere activar/verificar Zero Trust y definir la identidad interna.
  No crear ni aceptar upgrades si aparece una pantalla de plan/coste.
- Ningun activo de pago debe activarse sin un gate de coste separado.

## Decisiones recomendadas

1. Mantener `workers.dev` habilitado hasta que DNS, TLS, Access y smoke del
   custom domain pasen.
2. Cambiar staging de Route a Custom Domain:

   ```toml
   [env.staging]
   name = "winerim-middleware-api-staging"
   workers_dev = true
   routes = [
     { pattern = "api-staging.middleware.winerim.wine", custom_domain = true }
   ]
   ```

3. No desplegar el arbol actual sin reconciliar primero el drift remoto/local.
4. No enlazar Hyperdrive al Worker hasta que exista Postgres staging y el
   codigo use un driver compatible con `env.MIDDLEWARE_DB.connectionString`.
5. Crear Queues sin consumidores solo despues de cerrar nombres y retencion;
   no mover trafico productivo a esas colas durante staging.
6. Proteger Pages con Access. Mantener ademas autorizacion de aplicacion en el
   API; Access no sustituye controles de rol/tenant.

## Secuencia de creacion serial

Todos los comandos siguientes son un runbook; no se ejecutaron en esta
auditoria. Ejecutarlos desde una rama/worktree limpia y con variables secretas
inyectadas por CI o shell, nunca escritas en archivos.

### 0. Snapshot y gate local

```sh
./infrastructure/cloudflare/audit-staging-readonly.sh
npx esbuild cloudflare/workers/middleware-api/src/index.ts \
  --bundle --platform=browser --format=esm \
  --outfile=/tmp/winerim-middleware-api-staging.js
node --check scripts/smoke-middleware-api.mjs
npx wrangler deploy --config wrangler.middleware.toml --env staging \
  --dry-run --outdir /tmp/winerim-cf-staging-dryrun
```

Gate: fuente limpia, bundle OK, diff remoto/local revisado y version anterior
anotada. La referencia de rollback inicial es
`6af1c6ed-fc3a-4d29-aa55-84cb81fbe915`.

### 1. Worker staging y Custom Domain

Tras cambiar el TOML al bloque `custom_domain=true` anterior:

```sh
npx wrangler deploy --config wrangler.middleware.toml --env staging
npx wrangler deployments status --config wrangler.middleware.toml --env staging
curl --connect-timeout 5 --max-time 10 \
  https://api-staging.middleware.winerim.wine/health
npm run cf:api:smoke:staging
```

Rollback de codigo:

```sh
npx wrangler rollback 6af1c6ed-fc3a-4d29-aa55-84cb81fbe915 \
  --config wrangler.middleware.toml --env staging \
  --message "rollback staging asset bootstrap" --yes
```

El rollback de una version no revierte dominios, routes ni secrets. Para
retirar el Custom Domain, listar su id y separarlo:

```sh
curl -fsS \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains"

curl -fsS -X DELETE \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains/$WORKER_DOMAIN_ID"
```

### 2. Pages staging y dominio

```sh
npx wrangler pages project create winerim-middleware-staging \
  --production-branch staging
VITE_MIDDLEWARE_API_URL=https://api-staging.middleware.winerim.wine npm run build
npx wrangler pages deploy dist \
  --project-name winerim-middleware-staging \
  --branch staging \
  --commit-hash "$(git rev-parse HEAD)" \
  --commit-dirty=false

curl -fsS -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"staging.middleware.winerim.wine"}' \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/winerim-middleware-staging/domains"
```

Readback:

```sh
npx wrangler pages project list
dig +short staging.middleware.winerim.wine
curl --connect-timeout 5 --max-time 10 -I \
  https://staging.middleware.winerim.wine/onboarding
```

Rollback del dominio y del proyecto vacio:

```sh
curl -fsS -X DELETE \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/winerim-middleware-staging/domains/staging.middleware.winerim.wine"
npx wrangler pages project delete winerim-middleware-staging --yes
```

Si ya existe una version Pages sana, preferir el endpoint de rollback de esa
deployment antes de borrar el proyecto.

### 3. Cloudflare Access

Requiere API token con `Access: Apps and Policies Write` y decidir el dominio
de correo o lista exacta del equipo. Ejemplo con dominio interno placeholder:

```sh
ACCESS_APP_ID="$(curl -fsS -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"Middleware Winerim staging","type":"self_hosted","domain":"staging.middleware.winerim.wine","session_duration":"8h"}' \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" \
  | jq -r '.result.id')"

curl -fsS -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"Equipo interno","decision":"allow","precedence":1,"include":[{"email_domain":{"domain":"<INTERNAL_EMAIL_DOMAIN>"}}]}' \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$ACCESS_APP_ID/policies"
```

Readback y rollback:

```sh
curl -fsS \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$ACCESS_APP_ID"
curl -fsS -X DELETE \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$ACCESS_APP_ID"
```

Gate: verificar primero identidad/IdP y que no aparece contratacion o upgrade.

### 4. Postgres staging e Hyperdrive

Requiere una base dedicada, usuario con permisos minimos y cadena TLS. No usar
el Hyperdrive `market-winerim-postgres`.

```sh
npx wrangler hyperdrive create winerim-middleware-staging-postgres \
  --connection-string "$STAGING_DATABASE_URL" \
  --caching-disabled \
  --origin-connection-limit 10
npx wrangler hyperdrive list
```

Despues de obtener el id, declararlo solo en staging:

```toml
[[env.staging.hyperdrive]]
binding = "MIDDLEWARE_DB"
id = "<WINERIM_STAGING_HYPERDRIVE_ID>"
```

Antes de desplegar ese binding, el Worker debe:

- usar `env.MIDDLEWARE_DB.connectionString`;
- activar la compatibilidad requerida por el driver Postgres elegido;
- usar transacciones e idempotencia del esquema actual;
- pasar smoke de lectura contra Postgres staging;
- no depender de `LOVABLE_CLOUD_URL/rest/v1`.

Rollback:

```sh
# Primero retirar el binding del TOML y desplegar la version staging anterior.
npx wrangler hyperdrive delete "$WINERIM_STAGING_HYPERDRIVE_ID"
```

No eliminar Hyperdrive mientras un Worker lo tenga enlazado.

### 5. Secrets por nombre

Estado actual remoto: ninguna secret en el Worker staging.

Destino independiente minimo:

```txt
MIDDLEWARE_ADMIN_TOKEN
```

Opcionales si se protege el API maquina-a-maquina con Access:

```txt
CLOUDFLARE_ACCESS_CLIENT_ID
CLOUDFLARE_ACCESS_CLIENT_SECRET
```

Secrets de CI, no bindings del frontend:

```txt
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
STAGING_DATABASE_URL
MIDDLEWARE_ADMIN_TOKEN
```

Configuracion y rollback:

```sh
npx wrangler secret put MIDDLEWARE_ADMIN_TOKEN \
  --config wrangler.middleware.toml --env staging
npx wrangler secret list --config wrangler.middleware.toml --env staging
npx wrangler secret delete MIDDLEWARE_ADMIN_TOKEN \
  --config wrangler.middleware.toml --env staging
```

`LOVABLE_CLOUD_URL` y `LOVABLE_SERVICE_ROLE_KEY` solo tienen sentido en un
staging transitorio dependiente de Lovable. No deben formar parte del failover
independiente final.

### 6. Queues staging

Nombres propuestos:

```txt
winerim-staging-catalog
winerim-staging-sales
winerim-staging-stock
winerim-staging-maintenance
winerim-staging-dead-letter
```

Creacion sin consumidores:

```sh
npx wrangler queues create winerim-staging-catalog
npx wrangler queues create winerim-staging-sales
npx wrangler queues create winerim-staging-stock
npx wrangler queues create winerim-staging-maintenance
npx wrangler queues create winerim-staging-dead-letter
npx wrangler queues list
```

No enlazar consumidores hasta que el runtime implemente `queue()` con
idempotencia, retry acotado y DLQ. En Free la retencion es 24 horas.

Rollback, despues de retirar bindings y consumidores:

```sh
npx wrangler queues delete winerim-staging-catalog
npx wrangler queues delete winerim-staging-sales
npx wrangler queues delete winerim-staging-stock
npx wrangler queues delete winerim-staging-maintenance
npx wrangler queues delete winerim-staging-dead-letter
```

## Matriz de disponibilidad

| Activo | Se puede crear ya | Requiere antes | Gate de coste/plan |
|---|---:|---|---|
| Worker custom domain | Si | Fuente limpia y drift reconciliado | No aceptar upgrade |
| Pages staging | Si | Build limpio | Free es suficiente para smoke |
| DNS API directo | No con OAuth actual | Token DNS acotado, o usar Custom Domain/Pages | Ninguno esperado |
| Access | No con OAuth actual | Scope Access + identidad interna/IdP | Parar ante alta/upgrade |
| Queues vacias | Si | Nombres aprobados | Free: 10k ops/dia, 24h |
| Hyperdrive | No aun | Postgres staging + credencial TLS | Free: 100k queries/dia; DB aparte |
| Secrets Worker | Si | Valores desde canal seguro | Ninguno esperado |
| Cron Triggers | No aun | Handlers y politica de jitter | No activar durante esta fase |

## Criterio de cierre de staging

- Worker local/remoto reconciliado y versionado.
- `api-staging.middleware.winerim.wine/health` resuelve y responde 200.
- Pages resuelve y queda detras de Access.
- Ninguna secret aparece en frontend, logs o repo.
- Hyperdrive apunta al Postgres staging propio y el Worker ya no depende de
  Lovable para las lecturas de control plane.
- Smoke publico y protegido pasa.
- Queues tienen handlers, idempotencia y DLQ probados antes de consumidores.
- Cero DNS, crons, trafico o clientes productivos movidos.

## Referencias oficiales

- Workers routes/custom domains: https://developers.cloudflare.com/workers/configuration/routing/
- Pages custom domains: https://developers.cloudflare.com/pages/configuration/custom-domains/
- Access applications: https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/list/
- Queues: https://developers.cloudflare.com/queues/get-started/
- Hyperdrive: https://developers.cloudflare.com/hyperdrive/get-started/
- Hyperdrive pricing: https://developers.cloudflare.com/hyperdrive/platform/pricing/
- Queues pricing: https://developers.cloudflare.com/queues/platform/pricing/

## No produccion confirmado

- No deploy, route, DNS, Access, Hyperdrive ni secret creados. Pages y seis
  Queues se crearon despues como activos vacios e inertes, sin trafico.
- No se modifico Lovable Cloud/backend, base, TPV, stock, ventas ni clientes.
