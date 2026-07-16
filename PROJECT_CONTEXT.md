# PROJECT_CONTEXT

> Fuente de verdad sobre **qué es** este proyecto. Cambia poco. Solo hechos estructurales.

## 1. Qué es
**Winerim TPV Integrations Middleware**: proxy multi-tenant que conecta Winerim (gestión de vinos) con múltiples sistemas POS (Agora, BDP NET, Revo XEF, Toast, Numier, Clover, Simphony, ICG, HIOPOS, TCPOS Kumo, Square, Cassa in Cloud) y puede enlazar sistemas auxiliares de operaciones/contabilidad como tSpoonLab, Yurest y Holded.

Flujo principal:
- **Catálogo (one-way)**: Winerim → POS (precios, productos).
- **Ventas (one-way)**: POS → Winerim (deducción absoluta de stock).
- **Operaciones auxiliares**: tSpoonLab o Yurest pueden aportar escandallos, costes, compras, almacenes e inventario; Holded actúa como destino contable de las ventas cerradas procedentes del POS. Ninguno sustituye al POS como fuente de la venta.
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
- Agora puede activar por conexión un piloto casi en tiempo real leyendo tickets abiertos (`/api/export/tickets/`) cada pocos minutos. `Invoices` sigue siendo la reconciliación definitiva para evitar pérdidas si el TPV estuvo apagado o inaccesible.
- Las fechas de línea de Agora sin sufijo de zona horaria se interpretan en `provider_config.sales_timezone` para filtros de antigüedad y ventanas operativas. Las fechas con `Z` u offset explícito se comparan como instantes absolutos.
- En Agora, la deducción normal de ventas contra Winerim usa `PUT /api/v2/stock/{stockId}` con stock absoluto por variante. Si el stock no se mueve porque ya estaba a `0`, se usa `POST /api/v2/sales/import` para registrar historial de venta sin modificar inventario y con `orderId` idempotente.
- `sales_events` y `sales_line_items` de Agora son snapshots reemplazables; `stock_sync_log` es evidencia duradera. Nunca se pueden borrar/reinsertar líneas sin conservar previamente los claims de stock/venta, y su FK debe usar `ON DELETE SET NULL`, no `CASCADE`.
- Los históricos anteriores a la activación se importan exclusivamente por `POST /api/v2/sales/import`, con `orderId` determinista, sin tocar stock y solo mediante mapping confirmado, nombre exacto único o alias manual auditado. El fuzzy matching solo propone revisión; nunca escribe.
- En Agora, `product_mappings.REJECTED` es un bloqueo explícito de resolución: tiene prioridad sobre `winerim_push_tracking` histórico para evitar que productos antiguos sigan descontando stock contra vinos/variantes inaccesibles.
- En Agora, los productos Winerim vendibles deben ir como `UseAsDirectSale=false` + `SaleableAsMain=true`: no salen como botones raíz, pero sí se venden dentro de su familia. `PreparationTypeId` y `PreparationOrderId` deben ir ambos vacíos o ambos informados.
- Algunas conexiones Agora pueden conservar una estructura visual legacy con reglas en `pos_connections.provider_config.agora_family_routing_rules` para enrutar por formato/tipo/región a familias existentes del TPV.
- La base tSpoonLab/Holded comienza en modo `read_only`: no se habilitan escrituras hasta persistir claves idempotentes, completar un `dry-run` y validar un canary con reversión.
- La integración Yurest V2 comienza en modo `read_only`, exige aislamiento por `store_id` y resuelve usuario, contraseña y token de proveedor desde secretos de Lovable Cloud; nunca desde `provider_config` ni desde el repositorio.
- En menús/armonías, el consumo de vino debe usar una instantánea versionada de la composición aplicable al momento de la venta. Nunca recalcular una venta histórica usando solo la receta actual.
- En Agora, las conexiones que necesiten mantener orden comercial por código pueden activar `provider_config.agora_product_sort_mode="COMMERCIAL_CODE_NUMERIC"`. El orden usa códigos explícitos de nombre (`T501`, `B437`, `E516`, `D709`, `G801`, `MAGNUM21`) y solo debe cambiar `Order`, no IDs, precios, familias ni visibilidad.
- Matching POS -> Winerim: cuando el nombre del POS o de Winerim trae código comercial exacto (`T31`, `B303`, `G801`, `MAGNUM21`), ese código tiene prioridad sobre fuzzy. No interpretar números sin separador como código (`Magnum 4 Kilos`, `As 2 Ladeiras`).
- Una mutación de catálogo Agora no se considera correcta solo porque `/api/import/` responda sin error: familia, producto, visibilidad y atributos críticos deben confirmarse mediante una lectura fresca posterior del catálogo.
- Las auditorías de cobertura de catálogo resuelven primero `product_mappings` confirmados y reglas específicas de la conexión; los IDs deterministas por formato son únicamente el fallback. Esto evita falsos huecos en instalaciones con botones consolidados, como los dulces ordenados de Sa Pedrera.
- Los nombres enviados a Agora deben ser únicos y estables por conexión. Cuando dos variantes colisionan, se usa primero la añada y después el identificador Winerim como desambiguador; un mapping ya confirmado conserva el nombre exacto enviado anteriormente.
- La auditoría intradía de Agora separa dos planos: idempotencia del runtime y conciliación histórica. La primera se valida con claves exactas de `stock_sync_log` y canaries observados durante varios ciclos; las diferencias agregadas entre facturas Agora e historial ERP se tratan como deuda de conciliación y nunca autorizan borrados automáticos.

