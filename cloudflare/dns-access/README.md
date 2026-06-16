# Cloudflare DNS and Access runbook

## Objetivo
Activar staging bajo dominios de `winerim.wine` sin tocar produccion Lovable Cloud:

- UI staging: `staging.middleware.winerim.wine`
- API staging: `api-staging.middleware.winerim.wine`
- UI produccion futura: `middleware.winerim.wine`
- API produccion futura: `api.middleware.winerim.wine`

## Estado actual
- Worker staging desplegado: `winerim-middleware-api-staging`.
- Version ID actual: `6af1c6ed-fc3a-4d29-aa55-84cb81fbe915` (2026-06-16 08:00 CEST).
- URL temporal funcional: `https://winerim-middleware-api-staging.gugocreative.workers.dev`.
- Ruta Worker declarada en `wrangler.middleware.toml`: `api-staging.middleware.winerim.wine/*`.
- Bloqueo actual: `api-staging.middleware.winerim.wine` no resuelve DNS.
- Cloudflare Pages no esta desplegado todavia.
- La bandeja `onboarding_requests` existe en codigo, pero esta apagada por `ONBOARDING_REQUESTS_ENABLED=false`.
- Rutas staging desplegadas:
  - `GET /health`
  - `POST /api/onboarding/test`
  - `GET /api/onboarding/requests` (disabled hasta Access + storage)
  - `POST /api/onboarding/requests` (disabled hasta Access + storage)
  - `PATCH /api/onboarding/requests/:id` (disabled hasta Access + storage)

Smoke test disponible:

```sh
npm run cf:api:verify:staging
npm run cf:readiness:staging
```

Checklists relacionados:

- `cloudflare/access/README.md`
- `cloudflare/secrets/README.md`
- `cloudflare/onboarding-storage/README.md`

## Paso 1 - API staging

Opcion preferida: Custom Domain gestionado por Cloudflare.

1. Cloudflare Dashboard -> Workers & Pages.
2. Abrir Worker `winerim-middleware-api-staging`.
3. Settings -> Domains & Routes.
4. Add -> Custom Domain.
5. Dominio: `api-staging.middleware.winerim.wine`.
6. Confirmar que Cloudflare crea DNS/certificado automaticamente.
7. Validar:

```sh
curl -i https://api-staging.middleware.winerim.wine/health
```

Resultado esperado:

```json
{"ok":true,"service":"winerim-middleware-api","environment":"staging","release":"staging"}
```

Fallback si se usa Route en vez de Custom Domain:

1. Cloudflare Dashboard -> DNS -> `winerim.wine`.
2. Crear registro proxied para `api-staging.middleware`.
3. Mantener la ruta Worker `api-staging.middleware.winerim.wine/*`.
4. Validar con el mismo `curl`.

No crear registros DNS de produccion (`api.middleware.winerim.wine`) durante esta fase.

## Paso 2 - Pages staging

No desplegar Pages hasta tener Access.

1. Cloudflare Dashboard -> Workers & Pages -> Create application -> Pages.
2. Proyecto recomendado: `winerim-middleware`.
3. Framework preset: Vite.
4. Build command: `npm run build`.
5. Output directory: `dist`.
6. Node version: `20`.
7. Branch inicial: `codex/cloudflare-middleware-onboarding` o una rama de staging dedicada.
8. Variable staging:

```txt
VITE_MIDDLEWARE_API_URL=https://api-staging.middleware.winerim.wine
```

Mientras el DNS de API no este resuelto, para pruebas internas se puede usar:

```txt
VITE_MIDDLEWARE_API_URL=https://winerim-middleware-api-staging.gugocreative.workers.dev
```

## Paso 3 - Cloudflare Access

Aplicar Access sobre la UI staging antes de activar Pages para el equipo:

1. Cloudflare Zero Trust -> Access -> Applications.
2. Add an application -> Self-hosted.
3. Name: `Winerim Middleware Staging`.
4. Application domain: `staging.middleware.winerim.wine`.
5. Policy: Allow internal Winerim users.
6. Include: emails o dominio corporativo validado por el equipo.
7. Activar logs de acceso.

Importante: para activar `GET/POST/PATCH /api/onboarding/requests`, el Worker exige identidad Access por defecto. Por eso la API tambien debe recibir identidad Access antes de poner `ONBOARDING_REQUESTS_ENABLED=true`.

