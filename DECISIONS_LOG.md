# DECISIONS_LOG

> Append-only. Una decisión por bloque. Formato: fecha · decisión · razón · alternativa descartada.

---

## 2026-06-04 · Sa Pedrera debe tratar duplicados con política legacy-first, no borrado masivo
- **Decisión**: Para Sa Pedrera, si el cliente quiere mantener su pantalla legacy/regional, la corrección de duplicados debe ser `legacy-first`: cuando exista un producto legacy con mapping `CONFIRMED` para el mismo vino/formato, ocultar el producto publicado desde Winerim; conservar productos Winerim publicados solo donde no haya legacy seguro o donde el cliente quiera explícitamente nombre/formato Winerim.
- **Razón**: Sa Pedrera está configurada en `LEGACY_REGION_ROUTING`, por lo que conviven productos legacy y productos Winerim dentro de familias regionales. El matching no impide por sí solo que se publique un producto Winerim; solo permite que una venta legacy descuente stock. Borrar u ocultar todo Winerim dejaría fuera vinos nuevos o formatos sin legacy.
- **Alternativa descartada**: ocultar todos los Winerim publicados o todos los legacy visibles. Ambas opciones romperían parte de la operativa: la primera perdería vinos nuevos de Winerim; la segunda cambiaría la pantalla que el cliente quiere conservar.

---

## 2026-06-04 · Mantener Sa Vida bloqueada aunque el instalador indique API habilitada
- **Decisión**: No procesar catálogo, ventas, stock ni backlog de Sa Vida hasta que `http://80.32.137.41:8984/api/export-master/?filter=Families` y `Products` devuelvan HTTP 200/XML desde fuera.
- **Razón**: La revalidación profunda posterior al aviso del instalador sigue devolviendo HTTP 501 con el mensaje literal de Agora `La integración a través del API HTTP no está habilitada.` El mismo método funciona en Kava, Cienvinos y Baco, y Sa Vida devuelve 501 antes de validar token, por lo que reactivar colas solo generaría más fallos.
- **Alternativa descartada**: asumir que el módulo está correcto por confirmación verbal/local y limpiar o reintentar el backlog. Si el puerto público apunta a otra instancia o el servicio no recargó configuración, se reabrirían miles de tareas fallidas sin posibilidad de éxito.

---

## 2026-06-04 · Reparación mínima de flota Agora sin tocar stock, precios ni legacy operativo
- **Decisión**: Corregir solo lo que era claramente reversible y verificado: activar visibilidad de las 8 familias Winerim de Cienvinos, resetear breakers obsoletos en conexiones Agora que responden HTTP 200, marcar capacidades `READY/XML_IMPORT/YES` en esas conexiones sanas y bloquear un único `AGORA_HIDE_PRODUCT` de Sa Pedrera que reintentaba con error de duplicado.
- **Razón**: Cienvinos tenía productos correctos pero familias ocultas; era un fallo visual aislado y reversible. Los breakers antiguos eran ruido de monitorización tras comprobar salud real. En Sa Pedrera, el modo híbrido/legacy exige frenar reintentos de ocultación si Agora devuelve duplicados, porque alterar ese layout sin revisión puede romper la operativa del cliente.
- **Alternativa descartada**: reintentar o cerrar en masa todas las tareas `FAILED/BLOCKED` antiguas y tocar productos legacy. Ese camino habría reducido ruido de panel, pero con riesgo de ocultar productos que todavía se venden, reabrir duplicados o dar por resuelto stock no probado.

---

## 2026-06-04 · Auditoría de flota no invasiva y sin declarar "todo sano" en bloque
- **Decisión**: Tratar la revisión del 2026-06-04 como auditoría read-only: documentar hallazgos y próximos pasos, pero no reparar Cienvinos, Sa Pedrera, breakers ni mappings en la misma pasada sin validación específica.
- **Razón**: La auditoría encontró estados delicados que pueden ser intencionados o sensibles para operación real: Baco en rollback legacy, Sa Pedrera híbrida legacy/regional, Cienvinos con familias Winerim ocultas y varios clientes con auto-push pausado por seguridad. Tocar esos estados en bloque podría romper pantallas que el cliente usa hoy.
- **Alternativa descartada**: aplicar reparaciones automáticas inmediatas y comunicar la flota como completamente operativa. Habría riesgo de reabrir duplicados visuales, ocultar legacy necesario o prometer stock/Historial Winerim sin prueba real por conexión.

---

## 2026-06-01 · Auto-push de catálogo Agora debe ser diferencial antes de reactivar `auto_push_verified_ready`
- **Decisión**: Cambiar `winerim-proxy fetch-catalog` para que el auto-push solo evalúe vinos nuevos/no publicados o vinos con cambios reales en campos visibles (`name`, tipo, región, activo, copa y precios por formato), en vez de reencolar todo el lote procesado.
- **Razón**: Katsu, Kava, La Candela, Luruna y Sa Pedrera tienen `auto_push_on_update=true`; reactivar `auto_push_verified_ready` con el runtime anterior habría podido reimportar lotes completos en cada cron, cargando Agora y reabriendo riesgo visual.
- **Alternativa descartada**: reactivar ya las cinco conexiones porque `agora-proxy preview-xml` está corregido. Aún faltaba confirmar `winerim-proxy` desplegado, que es quien decide cuándo encolar updates automáticos.

## 2026-06-01 · Mantener pausado el auto-push verificado hasta redeploy real de Lovable Cloud
- **Decisión**: Dejar `auto_push_verified_ready=false` en Katsu, Kava, La Candela, Luruna y Sa Pedrera hasta que Lovable Cloud ejecute el commit `a180c6c` y `fetch-catalog` devuelva `autoPushResult.reason=no_catalog_changes_detected` o `autoPushResult.differential=true`.
- **Razón**: La prueba live tras el push seguía devolviendo `auto_push_not_verified_no_manual_import_success_yet`, señal del runtime anterior. El estado seguro es que los productos ya publicados funcionen, pero que no se generen nuevos updates automáticos hasta redeploy.
- **Alternativa descartada**: activar la automatización completa inmediatamente. Podía romper lo que acababa de quedar reparado.

## 2026-06-01 · Reparar Cienvinos y desalineaciones residuales sin borrar histórico
- **Decisión**: Reparar por XML los productos Winerim publicados de Cienvinos, Katsu y Sa Pedrera para que queden `UseAsDirectSale=false`, `SaleableAsMain=true` y preparación coherente, conservando IDs y ventas históricas.
- **Razón**: Cienvinos seguía con 428 productos Winerim como botones raíz; Katsu y Sa Pedrera tenían un producto verificado residual fuera de contrato. Borrar/recrear habría roto referencias, mappings e histórico.
- **Alternativa descartada**: dejarlo a que lo corrigiera el siguiente auto-update. El auto-update completo todavía depende del redeploy diferencial de `winerim-proxy`.

## 2026-06-01 · No prometer "Historial de ventas" Winerim como venta creada por API
- **Decisión**: Documentar que el flujo implementado descuenta stock Winerim por `PUT /api/v2/stock/{stockId}` y guarda historial canónico en Lovable Cloud; no existe en el código actual un POST de venta hacia Winerim.
- **Razón**: La documentación local Winerim API v2 disponible solo documenta endpoints de stock para este caso. Decir que se crea una venta en el Historial de ventas de Winerim sería asumir comportamiento no verificado.
- **Alternativa descartada**: afirmar que el Historial de ventas de Winerim queda garantizado solo porque el stock baja. Puede ser cierto si Winerim registra movimientos de stock como historial, pero hay que validarlo con Winerim o con su UI.

---

## 2026-05-18 · Desactivar cron `agora-dispatch-restore-stock` y eliminar `restore-stock` del dispatcher
- **Decisión**: `cron.unschedule('agora-dispatch-restore-stock')` (jobid 12) y eliminar el case `"restore-stock"` del `agora-cron-dispatcher` + del tipo `DispatchBody`. La acción `restore-glass-overdiscount` sigue existiendo en `agora-proxy` pero solo se puede invocar manualmente.
- **Razón**: El cron corría cada 5min con `apply: true` y reescribía el stock de Winerim en Sa Vida como `max(0, baseline - allHistoricalSales)`, dejando a 0 los vinos más vendidos cada vez que el cliente los reponía manualmente. Era una herramienta one-shot programada por error como recurrente.
- **Alternativa descartada**: subir el TTL del baseline o filtrar por fecha — sigue siendo destructivo para ajustes manuales del cliente.

