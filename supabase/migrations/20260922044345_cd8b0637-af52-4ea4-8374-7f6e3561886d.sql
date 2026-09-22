CREATE INDEX IF NOT EXISTS idx_sli_conn_pid_created ON public.sales_line_items (connection_id, provider_product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pp_conn_pid ON public.provider_products (connection_id, provider_product_id);
CREATE INDEX IF NOT EXISTS idx_wpt_conn_agora_pid ON public.winerim_push_tracking (connection_id, agora_product_id);
CREATE INDEX IF NOT EXISTS idx_pm_conn_pid_status ON public.product_mappings (connection_id, provider_product_id, status);

CREATE OR REPLACE FUNCTION public.review_legacy_products(p_connection_id uuid, p_search text DEFAULT NULL::text, p_state text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(provider_product_id text, name text, family text, sale_format text, format_key text, price numeric, agora_visible boolean, agora_saleable boolean, units_recent numeric, last_sale_at timestamp with time zone, mapping_status text, tracking_status text, legacy_state text, reason text, next_action text, source text, total_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
WITH sales AS (
  SELECT sli.provider_product_id AS pid,
         max(sli.name) AS name,
         max(sli.family) AS family,
         coalesce(max(sli.format), '') AS sale_format,
         max(sli.winerim_product_id) AS winerim_wine_id,
         sum(sli.quantity) FILTER (WHERE sli.created_at >= now() - interval '30 days') AS units_recent,
         max(sli.created_at) AS last_sale_at,
         bool_or(public.review_is_wine(sli.family, sli.format, sli.winerim_product_id)) AS is_wine
  FROM public.sales_line_items sli
  WHERE sli.connection_id = p_connection_id
    AND sli.provider_product_id IS NOT NULL
    AND sli.created_at >= now() - interval '90 days'
  GROUP BY sli.provider_product_id
), catalog AS (
  SELECT pp.provider_product_id AS pid, pp.name, pp.family,
         coalesce(pp.sale_format, '') AS sale_format,
         public.review_format_key(coalesce(nullif(pp.sale_format, ''), pp.name)) AS fkey,
         pp.price,
         (pp.raw_payload -> 'attrs' ->> 'UseAsDirectSale')::boolean AS visible_attr,
         (pp.raw_payload -> 'attrs' ->> 'SaleableAsMain')::boolean AS saleable_attr,
         pp.winerim_wine_id,
         'AGORA_CATALOG'::text AS source
  FROM public.provider_products pp
  WHERE pp.connection_id = p_connection_id
    AND pp.classification_override <> 'NOT_WINE'
    AND public.review_is_wine(pp.family, coalesce(nullif(pp.sale_format, ''), pp.name), pp.winerim_wine_id)
), sold AS (
  SELECT s.pid, s.name, s.family, s.sale_format,
         public.review_format_key(nullif(s.sale_format, '')) AS fkey,
         NULL::numeric AS price, NULL::boolean AS visible_attr, NULL::boolean AS saleable_attr,
         s.winerim_wine_id, 'AGORA_SALES'::text AS source
  FROM sales s
  WHERE s.is_wine
    AND NOT EXISTS (
      SELECT 1 FROM public.provider_products pp2
      WHERE pp2.connection_id = p_connection_id
        AND pp2.provider_product_id = s.pid
    )
), wine_products AS (
  SELECT * FROM catalog UNION ALL SELECT * FROM sold
), enriched AS (
  SELECT wp.*, pm.status AS mapping_status, t.sync_status AS tracking_status,
         sa.units_recent, sa.last_sale_at
  FROM wine_products wp
  LEFT JOIN public.product_mappings pm
    ON pm.connection_id = p_connection_id
   AND pm.provider_product_id = wp.pid
   AND pm.status = 'CONFIRMED'
  LEFT JOIN public.winerim_push_tracking t
    ON t.connection_id = p_connection_id AND t.agora_product_id = wp.pid
  LEFT JOIN sales sa ON sa.pid = wp.pid
), classified AS (
  SELECT e.*,
    CASE
      WHEN e.fkey = 'SIN_DATO' THEN 'IDENTITY_BLOCKED'
      WHEN e.mapping_status IS NOT NULL THEN 'LEGACY_MAPPED_EXCEPTION'
      WHEN e.visible_attr IS FALSE THEN 'LEGACY_HIDDEN'
      WHEN e.visible_attr IS TRUE THEN 'LEGACY_VISIBLE'
      ELSE 'LEGACY_ONLY'
    END AS legacy_state
  FROM enriched e
  WHERE e.tracking_status IS NULL OR e.mapping_status IS NULL
), filtered AS (
  SELECT c.* FROM classified c
  WHERE (p_state IS NULL OR c.legacy_state = p_state)
    AND (
      p_search IS NULL OR p_search = ''
      OR public.review_normalize_text(c.name) LIKE '%' || public.review_normalize_text(p_search) || '%'
      OR c.pid LIKE '%' || p_search || '%'
    )
)
SELECT f.pid, f.name, f.family,
       CASE WHEN f.sale_format = '' THEN 'SIN_DATO' ELSE f.sale_format END,
       f.fkey, f.price, f.visible_attr, f.saleable_attr, f.units_recent,
       f.last_sale_at, f.mapping_status, f.tracking_status, f.legacy_state,
       CASE f.legacy_state
         WHEN 'IDENTITY_BLOCKED' THEN 'Formato de venta sin dato en Ágora: la identidad no se puede cerrar.'
         WHEN 'LEGACY_MAPPED_EXCEPTION' THEN 'Producto fuera del catálogo canónico pero con mapa confirmado.'
         WHEN 'LEGACY_HIDDEN' THEN 'Producto legacy no vendible como principal en la última lectura.'
         WHEN 'LEGACY_VISIBLE' THEN 'Producto legacy activo en el TPV, sin catálogo canónico Winerim.'
         ELSE 'Producto legacy sin mapa ni tracking; visibilidad desconocida.'
       END,
       CASE f.legacy_state
         WHEN 'IDENTITY_BLOCKED' THEN 'Confirmar formato con el restaurante antes de cualquier decisión.'
         WHEN 'LEGACY_MAPPED_EXCEPTION' THEN 'Revisar la excepción; no se oculta ni se remapea automáticamente.'
         ELSE 'Abrir en revisión y decidir vino y formato exacto.'
       END,
       f.source,
       count(*) OVER () AS total_count
FROM filtered f
ORDER BY f.units_recent DESC NULLS LAST, f.name
LIMIT greatest(coalesce(p_limit, 50), 1) OFFSET greatest(coalesce(p_offset, 0), 0);
$function$;

REVOKE ALL ON FUNCTION public.review_legacy_products(uuid, text, text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.review_legacy_products(uuid, text, text, integer, integer) TO authenticated;