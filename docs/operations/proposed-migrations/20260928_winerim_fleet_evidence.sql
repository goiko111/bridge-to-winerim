-- PROPUESTA, NO APLICADA. Rollback: 20260928_winerim_fleet_evidence_rollback.sql
-- 1. Enlace conexión -> restaurantId de Winerim (se rellena leyendo /restaurants con el token del propio restaurante).
CREATE TABLE public.winerim_restaurant_links (
  connection_id uuid PRIMARY KEY REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  winerim_restaurant_id bigint NOT NULL UNIQUE,
  verified_via text NOT NULL DEFAULT 'restaurant_token_restaurants',
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.winerim_restaurant_links TO authenticated;
GRANT ALL ON public.winerim_restaurant_links TO service_role;
ALTER TABLE public.winerim_restaurant_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Links readable per restaurant" ON public.winerim_restaurant_links FOR SELECT TO authenticated USING (public.can_access_connection(connection_id));

-- 2. Evidencias de anulación externa (solo inserción desde servidor, nunca se editan).
CREATE TABLE public.winerim_external_resolution_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_case_id uuid NOT NULL REFERENCES public.agora_reversal_audit(id),
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id),
  winerim_restaurant_id bigint NOT NULL,
  run_id uuid NOT NULL,
  checked_at timestamptz NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('RESOLVED_EXTERNALLY','EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE','NOT_CANCELLED_YET','BLOCKED_DETAIL_SCOPE','NOT_ELIGIBLE','CONFLICT')),
  missing text[] NOT NULL DEFAULT '{}',
  cancelled_sale_id bigint, kept_sale_id bigint, sale_detail_id bigint,
  deletion_reason text, deleted_at timestamptz,
  movement_id bigint, quantity_before integer, change integer, quantity_after integer,
  receipt_id text, expected_restored_qty numeric,
  sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resolved_requires_full_evidence CHECK (verdict <> 'RESOLVED_EXTERNALLY' OR (
    cardinality(missing) = 0 AND cancelled_sale_id IS NOT NULL AND kept_sale_id IS NOT NULL
    AND cancelled_sale_id <> kept_sale_id AND deletion_reason = 'sale_cancelled' AND deleted_at IS NOT NULL
    AND expected_restored_qty IS NOT NULL
    AND (expected_restored_qty = 0 OR (movement_id IS NOT NULL AND quantity_before IS NOT NULL AND quantity_after IS NOT NULL
         AND change = expected_restored_qty AND quantity_after - quantity_before = change))))
);
GRANT SELECT ON public.winerim_external_resolution_evidence TO authenticated;
GRANT ALL ON public.winerim_external_resolution_evidence TO service_role;
ALTER TABLE public.winerim_external_resolution_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Evidence readable per restaurant" ON public.winerim_external_resolution_evidence FOR SELECT TO authenticated USING (public.can_access_connection(connection_id));
CREATE INDEX winerim_ext_evidence_case_idx ON public.winerim_external_resolution_evidence(audit_case_id, checked_at DESC);

-- 3. Reconciliador diario, AUDIT_ONLY.
CREATE TABLE public.winerim_daily_reconciliation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id),
  run_id uuid NOT NULL, business_day date NOT NULL,
  winerim_wine_id text NOT NULL, format_key text NOT NULL,
  agora_net_qty numeric NOT NULL, winerim_history_qty numeric NOT NULL, winerim_stock_units numeric, diff numeric NOT NULL,
  status text NOT NULL CHECK (status IN ('MATCH','WINERIM_EXCESS','WINERIM_MISSING','STOCK_UNKNOWN')),
  manual_action text NOT NULL,
  mode text NOT NULL DEFAULT 'AUDIT_ONLY' CHECK (mode = 'AUDIT_ONLY'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, run_id, business_day, winerim_wine_id, format_key)
);
GRANT SELECT ON public.winerim_daily_reconciliation TO authenticated;
GRANT ALL ON public.winerim_daily_reconciliation TO service_role;
ALTER TABLE public.winerim_daily_reconciliation ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Reconciliation readable per restaurant" ON public.winerim_daily_reconciliation FOR SELECT TO authenticated USING (public.can_access_connection(connection_id));

