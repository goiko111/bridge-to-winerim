# Cloudflare Access checklist

## Objetivo
Proteger el panel `staging.middleware.winerim.wine` y las rutas privadas de API antes de que el equipo comercial o tecnico use el onboarding fuera de Lovable Cloud.

## Aplicaciones Access necesarias

### UI staging
- Name: `Winerim Middleware Staging UI`
- Domain: `staging.middleware.winerim.wine`
- Policy: permitir solo usuarios internos de Winerim.
- Session duration: corto para staging, por ejemplo 8 horas.
- Logs: activados.

### API staging
- Name: `Winerim Middleware Staging API`
- Domain: `api-staging.middleware.winerim.wine`
- Policy: permitir solo usuarios internos de Winerim.
- Header/JWT: copiar el `Audience Tag`.

La API puede mantener `/api/onboarding/test` abierta solo durante pruebas tecnicas, pero `GET/POST/PATCH /api/onboarding/requests` no deben activarse sin identidad Access validada.

## Variables Worker
Cuando exista la app Access de API staging:

```txt
CF_ACCESS_AUD=<Audience Tag de Winerim Middleware Staging API>
CF_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
```

Configurar estas variables solo en `env.staging` al principio.

El Worker valida `CF-Access-Jwt-Assertion` si `CF_ACCESS_AUD` existe. Si el JWT no es valido, responde:

```json
{"success":false,"error":"ACCESS_IDENTITY_REQUIRED"}
```

## Validacion manual

1. Abrir `https://staging.middleware.winerim.wine/onboarding`.
2. Confirmar login de Access.
3. Entrar con usuario interno permitido.
4. Probar un payload incompleto en Agora o REVO.
5. Confirmar que no se crea conexion ni se guarda solicitud si `ONBOARDING_REQUESTS_ENABLED=false`.
6. Abrir `https://staging.middleware.winerim.wine/onboarding/requests`.
7. Confirmar mensaje de bandeja no activada.

## Validacion API

Sin sesion/JWT, con storage activo, la API privada debe rechazar:

```sh
curl -i https://api-staging.middleware.winerim.wine/api/onboarding/requests
```

Esperado:

- HTTP `401`;
- `ACCESS_IDENTITY_REQUIRED`;
- cero llamadas a storage.

Desde navegador autenticado, el preflight debe permitir credenciales y `PATCH`:

```sh
curl -i -X OPTIONS \
  -H 'Origin: https://staging.middleware.winerim.wine' \
  -H 'Access-Control-Request-Method: PATCH' \
  https://api-staging.middleware.winerim.wine/api/onboarding/requests/11111111-1111-1111-1111-111111111111
```

Esperado:

- `access-control-allow-origin: https://staging.middleware.winerim.wine`;
- `access-control-allow-credentials: true`;
- `access-control-allow-methods` contiene `PATCH`.

## Rollback Access
- Si Access bloquea demasiado, apagar primero `ONBOARDING_REQUESTS_ENABLED`.
- Despues ajustar politica Access.
- No quitar el bloqueo de Access para compensar un problema de CORS.
- No activar Pages publica sin Access.
