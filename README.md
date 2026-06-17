# Winerim TPV Integrations Middleware

Middleware multi-tenant para conectar Winerim con POS/TPV de restauracion.

Flujos principales:

- Winerim -> POS: catalogo, precios y altas de productos.
- POS -> Winerim: ventas cerradas y deduccion absoluta de stock por variante.
- Aislamiento por `connection_id`.

## Estado de infraestructura

- Produccion actual: Lovable Cloud.
- Migracion activa: control plane en Cloudflare bajo `middleware.winerim.wine`.
- Primer flujo Cloudflare: onboarding comercial no destructivo.

Cloudflare no sustituye todavia el backend operativo de clientes. El objetivo actual es permitir que el equipo pruebe URL/token POS + token Winerim, deje solicitudes en revision y evite depender de acceso manual a Lovable Cloud.

## Reglas duras

- No editar `.env`.
- No editar `src/integrations/supabase/client.ts`.
- No editar `src/integrations/supabase/types.ts`.
- Los proxies deben leer `await req.json()` una sola vez.
- En Agora, `/api/export-master/?filter=Products` solo puede leerse mediante `fetchAgoraProductsXmlCached`.
- Toda llamada saliente Agora debe pasar por fetch con retry/rate limit/circuit breaker.
- No crear conexiones ni escrituras POS desde onboarding comercial sin revision tecnica y rollback.

## Documentos de sesion

Antes de trabajar, leer:

1. `PROJECT_CONTEXT.md`
2. `CURRENT_STATE.md`
3. `DECISIONS_LOG.md`
4. `NEXT_STEPS.md`

Al cerrar una sesion, actualizar:

1. `CURRENT_STATE.md`
2. `DECISIONS_LOG.md`
3. `NEXT_STEPS.md`

Separar siempre hechos, decisiones, hipotesis y tareas pendientes.

## Desarrollo local

```sh
npm ci
npm run dev
npm run cf:api:dev
```

Frontend local:

```txt
http://127.0.0.1:8084/onboarding
```

Worker local:

```txt
http://127.0.0.1:8787/health
```

## Validacion

```sh
npm run test
npx tsc --noEmit
npm run build
npx wrangler deploy --config wrangler.middleware.toml --env staging --dry-run
```

El lint global arrastra deuda historica del proyecto. Para cambios acotados, validar tambien los archivos tocados con `npx eslint <files>`.

## Cloudflare staging

Worker staging actual:

```txt
https://winerim-middleware-api-staging.gugocreative.workers.dev
```

Comandos:

```sh
npm run cf:api:verify:staging
npm run cf:readiness:staging
npm run cf:api:deploy:staging
```

Documentacion:

- `cloudflare/README.md`
- `cloudflare/pages/README.md`
- `cloudflare/dns-access/README.md`
- `cloudflare/access/README.md`
- `cloudflare/onboarding-storage/README.md`
- `cloudflare/secrets/README.md`

## Activacion segura de solicitudes

No activar `ONBOARDING_REQUESTS_ENABLED=true` hasta tener:

- Cloudflare Access en UI y API staging;
- `CF_ACCESS_AUD` y `CF_ACCESS_TEAM_DOMAIN` configurados;
- migracion `20260615073500_onboarding_requests.sql` aplicada solo en staging;
- `LOVABLE_CLOUD_REST_URL` y `LOVABLE_CLOUD_SERVICE_KEY` configurados como var/secret del Worker;
- smoke test pasando con storage activo;
- confirmacion de que `PATCH /api/onboarding/requests/:id` funciona desde la UI.

Rollback inmediato:

```txt
ONBOARDING_REQUESTS_ENABLED=false
```
