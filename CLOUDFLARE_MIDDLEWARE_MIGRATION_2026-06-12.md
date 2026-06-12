# Cloudflare Middleware Migration — 2026-06-12

> Objetivo: convertir el middleware TPV en un producto operable por equipo, sin depender del panel de Lovable Cloud ni de una unica persona para publicar cambios.

## Hechos

- El dominio objetivo para la interfaz operativa es `middleware.winerim.wine`.
- El subdominio objetivo para API es `api.middleware.winerim.wine`.
- Se crea un scaffold inicial de Cloudflare:
  - Worker: `cloudflare/workers/middleware-api/src/index.ts`.
  - Config: `wrangler.middleware.toml`.
  - Front comercial: `/onboarding`.
- Runbook DNS/Access creado: `cloudflare/dns-access/README.md`.
- Worker staging desplegado y validado:
  - Servicio: `winerim-middleware-api-staging`.
  - URL temporal funcional: `https://winerim-middleware-api-staging.gugocreative.workers.dev`.
  - Version ID: `21976e01-4065-4c09-ae5f-6f91d1e7b0c9`.
- `api-staging.middleware.winerim.wine` esta declarado como ruta Worker, pero todavia no resuelve DNS.
- El primer endpoint Cloudflare es deliberadamente no destructivo:
  - `GET /health`.
  - `POST /api/onboarding/test`.
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
- La interfaz `/onboarding` esta pensada para equipo comercial:
  - POS;
  - restaurante;
  - URL POS / base API;
  - token POS;
  - campos especificos REVO (`tenant`, access token, client-token);
  - token Winerim;
  - boton `Probar`;
  - estado por semaforos.

## Decisiones

- Cloudflare sera el control plane objetivo para interfaz, Workers, colas, crons, Access y dominio.
- La base de datos principal debe seguir siendo Postgres gestionado, no D1, porque el middleware depende de relaciones, SQL operativo, auditoria y volumen multi-tenant.
- Lovable Cloud no se apaga todavia: queda como produccion actual mientras Cloudflare se valida en staging/canary.
- La primera pieza Cloudflare es solo onboarding/test comercial; las escrituras quedan fuera hasta tener dry-run, rollback y revision tecnica.
- La UI comercial no debe exponer colas, XML, stockIds, logs crudos ni configuracion avanzada.
- Cloudflare Pages no se despliega hasta tener Cloudflare Access configurado para staging.

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
- [x] Documentar DNS/Access staging en `cloudflare/dns-access/README.md`.
- [x] Crear Worker staging funcional en `workers.dev`.
- [x] Validar `GET /health` y validacion negativa de `/api/onboarding/test`.
- [ ] Configurar Cloudflare Access para `middleware.winerim.wine`.
- [ ] Crear proyecto Cloudflare Pages para frontend.
- [ ] Resolver DNS/Custom Domain para `api-staging.middleware.winerim.wine`.

### Fase 2 — Staging conectado
- [ ] Provisionar Postgres staging.
- [ ] Definir variables y secrets por entorno.
- [ ] Conectar Worker a Postgres con Hyperdrive o conexion TCP directa.
- [ ] Migrar lectura de `pos_connections` para staging.
- [ ] Crear tabla/flujo de solicitudes de integracion comercial.

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

- La copia original local puede estar por detras de cambios recientes del repo oficial; para esta fase se valido una rama limpia desde `main`.
- `api-staging.middleware.winerim.wine` requiere DNS/Custom Domain antes de usarse como URL estable.
- Cloudflare Pages debe quedar detras de Access antes de abrirlo al equipo.
- La API comercial no debe registrar tokens en logs. Mantener outputs sanitizados.
- No activar escritura ni cron desde Cloudflare hasta tener staging y canary verificados.
