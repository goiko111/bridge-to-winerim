# Cloudflare DNS and Access runbook

## Objetivo
Activar staging bajo dominios de `winerim.wine` sin tocar produccion Lovable Cloud:

- UI staging: `staging.middleware.winerim.wine`
- API staging: `api-staging.middleware.winerim.wine`
- UI produccion futura: `middleware.winerim.wine`
- API produccion futura: `api.middleware.winerim.wine`

## Estado actual
- Worker staging desplegado: `winerim-middleware-api-staging`.
- URL temporal funcional: `https://winerim-middleware-api-staging.gugocreative.workers.dev`.
- Ruta Worker declarada en `wrangler.middleware.toml`: `api-staging.middleware.winerim.wine/*`.
- Bloqueo actual: `api-staging.middleware.winerim.wine` no resuelve DNS.
- Cloudflare Pages no esta desplegado todavia.

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

Aplicar Access sobre la UI staging:

1. Cloudflare Zero Trust -> Access -> Applications.
2. Add an application -> Self-hosted.
3. Name: `Winerim Middleware Staging`.
4. Application domain: `staging.middleware.winerim.wine`.
5. Policy: Allow internal Winerim users.
6. Include: emails o dominio corporativo validado por el equipo.
7. Activar logs de acceso.

Importante: no proteger `api-staging.middleware.winerim.wine` con Access todavia si la UI llama a la API desde el navegador. Si se protege tambien la API, el Worker debe validar/aceptar el token de Access y la configuracion CORS debe permitir ese flujo. El endpoint actual no escribe ni guarda tokens, por lo que puede quedar publico temporalmente en staging mientras se implementa autenticacion real para endpoints destructivos.

## Validacion completa

1. `curl -i https://api-staging.middleware.winerim.wine/health`.
2. Abrir `https://staging.middleware.winerim.wine/onboarding`.
3. Confirmar que Access solicita login.
4. Entrar con usuario interno permitido.
5. Probar payload incompleto y confirmar que solo devuelve validaciones.
6. Probar Agora de baja criticidad o entorno de pruebas.
7. Probar REVO solo con tenant/access token/client-token reales de prueba.

## Rollback

- Si API staging falla: quitar Custom Domain o ruta `api-staging.middleware.winerim.wine/*`; usar temporalmente `workers.dev`.
- Si Pages staging falla: desactivar deployment o quitar dominio `staging.middleware.winerim.wine`.
- Si Access bloquea demasiado: desactivar temporalmente la app Access de staging, no tocar produccion.
- No hay rollback de datos porque esta fase no escribe en Lovable Cloud, POS ni Winerim.