## 4. Reglas duras (no romper)
- Proxies leen `await req.json()` **una sola vez**.
- IPs requieren prefijo `http://`.
- Roles SIEMPRE en tabla separada `user_roles` con `has_role()` SECURITY DEFINER.
- NUNCA editar `src/integrations/supabase/{client,types}.ts` ni `.env`.
- Agora `/api/export-master/?filter=Products` SOLO vía `fetchAgoraProductsXmlCached`.
- Toda llamada saliente Agora pasa por `fetchWithRetry` (rate limit 2 req/s/conexión + circuit breaker).
- Un backfill histórico no puede llamar a `PUT /stock/*`, reactivar vinos ni inventar variantes. Debe omitir filas fraccionarias o sin `stockId` accesible y documentarlas para revisión.
- Comunicación al usuario: "Lovable Cloud" / "backend", nunca "Supabase".

## 5. Documentos de sesión (protocolo)
- `PROJECT_CONTEXT.md` — este archivo. Estructural, cambia poco.
- `CURRENT_STATE.md` — estado vivo: qué funciona, qué está roto, hipótesis abiertas.
- `DECISIONS_LOG.md` — append-only. Decisiones con fecha y razón.
- `NEXT_STEPS.md` — tareas pendientes priorizadas para la próxima sesión.

Separar siempre: **Hechos | Decisiones | Hipótesis | Tareas**.

## 6. Referencias técnicas locales
- Winerim API Token v2: `/Users/GOIKO/Downloads/API_TOKEN_V2_DOCUMENTATION.html` (v2.0.1, última actualización indicada en el HTML: julio 2025).

## 7. Criterio único de estado para una integración Agora
- `CATALOG_READY`: conexión fresh, catálogo Winerim elegible publicado y verificado por lectura fresh, sin huecos reales ni cola operativa pendiente.
- `LIVE`: además de `CATALOG_READY`, ventas recientes llegan desde Agora a Winerim con mapping correcto y el comportamiento de stock activo/inactivo está validado.
- `100%_SIGNED_OFF`: además de `LIVE`, existe evidencia reciente de botella y copa, altas y cambios de precio automáticos, ocultación/reactivación, idempotencia, recuperación tras caída, alertas limpias y aceptación visual/operativa del cliente.
- Una conexión no se denomina `100%` por tener solo el catálogo completo. Los criterios no aplicables requieren razón documentada; la ausencia de evidencia no equivale a `PASS`.
- La lectura de tickets abiertos es opcional según soporte del Agora local. Las facturas cerradas y su reconciliación son obligatorias.
- Las conexiones desactivadas se informan como `NOT_ACTIVE`; no se consideran fallos por no tener flags intradía ni se deben activar como efecto secundario de una auditoría.
