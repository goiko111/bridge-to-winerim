# PROJECT_CONTEXT

> Fuente de verdad sobre **qué es** este proyecto. Cambia poco. Solo hechos estructurales.

## 1. Qué es
**Winerim TPV Integrations Middleware**: proxy multi-tenant que conecta Winerim (gestión de vinos) con múltiples sistemas POS (Agora, BDP NET, Revo XEF, Toast, Numier, Clover, Simphony, ICG, HIOPOS, TCPOS Kumo, Square, Cassa in Cloud).

Flujo principal:
- **Catálogo (one-way)**: Winerim → POS (precios, productos).
- **Ventas (one-way)**: POS → Winerim (deducción absoluta de stock).
- Aislamiento estricto por `connection_id`.

## 2. Stack
- **Frontend**: React 18 + Vite 5 + Tailwind v3 + TypeScript 5 + shadcn/ui.
- **Backend**: Lovable Cloud (Supabase) — Postgres, Auth, Storage, Edge Functions (Deno/SWC).
- **Cron**: `pg_cron` + `pg_net` invocando dispatchers HTTP.
- **AI**: Lovable AI Gateway cuando aplique.

## 3. Arquitectura clave
- Cada POS tiene su `*-proxy` edge function + hook `use*Connection.ts`.
- Tabla central: `pos_connections` (con `circuit_breaker_paused_until`, credenciales cifradas).
- Tareas asíncronas en cola `outbound_tasks` (idempotente, con reintentos).
- Dispatcher común para Agora: `agora-cron-dispatcher` (chunks de 10, 1.5s entre chunks).
- Agora opera en automático sobre días cerrados (`Invoices`): guardar ventas y descontar stock Winerim son un único flujo operativo. El cursor `last_business_day_synced` no debe avanzar si el stock del día no queda confirmado.
- En Agora, `product_mappings.REJECTED` es un bloqueo explícito de resolución: tiene prioridad sobre `winerim_push_tracking` histórico para evitar que productos antiguos sigan descontando stock contra vinos/variantes inaccesibles.
- En Agora, los productos Winerim vendibles deben ir como `UseAsDirectSale=false` + `SaleableAsMain=true`: no salen como botones raíz, pero sí se venden dentro de su familia. `PreparationTypeId` y `PreparationOrderId` deben ir ambos vacíos o ambos informados.
- Algunas conexiones Agora pueden conservar una estructura visual legacy con reglas en `pos_connections.provider_config.agora_family_routing_rules` para enrutar por formato/tipo/región a familias existentes del TPV.
- Matching POS -> Winerim: cuando el nombre del POS o de Winerim trae código comercial exacto (`T31`, `B303`, `G801`, `MAGNUM21`), ese código tiene prioridad sobre fuzzy. No interpretar números sin separador como código (`Magnum 4 Kilos`, `As 2 Ladeiras`).

## 4. Reglas duras (no romper)
- Proxies leen `await req.json()` **una sola vez**.
- IPs requieren prefijo `http://`.
- Roles SIEMPRE en tabla separada `user_roles` con `has_role()` SECURITY DEFINER.
- NUNCA editar `src/integrations/supabase/{client,types}.ts` ni `.env`.
- Agora `/api/export-master/?filter=Products` SOLO vía `fetchAgoraProductsXmlCached`.
- Toda llamada saliente Agora pasa por `fetchWithRetry` (rate limit 2 req/s/conexión + circuit breaker).
- Comunicación al usuario: "Lovable Cloud" / "backend", nunca "Supabase".

## 5. Documentos de sesión (protocolo)
- `PROJECT_CONTEXT.md` — este archivo. Estructural, cambia poco.
- `CURRENT_STATE.md` — estado vivo: qué funciona, qué está roto, hipótesis abiertas.
- `DECISIONS_LOG.md` — append-only. Decisiones con fecha y razón.
- `NEXT_STEPS.md` — tareas pendientes priorizadas para la próxima sesión.

Separar siempre: **Hechos | Decisiones | Hipótesis | Tareas**.

## 6. Referencias técnicas locales
- Winerim API Token v2: `/Users/GOIKO/Downloads/API_TOKEN_V2_DOCUMENTATION.html` (v2.0.1, última actualización indicada en el HTML: julio 2025).
