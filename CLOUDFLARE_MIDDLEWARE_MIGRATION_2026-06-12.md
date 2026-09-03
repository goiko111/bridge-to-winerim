# Cloudflare Middleware Migration — 2026-06-12

> Objetivo: convertir el middleware TPV en un producto operable por equipo, sin depender del panel de Lovable Cloud ni de una unica persona para publicar cambios.

## Hechos

- El dominio objetivo para la interfaz operativa es `middleware.winerim.wine`.
- El subdominio objetivo para API es `api.middleware.winerim.wine`.
- El sistema actual en Lovable Cloud sigue funcionando y no se sustituye hasta completar staging/canary.
- Runbook de staging: `CLOUDFLARE_STAGING_RUNBOOK_2026-06-30.md`.
- Se crea un scaffold inicial de Cloudflare:
  - Worker: `cloudflare/workers/middleware-api/src/index.ts`.
  - Config: `wrangler.middleware.toml`.
  - Front comercial: `/onboarding`.
- El primer endpoint Cloudflare es deliberadamente no destructivo:
  - `GET /health`.
  - `POST /api/onboarding/test`.
  - `POST /api/onboarding/requests` protegido por token interno.
  - `GET /api/checklist?provider=agora|revo`.
  - `GET /api/agora/fleet` protegido por token interno.
  - `GET /api/connections/:connectionId/notification-contacts` protegido por token interno.
- `POST /api/onboarding/test`:
  - valida campos;
  - normaliza URL POS con `http://` si falta;
  - prueba token Winerim;
  - prueba alcance basico de Agora;
  - prueba REVO con `tenant`, `Authorization: Bearer <access-token>` y `client-token`;
  - no guarda tokens;
  - no crea conexiones;
  - no escribe productos;
  - no oculta legacy;
  - devuelve semaforos para revision tecnica.
- `POST /api/onboarding/requests`:
  - requiere `MIDDLEWARE_ADMIN_TOKEN`;
  - guarda solo solicitudes sanitizadas en `integration_onboarding_requests`;
  - no persiste token POS, token Winerim, client-token REVO ni webhook secrets;
  - deja la solicitud en `DRAFT` o `READY_FOR_TECHNICAL_REVIEW`.
- La interfaz `/onboarding` esta pensada para equipo comercial:
  - POS;
  - restaurante;
  - URL POS / base API;
  - token POS;
  - campos especificos REVO (`tenant`, access token, client-token);
  - token Winerim;
  - boton `Probar`;
  - estado por semaforos.
- La interfaz operativa añade:
  - `/checklist`: protocolo obligatorio/opcional por proveedor.
  - `/agora-fleet`: estado read-only de conexiones Agora, sin acciones destructivas.
- La API propia ya tiene una primera lectura backend de flota Agora (`GET /api/agora/fleet`) para ir retirando lecturas directas desde React contra Lovable Cloud.

## Variables y secrets Worker

Variables no secretas:

```txt
ENVIRONMENT
RELEASE
ALLOWED_ORIGIN
LOVABLE_CLOUD_URL
```

Secrets obligatorios para endpoints internos:

```txt
LOVABLE_SERVICE_ROLE_KEY
MIDDLEWARE_ADMIN_TOKEN
```

Notas:

- `LOVABLE_SERVICE_ROLE_KEY` nunca debe enviarse al frontend ni guardarse en archivos.
- `MIDDLEWARE_ADMIN_TOKEN` protege endpoints internos mientras no se complete Cloudflare Access/JWT.
- Si `MIDDLEWARE_ADMIN_TOKEN` no esta configurado, los endpoints internos devuelven `ADMIN_TOKEN_NOT_CONFIGURED`.
- Los contactos de cliente/SAT se leen por Worker seguro, no directamente desde la UI con clave publica.
- Las solicitudes de onboarding se guardan por Worker seguro; el navegador no debe recibir `MIDDLEWARE_ADMIN_TOKEN`.

## Decisiones

- Cloudflare sera el control plane objetivo para interfaz, Workers, colas, crons, Access y dominio.
- La base de datos principal debe seguir siendo Postgres gestionado, no D1, porque el middleware depende de relaciones, SQL operativo, auditoria y volumen multi-tenant.
- Lovable Cloud no se apaga todavia: queda como produccion actual mientras Cloudflare se valida en staging/canary.
- La primera pieza Cloudflare es solo onboarding/test comercial; las escrituras quedan fuera hasta tener dry-run, rollback y revision tecnica.
- La UI comercial no debe exponer colas, XML, stockIds, logs crudos ni configuracion avanzada.

## Arquitectura objetivo

