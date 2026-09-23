CREATE OR REPLACE FUNCTION public.review_legacy_products(p_connection_id uuid, p_search text DEFAULT NULL::text, p_state text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(provider_product_id text, name text, family text, sale_format text, format_key text, price numeric, agora_visible boolean, agora_saleable boolean, units_recent numeric, last_sale_at timestamp with time zone, mapping_status text, tracking_status text, legacy_state text, reason text, next_action text, source text, total_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
WITH catalog AS (
  SELECT pp.provider_product_id AS pid,
         pp.name,
         pp.family,
         coalesce(pp.sale_format, '') AS sale_format,
         public.review_format_key(coalesce(nullif(pp.sale_format, ''), pp.name)) AS fkey,
         pp.price,
         (pp.raw_payload -> 'attrs' ->> 'UseAsDirectSale')::boolean AS visible_attr,
         (pp.raw_payload -> 'attrs' ->> 'SaleableAsMain')::boolean AS saleable_attr,
         pp.winerim_wine_id,
         NULL::numeric AS units_recent,
         NULL::timestamp with time zone AS last_sale_at,
         'AGORA_CATALOG'::text AS source
  FROM public.provider_products pp
  WHERE pp.connection_id = p_connection_id
    AND pp.classification_override <> 'NOT_WINE'
    AND public.review_is_wine(pp.family, coalesce(nullif(pp.sale_format, ''), pp.name), pp.winerim_wine_id)
), sold AS (
  SELECT sli.provider_product_id AS pid,
         max(sli.name) AS name,
         max(sli.family) AS family,
         coalesce(max(sli.format), '') AS sale_format,
         public.review_format_key(nullif(coalesce(max(sli.format), ''), '')) AS fkey,
         nullif((array_agg(sli.unit_price ORDER BY sli.created_at DESC NULLS LAST))[1], 0) AS price,
         NULL::boolean AS visible_attr,
         NULL::boolean AS saleable_attr,
         max(sli.winerim_product_id) AS winerim_wine_id,
         sum(sli.quantity) AS units_recent,
         max(sli.created_at) AS last_sale_at,
         'AGORA_SALES'::text AS source
  FROM public.sales_line_items sli
  WHERE sli.connection_id = p_connection_id
    AND sli.provider_product_id IS NOT NULL
    AND sli.created_at >= now() - interval '30 days'
    AND public.review_is_wine(sli.family, sli.format, sli.winerim_product_id)
    AND NOT EXISTS (
      SELECT 1 FROM public.provider_products pp2
      WHERE pp2.connection_id = p_connection_id
        AND pp2.provider_product_id = sli.provider_product_id
    )
  GROUP BY sli.provider_product_id
), wine_products AS (
  SELECT * FROM catalog UNION ALL SELECT * FROM sold
), enriched AS (
  SELECT wp.*,
         pm.status AS mapping_status,
         t.sync_status AS tracking_status
  FROM wine_products wp
  LEFT JOIN public.product_mappings pm
    ON pm.connection_id = p_connection_id
   AND pm.provider_product_id = wp.pid
   AND pm.status = 'CONFIRMED'
  LEFT JOIN public.winerim_push_tracking t
    ON t.connection_id = p_connection_id
   AND t.agora_product_id = wp.pid
), classified AS (
  SELECT e.*,
    CASE
      WHEN e.mapping_status IS NOT NULL THEN 'LEGACY_MAPPED_EXCEPTION'
      WHEN e.fkey = 'SIN_DATO' THEN 'IDENTITY_BLOCKED'
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
         WHEN 'LEGACY_MAPPED_EXCEPTION' THEN 'Ya tiene vino de Winerim asignado (mapa confirmado), aunque está fuera del catálogo canónico.'
         WHEN 'LEGACY_HIDDEN' THEN 'Producto legacy no vendible como principal en la última lectura.'
         WHEN 'LEGACY_VISIBLE' THEN 'Producto legacy activo en el TPV, sin catálogo canónico Winerim.'
         ELSE 'Producto legacy sin mapa ni tracking; visibilidad desconocida.'
       END,
       CASE f.legacy_state
         WHEN 'IDENTITY_BLOCKED' THEN 'Confirmar formato con el restaurante antes de cualquier decisión.'
         WHEN 'LEGACY_MAPPED_EXCEPTION' THEN 'Nada que mapear: revisar la excepción; no se oculta ni se remapea automáticamente.'
         ELSE 'Abrir en revisión y decidir vino y formato exacto.'
       END,
       f.source,
       count(*) OVER () AS total_count
FROM filtered f
ORDER BY f.units_recent DESC NULLS LAST, f.name
LIMIT greatest(coalesce(p_limit, 50), 1) OFFSET greatest(coalesce(p_offset, 0), 0);
$function$;