---

## 2026-05-18 · Agora Kava no expone ventas en tiempo real → mantener flujo diario + proponer doble cierre
- **Decisión**: Confirmar que la versión de Agora desplegada en Kava SOLO devuelve datos por `/api/export/?filter=Invoices` (tras cierre de caja). Los filtros `Tickets`, `Orders`, `OpenInvoices`, `Receipts` devuelven HTTP 500. Mantener `auto-sync-sales` con scan hasta D-1 y proponer al cliente realizar doble cierre (comida + cena) para tener visibilidad 2 veces/día.
- **Razón**: No existe endpoint público en esta versión de Agora para tickets en curso. Forzar SQL directo al servidor del cliente requiere abrir puertos y rompe el contrato API-only.
- **Alternativa descartada**: (a) acceso SQL Server directo al backend de Agora — alto riesgo operativo y de seguridad; (b) polling especulativo de filtros no documentados — ya probado, devuelve 500.

---

## 2026-05-05 (tarde) · Extraer resiliencia a `_shared/resilience.ts`
- **Decisión**: Mover `fetchWithRetry`/`classifyPosError`/`applyCircuitBreaker` (originales en agora-proxy) a un módulo compartido + añadir `isConnectionPaused` y `preflightCheck`.
- **Razón**: Necesario para extender el patrón a BDP, Revo, Toast, Numier, ICG sin duplicar código.
- **Alternativa descartada**: copiar las funciones en cada proxy (deuda técnica inmediata).

## 2026-05-05 (tarde) · Aplicar SOLO guard de breaker en los 5 proxies (no reemplazar todos los fetch)
- **Decisión**: Añadir `isConnectionPaused` al inicio de cada handler. No reemplazar las llamadas `fetch(...)` internas todavía.
- **Razón**: Cubre el 80% del beneficio (cortar tráfico a un POS pausado) con cambio mínimo y reversible. Reescribir todas las llamadas en 6.3k LOC en una sola sesión es alto riesgo.
- **Alternativa descartada**: refactor masivo de cada proxy para usar `createResilientFetch` (queda como P1 siguiente).

## 2026-05-05 (tarde) · Pre-flight solo en jobs que tocan POS del cliente
- **Decisión**: En `agora-cron-dispatcher` añadir `GET /api/` con timeout 5s solo para `outbound-queue`, `sales-stock`, `restore-stock`. `catalog` queda sin filtro.
- **Razón**: `catalog` también sincroniza Winerim (no solo Agora); aunque el POS esté caído, el lado Winerim debe correr.
- **Alternativa descartada**: pre-flight en todos los jobs.

## 2026-05-05 (tarde) · Panel de salud genérico (no específico de Agora)
- **Decisión**: `ConnectionHealthPanel` recibe solo `connectionId`. Misma componente reutilizable para todos los providers.
- **Razón**: La Capa 3 ya marca a los 5 proxies con la misma semántica de breaker → un panel sirve para todos.
- **Alternativa descartada**: panel específico de Agora (no escalaba al resto).



## 2026-05-05 · Adoptar protocolo de 4 documentos de sesión
- **Decisión**: Trabajar con `PROJECT_CONTEXT.md`, `CURRENT_STATE.md`, `DECISIONS_LOG.md`, `NEXT_STEPS.md` como fuente de verdad. Leerlos al inicio y actualizarlos al cierre de cada sesión.
- **Razón**: Evitar asumir estado no documentado entre sesiones; trazabilidad de decisiones.
- **Alternativa descartada**: confiar solo en memoria del agente (`mem://`) — útil pero no transparente para el humano.

## 2026-05-05 · Cache de `/api/export-master/?filter=Products` (60s TTL)
- **Decisión**: Toda lectura del catálogo Agora pasa por `fetchAgoraProductsXmlCached`.
- **Razón**: Cada tarea de write descargaba ~1MB del XML para verificar → saturaba el SQL pool del cliente (Luruna).
- **Alternativa descartada**: subir el TTL más alto — sacrifica frescura tras escrituras.

## 2026-05-05 · Sistema de resiliencia multicapa para Agora
- **Decisión**: Implementar capas 1 (rate limiter 2 req/s), 2 (clasificador + circuit breaker), 3 (cron rescate zombies). Posponer capas 4 (health-check) y 5 (dashboard).
- **Razón**: Las 3 primeras eliminan el modo de fallo crítico (saturación POS + cola atascada). Las otras dos son QoL.
- **Alternativa descartada**: pausar manualmente las conexiones — no escalable.

## 2026-05-05 · Cleanup masivo de tareas (Sa Vida / Sa Pedrera / Kava)
- **Decisión**: Marcar tareas con "Connection refused" / >10 intentos como `BLOCKED`; zombies `RUNNING >15min` como `FAILED`.
- **Razón**: 11.879 tareas FAILED bloqueaban diagnóstico y consumían reintentos.
- **Alternativa descartada**: dejarlas — generaba ruido permanente.

## 2026-05-05 · Confirmar que las IPs AWS del informe del cliente son nuestras Edge Functions
- **Decisión**: Asumir responsabilidad y arreglar (no esquivar).
- **Razón**: Coincidencia con rangos de Supabase Edge Functions; patrón de carga coherente con nuestro proxy.

---

## 2026-05-26 · Registrar auditoría como revisión no invasiva antes de tocar stock/colas/seguridad
- **Decisión**: Documentar los hallazgos P0/P1 y dejar las acciones en `NEXT_STEPS.md`, sin aplicar cambios funcionales en esta misma pasada.
- **Razón**: Los hallazgos principales afectan deducción absoluta de stock, idempotencia, colas outbound y seguridad de datos. Son áreas críticas que requieren cambios pequeños, migraciones revisadas y pruebas de regresión antes de desplegar.
- **Alternativa descartada**: aplicar varios hotfixes en bloque durante la auditoría. Aumentaría el riesgo de romper flujos que hoy están funcionando en clientes reales.

## 2026-05-26 · Priorizar bugs de stock/idempotencia y contrato Agora antes de continuar mejoras P1
- **Decisión**: Añadir una sección P0 específica de auditoría en `NEXT_STEPS.md`, por encima de la extensión de Capa 3 a otros proxies.
- **Razón**: La resiliencia P1 sigue siendo importante, pero los problemas detectados pueden causar deducciones incorrectas, tareas duplicadas o incumplimiento de reglas duras ya acordadas.
- **Alternativa descartada**: mantener el backlog anterior sin reordenar; ocultaría riesgos más urgentes detrás de mejoras de infraestructura.

## 2026-05-26 · Incorporar documentación local Winerim API Token v2 como referencia, validando bulk contra producción
- **Decisión**: Registrar `/Users/GOIKO/Downloads/API_TOKEN_V2_DOCUMENTATION.html` como referencia técnica local para Winerim API v2, pero no activar automáticamente `stock/bulk` hasta probarlo con una conexión real.
- **Razón**: El HTML documenta `POST /wines/bulk` y `PUT /stock/bulk`, además de confirmar stock por variante con `erpStock.id`; sin embargo, el estado previo del proyecto indica que `stock/bulk` devolvía HTML/login en producción.
- **Alternativa descartada**: migrar directamente el flujo de stock a bulk solo porque el HTML lo documenta. El riesgo es dejar actualizaciones parciales sin trazabilidad suficiente o romper una integración que hoy funciona con PUT individual.

## 2026-05-26 · Hacer el P0 de stock con compatibilidad legacy y rollback explícito
- **Decisión**: Añadir idempotencia por línea/variante (`idempotency_key`) y mantener un guard de compatibilidad que respeta logs `SUCCESS` antiguos sin clave.
- **Razón**: Sin compatibilidad, reejecutar días históricos podría descontar dos veces ventas ya sincronizadas antes de la migración. La prioridad es no romper stock que ya funciona.
- **Alternativa descartada**: backfill agresivo de claves sobre logs antiguos. No hay suficiente información en todas las filas antiguas para reconstruir línea/variante sin ambigüedad.

## 2026-05-26 · Mantener `auto-sync-sales` en comportamiento efectivo D-1 y eliminar rama intradía muerta
- **Decisión**: Eliminar la segunda rama `auto-sync-sales`, que era inalcanzable, y conservar el flujo efectivo actual de días cerrados.
- **Razón**: Kava solo expone `Invoices` post-cierre y activar intradía sin verificación puede reabrir deducciones parciales o inconsistentes.
- **Alternativa descartada**: activar hoy intradía globalmente. Queda para una feature flag por conexión tras pruebas reales.