```txt
middleware.winerim.wine
  Cloudflare Pages
  Interfaz comercial + operativa
  Cloudflare Access

api.middleware.winerim.wine
  Cloudflare Workers
  API de onboarding, proxies, acciones tecnicas

Cloudflare Queues
  outbound catalog
  sales import
  stock sync
  maintenance/rescue

Cloudflare Cron Triggers
  dispatchers programados con jitter

Durable Objects / Rate limiting
  rate limit y circuit breaker por connection_id

Postgres gestionado
  pos_connections
  outbound_tasks
  sales_events / sales_line_items
  stock_sync_log
  provider_products / product_mappings
  winerim_wines
```

## Roles

### Comercial
- Crear una integracion.
- Introducir URL, token POS y token Winerim.
- Lanzar prueba.
- Ver mensajes accionables.
- Solicitar revision tecnica.

### Tecnico
- Revisar master data.
- Auditar legacy.
- Configurar familias y mappings.
- Ejecutar dry-run.
- Activar escrituras.
- Revisar colas, breakers y logs.

### Admin/Ops
- Gestionar secrets.
- Publicar releases.
- Revertir despliegues.
- Gestionar Cloudflare Access.
- Revisar metricas globales.

## Plan de migracion

### Fase 1 — Control plane sin riesgo
- [x] Crear scaffold Worker Cloudflare.
- [x] Crear endpoint no destructivo de onboarding/test.
- [x] Crear interfaz `/onboarding`.
- [x] Configurar scripts `cf:api:*`.
- [x] Ajustar onboarding REVO a requisitos reales: tenant + access token + client-token.
- [x] Documentar setup de Pages en `cloudflare/pages/README.md`.
- [x] Crear checklist operativo en UI/API.
- [x] Crear primera vista read-only `/agora-fleet`.
- [x] Crear migracion protegida para contactos de alerta.
- [x] Preparar endpoint Worker protegido para contactos de alerta.
- [x] Crear migracion protegida para solicitudes de onboarding.
- [x] Preparar endpoint Worker protegido para persistir solicitudes sanitizadas.
- [x] Crear runbook de staging y smoke test sin impacto productivo.
- [ ] Configurar Cloudflare Access para `middleware.winerim.wine`.
- [ ] Crear proyecto Cloudflare Pages para frontend.
- [ ] Crear Worker staging en `api-staging.middleware.winerim.wine`.

### Fase 2 — Staging conectado
- [ ] Provisionar Postgres staging.
- [ ] Definir variables y secrets por entorno.
- [ ] Conectar Worker a Postgres con Hyperdrive o conexion TCP directa.
- [ ] Migrar lectura de `pos_connections` para staging.
- [x] Crear tabla/flujo base de solicitudes de integracion comercial sin secretos.
- [ ] Aplicar y verificar solicitudes de integracion comercial en staging.

### Fase 3 — Canary Agora
- [ ] Portar prueba Agora completa.
- [ ] Portar lectura master data Agora.
- [ ] Portar fetch catalog Winerim.
- [ ] Hacer canary con una conexion no critica.
- [ ] Mantener escrituras apagadas hasta post-write controlado.

### Fase 4 — Operacion real
- [ ] Migrar colas a Cloudflare Queues o mantener Postgres queue con workers.
- [ ] Migrar crons a Cloudflare Cron Triggers.
- [ ] Implementar circuit breaker por conexion.
- [ ] Implementar panel Fleet Status.
- [ ] Migrar clientes por lotes.

## Validacion inicial local

Comandos previstos:

```sh
npm test -- --run src/test/middlewareOnboarding.test.ts
npm test -- --run src/test/integrationChecklist.test.ts src/test/agoraFleetStatus.test.ts
npm run build
npm run cf:api:dev
```

## Rollback

- No hay impacto en produccion actual.
- Para revertir esta primera fase basta con retirar:
  - `cloudflare/workers/middleware-api/src/index.ts`;
  - `wrangler.middleware.toml`;
  - ruta `/onboarding`;
  - scripts `cf:api:*`;
  - `src/lib/middlewareOnboarding.ts`;
  - `src/test/middlewareOnboarding.test.ts`.
- Lovable Cloud y los clientes actuales no dependen de estos archivos.

## Riesgos

- La copia local actual puede estar por detras de cambios recientes del repo oficial. Antes de desplegar hay que reconciliar con `main`.
- La CLI local de Wrangler se queda esperando en esta copia; no hay despliegue Cloudflare realizado desde este entorno.
- La API comercial no debe registrar tokens en logs. Mantener outputs sanitizados.
- No activar escritura ni cron desde Cloudflare hasta tener staging y canary verificados.
