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
3. Si la prueba queda lista para revision, una accion posterior guardara:
   - metadata sanitizada en `onboarding_requests`;
   - referencias a secretos en `secret_refs`, si ya existe secret storage;
   - estado `READY_FOR_TECHNICAL_REVIEW`.
4. Tecnico revisa familias, legacy, mappings, dry-run y alcance.
5. Solo tras aprobar se crea `pos_connections`.

## Pendiente antes de activar escritura
- Elegir secret storage real para tokens:
  - Cloudflare Secrets Store, si encaja con el modelo multi-tenant;
  - cifrado de aplicacion con clave fuera de la base;
  - gestor externo de secretos.
- Conectar Worker a Postgres staging.
- Implementar `POST /api/onboarding/requests` solo tras tener autenticacion/Access y secreto de escritura.
- Añadir auditoria de conversion `onboarding_request -> pos_connection`.
