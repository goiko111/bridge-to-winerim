ALTER TABLE public.agora_reversal_audit ADD COLUMN IF NOT EXISTS candidate_targets jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.agora_reversal_audit ADD CONSTRAINT agora_reversal_audit_targets_is_array CHECK (jsonb_typeof(candidate_targets) = 'array');
COMMENT ON COLUMN public.agora_reversal_audit.candidate_detail_ids IS 'DEPRECATED: informational only. Use candidate_targets.';

CREATE UNIQUE INDEX IF NOT EXISTS agora_reversal_queue_one_per_detail
  ON public.agora_reversal_queue (connection_id, sale_id, sale_detail_id) WHERE sale_detail_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agora_reversal_queue_one_per_case_sale
  ON public.agora_reversal_queue (audit_case_id, sale_id) WHERE sale_detail_id IS NULL;

CREATE OR REPLACE FUNCTION public.guard_agora_reversal_audit()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
DECLARE n int; nd int; s numeric;
BEGIN
  IF NEW.workflow_status IN ('VERIFIED','READY_TO_REVERSE','REVERSED') AND (NEW.verified_by IS NULL OR NEW.verified_at IS NULL) THEN
    RAISE EXCEPTION 'audit %: % requires verified_by and verified_at', NEW.id, NEW.workflow_status; END IF;
  IF NEW.eligible_for_reversal OR NEW.workflow_status IN ('READY_TO_REVERSE','REVERSED') THEN
    IF NEW.evidence_classification NOT IN ('CONFIRMED_DUPLICATE_STOCK','CONFIRMED_DUPLICATE_HISTORY') THEN RAISE EXCEPTION 'audit %: evidence % not reversible', NEW.id, NEW.evidence_classification; END IF;
    IF NEW.reverse_qty <= 0 THEN RAISE EXCEPTION 'audit %: reverse_qty must be > 0', NEW.id; END IF;
    IF NEW.identity_scope NOT IN ('DETAIL','SALE') THEN RAISE EXCEPTION 'audit %: missing exact candidate identity', NEW.id; END IF;
    n := jsonb_array_length(NEW.candidate_targets);
    IF n = 0 THEN RAISE EXCEPTION 'audit %: candidate_targets empty', NEW.id; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.candidate_targets) t
               WHERE coalesce(t->>'saleId','') !~ '^[0-9]+$'
                  OR jsonb_typeof(t->'qty') <> 'number' OR (t->>'qty')::numeric <= 0
                  OR (NEW.identity_scope = 'DETAIL' AND coalesce(t->>'saleDetailId','') !~ '^[0-9]+$')) THEN
      RAISE EXCEPTION 'audit %: malformed candidate target', NEW.id; END IF;
    IF NEW.identity_scope = 'DETAIL' THEN
      SELECT count(DISTINCT t->>'saleDetailId') INTO nd FROM jsonb_array_elements(NEW.candidate_targets) t;
      IF nd <> n THEN RAISE EXCEPTION 'audit %: repeated saleDetailId in targets', NEW.id; END IF;
    ELSE
      SELECT count(DISTINCT t->>'saleId') INTO nd FROM jsonb_array_elements(NEW.candidate_targets) t;
      IF nd <> n THEN RAISE EXCEPTION 'audit %: repeated saleId in targets', NEW.id; END IF;
    END IF;
    SELECT sum((t->>'qty')::numeric) INTO s FROM jsonb_array_elements(NEW.candidate_targets) t;
    IF s <> NEW.reverse_qty THEN RAISE EXCEPTION 'audit %: targets qty % <> reverse_qty %', NEW.id, s, NEW.reverse_qty; END IF;
    IF cardinality(NEW.blockers) > 0 THEN RAISE EXCEPTION 'audit %: blocked by %', NEW.id, NEW.blockers; END IF;
    IF NEW.workflow_status NOT IN ('VERIFIED','READY_TO_REVERSE','REVERSED') THEN RAISE EXCEPTION 'audit %: must be manually VERIFIED first', NEW.id; END IF;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.guard_agora_reversal_queue()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
