# Secret storage model

## Objetivo
Separar credenciales reales de las solicitudes comerciales.

El onboarding comercial puede validar una conexion, pero no debe guardar tokens POS/Winerim en claro ni convertir automaticamente una solicitud en `pos_connections`.

## Estado actual
- `onboarding_requests.secret_refs` existe, pero se guarda como `{}`.
- `normalized_input` solo guarda booleanos como `posAuthProvided` y `winerimAuthProvided`.
- El Worker bloquea/recorta detalles tecnicos y redacciona secretos conocidos.
- `LOVABLE_CLOUD_SERVICE_KEY` debe ser un secret del Worker, nunca variable Vite ni archivo del repo.

## Opciones

### Opcion A - Cloudflare Secrets Store
Wrangler expone Secrets Store como open beta:

```sh
npx wrangler secrets-store store list
npx wrangler secrets-store store create winerim-middleware-staging
npx wrangler secrets-store secret create <store-id>
```

Ventajas:
- queda dentro de Cloudflare;
- encaja con Workers;
- permite referencias opacas en `secret_refs`.

Riesgos:
- open beta;
- hay que cerrar permisos, rotacion y naming antes de usarlo para clientes reales.

### Opcion B - Gestor externo de secretos
Guardar tokens en un gestor externo y persistir solo referencias en `onboarding_requests.secret_refs`.

Ventajas:
- control de permisos y auditoria fuera del runtime;
- mas portable si la infraestructura cambia.

Riesgos:
- nueva dependencia operativa;
- mas trabajo de integracion.

### Opcion C - Cifrado de aplicacion
Cifrar tokens antes de guardarlos en Lovable Cloud, con clave fuera de la base.

Ventajas:
- menos piezas externas;
- buena experiencia para conversion tecnica.

Riesgos:
- hay que disenar rotacion de claves;
- un error podria acabar guardando secretos recuperables en una tabla operacional.

## Decision actual
No elegir todavia storage real para tokens.

Mantener:

- `secret_refs={}`;
- `ONBOARDING_REQUESTS_ENABLED=false` hasta Access + storage staging;
- conversion manual a `pos_connections` tras revision tecnica.

## Contrato futuro de `secret_refs`
Cuando se elija storage, usar referencias opacas, por ejemplo:

```json
{
  "posAuthRef": "cfss://winerim-middleware-staging/agora/casa-demo/pos-auth",
  "winerimAuthRef": "cfss://winerim-middleware-staging/agora/casa-demo/winerim-auth",
  "revoClientAuthRef": "cfss://winerim-middleware-staging/revo/hotel-demo/client-auth"
}
```

No usar claves con:

- `token`;
- `secret`;
- `password`;
- `credential`;
- `api_key`;
- `api-key`.

La migracion `20260615073500_onboarding_requests.sql` bloquea esas claves en JSON para reducir fugas accidentales.