## 2026-05-26 · Añadir claim atómico con fallback para colas outbound
- **Decisión**: Crear `claim_outbound_tasks(...)` con `FOR UPDATE SKIP LOCKED` y usarlo en colas Agora/Revo, manteniendo fallback al selector anterior si la función no existe aún.
- **Razón**: Evita que dos invocaciones procesen la misma tarea a la vez sin bloquear despliegues donde la migración todavía no se haya aplicado.
- **Alternativa descartada**: cambiar todos los procesadores a RPC sin fallback; habría roto entornos si se desplegaban funciones antes que migraciones.

## 2026-05-26 · Bloquear escrituras de `restore-glass-overdiscount` salvo flag explícito
- **Decisión**: `restore-glass-overdiscount` queda dry-run por defecto; `apply=true` solo escribe si se añade `allowLegacyFractionalRestore=true`.
- **Razón**: La acción conserva lógica fraccional antigua y puede sobrescribir stock real del cliente. El bloqueo reduce riesgo sin borrar la herramienta de emergencia.
- **Alternativa descartada**: eliminar la acción por completo; podría ser útil para diagnóstico histórico mientras se reescribe variant-aware.

## 2026-05-26 · Auditar front Agora sin aplicar cambios funcionales inmediatos
- **Decisión**: Registrar hallazgos del front Agora en `CURRENT_STATE.md` y tareas P0/P1 en `NEXT_STEPS.md`, sin tocar todavía UI/backends asociados.
- **Razón**: Varios hallazgos afectan flujos operativos sensibles (guardado manual de ventas, stock, publicación de catálogo, visibilidad en TPV). Aplicarlos en bloque podría cambiar comportamiento que usan clientes reales.
- **Alternativa descartada**: corregir navegación, stock manual, magnum y visibilidad en una misma pasada. Se prioriza una secuencia pequeña y verificable, con rollback sencillo por cada cambio.

## 2026-05-26 · Cursor Agora condicionado a stock confirmado
- **Decisión**: `save-sales` y `auto-sync-sales` solo avanzan `last_business_day_synced` cuando el stock Winerim del día termina sin fallos. Si stock falla, el cursor queda atrás y el cron reintenta.
- **Razón**: Antes se podían guardar ventas y avanzar cursor sin descontar stock, obligando a intervención manual. El objetivo operativo es que cada cliente Agora funcione solo con cierres de caja.
- **Alternativa descartada**: mantener `Save to DB` como acción solo de persistencia. Es más cómodo para depurar, pero deja una vía real para saltarse stock.

## 2026-05-26 · Catch-up idempotente de stock para días ya guardados
- **Decisión**: `auto-sync-sales` revisa días recientes ya guardados con líneas de vino resueltas y ejecuta `syncStockForDay`, que salta lo ya sincronizado.
- **Razón**: Corrige casos históricos donde el cursor pudo avanzar antes de confirmar stock. La ejecución es barata cuando todo está ya en `SUCCESS` porque no llega a llamar a Winerim.
- **Alternativa descartada**: crear un cron nuevo separado para “stock pending”. Añade superficie operativa y configuración; se puede extraer más adelante si crece el volumen.

## 2026-05-26 · Guard anti doble-descuento por evento/vino/variante
- **Decisión**: además de `idempotency_key` por línea/variante, `syncStockForDay` considera sincronizado cualquier grupo `sales_event_id + winerim_product_id + variant` con `SUCCESS` previo.
- **Razón**: Las ventas se re-guardan borrando/reinsertando `sales_line_items`; los IDs de línea cambian y una clave solo por línea permitiría descontar dos veces al reejecutar un día.
- **Alternativa descartada**: recalcular deltas si un ticket cerrado cambia. Es más exacto en teoría, pero abre riesgo de doble deducción; para Agora post-cierre se asume ticket cerrado estable.

## 2026-05-26 · Activar MAGNUM en acciones principales de Agora
- **Decisión**: Preview/push/backfill principales envían `MAGNUM` junto a `BOTTLE` y `GLASS`.
- **Razón**: Backend y Winerim API v2 ya soportan variante magnum; dejarla fuera de los botones principales hacía que un formato “listo” no se automatizara.
- **Alternativa descartada**: añadir un toggle nuevo `write_magnum` ahora. Requiere migración/configuración extra; el backend ya valida por precio y elegibilidad, así que el riesgo funcional es bajo.

## 2026-05-26 · Mappings manuales deben declarar formato
- **Decisión**: `AgoraManualMatchPanel` permite elegir `BOTTLE`/`GLASS`/`MAGNUM` y deriva una propuesta inicial del nombre del producto Agora.
- **Razón**: Guardar siempre `BOTTLE` hacía ambiguas las ventas manualmente mapeadas de copa o magnum.
- **Alternativa descartada**: inferir siempre en backend sin mostrarlo. La inferencia por nombre es útil, pero debe ser visible/corregible por el operador.

## 2026-05-26 · Test de conexión sin basura operativa
- **Decisión**: las filas creadas durante `testConnection` nacen deshabilitadas y se eliminan si el test falla.
- **Razón**: Evita conexiones inválidas “New Location” que podrían aparecer en listados o diagnósticos.
- **Alternativa descartada**: crear un action backend que pruebe credenciales sin `connectionId`. Es más limpio, pero requiere reordenar el contrato del proxy; la limpieza en fallo es menor cambio y reversible.

## 2026-05-26 · Extraer reglas críticas de stock a utilidades puras testeables
- **Decisión**: mover la clave estable de grupo y la decisión de avance de cursor a `_shared/stockSyncUtils.ts`, con tests unitarios.
- **Razón**: Son reglas de seguridad operativa: no descontar dos veces y no avanzar cursor si stock falla. Deben quedar verificadas fuera del flujo completo de Edge Function.
- **Alternativa descartada**: dejar la lógica inline solo en `agora-proxy`. Funciona, pero dificulta detectar regresiones pequeñas.

## 2026-05-27 · Crear Cienvinos deshabilitado hasta completar despliegue P0
- **Decisión**: Crear la conexión Agora de `Restaurante Cienvinos Ecija` con credenciales reales, pero dejar `enabled=false`, auto-push desactivado y revisión manual obligatoria.
- **Razón**: La conexión y credenciales funcionan, pero Lovable Cloud aún no tiene aplicadas las migraciones de idempotencia variant-aware (`stock_sync_log.variant/stock_id/idempotency_key`) ni `user_roles/has_role()`. Activar cron antes de ese despliegue pondría en riesgo el stock automático.
- **Alternativa descartada**: activar inmediatamente la conexión por tener `test` correcto. El test solo valida alcance/credenciales, no garantiza deducción idempotente de stock ni seguridad de reintentos.

## 2026-05-27 · Backfill directo de stockIds Cienvinos como corrección de metadatos, no de stock
- **Decisión**: Consultar Winerim `GET /api/v2/stock/wine/{wineId}` para los 378 vinos y rellenar `bottle_stock_id`, `glass_stock_id`, `magnum_stock_id` en `winerim_wines`.
- **Razón**: El `winerim-proxy` actualmente desplegado leyó el catálogo, pero no persistió `erpStock.id`; la API real sí devolvió esos IDs. Sin stockIds, el flujo variant-aware no puede descontar la variante correcta.
- **Alternativa descartada**: esperar a una nueva sincronización automática con el proxy desplegado actual. Ya se comprobó que esa versión no capturaba los IDs, así que repetirla no aportaría valor.

## 2026-05-27 · Preparar XML de Cienvinos con familias automáticas deterministas
- **Decisión**: Configurar `auto_create_families=true`, IVA `Reducido` 10%, preparación `BARRA/BEBIDAS`, almacén general y sale centers Barra/Sala/Terraza; validar por `preview-xml` antes de cualquier import real.
- **Razón**: Agora Cienvinos devuelve 0 familias en master data y 3 listas de precio activas. Sin autocreación de familias, el XML quedaría sin una clasificación fiable; con IDs deterministas el resultado es repetible y reversible.
- **Alternativa descartada**: crear manualmente familias desde la interfaz antes de preview. Es más lento y no mejora la seguridad mientras no haya import real.

