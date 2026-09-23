CREATE OR REPLACE FUNCTION public.review_agora_coverage(p_connection_id uuid, p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_format text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(provider_product_id text, name text, family text, sale_format text, format_key text, agora_price numeric, agora_visible boolean, agora_saleable boolean, linked_winerim_id text, linked_winerim_name text, link_source text, winerim_price numeric, winerim_active boolean, coverage_status text, comparison text, next_action text, total_count bigint)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH guard AS (
  SELECT public.can_access_connection(p_connection_id) AS ok
), pp_wine AS MATERIALIZED (
  SELECT pp.provider_product_id AS pid,
         pp.name,
         pp.family,
         CASE WHEN coalesce(pp.sale_format,'') = '' THEN 'SIN_DATO' ELSE pp.sale_format END AS sale_format,
         public.review_format_key(coalesce(nullif(pp.sale_format,''), pp.name)) AS fkey,
         pp.price,
         (pp.raw_payload -> 'attrs' ->> 'UseAsDirectSale')::boolean AS visible_attr,
         (pp.raw_payload -> 'attrs' ->> 'SaleableAsMain')::boolean AS saleable_attr,
         pp.winerim_wine_id
  FROM public.provider_products pp
  WHERE pp.connection_id = p_connection_id
    AND (SELECT ok FROM guard)
    AND pp.classification_override <> 'NOT_WINE'
    AND public.review_is_wine(pp.family, coalesce(nullif(pp.sale_format,''), pp.name), pp.winerim_wine_id)
), md AS MATERIALIZED (
  SELECT amd.products_summary_json AS products, amd.families_json AS families
  FROM public.agora_master_data amd
  WHERE amd.connection_id = p_connection_id
    AND (SELECT ok FROM guard)
    AND NOT EXISTS (SELECT 1 FROM pp_wine)
  LIMIT 1
), fams AS MATERIALIZED (
  SELECT f ->> 'Id' AS fid, f ->> 'Name' AS fname
  FROM md CROSS JOIN LATERAL jsonb_array_elements(md.families) AS f
), snaps AS MATERIALIZED (
  SELECT DISTINCT ON (s.agora_product_id)
         s.agora_product_id AS pid, s.agora_price, s.winerim_wine_id
  FROM public.catalog_readback_snapshots s
  WHERE s.connection_id = p_connection_id
    AND s.agora_product_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM md)
  ORDER BY s.agora_product_id, s.read_at DESC
), master_wine AS MATERIALIZED (
  SELECT prod ->> 'Id' AS pid,
         prod ->> 'Name' AS name,
         fams.fname AS family,
         'SIN_DATO'::text AS sale_format,
         public.review_format_key(prod ->> 'Name') AS fkey,
         snaps.agora_price AS price,
         (prod ->> 'UseAsDirectSale')::boolean AS visible_attr,
         (prod ->> 'SaleableAsMain')::boolean AS saleable_attr,
         snaps.winerim_wine_id
  FROM md
  CROSS JOIN LATERAL jsonb_array_elements(md.products) AS prod
  LEFT JOIN fams ON fams.fid = prod ->> 'FamilyId'
  LEFT JOIN snaps ON snaps.pid = prod ->> 'Id'
  WHERE public.review_is_wine(fams.fname, prod ->> 'Name', snaps.winerim_wine_id)
), wine AS (
  SELECT * FROM pp_wine
  UNION ALL
  SELECT * FROM master_wine
), linked AS (
  SELECT w.*,
         coalesce(pm.winerim_wine_id, t.winerim_wine_id, w.winerim_wine_id) AS lid,
         CASE
           WHEN pm.winerim_wine_id IS NOT NULL THEN 'MAPA_CONFIRMADO'
           WHEN t.winerim_wine_id IS NOT NULL THEN 'ENVIO_WINERIM'
           WHEN w.winerim_wine_id IS NOT NULL THEN 'CATALOGO_AGORA'
           ELSE NULL
         END AS lsource
  FROM wine w
  LEFT JOIN public.product_mappings pm
    ON pm.connection_id = p_connection_id
   AND pm.provider_product_id = w.pid
   AND pm.status = 'CONFIRMED'
   AND pm.winerim_wine_id IS NOT NULL
  LEFT JOIN public.winerim_push_tracking t
    ON t.connection_id = p_connection_id
   AND t.agora_product_id = w.pid
), resolved AS (
  SELECT l.*,
         ww.name AS lname,
         ww.is_active AS wactive,
         wf.sale_price AS wprice
  FROM linked l
  LEFT JOIN public.winerim_wines ww
    ON ww.connection_id = p_connection_id AND ww.winerim_id = l.lid
  LEFT JOIN public.winerim_wine_formats wf
    ON wf.connection_id = p_connection_id
   AND wf.winerim_id = l.lid
   AND wf.format_key = l.fkey
), classified AS (
  SELECT r.*,
    CASE
      WHEN r.lid IS NULL AND r.fkey = 'SIN_DATO' THEN 'IDENTITY_BLOCKED'
      WHEN r.lid IS NULL THEN 'NOT_IN_WINERIM'
      WHEN r.lname IS NULL THEN 'LINKED_WINE_MISSING'
      WHEN r.wactive IS FALSE THEN 'LINKED_WINE_INACTIVE'
      WHEN r.price IS NOT NULL AND r.wprice IS NOT NULL
           AND abs(r.price - r.wprice) > 0.005 THEN 'LINKED_PRICE_MISMATCH'
      WHEN r.wprice IS NULL THEN 'LINKED_NO_PRICE_REF'
      ELSE 'LINKED_OK'
    END AS coverage_status
  FROM resolved r
), filtered AS (
  SELECT c.* FROM classified c
  WHERE (p_status IS NULL OR p_status = '' OR c.coverage_status = p_status)
    AND (p_format IS NULL OR p_format = '' OR c.fkey = p_format)
    AND (p_search IS NULL OR btrim(p_search) = ''
         OR public.review_normalize_text(c.name) LIKE '%' || public.review_normalize_text(p_search) || '%'
         OR c.pid ILIKE '%' || btrim(p_search) || '%'
         OR coalesce(c.lid,'') ILIKE '%' || btrim(p_search) || '%')
)
SELECT f.pid, f.name, f.family, f.sale_format, f.fkey, f.price,
       f.visible_attr, f.saleable_attr, f.lid, f.lname, f.lsource,
       f.wprice, f.wactive, f.coverage_status,
       CASE f.coverage_status
         WHEN 'LINKED_OK' THEN 'Vinculado a Winerim con precio coincidente.'
         WHEN 'LINKED_PRICE_MISMATCH' THEN 'Vinculado, pero el precio de Ágora y el de Winerim no coinciden.'
         WHEN 'LINKED_NO_PRICE_REF' THEN 'Vinculado, sin precio de referencia en Winerim para ese formato: no se concluye.'
         WHEN 'LINKED_WINE_INACTIVE' THEN 'Vinculado a un vino de Winerim que ya no está activo.'
         WHEN 'LINKED_WINE_MISSING' THEN 'Apunta a un ID de Winerim que no existe en el catálogo leído.'
         WHEN 'NOT_IN_WINERIM' THEN 'Producto de vino en Ágora sin vino de Winerim asociado.'
         ELSE 'Formato de venta sin dato en Ágora: la identidad no se puede cerrar.'
       END AS comparison,
       CASE f.coverage_status
         WHEN 'LINKED_OK' THEN 'Nada que hacer.'
         WHEN 'LINKED_PRICE_MISMATCH' THEN 'Revisar precio y decidir envío controlado.'
         WHEN 'LINKED_NO_PRICE_REF' THEN 'Comprobar el formato y precio en Winerim.'
         WHEN 'LINKED_WINE_INACTIVE' THEN 'Revisar manualmente antes de cualquier cambio en Ágora.'
         WHEN 'LINKED_WINE_MISSING' THEN 'Revisar la vinculación; no se remapea automáticamente.'
         WHEN 'NOT_IN_WINERIM' THEN 'Decidir vino y formato en la pestaña Sin mapear.'
         ELSE 'Confirmar formato con el restaurante.'
       END AS next_action,
       count(*) OVER () AS total_count
