# Cloudflare control plane

## Objetivo
Mover el panel operativo del middleware a Cloudflare sin romper la produccion actual en Lovable Cloud.

Esta carpeta documenta solo la nueva capa Cloudflare:

- `pages/`: interfaz Vite/React que se publicara en `middleware.winerim.wine`.
- `workers/middleware-api/`: API no destructiva para onboarding comercial.
- `dns-access/`: dominios, rutas y Access.
- `onboarding-storage/`: contrato de almacenamiento de solicitudes.
- `access/`: checklist de Cloudflare Access.
- `secrets/`: modelo previsto para secretos.

## Estado seguro actual
- Worker staging desplegado en `workers.dev`.
- `/api/onboarding/test` valida Agora/REVO/Winerim y no escribe en ningun sistema.
- `/api/onboarding/requests` existe, pero esta apagado por `ONBOARDING_REQUESTS_ENABLED=false`.
- La pantalla `/onboarding/requests` existe, pero no muestra datos hasta activar storage + Access.
- Pages staging no debe exponerse al equipo hasta que Cloudflare Access este delante.

## Comandos utiles

```sh
npm run cf:api:verify:staging
npm run cf:readiness:staging
npx wrangler deploy --config wrangler.middleware.toml --env staging --dry-run
npm run build
npm run test
```

`cf:api:verify:staging` valida el Worker desplegado.

`cf:readiness:staging` diferencia:

- runtime `workers.dev` OK;
- custom domain `api-staging.middleware.winerim.wine` pendiente;
- Pages staging pendiente;
- CORS `POST/PATCH` listo para Cloudflare Access.

## Gates antes de activar solicitudes reales
No activar `ONBOARDING_REQUESTS_ENABLED=true` hasta cumplir todos:

1. `api-staging.middleware.winerim.wine` resuelve y responde `/health`.
2. `staging.middleware.winerim.wine` esta protegido por Cloudflare Access.
3. La API privada tambien recibe identidad Access.
4. `CF_ACCESS_AUD` y `CF_ACCESS_TEAM_DOMAIN` estan configurados en staging.
5. `20260615073500_onboarding_requests.sql` esta aplicada solo en staging.
6. `LOVABLE_CLOUD_REST_URL` y `LOVABLE_CLOUD_SERVICE_KEY` estan configurados en el Worker staging.
7. `npm run cf:api:verify:staging` pasa con `EXPECT_REQUEST_STORAGE=enabled`.

## Rollback general
- Apagar almacenamiento: `ONBOARDING_REQUESTS_ENABLED=false`.
- Si la API falla: quitar custom domain o route y usar temporalmente `workers.dev`.
- Si Pages falla: quitar dominio Pages o pausar deployment.
- No hay rollback de POS/Winerim en esta fase porque el flujo no escribe en POS, Winerim ni `pos_connections`.