## 2026-05-27 · No escribir catálogo real en Agora Cienvinos hasta lote piloto verificado
- **Decisión**: Detenerse en preview global correcto (428 productos, 6 familias, 0 IDs duplicados) y no ejecutar `xml-import` todavía.
- **Razón**: Importar 428 productos modifica el TPV productivo. Aunque el XML sea válido, el primer write debe ser un lote piloto pequeño con verificación post-write y plan de rollback.
- **Alternativa descartada**: importar el catálogo completo de una vez. Ahorra tiempo, pero aumenta el impacto si el cliente no quiere todos los sale centers, familias o nombres generados.

## 2026-05-27 · Usar familias dedicadas WINERIM para Cienvinos
- **Decisión**: Crear familias `... WINERIM` dedicadas y mapear todo el catálogo de Winerim a esas familias, en lugar de mezclarlo con familias existentes del cliente.
- **Razón**: Es el despliegue más reversible: permite ver claramente qué productos vienen de Winerim y ocultar/restaurar ese bloque completo sin tocar comida/bebidas.
- **Alternativa descartada**: usar las familias genéricas auto-creadas `Vinos Tinto`, `Vinos Blanco`, etc. Cumplían técnicamente, pero no dejaban tan claro el origen WINERIM pedido por el usuario.

## 2026-05-27 · No ocultar productos previos de Cienvinos que no sean vino real
- **Decisión**: No ocultar los 177 productos preexistentes de Agora Cienvinos, porque no hay familias antiguas de vino y los candidatos por texto eran falsos positivos (`tinto limón`, `copa cerveza`, infusiones/licores).
- **Razón**: Ocultar por heurística habría podido romper bebidas/carta activa del cliente. El objetivo era ocultar vino legacy, no elementos operativos no-Winerim.
- **Alternativa descartada**: ocultar cualquier producto que contuviera palabras como `tinto`, `copa` o `manzanilla`. Esa regla habría sido demasiado agresiva.

## 2026-05-27 · Importar Cienvinos por formato y lotes pequeños
- **Decisión**: Tras fallar el XML global con HTTP 500, importar por formato (`BOTTLE`, `GLASS`, `MAGNUM`) y por lotes pequeños, verificando cada lote contra las 3 listas de precio.
- **Razón**: Agora aceptó los lotes pequeños y permitió aislar errores individuales sin repetir importaciones masivas ni dejar el catálogo a medias.
- **Alternativa descartada**: reintentar el XML global completo. Habría repetido el mismo 500 y aumentado carga sobre el POS.

## 2026-05-27 · Desambiguar nombres duplicados de Winerim con sufijo corto en Agora
- **Decisión**: Importar las 12 botellas duplicadas de nombre con sufijo corto basado en el ID Winerim visible en Agora, restaurando después los nombres originales en el catálogo cacheado local.
- **Razón**: Agora rechaza nombres duplicados aunque el `Id` de producto sea distinto. El sufijo mantiene todos los vinos vendibles sin borrar duplicados de Winerim.
- **Alternativa descartada**: saltar los duplicados o borrar uno de cada par. No era seguro asumir que son duplicados descartables; pueden representar añadas, precios o fichas distintas.

## 2026-05-27 · No activar cron global de Cienvinos hasta completar migraciones P0
- **Decisión**: Mantener `enabled=false` en Cienvinos aunque el catálogo ya esté importado y `provider_capabilities` esté en `READY/XML_IMPORT`.
- **Razón**: En Lovable Cloud aún faltan las columnas variant-aware de `stock_sync_log` y `user_roles/has_role()`. Además, el dispatcher Agora usa `enabled=true` para `catalog`, `sales-stock` y `outbound-queue`; no hay un interruptor seguro para encender solo catálogo sin ventas/stock.
- **Alternativa descartada**: activar Cienvinos inmediatamente por petición operativa. Habría podido lanzar `auto-sync-sales`/colas con idempotencia de stock incompleta.

## 2026-05-27 · Cerrar cola Cienvinos supersedida por import verificado
- **Decisión**: Marcar como `SUCCESS` las 75 tareas `AGORA_XML_UPSERT_PRODUCT` de Cienvinos que seguían `QUEUED`.
- **Razón**: Todas correspondían a botellas ya importadas y registradas como `PUSHED` en `winerim_push_tracking`. Dejarlas pendientes habría reintentado creates antiguos al activar la cola y podía provocar errores por productos ya existentes.
- **Alternativa descartada**: dejarlas en `QUEUED` o pasarlas a `BLOCKED`. `QUEUED` reabría el riesgo de duplicado; `BLOCKED` ensuciaría los paneles con una alarma que ya no requiere acción operativa.

## 2026-05-27 · Sa Vida queda marcada como no conectada pese a credenciales actualizadas
- **Decisión**: Cargar las credenciales nuevas de Sa Vida, pero marcar su capacidad Agora como `UNKNOWN/NOT_CONNECTED/NONE` tras recibir HTTP `501` en endpoints de catálogo y ventas.
- **Razón**: El servidor responde, pero la API REST de Agora no está disponible en los endpoints usados por el middleware. Presentarla como `READY` sería engañoso y fomentaría reintentos de escritura destinados a fallar.
- **Alternativa descartada**: forzar `READY/XML_IMPORT` por tener credenciales nuevas. Las credenciales no bastan si el módulo/API del POS responde `501`.

## 2026-05-27 · Limpiar breakers obsoletos en instalaciones Agora sanas
- **Decisión**: Resetear `consecutive_failures`, `circuit_breaker_paused_until` y `circuit_breaker_reason` en Kava, Luruna y Sa Pedrera tras comprobar endpoints operativos.
- **Razón**: Los breakers estaban caducados y los contadores eran residuo de incidentes anteriores; mantenerlos generaba señales falsas de degradación en paneles y diagnósticos.
- **Alternativa descartada**: esperar a que un flujo futuro los resetee automáticamente. Ya se había comprobado salud básica y el reset manual reduce ruido sin cambiar credenciales ni catálogo.

## 2026-05-27 · Desambiguación automática de nombres duplicados en XML Agora
- **Decisión**: Añadir una utilidad pura para que `generateImportXml` mantenga nombres únicos sin cambios, conserve el nombre al actualizar el mismo `Product Id` y añada sufijo corto determinista solo cuando haya duplicados reales o colisión con otro producto existente.
- **Razón**: Cienvinos demostró que Agora rechaza nombres duplicados aunque el `Id` sea distinto. Resolverlo manualmente funciona una vez, pero auto-push/actualizaciones futuras necesitaban la misma regla para no reintroducir HTTP 500.
- **Alternativa descartada**: sufijar todos los productos siempre. Sería más simple, pero cambiaría nombres que ya funcionan y haría más ruidoso el TPV.

## 2026-05-27 · Crear Baco Getafe deshabilitado y con catálogo controlado
- **Decisión**: Crear `Baco Getafe` en Lovable Cloud con `enabled=false`, importar catálogo Winerim manualmente y no activar cron global.
- **Razón**: La conexión Agora y Winerim funcionan, pero Lovable Cloud sigue sin migraciones P0 de stock idempotente. Activar `enabled=true` lanzaría también ventas/stock y colas automáticas.
- **Alternativa descartada**: activar la conexión al terminar la importación de catálogo. El catálogo está verificado, pero el stock automático aún no tiene la garantía de idempotencia por variante en producción.

## 2026-05-27 · Baco usa familias WINERIM separadas y oculta legado por familia/producto
- **Decisión**: Crear 8 familias WINERIM dedicadas, importar 118 productos Winerim ahí y ocultar las familias legacy `VINO`, `FINOS`, `ROSADOS`, `TINTOS`, `CHAMPAGNE`, `BLANCOS` junto con sus 348 productos.
- **Razón**: Es el despliegue más reversible y cumple la petición de dejar el vino antiguo fuera del TPV sin borrar histórico.
- **Alternativa descartada**: reutilizar las familias legacy existentes. Mezclar nuevo y viejo habría hecho más difícil verificar y revertir.

## 2026-05-27 · Excluir `Personal` y `MUS` de los sale centers Baco
- **Decisión**: Publicar precios en los sale centers `Cafet.`, `Restaurante` y `Terraza`, excluyendo `Personal` y `MUS`.
- **Razón**: Los tres primeros son centros de venta de cliente con price lists activas; `Personal` y `MUS` parecen operativos/internos o especiales. Publicar vinos ahí sin confirmación podría alterar flujos no comerciales.
- **Alternativa descartada**: publicar en los 5 sale centers por defecto. Es más amplio, pero menos conservador.

