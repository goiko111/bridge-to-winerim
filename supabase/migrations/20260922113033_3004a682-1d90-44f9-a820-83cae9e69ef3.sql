DROP FUNCTION IF EXISTS public.review_unmapped_products(uuid, text, text, text, text, integer, integer, integer) CASCADE;

CREATE OR REPLACE FUNCTION public.review_unmapped_products(
  p_connection_id uuid,
  p_search text DEFAULT NULL::text,
  p_family text DEFAULT NULL::text,
  p_format text DEFAULT NULL::text,
  p_status text DEFAULT NULL::text,
  p_days integer DEFAULT 30,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  provider_product_id text,
  provider_product_name text,
  family text,
  sale_format text,
  format_key text,
  units numeric,
  line_count integer,
  last_sale_at timestamp with time zone,
  agora_price numeric,
  decision_status text,
  selected_winerim_id text,
  selected_winerim_name text,
  selected_format_key text,
  force_ready boolean,
  note text,
  decided_at timestamp with time zone,
  total_count bigint
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
WITH sold AS (
  SELECT sli.provider_product_id pid, max(sli.name) pname, max(sli.family) pfamily, coalesce(sli.format,'') pformat, public.review_format_key(sli.format) fkey, sum(sli.quantity) units, count(*)::int line_count, max(sli.created_at) last_sale_at
  FROM public.sales_line_items sli
  WHERE sli.connection_id=p_connection_id AND sli.provider_product_id IS NOT NULL AND sli.created_at >= now()-make_interval(days=>greatest(coalesce(p_days,30),1)) AND public.review_is_wine(sli.family,sli.format,sli.winerim_product_id)
  GROUP BY sli.provider_product_id,coalesce(sli.format,''),public.review_format_key(sli.format)
), unmapped AS (
  SELECT s.* FROM sold s WHERE NOT EXISTS (
    SELECT 1 FROM public.product_mappings pm WHERE pm.connection_id=p_connection_id AND pm.provider_product_id=s.pid AND pm.status='CONFIRMED' AND (upper(coalesce(pm.format_type,''))=s.fkey OR s.fkey='SIN_DATO')
  )
), joined AS (
  SELECT u.pid,coalesce(pp.name,u.pname) pname,coalesce(u.pfamily,pp.family) pfamily,u.pformat,u.fkey,u.units,u.line_count,u.last_sale_at,pp.price agora_price,coalesce(d.status,'DRAFT') decision_status,d.selected_winerim_id,d.selected_winerim_name,d.selected_format_key,coalesce(d.force_ready,false) force_ready,d.note,d.decided_at
  FROM unmapped u LEFT JOIN public.provider_products pp ON pp.connection_id=p_connection_id AND pp.provider_product_id=u.pid
  LEFT JOIN public.catalog_review_decisions d ON d.connection_id=p_connection_id AND d.provider_product_id=u.pid AND d.sale_format=CASE WHEN u.pformat='' THEN 'SIN_DATO' ELSE u.pformat END
), filtered AS (
  SELECT j.* FROM joined j WHERE (p_search IS NULL OR btrim(p_search)='' OR public.review_normalize_text(j.pname) LIKE '%'||public.review_normalize_text(p_search)||'%' OR j.pid ILIKE '%'||btrim(p_search)||'%') AND (p_family IS NULL OR p_family='' OR j.pfamily=p_family) AND (p_format IS NULL OR p_format='' OR j.fkey=p_format) AND (p_status IS NULL OR p_status='' OR j.decision_status=p_status)
)
SELECT f.pid,f.pname,f.pfamily,CASE WHEN f.pformat='' THEN 'SIN_DATO' ELSE f.pformat END,f.fkey,f.units,f.line_count,f.last_sale_at,f.agora_price,f.decision_status,f.selected_winerim_id,f.selected_winerim_name,f.selected_format_key,f.force_ready,f.note,f.decided_at,count(*) OVER () total_count
FROM filtered f ORDER BY f.units DESC NULLS LAST,f.pname LIMIT greatest(coalesce(p_limit,50),1) OFFSET greatest(coalesce(p_offset,0),0)
$function$;

GRANT EXECUTE ON FUNCTION public.review_unmapped_products(uuid, text, text, text, text, integer, integer, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.review_unmapped_counters(
  p_connection_id uuid,
  p_days integer DEFAULT 30
)
RETURNS TABLE(total bigint, draft bigint, ready bigint, no_match bigint, needs_confirmation bigint, sin_dato bigint, units numeric)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
   SELECT count(*),
          count(*) FILTER (WHERE r.decision_status = 'DRAFT'),
          count(*) FILTER (WHERE r.decision_status = 'READY_FOR_APPROVAL'),
          count(*) FILTER (WHERE r.decision_status = 'NO_MATCH'),
          count(*) FILTER (WHERE r.decision_status = 'NEEDS_CONFIRMATION'),
          count(*) FILTER (WHERE r.format_key = 'SIN_DATO'),
          coalesce(sum(r.units), 0)
   FROM public.review_unmapped_products(
     p_connection_id, NULL, NULL, NULL, NULL, p_days, 100000, 0) r
$function$;

GRANT EXECUTE ON FUNCTION public.review_unmapped_counters(uuid, integer) TO authenticated, service_role;
