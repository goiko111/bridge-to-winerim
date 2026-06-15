-- Cloudflare control-plane onboarding requests.
--
-- This table intentionally stores only sanitized onboarding metadata and secret
-- references. Raw POS/Winerim tokens must not be inserted here.

CREATE OR REPLACE FUNCTION public.jsonb_contains_forbidden_secret_key(p_payload JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  item RECORD;
  element JSONB;
BEGIN
  IF p_payload IS NULL THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_payload) = 'object' THEN
    FOR item IN SELECT key, value FROM jsonb_each(p_payload)
    LOOP
      IF item.key ~* '(token|secret|password|credential|api[_-]?key)' THEN
        RETURN true;
      END IF;

      IF jsonb_typeof(item.value) IN ('object', 'array') AND public.jsonb_contains_forbidden_secret_key(item.value) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(p_payload) = 'array' THEN
    FOR element IN SELECT value FROM jsonb_array_elements(p_payload)
    LOOP
      IF jsonb_typeof(element) IN ('object', 'array') AND public.jsonb_contains_forbidden_secret_key(element) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;

  RETURN false;
END;
$$;

CREATE TABLE IF NOT EXISTS public.onboarding_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  location_name TEXT NOT NULL,
  pos_base_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  source TEXT NOT NULL DEFAULT 'commercial_onboarding',
  requested_by UUID,
  requested_by_email TEXT,
  normalized_input JSONB NOT NULL DEFAULT '{}'::jsonb,
  test_gates JSONB NOT NULL DEFAULT '[]'::jsonb,
  test_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_refs JSONB NOT NULL DEFAULT '{}'::jsonb,
  ready_for_technical_review BOOLEAN NOT NULL DEFAULT false,
  connection_id UUID REFERENCES public.pos_connections(id) ON DELETE SET NULL,
  notes TEXT,
  submitted_at TIMESTAMP WITH TIME ZONE,
  tested_at TIMESTAMP WITH TIME ZONE,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  converted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_requests_provider_check
    CHECK (provider IN ('agora', 'revo')),
  CONSTRAINT onboarding_requests_status_check
    CHECK (status IN (
      'DRAFT',
      'TESTED',
      'READY_FOR_TECHNICAL_REVIEW',
      'TECHNICAL_REVIEW',
      'APPROVED',
      'REJECTED',
      'CONVERTED',
      'CANCELED'
    )),
  CONSTRAINT onboarding_requests_no_plaintext_normalized_input
    CHECK (NOT public.jsonb_contains_forbidden_secret_key(normalized_input)),
  CONSTRAINT onboarding_requests_no_plaintext_test_summary
    CHECK (NOT public.jsonb_contains_forbidden_secret_key(test_summary)),
  CONSTRAINT onboarding_requests_no_plaintext_test_gates
    CHECK (NOT public.jsonb_contains_forbidden_secret_key(test_gates)),
  CONSTRAINT onboarding_requests_no_plaintext_secret_refs
    CHECK (NOT public.jsonb_contains_forbidden_secret_key(secret_refs)),
  CONSTRAINT onboarding_requests_json_shapes
    CHECK (
      jsonb_typeof(normalized_input) = 'object'
      AND jsonb_typeof(test_summary) = 'object'
      AND jsonb_typeof(secret_refs) = 'object'
      AND jsonb_typeof(test_gates) = 'array'
    )
);

ALTER TABLE public.onboarding_requests ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_onboarding_requests_status_created
  ON public.onboarding_requests(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_onboarding_requests_provider_created
  ON public.onboarding_requests(provider, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_onboarding_requests_connection
  ON public.onboarding_requests(connection_id)
  WHERE connection_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_onboarding_requests_updated_at ON public.onboarding_requests;
CREATE TRIGGER update_onboarding_requests_updated_at
  BEFORE UPDATE ON public.onboarding_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.onboarding_requests IS
  'Sanitized commercial onboarding requests for the Cloudflare control plane. Does not store raw tokens.';

COMMENT ON COLUMN public.onboarding_requests.normalized_input IS
  'Sanitized provider/location/base URL metadata only. Raw tokens are forbidden by CHECK constraint.';

COMMENT ON COLUMN public.onboarding_requests.secret_refs IS
  'References to external secret storage/encrypted material. Do not store raw token values here.';