## 2026-05-27 · Corregir tracking tras timeout de importación Baco
- **Decisión**: Tras un HTTP `546` del `xml-import`, verificar directamente `export-master` y reconstruir `winerim_push_tracking`/`product_mappings` según productos realmente existentes.
- **Razón**: El XML se aplicó en Agora, pero el timeout dejó tracking local con falsos positivos para formatos no exportables. Corregirlo evita que el panel y futuras colas crean que hay 285 formatos publicados cuando solo hay 118.
- **Alternativa descartada**: reintentar la importación global. Habría duplicado carga y podía generar errores por productos ya existentes.

## 2026-05-27 · Desambiguar duplicados Baco temporalmente y restaurar nombres Winerim
- **Decisión**: Importar `Alión` y `Villacardiel` duplicados con sufijo corto en Agora (`M Alión 054`, `B Villacardiel 977`) y restaurar después los nombres Winerim locales originales.
- **Razón**: Agora rechaza nombres duplicados aunque los productos tengan `Id` distinto. El sufijo solo afecta al nombre visible del producto Agora necesario para distinguir variantes/fichas duplicadas.
- **Alternativa descartada**: saltar uno de los duplicados. No era seguro asumir que son equivalentes; en Baco representan productos/precios distintos.

## 2026-05-28 · Publicar cambios P0 en GitHub antes de tocar activación automática
- **Decisión**: Empujar al repo oficial `goiko111/bridge-to-winerim` los cambios P0 ya validados localmente, excluyendo `.env`, mediante el commit `5ecee98` (`Stabilize Agora automation and stock sync`).
- **Razón**: El README del proyecto indica que los pushes a GitHub se reflejan en Lovable. La UI de Lovable Cloud requería login en el navegador integrado, así que GitHub era la vía disponible para dejar código, migraciones, tests y rollback en la fuente oficial sin esperar credenciales.
- **Alternativa descartada**: activar Cienvinos/Baco solo con el catálogo importado. El backend real seguía sin columnas `stock_sync_log.variant/stock_id/idempotency_key` ni `user_roles`, por lo que activar `enabled=true` habría encendido ventas/stock con garantías incompletas.

## 2026-05-28 · No asumir que GitHub aplica DDL en Lovable Cloud
- **Decisión**: Tratar el push a GitHub como publicación de código/migraciones, pero no como prueba de migración aplicada. Se validó contra backend real después del push y las columnas/tablas seguían faltando.
- **Razón**: La seguridad operativa depende del esquema real, no de que los archivos existan en el repositorio. La verificación por REST demostró que `stock_sync_log.variant` y `user_roles` aún no están disponibles.
- **Alternativa descartada**: esperar pasivamente y activar cuando el repo estuviera actualizado. Sin confirmación de DDL y redeploy de funciones, el riesgo de romper stock automático sigue abierto.

## 2026-05-28 · Aplicar migraciones P0 antes de activar conexiones Agora
- **Decisión**: Ejecutar en Lovable Cloud las migraciones `20260526090000_stock_sync_variant_idempotency.sql` y `20260526091000_user_roles_has_role.sql`, verificar columnas/tabla/RPCs contra el backend real y mantener Cienvinos/Baco deshabilitados.
- **Razón**: El stock automático depende de `variant`, `stock_id`, `idempotency_key` y del claim atómico de colas. Activar sin ese esquema podía provocar deducciones ambiguas o reintentos no idempotentes.
- **Alternativa descartada**: activar `enabled=true` tras importar catálogo, confiando en que el código con fallback bastaría. El fallback protege despliegues parciales, pero no es la garantía correcta para clientes productivos.

## 2026-05-28 · Redeploy de Edge Functions tras migraciones y corrección de cambios generados por Lovable
- **Decisión**: Redeployar `agora-proxy`, `winerim-proxy`, `agora-cron-dispatcher` y `revo-proxy` desde Lovable Cloud después de aplicar DDL. Al detectar que Lovable generó cambios en `src/integrations/supabase/types.ts` y un cast menor de UI, revertir esos cambios en fuente porque el protocolo del proyecto prohíbe tocar `src/integrations/supabase/{client,types}.ts`.
- **Razón**: El redeploy era necesario para que el backend ejecutase la lógica P0 actual, pero no justifica romper una regla dura de mantenimiento ni dejar cambios no solicitados en archivos generados.
- **Alternativa descartada**: conservar los tipos actualizados generados automáticamente. Aunque reflejan el nuevo esquema, contradicen la regla explícita del proyecto y pueden introducir churn/confianza falsa en tipos generados.

## 2026-05-28 · No activar automático hasta una venta WINERIM real validada
- **Decisión**: Mantener `enabled=false` en Cienvinos y Baco tras migraciones y redeploy. La siguiente activación requiere una venta/cierre con producto WINERIM resuelto y verificación de `stock_sync_log.variant`, `stock_id`, `idempotency_key` y reejecución sin doble descuento.
- **Razón**: Cienvinos no tiene facturas cerradas recientes y Baco tiene cierres legacy con 0 líneas resueltas contra productos WINERIM. No existe aún una prueba real de deducción de stock por variante en estas instalaciones nuevas.
- **Alternativa descartada**: activar cron global inmediatamente. `enabled=true` dispara catálogo, ventas/stock y cola outbound juntos; sin prueba real de stock, el riesgo operativo sigue siendo innecesario.

## 2026-05-28 · Activar Cienvinos y Baco en producción controlada
- **Decisión**: Tras instrucción explícita del usuario, activar `enabled=true` en Cienvinos y Baco, marcar `auto_push_verified_ready=true`, encender `auto_push_on_create=true`, dejar `auto_push_on_update=false`, y fijar `last_business_day_synced=2026-05-27`.
- **Razón**: Las migraciones P0 y Edge Functions actuales ya están desplegadas, ambas conexiones están `READY/XML_IMPORT`, sin breakers y sin cola abierta. El cursor inicial evita reescaneos históricos inútiles: Cienvinos no tiene facturas cerradas recientes y Baco tiene histórico legacy sin líneas WINERIM resueltas.
- **Alternativa descartada**: dejar ambas conexiones apagadas hasta una venta real WINERIM. Era la postura más conservadora, pero el usuario priorizó que funcionen ya con normalidad; se compensa arrancando desde el último día cerrado y monitorizando el primer cierre nuevo.

## 2026-05-28 · Mantener auto-update de catálogo apagado hasta hacerlo diferencial
- **Decisión**: No activar todavía `auto_push_on_update` en Cienvinos/Baco aunque sí se active el cron general y el auto-create.
- **Razón**: La implementación actual de `fetch-catalog` llama `evaluate-auto-push` con `eventType=UPDATE` para cada lote procesado, no solo para vinos cambiados. Encender `auto_push_on_update` ahora podría reencolar/reimportar muchos productos en cada sincronización de catálogo y cargar Agora innecesariamente.
- **Alternativa descartada**: encender `auto_push_on_update=true` para lograr automatización total inmediata. Es funcionalmente tentador, pero aumenta el riesgo de sobreescrituras masivas y de carga POS; la mejora correcta es detectar cambios reales antes de encolar updates.

## 2026-05-28 · Evitar zombies `RUNNING` en colas Agora por agotamiento de tiempo
- **Decisión**: Modificar los procesadores de cola Agora para no reclamar lotes cuando queda poco presupuesto de ejecución y reencolar cualquier tarea ya reclamada que no llegue a procesarse.
- **Razón**: Durante la activación de Cienvinos, el procesador completó imports correctamente pero dejó tareas en `RUNNING` al agotar tiempo después de reclamar un lote. El resultado operativo era una cola aparentemente atascada sin error real.
- **Alternativa descartada**: esperar al cron de rescate de zombies. Funciona como red de seguridad, pero para clientes nuevos en producción es mejor que el procesador no cree zombies en condiciones normales.

## 2026-05-28 · Preservar capacidades verificadas y usar gates automáticos para vinos recién READY
- **Decisión**: `sync-master-data` no debe degradar `can_write_products=YES` a `UNKNOWN` si ya hubo XML import verificado. Además, los vinos que pasan de pricing incompleto a `READY` se evalúan con `evaluate-auto-push` (`CREATE`) en vez de llamar al encolador manual directo.
- **Razón**: Baco había importado correctamente pero una lectura de master data volvió a mostrar la capacidad de escritura como `UNKNOWN`. El encolado directo de newly-ready también podía saltarse gates como `auto_push_on_create`, `auto_push_verified_ready` o `write_mode`.
- **Alternativa descartada**: corregir solo los valores en base de datos. Arregla la foto puntual, pero no evita que una sincronización futura vuelva a degradar capacidades o encolar fuera de las reglas automáticas.