FROM filtered f
ORDER BY f.name, f.fkey
LIMIT greatest(coalesce(p_limit,50),1) OFFSET greatest(coalesce(p_offset,0),0);
$function$;

CREATE OR REPLACE FUNCTION public.review_agora_coverage_summary(p_connection_id uuid)
 RETURNS TABLE(agora_wine_products bigint, linked_ok bigint, linked_price_mismatch bigint, linked_no_price_ref bigint, linked_wine_inactive bigint, linked_wine_missing bigint, not_in_winerim bigint, identity_blocked bigint)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH rows AS (
    SELECT * FROM public.review_agora_coverage(p_connection_id, NULL, NULL, NULL, 100000, 0)
  )
  SELECT count(*),
         count(*) FILTER (WHERE r.coverage_status = 'LINKED_OK'),
         count(*) FILTER (WHERE r.coverage_status = 'LINKED_PRICE_MISMATCH'),
         count(*) FILTER (WHERE r.coverage_status = 'LINKED_NO_PRICE_REF'),
         count(*) FILTER (WHERE r.coverage_status = 'LINKED_WINE_INACTIVE'),
         count(*) FILTER (WHERE r.coverage_status = 'LINKED_WINE_MISSING'),
         count(*) FILTER (WHERE r.coverage_status = 'NOT_IN_WINERIM'),
         count(*) FILTER (WHERE r.coverage_status = 'IDENTITY_BLOCKED')
  FROM rows r
$function$;

REVOKE ALL ON FUNCTION public.review_agora_coverage(uuid, text, text, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_agora_coverage_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_agora_coverage(uuid, text, text, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_agora_coverage_summary(uuid) TO authenticated, service_role;