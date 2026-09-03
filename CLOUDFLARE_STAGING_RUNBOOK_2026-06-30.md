# Cloudflare Staging Runbook — 2026-06-30

Objetivo: levantar `middleware.winerim.wine` en staging sin afectar al sistema actual de Lovable Cloud.

## Regla principal

Lovable Cloud sigue siendo producción para clientes reales hasta decisión explícita de go-live. No se mueven crons, proxies, colas, DNS productivo ni escrituras de POS desde Cloudflare durante esta fase.

## Qué se puede activar en staging

- Worker `winerim-middleware-api-staging`.
- Ruta `api-staging.middleware.winerim.wine`.
- Pages `staging.middleware.winerim.wine`.
- Cloudflare Access para equipo interno.
- Tablas auxiliares de control plane:
  - `connection_notification_contacts`.
  - `integration_onboarding_requests`.

## Qué NO se activa todavía

- `api.middleware.winerim.wine` productivo.
- Crons de ventas/stock en Cloudflare.
- Colas de catálogo en Cloudflare.
- Escritura de productos a POS desde Cloudflare.
- Cambios de DNS que sustituyan Lovable Cloud.
- Botones frontend que ejecuten acciones productivas.

## Secrets de Worker staging

Configurar solo en entorno staging:

```sh
npx wrangler secret put LOVABLE_SERVICE_ROLE_KEY --config wrangler.middleware.toml --env staging
npx wrangler secret put MIDDLEWARE_ADMIN_TOKEN --config wrangler.middleware.toml --env staging
```

Variables no secretas:

```sh
LOVABLE_CLOUD_URL=<url del backend Lovable Cloud usado para staging>
```

Si se usa Lovable Cloud productivo temporalmente para lectura/control plane, no activar ninguna ruta destructiva ni conectar la UI pública sin Access.

## Migraciones staging

Aplicar primero en staging:

```txt
supabase/migrations/20260629151602_connection_notification_contacts.sql
supabase/migrations/20260630063407_integration_onboarding_requests.sql
```

Verificar:

- RLS activado en ambas tablas.
- Sin policies públicas para `anon` ni `authenticated`.
- `service_role` tiene permisos:
  - `SELECT` sobre `connection_notification_contacts`;
  - `SELECT`, `INSERT`, `UPDATE` sobre `integration_onboarding_requests`.

## Deploy staging

### Opcion recomendada: GitHub Actions manual

Workflow:

```txt
.github/workflows/deploy-middleware-staging.yml
```

Secrets del environment `middleware-staging`:

```txt
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
MIDDLEWARE_ADMIN_TOKEN
LOVABLE_SERVICE_ROLE_KEY
LOVABLE_CLOUD_URL
STAGING_DB_URL
```

Variables/secrets que deben configurarse en el Worker staging, no en el frontend:

```txt
LOVABLE_CLOUD_URL
LOVABLE_SERVICE_ROLE_KEY
MIDDLEWARE_ADMIN_TOKEN
```

Para lanzar el workflow, usar `workflow_dispatch` con:

```txt
confirm_target = staging-only
apply_migrations = true/false
deploy_worker = true
deploy_pages = false/true
```

El workflow no tiene job de produccion, no usa `--env production` y carga los secrets del Worker solo en `--env staging`.

### Opcion local si Wrangler funciona

```sh
npm run cf:api:deploy:staging
```

Si `wrangler whoami` o deploy se quedan esperando, no seguir a producción. Reautenticar Cloudflare en la máquina o hacer el deploy desde CI.

## Smoke test

Sin token interno:

```sh
npm run cf:api:smoke:staging
```

Con token interno:

```sh
MIDDLEWARE_ADMIN_TOKEN=<token> npm run cf:api:smoke:staging
```

Debe cumplirse:

- `/health` responde OK.
- `/api/checklist?provider=agora` responde OK.
- `POST /api/onboarding/requests` sin token devuelve `401` o `503`, nunca `201`.
- `GET /api/agora/fleet` sin token devuelve `401` o `503`, nunca datos.
- `POST /api/onboarding/requests` con token devuelve `201` y no filtra secretos.
- `GET /api/agora/fleet` con token devuelve `{ success: true, rows: [...] }`.

## Rollback

- Quitar ruta `api-staging.middleware.winerim.wine` o pausar Worker staging.
- No tocar Lovable Cloud productivo.
- No revertir tablas auxiliares salvo que se quiera limpiar staging.

## Criterio para pasar a canary

- Staging protegido por Cloudflare Access.
- Smoke test OK.
- Solicitud de onboarding creada sin secretos.
- Contactos leídos solo por Worker seguro.
- Checklist operativo visible para comercial/técnico.
- Cero rutas productivas o crons Cloudflare activos.