## 2026-05-28 · Reforzar visibilidad de familias Baco tras reporte visual
- **Decisión**: Forzar `ShowInPos=false` en las familias legacy de vino de Baco (`VINO`, `FINOS`, `ROSADOS`, `TINTOS`, `CHAMPAGNE`, `BLANCOS`) y `ShowInPos=true` en las familias dedicadas `... WINERIM`.
- **Razón**: El vídeo del cliente mostraba productos legacy antiguos en la familia `VINO`. En Lovable Cloud esos productos ya estaban no vendibles, pero varias familias legacy seguían visibles, lo que mantenía ruido visual y podía confundir al equipo de sala.
- **Alternativa descartada**: dejarlo como estaba porque `UseAsDirectSale=false` y `SaleableAsMain=false` ya impedían vender legacy. Técnicamente evitaba cobros, pero no cumplía la petición operativa de que las familias/vinos antiguos desaparezcan del TPV.

## 2026-05-28 · Interpretar `last_sync_at` como último chequeo operativo aunque no haya días pendientes
- **Decisión**: Cambiar `auto-sync-sales` para que actualice `last_sync_at` cuando el POS responde y no hay días cerrados pendientes, sin mover `last_business_day_synced`.
- **Razón**: Baco y Cienvinos estaban sanos y con cursor `2026-05-27`, pero el Sync Monitor mostraba `Never` porque el flujo no escribía `last_sync_at` en el camino "No pending days to sync". Eso confundía activación con fallo operativo.
- **Alternativa descartada**: rellenar `last_sync_at` solo a mano en base de datos. Arregla la foto puntual, pero deja el mismo síntoma en el siguiente cliente nuevo o en cualquier conexión sin cierres pendientes.

## 2026-05-28 · Hacer visible la conexión origen en fallos de `stock_sync_log`
- **Decisión**: Añadir ubicación a la pestaña `Stock Sync` del Sync Monitor.
- **Razón**: La pestaña mostraba las últimas 100 filas globales sin indicar conexión; los fallos de Sa Vida/Sa Pedrera/Kava podían parecer fallos de Baco o Cienvinos.
- **Alternativa descartada**: explicar el origen solo en documentación. La UI debe mostrar la conexión para evitar diagnósticos falsos durante soporte.

## 2026-05-28 · No declarar toda la flota Agora como lista hasta reparar mappings/stockIds antiguos
- **Decisión**: Separar el estado de Baco/Cienvinos (limpios y preparados para primer cierre nuevo) del resto de instalaciones Agora, que aún tienen deuda operativa.
- **Razón**: Sa Vida, Sa Pedrera y Kava tienen fallos reales de stock; Katsu/La Candela/Luruna tienen stockIds incompletos o capacidades inconsistentes. Decir "todo listo" ocultaría riesgos de stock no descontado o reintentos repetidos.
- **Alternativa descartada**: considerar `enabled=true` y token Winerim como suficiente. La preparación real exige cursor, mappings, stockIds por variante, capacidades de escritura y logs sin fallos recientes.

## 2026-05-28 · Tratar fallos terminales de stock Winerim como bloqueados, no reintentables
- **Decisión**: Clasificar `wine not found`, `not accessible` y `Variant '<formato>' not found` como fallos terminales de stock; bloquear su repetición en `syncStockForDay` y marcar logs históricos como `BLOCKED_TERMINAL`.
- **Razón**: Reintentar cada ciclo no corrige un vino inaccesible ni una variante que no existe en Winerim; solo genera ruido en Sync Monitor, alertas falsas y riesgo de no ver fallos nuevos reales.
- **Alternativa descartada**: dejar todos los errores como `FAILED` recuperables. Era más simple, pero mantenía bucles de reintento y mezclaba datos obsoletos con incidencias operativas reales.

## 2026-05-28 · Un mapping `REJECTED` tiene prioridad sobre tracking histórico
- **Decisión**: Cambiar la resolución de ventas Agora para que `product_mappings.REJECTED` bloquee el uso de `winerim_push_tracking` aunque el producto figure como `PUSHED` o `VERIFIED`.
- **Razón**: El tracking demuestra que un producto se creó en Agora, no que el vino/variante siga siendo descontable con el token Winerim actual. Los fallos de Sa Vida/Sa Pedrera/Kava demostraron que tracking histórico podía volver a mapear productos obsoletos.
- **Alternativa descartada**: actualizar solo `product_mappings`. Sin cambiar la prioridad, el mismo producto podía resolverse por tracking y volver a fallar stock.

## 2026-05-28 · Reparar stockIds y mappings por lectura, sin tocar inventario real
- **Decisión**: Ejecutar una reparación controlada con `GET /api/v2/stock/wine/{wineId}` para backfill de `bottle/glass/magnum_stock_id`, rechazar mappings imposibles y limpiar líneas históricas ya rechazadas, sin hacer ningún `PUT /stock`.
- **Razón**: La preparación automática de ventas requiere stockIds por variante y mappings válidos; escribir cantidades de stock durante una reparación de metadata habría sido innecesario y arriesgado.
- **Alternativa descartada**: forzar un re-sync completo de catálogo y ventas. Habría mezclado lectura, escritura y colas POS, aumentando el blast radius cuando el problema concreto era metadata/mapping.

## 2026-05-28 · Respetar `auto_push_on_update=false` desde `winerim-proxy`
- **Decisión**: El enriquecimiento de catálogo solo invoca `evaluate-auto-push` con `eventType=UPDATE` cuando la conexión es Agora y `auto_push_on_update=true`.
- **Razón**: Cienvinos volvió a reencolar updates masivos pese a tener auto-update apagado. La automatización debe crear vinos nuevos, pero no reimportar todo cada día hasta tener detección diferencial de cambios.
- **Alternativa descartada**: limpiar la cola manualmente cada vez que reaparezca. Corrige la foto puntual, pero deja la causa viva en cada ciclo de catálogo.

## 2026-05-28 · Cerrar updates Cienvinos supersedidos solo si ya están publicados
- **Decisión**: Marcar como `SUCCESS` las 82 tareas abiertas de Cienvinos generadas por el runtime antiguo únicamente después de comprobar que todos sus formatos ya estaban `PUSHED` o `VERIFIED` en `winerim_push_tracking`.
- **Razón**: Eran updates `MANUAL` de productos ya importados; procesarlos otra vez habría cargado Agora sin aportar cambios y mantenerlos abiertos hacía parecer que Cienvinos estaba atascado.
- **Alternativa descartada**: borrar las tareas o marcarlas `SUCCESS` sin verificación. Borrarlas pierde trazabilidad; cerrarlas sin comprobar tracking podría ocultar productos realmente pendientes.

## 2026-05-28 · Baco: productos Winerim presentes pero no direct-sale
- **Decisión**: Esta decisión queda corregida por la decisión siguiente. El intento de forzar `UseAsDirectSale=true` resolvía botones directos, pero provocaba duplicado visual en la pantalla raíz.
- **Razón**: En Agora, `UseAsDirectSale=true` no significa solo "vendible"; significa que el producto aparece también como venta directa fuera de su familia. La vendibilidad dentro de familia depende de `SaleableAsMain=true`.
- **Alternativa descartada**: mantener `UseAsDirectSale=true`. El cliente confirmó duplicidad visual: los vinos aparecían dentro de `TINTOS WINERIM` y también abajo en la pantalla principal.

## 2026-05-28 · Baco: quitar duplicados raíz manteniendo venta dentro de familia
- **Decisión**: Dejar los 118 productos Winerim de Baco con `UseAsDirectSale=false` y `SaleableAsMain=true`.
- **Razón**: Así desaparecen los botones duplicados de la pantalla principal y los vinos siguen vendibles cuando se entra en su familia WINERIM (`TINTOS WINERIM`, `BLANCOS WINERIM`, `COPAS WINERIM`, etc.).
- **Alternativa descartada**: reimportar catálogo completo o ocultar productos. Reimportar era innecesario y ocultar productos rompería la venta dentro de familia.

