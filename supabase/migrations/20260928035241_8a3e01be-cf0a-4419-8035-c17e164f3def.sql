CREATE TABLE public.agora_reversal_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_fingerprint text NOT NULL UNIQUE,
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id),
  business_day date NOT NULL,
  agora_ticket_id text, source_line_id text, original_invoice text, new_invoice text,
  refund_document text NOT NULL, refund_source text,
  agora_product_id text NOT NULL, winerim_wine_id text, format_key text NOT NULL,
  original_qty numeric, reverse_qty numeric NOT NULL DEFAULT 0 CHECK (reverse_qty >= 0),
  amount numeric,
  keep_sale_ids text, keep_detail_ids text,
  candidate_sale_id text, candidate_detail_ids text, receipt_id text, order_id text, import_mode text,
  movement_ids text, history_units_excess numeric, bottles_overdeducted numeric,
  evidence_classification text NOT NULL CHECK (evidence_classification IN ('CONFIRMED_DUPLICATE_STOCK','CONFIRMED_DUPLICATE_HISTORY','PROBABLE_DUPLICATE','AMBIGUOUS','STOCK_CONFLICT','NEEDS_WINERIM_READBACK','SUPERSEDED_AT_SOURCE')),
  cup_classification text CHECK (cup_classification IN ('CUP_HISTORY_MATCHED_STOCK_NOT_EXPECTED','CUP_OPENING_EFFECT_CONFIRMED','CUP_STOCK_UNKNOWN','CUP_REAL_STOCK_CONFLICT')),
  blockers text[] NOT NULL DEFAULT '{}',
  workflow_status text NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (workflow_status IN ('PENDING_REVIEW','VERIFIED','REJECTED','READY_TO_REVERSE','REVERSED','FAILED')),
  eligible_for_reversal boolean NOT NULL DEFAULT false,
  confidence text NOT NULL DEFAULT 'low', reason text, evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_file text, verified_by uuid, verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.agora_reversal_audit TO authenticated;
GRANT ALL ON public.agora_reversal_audit TO service_role;
ALTER TABLE public.agora_reversal_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Reversal audit readable per restaurant" ON public.agora_reversal_audit
  FOR SELECT TO authenticated USING (public.can_access_connection(connection_id));
CREATE TRIGGER update_agora_reversal_audit_updated_at BEFORE UPDATE ON public.agora_reversal_audit
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.guard_agora_reversal_audit() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.eligible_for_reversal OR NEW.workflow_status IN ('READY_TO_REVERSE','REVERSED') THEN
    IF NEW.evidence_classification NOT IN ('CONFIRMED_DUPLICATE_STOCK','CONFIRMED_DUPLICATE_HISTORY') THEN RAISE EXCEPTION 'audit %: evidence % not reversible', NEW.id, NEW.evidence_classification; END IF;
    IF NEW.reverse_qty <= 0 THEN RAISE EXCEPTION 'audit %: reverse_qty must be > 0', NEW.id; END IF;
    IF coalesce(NEW.candidate_sale_id,'') = '' OR coalesce(NEW.candidate_detail_ids,'') = '' THEN RAISE EXCEPTION 'audit %: missing exact candidate sale/detail identity', NEW.id; END IF;
    IF NEW.blockers && ARRAY['STOCK_UNKNOWN','AMBIGUOUS','SOURCE_INCOMPLETE','ENDPOINT_GRANULARITY_UNKNOWN'] THEN RAISE EXCEPTION 'audit %: blocked by %', NEW.id, NEW.blockers; END IF;
    IF NEW.workflow_status NOT IN ('VERIFIED','READY_TO_REVERSE','REVERSED') OR NEW.verified_by IS NULL THEN RAISE EXCEPTION 'audit %: must be manually VERIFIED first', NEW.id; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_agora_reversal_audit BEFORE INSERT OR UPDATE ON public.agora_reversal_audit
  FOR EACH ROW EXECUTE FUNCTION public.guard_agora_reversal_audit();

-- Queue: only promoted, verified cases.
DELETE FROM public.agora_reversal_queue WHERE status = 'PROBABLE_DUPLICATE';
ALTER TABLE public.agora_reversal_queue ADD COLUMN audit_case_id uuid REFERENCES public.agora_reversal_audit(id),
  ADD COLUMN endpoint_granularity_supported boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX agora_reversal_queue_audit_case_uidx ON public.agora_reversal_queue(audit_case_id);
CREATE OR REPLACE FUNCTION public.guard_agora_reversal_queue() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE a public.agora_reversal_audit;
BEGIN
  IF NEW.audit_case_id IS NULL THEN RAISE EXCEPTION 'queue rows must be promoted from agora_reversal_audit'; END IF;
  SELECT * INTO a FROM public.agora_reversal_audit WHERE id = NEW.audit_case_id;
  IF a.workflow_status NOT IN ('VERIFIED','READY_TO_REVERSE','REVERSED') OR a.verified_by IS NULL THEN RAISE EXCEPTION 'audit case % not manually verified', a.id; END IF;
  IF NEW.status IN ('READY_TO_REVERSE','REVERSED') THEN
    IF NOT a.eligible_for_reversal THEN RAISE EXCEPTION 'audit case % not eligible', a.id; END IF;
    IF NOT NEW.endpoint_granularity_supported THEN RAISE EXCEPTION 'endpoint granularity not confirmed for %', a.id; END IF;
    IF NEW.reverse_qty <= 0 OR coalesce(NEW.sale_id,'') = '' OR coalesce(NEW.sale_detail_id,'') = '' THEN RAISE EXCEPTION 'missing qty or exact sale/detail identity'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_agora_reversal_queue BEFORE INSERT OR UPDATE ON public.agora_reversal_queue
  FOR EACH ROW EXECUTE FUNCTION public.guard_agora_reversal_queue();