Opciones seguras:

1. Proteger tambien `api-staging.middleware.winerim.wine` con Cloudflare Access y configurar validacion JWT en el Worker.
2. Mantener `/api/onboarding/test` publico temporalmente y no activar `ONBOARDING_REQUESTS_ENABLED` hasta separar rutas publicas/privadas.

No activar `ONBOARDING_REQUESTS_ENABLED=true` si la API no recibe identidad Access.

Validacion JWT opcional/recomendada para rutas privadas:

- `CF_ACCESS_AUD`: Audience Tag de la aplicacion Access.
- `CF_ACCESS_TEAM_DOMAIN`: dominio del equipo Access, por ejemplo `https://winerim.cloudflareaccess.com`.

Con `CF_ACCESS_AUD` configurado, el Worker valida `CF-Access-Jwt-Assertion` contra `CF_ACCESS_TEAM_DOMAIN/cdn-cgi/access/certs`, comprueba `aud`, `exp` y firma RS256. Si no hay JWT valido, devuelve `ACCESS_IDENTITY_REQUIRED`.

El codigo ya esta preparado para el lado CORS/credenciales del navegador:
- `/onboarding` usa `credentials: "include"`;
- el Worker permite credenciales y responde `Vary: Origin`;
- `ALLOWED_ORIGINS` debe contener el dominio exacto de Pages;
- el preflight permite `CF-Access-Client-Id`, `CF-Access-Client-Secret` y `CF-Access-Jwt-Assertion`.

Esto no sustituye la politica de Access: Access debe seguir protegiendo la UI/API. La validacion JWT dentro del Worker es una segunda defensa para rutas privadas.

## Validacion completa

1. `curl -i https://api-staging.middleware.winerim.wine/health`.
2. Validar preflight:

```sh
curl -i -X OPTIONS \
  -H 'Origin: https://staging.middleware.winerim.wine' \
  -H 'Access-Control-Request-Method: POST' \
  https://api-staging.middleware.winerim.wine/api/onboarding/test
```

3. Validar preflight de cambios de estado:

```sh
curl -i -X OPTIONS \
  -H 'Origin: https://staging.middleware.winerim.wine' \
  -H 'Access-Control-Request-Method: PATCH' \
  https://api-staging.middleware.winerim.wine/api/onboarding/requests/11111111-1111-1111-1111-111111111111
```

4. Abrir `https://staging.middleware.winerim.wine/onboarding`.
5. Confirmar que Access solicita login.
6. Entrar con usuario interno permitido.
7. Probar payload incompleto y confirmar que solo devuelve validaciones.
8. Abrir `https://staging.middleware.winerim.wine/onboarding/requests`.
9. Confirmar que, con storage apagado, muestra que la bandeja no esta activada.
10. Probar Agora de baja criticidad o entorno de pruebas.
11. Probar REVO solo con tenant/access token/client-token reales de prueba.

## Activar bandeja de solicitudes en staging

Precondiciones:

- Access activo en UI y API, o validacion equivalente de identidad en Worker.
- Migracion `20260615073500_onboarding_requests.sql` aplicada solo en staging.
- Secret del Worker configurado:

```sh
npx wrangler secret put LOVABLE_CLOUD_SERVICE_KEY --config wrangler.middleware.toml --env staging
```

- Variable `LOVABLE_CLOUD_REST_URL` configurada en staging con el endpoint REST de Lovable Cloud, sin incluir `/onboarding_requests`.
- `ONBOARDING_REQUESTS_ENABLED=true` solo en staging.
- `CF_ACCESS_AUD` y `CF_ACCESS_TEAM_DOMAIN` configurados si la API esta protegida por Access.

Validacion:

```sh
EXPECT_REQUEST_STORAGE=enabled npm run cf:api:verify:staging
```

Si falla cualquier paso, volver a `ONBOARDING_REQUESTS_ENABLED=false`.

## Rollback

- Si API staging falla: quitar Custom Domain o ruta `api-staging.middleware.winerim.wine/*`; usar temporalmente `workers.dev`.
- Si Pages staging falla: desactivar deployment o quitar dominio `staging.middleware.winerim.wine`.
- Si Access bloquea demasiado: desactivar temporalmente la app Access de staging, no tocar produccion.
- No hay rollback de datos porque esta fase no escribe en Lovable Cloud, POS ni Winerim.