## 2026-05-29 · Baco: no crear `C Tamaral Crianza` sin variante copa en Winerim
- **Decisión**: No crear manualmente un producto `C Tamaral Crianza` en Agora mientras Winerim no exponga una variante copa para el vino correspondiente (`Tamaral`/Crianza).
- **Razón**: En Winerim, la copa publicada es `Tamaral Roble` (`C Tamaral Roble (RIBERA)` en `COPAS WINERIM`). El vino `Tamaral` no tiene `glass_sale_price` ni `glass_stock_id`, por lo que crear una copa manual rompería la trazabilidad y el descuento de stock por variante.
- **Alternativa descartada**: renombrar `C Tamaral Roble` a `C Tamaral Crianza` o crear un producto alias. Podría resolver la queja visual, pero introduciría una equivalencia de negocio no confirmada y stock posiblemente incorrecto.

## 2026-05-29 · Generar Winerim en Agora como vendible dentro de familia, no como botón raíz
- **Decisión**: Cambiar `generateImportXml` para emitir `UseAsDirectSale=false` y `SaleableAsMain=true` en productos Winerim.
- **Razón**: Es la política validada en Baco: evita duplicados en la pantalla raíz y conserva la venta dentro de `... WINERIM`.
- **Alternativa descartada**: mantener el generador con `UseAsDirectSale=true` y corregir manualmente cada cliente. Eso reintroduciría duplicados en futuras reimportaciones o nuevos clientes Agora.

## 2026-05-29 · Revertir Baco Getafe a catálogo legacy sin borrar Winerim
- **Decisión**: Revertir operativamente Baco Getafe a su catálogo legacy: ocultar familias/productos Winerim, restaurar familias legacy, dejar vendibles los productos legacy activos, mantener no vendibles los legacy ya borrados y desactivar la automatización Winerim de esa conexión.
- **Razón**: El cliente reportó problemas operativos tras la integración Winerim. La vía más segura era quitar Winerim de la pantalla y devolver la operativa conocida sin eliminar histórico ni productos creados, dejando una ruta reversible si se decide reactivar Winerim más adelante.
- **Alternativa descartada**: borrar productos/familias Winerim o seguir ajustando nombres/visibilidad sobre la marcha. Borrar perdería trazabilidad y complicaría una vuelta atrás; seguir corrigiendo sobre producción mantenía al cliente en una operativa que ya había pedido revertir.

## 2026-05-29 · Baco legacy debe vender dentro de `VINO`, no como venta directa
- **Decisión**: Corregir el rollback de Baco para dejar todos los productos legacy de vino con `UseAsDirectSale=false`, mantener `SaleableAsMain=true` solo para los productos legacy esperados y colgar `FINOS`, `ROSADOS`, `TINTOS`, `CHAMPAGNE` y `BLANCOS` bajo la familia raíz `VINO`.
- **Razón**: El cliente confirmó que el estado anterior no tenía cinco pantallas de vinos en el frontal; los vinos estaban dentro de la categoría `VINO`. En Agora, `UseAsDirectSale=true` crea botones directos en la pantalla principal, que fue justo el problema visible tras el primer rollback.
- **Alternativa descartada**: mantener todos los productos activos como direct-sale. Aunque eran vendibles, rompía la operativa de sala y reactivaba visualmente referencias que el cliente no quería ver en el frontal.

## 2026-06-01 · Auditar integraciones en modo solo lectura antes de tocar colas
- **Decisión**: Generar una checklist operativa por integración (`INTEGRATIONS_CHECKLIST_2026-06-01.md`) con datos reales de Lovable Cloud y no ejecutar limpiezas, reintentos ni cambios de configuración durante esta revisión.
- **Razón**: La flota contiene estados mezclados: algunas conexiones tienen ventas/stock recientes, otras tienen capacidades degradadas o colas históricas. Antes de tocar datos conviene separar diagnóstico, prioridades y acciones seguras.
- **Alternativa descartada**: drenar colas o corregir capacidades durante la auditoría. Habría mezclado observación con mutación y podría ocultar el estado real que se quería revisar.

## 2026-06-01 · Reparar visual Agora sin borrar histórico
- **Decisión**: En Katsu, Kava, La Candela, Luruna y Sa Pedrera, dejar los productos Winerim activos con `UseAsDirectSale=false`, `SaleableAsMain=true` y pareja de preparación configurada.
- **Razón**: `UseAsDirectSale=true` crea botones raíz y desordena la pantalla; `SaleableAsMain=true` mantiene la venta dentro de la familia. Los campos de preparación vacíos explican de forma plausible que algunos vinos no llegasen a barra.
- **Alternativa descartada**: ocultar productos o familias Winerim. Habría quitado ruido visual, pero también podía dejar vinos inaccesibles para sala y romper operativa.

## 2026-06-01 · Sa Pedrera conserva estructura legacy regional
- **Decisión**: En Sa Pedrera, enrutar productos Winerim a familias legacy visibles por región/tipo (`T Rioja Navarra`, `T Ribera C.Leon`, `B Galicia`, `Champagnes`, `MAGNUMS`, etc.) mediante reglas en `provider_config.agora_family_routing_rules`.
- **Razón**: El cliente explicó que antes trabajaban visualmente por regiones; poner todo en `TINTOS WINERIM`/`BLANCOS WINERIM` o dejar botones directos rompe esa memoria operativa.
- **Alternativa descartada**: hacer visibles las familias `... WINERIM` o agrupar solo por tipo. Técnicamente sería más simple, pero no respeta la organización que el cliente usa en tablets.

## 2026-06-01 · Pausar auto-push verificado hasta confirmar redeploy de Lovable Cloud
- **Decisión**: Mantener `auto_push_verified_ready=false` temporalmente en Katsu, Kava, La Candela, Luruna y Sa Pedrera tras la reparación.
- **Razón**: El código corregido está en GitHub (`81c7dbb`), pero el `preview-xml` real de Lovable Cloud seguía generando `UseAsDirectSale=true`. Al reactivar antes del redeploy se creó una carrera `AUTO_UPDATE` que reintrodujo parte del problema visual en La Candela/Katsu.
- **Alternativa descartada**: dejar el automático encendido confiando en el push a GitHub. Sin preview de runtime confirmado, el sistema podía volver a escribir el catálogo con la política antigua.

## 2026-06-01 · No certificar copas sin venta real reciente por conexión
- **Decisión**: Separar el estado "preparado técnicamente" del estado "probado con venta real" para descuentos de copa en Agora.
- **Razón**: Varias conexiones tienen `glass_stock_id` completo y mappings confirmados, pero no tienen ventas recientes de copa en `stock_sync_log`. Kava y parte de Sa Pedrera sí demuestran descuentos de copa reales; Katsu, La Candela, Luruna y Cienvinos requieren venta/cierre de prueba antes de declararlas perfectas.
- **Alternativa descartada**: considerar que tener stockIds y mappings basta para comunicar que "todas las copas descuentan bien". Eso ocultaría el riesgo de una variante/mapping no ejercitado por ventas reales.

## 2026-06-01 · Tratar legacy visible como estado explícito, no como fallo genérico
- **Decisión**: Mantener Baco como legacy por rollback y Sa Pedrera con estructura legacy regional mientras no haya instrucción explícita de ocultarlo; revisar solo los productos directos residuales de Kava/Luruna como posibles excepciones o legacy pendiente.
- **Razón**: En Baco el rollback fue pedido por el usuario y en Sa Pedrera el cliente pidió conservar organización regional. Ocultar legacy sin validar operativa de sala podría romper botones conocidos y referencias que todavía usan.
- **Alternativa descartada**: ocultar de golpe todo producto/familia no-Winerim. Es más limpio a nivel técnico, pero puede alterar la pantalla que los camareros usan y provocar incidencias de servicio.

## 2026-06-01 · Ocultar residuos directos legacy en Kava y Luruna sin borrar productos
- **Decisión**: Ocultar con `SaleableAsMain=false` y `UseAsDirectSale=false` cuatro productos directos no-Winerim: Kava `1000011` / `EL LANCE`; Luruna `1164074` / `COPA ONDALAN TINTO`, `1164081` / `VIUDA DE CLICQUOT ROSADO`, `1164082` / `COPA VIÑA SASTRE CRZ`.
- **Razón**: No tenían tracking ni mapping Winerim, por lo que una venta desde esos botones podía no descontar stock en Winerim. En Kava además existe reemplazo Winerim confirmado para `El Lance 7 Fuentes`.
- **Alternativa descartada**: borrar productos o familias. Ocultar conserva histórico y permite rollback inmediato poniendo esos IDs de nuevo visibles si el cliente confirma que eran excepciones operativas necesarias.

