# Paquete pendiente de OK de Goiko — copas body.wine + corte 30-sep

Un único cambio en agora-proxy, sobre la versión de producción actual:

a) `resolveGlassViaWines`: `const wine = extractWineFromBody(body);` (antes leía `body.data`).
b) `syncStockForDays` (punto común de intradía, repaso de días anteriores y reintentos):
   al entrar, `partitionDaysByCutoff(days)`; solo procesa `allowed`; los `held` se
   registran con `SEPTEMBER_PENDING_APPROVAL` y no se envían ni marcan como enviados.

Alternativa sin código (existe hoy): `provider_config.stock_sync_not_before = "2026-09-30"`
por conexión; también filtra repaso e intradía. Es escritura de configuración → OK de Goiko.

Volver atrás: revertir las dos líneas y publicar agora-proxy.
