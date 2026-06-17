# Onboarding request storage

## Objetivo
Guardar solicitudes comerciales de integracion sin convertirlas automaticamente en conexiones productivas.

La tabla preparada es `public.onboarding_requests`.

## Principios
- No guardar tokens POS ni tokens Winerim en claro.
- No crear `pos_connections` desde el flujo comercial.
- No activar escrituras ni ocultacion legacy desde onboarding.
- Guardar solo metadatos sanitizados y resultado de semaforos.
- Cualquier conversion a conexion real requiere revision tecnica, dry-run y rollback.

## Datos permitidos
- `provider`
- `location_name`
- `pos_base_url`
- `normalized_input` sanitizado:
  - proveedor;
  - restaurante;
  - URL/base API;
  - tenant REVO si aplica;
  - flags booleanos de credenciales aportadas.
- `test_gates` sin `technicalDetail`.
- `test_summary`.
- `secret_refs`, solo referencias externas, nunca valores secretos.
  - usar nombres neutros como `posAuthRef`, `winerimAuthRef` o `revoClientAuthRef`;
  - no usar claves con `token`, `secret`, `password`, `credential` ni `api_key`.

## Datos prohibidos
No insertar en `normalized_input`, `test_gates` ni `test_summary` claves que contengan:

- `token`
- `secret`
- `password`
- `credential`
- `api_key` / `api-key`

La migracion añade una funcion/check para bloquear estas claves.

Tambien valida que `normalized_input`, `test_summary` y `secret_refs` sean objetos JSON, y que `test_gates` sea un array.

## Flujo previsto
1. Comercial completa `/onboarding`.
2. Worker ejecuta `POST /api/onboarding/test`.
3. Si la prueba queda lista para revision, `POST /api/onboarding/requests` puede guardar:
   - metadata sanitizada en `onboarding_requests`;
   - `secret_refs` vacio por ahora, hasta elegir secret storage;
   - estado `READY_FOR_TECHNICAL_REVIEW`.
4. Tecnico revisa familias, legacy, mappings, dry-run y alcance.
5. Solo tras aprobar se crea `pos_connections`.

## Endpoint Worker
`POST /api/onboarding/requests` existe, pero queda apagado por defecto.

Variables/secretos necesarios para activarlo:

- `ONBOARDING_REQUESTS_ENABLED=true`
- `ONBOARDING_REQUESTS_REQUIRE_ACCESS_EMAIL=true`
- `CF_ACCESS_AUD` si la API esta detras de Cloudflare Access
- `CF_ACCESS_TEAM_DOMAIN` si `CF_ACCESS_AUD` esta configurado
- `LOVABLE_CLOUD_REST_URL`
- `LOVABLE_CLOUD_SERVICE_KEY` como secret del Worker, nunca en Vite ni en repositorio

Comportamiento:

- exige identidad de Cloudflare Access;
- si `CF_ACCESS_AUD` esta configurado, valida `CF-Access-Jwt-Assertion` con firma y audience;
- si `CF_ACCESS_AUD` no esta configurado, usa `CF-Access-Authenticated-User-Email`;
- valida de nuevo el formulario;
- no llama al POS ni a Winerim;
- no crea `pos_connections`;
- no guarda tokens en claro;
- redacts valores secretos conocidos si apareciesen accidentalmente en detalles de semaforos;
- inserta solo una fila sanitizada para revision tecnica.

## Pendiente antes de activarlo en staging
- Elegir secret storage real para tokens:
  - Cloudflare Secrets Store, si encaja con el modelo multi-tenant;
  - cifrado de aplicacion con clave fuera de la base;
  - gestor externo de secretos.
- Conectar Worker a Postgres staging mediante `LOVABLE_CLOUD_REST_URL` + `LOVABLE_CLOUD_SERVICE_KEY`.
- Probar con Access real que el email llega al Worker.
- Mantener `ONBOARDING_REQUESTS_ENABLED=false` en produccion hasta completar canary.
- Añadir auditoria de conversion `onboarding_request -> pos_connection`.