## 2026-06-01 · Sa Pedrera: confirmar solo legacy inequívoco con variante Winerim válida
- **Decisión**: Insertar `38` mappings `CONFIRMED` para productos legacy de Sa Pedrera mediante `LEGACY_SAFE_MATCH`, y dejar fuera los casos ambiguos o sin variante válida.
- **Razón**: Un legacy vendido sin mapping no descuenta stock Winerim, pero un mapping erróneo descuenta el vino equivocado. La fase 1 prioriza matches con nombre fuerte, familia compatible y `stock_id` de la variante disponible.
- **Alternativa descartada**: confirmar automáticamente todos los candidatos del dry-run. Se detectaron falsos positivos (`Roda`, `Tokaji 6 Puttonyos`, `Magnum Marques de Murrieta`) y se corrigieron manualmente dos casos (`MACAN`, `Alba`) antes de escribir.

## 2026-06-02 · Sa Vida: no reactivar tras nueva IP si Agora sigue devolviendo 501
- **Decisión**: Mantener Sa Vida como no operativa aunque la URL esté normalizada a `http://80.32.137.41:8984/`.
- **Razón**: Las pruebas `test`, `Products` y `Families` siguen devolviendo HTTP 501 desde Agora; resetear breaker/capacidades o procesar colas generaría fallos repetidos y podría reactivar writes contra un POS no preparado.
- **Alternativa descartada**: asumir que el cambio de IP resolvía la incidencia y reactivar la conexión. La prueba viva demuestra que el módulo REST/export-master sigue sin responder correctamente.

## 2026-06-04 · Sa Pedrera: no ocultar Winerim duplicado sin filtrar calidad del mapping
- **Decisión**: No aplicar ocultación masiva de los `92` duplicados probables legacy + Winerim en Sa Pedrera hasta separar mappings seguros (`LEGACY_SAFE_MATCH`) de mappings difusos antiguos (`FUZZY`) y revisar los casos sospechosos.
- **Razón**: El total de `product_mappings.CONFIRMED` mezcla productos Winerim importados (`XML_IMPORT`) con legacy real, y algunos `FUZZY` antiguos apuntan a vinos no equivalentes. Usar ese número bruto para ocultar botones podría esconder el producto correcto o dejar un legacy descontando stock de un vino equivocado.
- **Alternativa descartada**: ocultar automáticamente todo producto Winerim que tenga cualquier mapping `CONFIRMED` para el mismo `winerim_wine_id + format`. Sería rápido, pero demasiado arriesgado en un servicio activo y en una carta organizada visualmente por regiones.

## 2026-06-04 · Priorizar matching por código comercial exacto sobre fuzzy
- **Decisión**: Añadir una capa de matching por código comercial exacto (`CODE_EXACT`) antes del fuzzy: extraer códigos tipo `T31`, `B303`, `G801`, `MAGNUM21` desde nombres Winerim y etiquetas Agora generadas (`B T31-...`, `C B303-...`).
- **Razón**: Sa Pedrera usa códigos correlativos en Winerim y los productos publicados en Agora conservan esos códigos. Cuando existe código, es una señal más fiable que similitud de nombre.
- **Alternativa descartada**: seguir confiando primero en fuzzy. Ya se observaron falsos positivos de fuzzy antiguos; el código exacto reduce riesgo de descontar stock del vino equivocado.

## 2026-06-04 · No interpretar números en nombres como códigos
- **Decisión**: Exigir separador de código (`-`) para extraer códigos; ejemplos válidos `G801-Papirusa`, `B T31-Semele`, `MAGNUM 21 - Finca La Montesa`; ejemplos no válidos `Magnum 4 Kilos`, `As 2 Ladeiras`, `200 Monges Rioja`.
- **Razón**: En la carta de vinos hay números que forman parte del nombre comercial. Interpretarlos como código produciría matches gravemente incorrectos, como mapear `Magnum 4 Kilos` a `MAGNUM 4 - Viña Mein Blanco`.
- **Alternativa descartada**: extraer cualquier prefijo letra+número o palabra+número. Parecía aumentar cobertura, pero el primer dry-run demostró falsos positivos peligrosos.

## 2026-06-04 · Sa Pedrera: piloto de dulces acotado a `D701-D709`
- **Decisión**: Publicar solo `D701-D709` en la familia Agora existente `903925`, renombrándola/mostrándola como `DULCES WINERIM`, sin tocar el resto de la estructura legacy regional.
- **Razón**: El cliente quiere validar si el orden por código Winerim resuelve el problema visual antes de aplicar cambios amplios en Sa Pedrera. Reutilizar la familia existente evita duplicar familias y limita el rollback.
- **Alternativa descartada**: reordenar/ocultar de golpe toda la carta legacy o todas las familias Winerim. El riesgo operativo es alto porque Sa Pedrera trabaja con memoria visual regional y todavía está validando qué quiere conservar.

## 2026-06-04 · Sa Pedrera: no crear formatos no activos en Winerim
- **Decisión**: Incluir copas dulces solo cuando `serve_by_glass=true`; no crear copa para `D707` aunque haya `glass_sale_price` cacheado, porque Winerim marca ese vino como no servido por copa.
- **Razón**: El stock variant-aware depende de variantes reales. Crear una copa visual no activa puede permitir ventas que Winerim no espera descontar como variante copa.
- **Alternativa descartada**: publicar todos los productos con cualquier precio de copa. Aumenta cobertura visual, pero puede crear botones no autorizados por la configuración real del vino.

## 2026-06-04 · Sa Pedrera: verificar orden visual en tablet antes de escalar
- **Decisión**: Considerar verificada por API la pertenencia/nombre de los 14 productos, pero dejar pendiente la validación visual de orden en tablet.
- **Razón**: Agora `export-master` no devuelve `SortOrder` de producto. El XML se envió en orden `D701-D709`, pero la API no demuestra cómo lo presentará la tablet.
- **Alternativa descartada**: asumir que `SortOrder` funciona por el hecho de enviarlo. Ya existe una hipótesis abierta de `Order` vs `SortOrder`; escalarlo sin prueba visual puede reproducir el problema de desorden.

## 2026-06-04 · Kava: restaurar legacy `GENEROSOS` y `DULCES` sin convertirlo en Winerim
- **Decisión**: Mostrar las familias legacy `GENEROSOS` (`2069`) y `DULCES` (`2070`) y hacer vendibles sus 15 productos dentro de familia, manteniendo `UseAsDirectSale=false`.
- **Razón**: Kava pidió recuperar esas familias legacy para operativa de sala. Hacer solo visible la familia no bastaba porque los productos estaban `SaleableAsMain=false`; activar `UseAsDirectSale=true` habría creado duplicados en pantalla raíz.
- **Alternativa descartada**: inventar mappings Winerim o confirmar mappings fuzzy de baja calidad. La mayoría no tienen mapping confirmado y dos candidatos `PENDING/FUZZY` tenían score muy bajo, por lo que mapearlos podría descontar stock del vino equivocado.

## 2026-06-04 · Sa Pedrera: controlar orden visual con `Product.Id`, no `SortOrder`
- **Decisión**: En el piloto `DULCES WINERIM`, sustituir los productos basados en `winerim_id` por IDs correlativos `903701-903709`.
- **Razón**: El vídeo del cliente demuestra que la tablet ordena visualmente por `Product.Id`; `SortOrder` no controla la posición efectiva en esta instalación.
- **Alternativa descartada**: reimportar los mismos productos cambiando solo `SortOrder`. Ya se había enviado así y el cliente seguía viendo `D707`, `D702`, `D706`, etc.

## 2026-06-04 · Sa Pedrera: un solo botón visible por código en `DULCES WINERIM`
- **Decisión**: Dejar un único producto visible por código `D701-D709`: copa si Winerim tiene `serve_by_glass=true`, botella si no hay copa activa.
- **Razón**: El cliente reportó duplicados porque algunos códigos tenían botella y copa en la misma familia. Para validar el orden y la usabilidad, la familia debe mostrar una sola referencia por código.
- **Alternativa descartada**: mantener B+C juntos en la misma familia. Conserva todos los formatos, pero recrea exactamente el problema visual reportado.