DECLARE a public.agora_reversal_audit; tq numeric; used numeric;
BEGIN
  IF NEW.audit_case_id IS NULL THEN RAISE EXCEPTION 'queue rows must be promoted from agora_reversal_audit'; END IF;
  SELECT * INTO a FROM public.agora_reversal_audit WHERE id = NEW.audit_case_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'audit case % not found', NEW.audit_case_id; END IF;
  IF NEW.connection_id IS DISTINCT FROM a.connection_id THEN RAISE EXCEPTION 'audit case %: connection mismatch', a.id; END IF;
  IF a.eligible_for_reversal IS NOT TRUE THEN RAISE EXCEPTION 'audit case % not eligible_for_reversal', a.id; END IF;
  IF a.evidence_classification NOT IN ('CONFIRMED_DUPLICATE_STOCK','CONFIRMED_DUPLICATE_HISTORY') THEN RAISE EXCEPTION 'audit case %: evidence % not reversible', a.id, a.evidence_classification; END IF;
  IF a.workflow_status NOT IN ('VERIFIED','READY_TO_REVERSE','REVERSED') OR a.verified_by IS NULL OR a.verified_at IS NULL THEN RAISE EXCEPTION 'audit case % not manually verified', a.id; END IF;
  IF 'ENDPOINT_GRANULARITY_UNKNOWN' = ANY(a.blockers) OR a.endpoint_granularity IS NULL THEN RAISE EXCEPTION 'audit case %: endpoint granularity unknown, stays in audit', a.id; END IF;
  IF cardinality(a.blockers) > 0 THEN RAISE EXCEPTION 'audit case %: blocked by %', a.id, a.blockers; END IF;
  IF a.identity_scope IS DISTINCT FROM a.endpoint_granularity THEN RAISE EXCEPTION 'audit case %: identity % incompatible with endpoint %', a.id, a.identity_scope, a.endpoint_granularity; END IF;
  IF coalesce(NEW.sale_id,'') = '' THEN RAISE EXCEPTION 'audit case %: missing sale_id', a.id; END IF;
  IF NEW.reverse_qty IS NULL OR NEW.reverse_qty <= 0 THEN RAISE EXCEPTION 'audit case %: invalid reverse_qty', a.id; END IF;
  IF a.identity_scope = 'DETAIL' THEN
    IF coalesce(NEW.sale_detail_id,'') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'audit case %: sale_detail_id must be exactly one detail id', a.id; END IF;
    SELECT (t->>'qty')::numeric INTO tq FROM jsonb_array_elements(a.candidate_targets) t
      WHERE t->>'saleId' = NEW.sale_id AND t->>'saleDetailId' = NEW.sale_detail_id;
    IF tq IS NULL THEN RAISE EXCEPTION 'audit case %: (sale %, detail %) is not a candidate target', a.id, NEW.sale_id, NEW.sale_detail_id; END IF;
    IF EXISTS (SELECT 1 FROM public.agora_reversal_queue q WHERE q.id <> NEW.id AND q.connection_id = NEW.connection_id AND q.sale_id = NEW.sale_id AND q.sale_detail_id = NEW.sale_detail_id) THEN
      RAISE EXCEPTION 'audit case %: detail % already promoted', a.id, NEW.sale_detail_id; END IF;
  ELSE
    IF NEW.sale_detail_id IS NOT NULL THEN RAISE EXCEPTION 'audit case %: SALE scope must not carry sale_detail_id', a.id; END IF;
    SELECT (t->>'qty')::numeric INTO tq FROM jsonb_array_elements(a.candidate_targets) t WHERE t->>'saleId' = NEW.sale_id;
    IF tq IS NULL THEN RAISE EXCEPTION 'audit case %: sale % is not a candidate target', a.id, NEW.sale_id; END IF;
    IF EXISTS (SELECT 1 FROM public.agora_reversal_queue q WHERE q.id <> NEW.id AND q.audit_case_id = a.id AND q.sale_id = NEW.sale_id) THEN
      RAISE EXCEPTION 'audit case %: sale % already promoted', a.id, NEW.sale_id; END IF;
  END IF;
  IF NEW.reverse_qty <> tq THEN RAISE EXCEPTION 'audit case %: qty % <> target qty %', a.id, NEW.reverse_qty, tq; END IF;
  SELECT coalesce(sum(q.reverse_qty),0) INTO used FROM public.agora_reversal_queue q WHERE q.audit_case_id = a.id AND q.id <> NEW.id;
  IF used + NEW.reverse_qty > a.reverse_qty THEN RAISE EXCEPTION 'audit case %: promoted qty exceeds case reverse_qty', a.id; END IF;
  IF a.endpoint_reverts_history IS NOT TRUE THEN RAISE EXCEPTION 'audit case %: endpoint does not revert history', a.id; END IF;
  IF a.evidence_classification = 'CONFIRMED_DUPLICATE_STOCK' AND a.endpoint_reverts_stock IS NOT TRUE THEN RAISE EXCEPTION 'audit case %: endpoint does not revert stock', a.id; END IF;
  IF a.reverse_qty < coalesce(a.history_units_excess, a.reverse_qty) AND a.endpoint_partial_qty IS NOT TRUE THEN RAISE EXCEPTION 'audit case %: partial reversal unsupported', a.id; END IF;
  RETURN NEW;
END $function$;