-- 4. Nuevo estado en la auditoría.
ALTER TABLE public.agora_reversal_audit DROP CONSTRAINT agora_reversal_audit_workflow_status_check;
ALTER TABLE public.agora_reversal_audit ADD CONSTRAINT agora_reversal_audit_workflow_status_check CHECK (workflow_status = ANY (ARRAY[
  'PENDING_REVIEW','VERIFIED','REJECTED','READY_TO_REVERSE','REVERSED','FAILED','RESOLVED_EXTERNALLY','EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE']));

-- 5. Control anti falsos positivos: RESOLVED_EXTERNALLY solo con evidencia completa, mismo restaurante,
--    alcance SALE, duplicado confirmado, y la venta anulada debe ser la única candidata del caso.
CREATE OR REPLACE FUNCTION public.guard_agora_resolved_externally() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE ev record;
BEGIN
  IF NEW.workflow_status = 'RESOLVED_EXTERNALLY' AND OLD.workflow_status IS DISTINCT FROM 'RESOLVED_EXTERNALLY' THEN
    IF NEW.identity_scope IS DISTINCT FROM 'SALE' THEN RAISE EXCEPTION 'RESOLVED_EXTERNALLY solo para identity_scope=SALE'; END IF;
    IF NEW.evidence_classification NOT IN ('CONFIRMED_DUPLICATE_STOCK','CONFIRMED_DUPLICATE_HISTORY') THEN RAISE EXCEPTION 'Clasificación no confirmada'; END IF;
    IF NEW.eligible_for_reversal THEN RAISE EXCEPTION 'Un caso resuelto externamente no puede ser apto para reversión'; END IF;
    SELECT * INTO ev FROM winerim_external_resolution_evidence e
      WHERE e.audit_case_id = NEW.id AND e.verdict = 'RESOLVED_EXTERNALLY' AND e.connection_id = NEW.connection_id
      ORDER BY checked_at DESC LIMIT 1;
    IF ev IS NULL THEN RAISE EXCEPTION 'Sin evidencia RESOLVED_EXTERNALLY para el caso'; END IF;
    IF NOT EXISTS (SELECT 1 FROM winerim_restaurant_links l WHERE l.connection_id = NEW.connection_id AND l.winerim_restaurant_id = ev.winerim_restaurant_id)
      THEN RAISE EXCEPTION 'Restaurante Winerim no coincide con la conexión'; END IF;
    IF (SELECT count(DISTINCT t->>'saleId') FROM jsonb_array_elements(NEW.candidate_targets) t) <> 1
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.candidate_targets) t WHERE (t->>'saleId')::bigint = ev.cancelled_sale_id)
      THEN RAISE EXCEPTION 'La venta anulada no es la candidata del caso'; END IF;
    IF NOT (ev.kept_sale_id::text = ANY (string_to_array(coalesce(NEW.keep_sale_ids,''), ' '))) THEN RAISE EXCEPTION 'La venta conservada no coincide'; END IF;
    IF ev.expected_restored_qty <> coalesce(NEW.bottles_overdeducted,0) THEN RAISE EXCEPTION 'Cantidad restaurada distinta de la auditada'; END IF;
  END IF;
  IF OLD.workflow_status = 'RESOLVED_EXTERNALLY' AND NEW.workflow_status NOT IN ('RESOLVED_EXTERNALLY') THEN
    RAISE EXCEPTION 'Un caso RESOLVED_EXTERNALLY no puede volver a otro estado';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_agora_resolved_externally BEFORE UPDATE OF workflow_status ON public.agora_reversal_audit
  FOR EACH ROW EXECUTE FUNCTION public.guard_agora_resolved_externally();

-- 6. La cola nunca acepta casos resueltos externamente (refuerzo; el guard existente ya exige eligible).
CREATE OR REPLACE FUNCTION public.guard_queue_not_resolved_externally() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM agora_reversal_audit a WHERE a.id = NEW.audit_case_id AND a.workflow_status IN ('RESOLVED_EXTERNALLY','EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE'))
    THEN RAISE EXCEPTION 'Caso resuelto o en verificación externa: no entra en la cola'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_queue_not_resolved_externally BEFORE INSERT OR UPDATE ON public.agora_reversal_queue
  FOR EACH ROW EXECUTE FUNCTION public.guard_queue_not_resolved_externally();
