CREATE OR REPLACE FUNCTION public.review_catalog_audit(
  p_connection_id uuid,
  p_search text DEFAULT NULL::text,
  p_status text DEFAULT NULL::text,
  p_format text DEFAULT NULL::text,
  p_readback_max_age_minutes integer DEFAULT 120,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  winerim_id text,
  wine_name text,
  wine_type text,
  format_key text,
  capacity_liters numeric,
  winerim_price numeric,
  agora_price numeric,
  agora_product_id text,
  agora_family_id text,
  agora_family_name text,
  stock_id bigint,
  agora_visible boolean,
  agora_saleable boolean,
  read_at timestamp with time zone,
  readback_fresh boolean,
  detected_at timestamp with time zone,
  queued_at timestamp with time zone,
  applied_at timestamp with time zone,
  push_status text,
  push_error text,
  differences text[],
  audit_status text,
  comparison text,
  next_action text,
  latency_seconds numeric,
  total_count bigint
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
WITH variants AS (
  SELECT v.* FROM public.review_winerim_variants v
  WHERE v.connection_id = p_connection_id AND v.is_active = true
), joined AS (
  SELECT v.winerim_id, v.name AS wine_name, v.wine_type, v.format_key,
         v.capacity_liters, v.sale_price AS winerim_price, v.stock_id,
         s.agora_price, s.agora_product_id, s.agora_family_id, s.agora_family_name,
         s.agora_visible, s.agora_saleable, s.found_in_agora, s.differences,
         s.read_at,
         t.created_at AS detected_at, t.pushed_at AS queued_at,
         t.verified_at AS applied_at, t.sync_status AS push_status,
         t.last_error AS push_error,
         (s.read_at IS NOT NULL
          AND s.read_at >= now() - make_interval(mins => greatest(coalesce(p_readback_max_age_minutes, 120), 1))) AS readback_fresh
  FROM variants v
  LEFT JOIN public.catalog_readback_snapshots s
    ON s.connection_id = p_connection_id
   AND s.winerim_wine_id = v.winerim_id
   AND s.format_key = v.format_key
  LEFT JOIN public.winerim_push_tracking t
    ON t.connection_id = p_connection_id
   AND t.winerim_wine_id = v.winerim_id
   AND upper(coalesce(t.format, '')) = v.format_key
), statused AS (
  SELECT j.*,
    CASE
      WHEN j.format_key IS NULL OR j.format_key = 'SIN_DATO' THEN 'AMBIGUOUS'
      WHEN NOT coalesce(j.readback_fresh, false) AND j.push_status = 'FAILED' THEN 'PUSH_FAILED'
      WHEN NOT coalesce(j.readback_fresh, false)
           AND j.push_status IN ('PENDING', 'QUEUED', 'PUSHED') THEN 'PENDING_PUSH'
      WHEN NOT coalesce(j.readback_fresh, false) THEN 'NO_CURRENT_READBACK'
      WHEN j.found_in_agora IS FALSE THEN 'MISSING_IN_AGORA'
      WHEN j.agora_saleable IS FALSE THEN 'NOT_SALEABLE'
      WHEN j.agora_visible IS FALSE THEN 'HIDDEN'
      WHEN 'FAMILY_MISMATCH' = ANY (coalesce(j.differences, '{}')) THEN 'FAMILY_MISMATCH'
      WHEN 'FORMAT_MISMATCH' = ANY (coalesce(j.differences, '{}')) THEN 'FORMAT_MISMATCH'
      WHEN j.winerim_price IS NOT NULL AND j.agora_price IS NOT NULL
           AND abs(j.winerim_price - j.agora_price) > 0.005 THEN 'PRICE_MISMATCH'
      WHEN j.agora_product_id IS NOT NULL AND j.push_status IS NULL THEN 'LEGACY_ONLY'
      WHEN j.found_in_agora IS TRUE THEN 'MATCHED_LIVE'
      ELSE 'AMBIGUOUS'
    END AS audit_status
  FROM joined j
)
SELECT s.winerim_id, s.wine_name, s.wine_type, s.format_key, s.capacity_liters,
       s.winerim_price, s.agora_price, s.agora_product_id, s.agora_family_id,
       s.agora_family_name, s.stock_id, s.agora_visible, s.agora_saleable,
       s.read_at, s.readback_fresh, s.detected_at, s.queued_at, s.applied_at,
       s.push_status, s.push_error, s.differences, s.audit_status,
       CASE
         WHEN s.audit_status = 'HIDDEN' AND s.agora_saleable = true THEN
           'Existe en Ágora en familia ' || coalesce(s.agora_family_name, s.agora_family_id, 'desconocida') ||
           ', sin tecla principal (sí vendible en la familia).'
         WHEN s.audit_status = 'HIDDEN' AND (s.agora_saleable IS NULL OR s.agora_saleable = false) THEN
           'Existe en Ágora en familia ' || coalesce(s.agora_family_name, s.agora_family_id, 'desconocida') ||
           ', pero no es vendible (oculto).'
         WHEN s.audit_status = 'MATCHED_LIVE' THEN 'Lectura fresca de Ágora coincide con Winerim.'
         WHEN s.audit_status = 'NO_CURRENT_READBACK' THEN 'Sin lectura fresca de Ágora: estado desconocido.'
         WHEN s.audit_status = 'MISSING_IN_AGORA' THEN 'La variante no aparece en la lectura de Ágora.'
         WHEN s.audit_status = 'PRICE_MISMATCH' THEN 'Precio distinto entre Winerim y Ágora.'
         WHEN s.audit_status = 'FORMAT_MISMATCH' THEN 'Formato distinto al esperado.'
         WHEN s.audit_status = 'FAMILY_MISMATCH' THEN 'Familia de Ágora distinta a la esperada.'
         WHEN s.audit_status = 'NOT_SALEABLE' THEN 'Existe en Ágora pero no es vendible.'
         WHEN s.audit_status = 'PENDING_PUSH' THEN 'Envío detectado o encolado, sin readback posterior.'
         WHEN s.audit_status = 'PUSH_FAILED' THEN 'El último envío falló; sin readback que lo confirme.'
         WHEN s.audit_status = 'LEGACY_ONLY' THEN 'Presente en Ágora sin evidencia de envío Winerim.'
         ELSE 'Identidad o formato ambiguo: no se concluye nada.'
       END AS comparison,
       CASE s.audit_status
         WHEN 'MATCHED_LIVE' THEN 'Nada que hacer.'
         WHEN 'NO_CURRENT_READBACK' THEN 'Pedir lectura de Ágora antes de concluir.'
         WHEN 'PRICE_MISMATCH' THEN 'Revisar precio y decidir envío controlado.'
         WHEN 'AMBIGUOUS' THEN 'Confirmar formato con el restaurante.'
         ELSE 'Revisar manualmente antes de cualquier envío.'
       END AS next_action,
       CASE
         WHEN s.detected_at IS NOT NULL AND s.applied_at IS NOT NULL
           THEN round(extract(epoch FROM (s.applied_at - s.detected_at))::numeric, 1)
         ELSE NULL
       END AS latency_seconds,
       count(*) OVER () AS total_count
FROM statused s
WHERE (p_search IS NULL OR btrim(p_search) = ''
       OR public.review_normalize_text(s.wine_name) LIKE '%' || public.review_normalize_text(p_search) || '%'
       OR s.winerim_id ILIKE '%' || btrim(p_search) || '%')
  AND (p_status IS NULL OR p_status = '' OR s.audit_status = p_status)
  AND (p_format IS NULL OR p_format = '' OR s.format_key = p_format)
ORDER BY s.wine_name, s.format_key
LIMIT greatest(coalesce(p_limit, 50), 1) OFFSET greatest(coalesce(p_offset, 0), 0)
$function$;

GRANT EXECUTE ON FUNCTION public.review_catalog_audit(uuid, text, text, text, integer, integer, integer) TO authenticated;