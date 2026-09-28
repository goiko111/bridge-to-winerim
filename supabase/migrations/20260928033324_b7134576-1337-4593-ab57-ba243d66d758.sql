CREATE TABLE public.agora_reversal_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.pos_connections(id),
  business_day date,
  agora_ticket_id text,
  source_line_id text,
  original_invoice text,
  new_invoice text,
  refund_document text,
  refund_source text,
  agora_product_id text,
  winerim_wine_id text,
  price_id text,
  stock_id bigint,
  format_key text,
  original_qty numeric,
  reverse_qty numeric NOT NULL DEFAULT 0 CHECK (reverse_qty >= 0),
  amount numeric,
  sale_id text,
  sale_detail_id text,
  receipt_id text,
  order_id text,
  import_mode text,
  history_applied boolean,
  stock_applied boolean,
  classification text NOT NULL,
  reason text NOT NULL,
  effective_at timestamptz,
  status text NOT NULL DEFAULT 'DETECTED' CHECK (status IN
    ('DETECTED','NEEDS_WINERIM_READBACK','PROBABLE_DUPLICATE','STOCK_CONFLICT','AMBIGUOUS',
     'MATCHED_TO_WINERIM','REVERSAL_PENDING_API','READY_TO_REVERSE','REVERSED','FAILED')),
  confidence text NOT NULL DEFAULT 'low',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  prepared_at timestamptz,
  executed_at timestamptz,
  verified_at timestamptz,
  approved_by uuid,
  executed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, business_day, refund_document, agora_product_id, format_key)
);
GRANT SELECT ON public.agora_reversal_queue TO authenticated;
GRANT ALL ON public.agora_reversal_queue TO service_role;
ALTER TABLE public.agora_reversal_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Reversal queue readable per restaurant" ON public.agora_reversal_queue
  FOR SELECT TO authenticated USING (public.can_access_connection(connection_id));
CREATE INDEX idx_agora_reversal_queue_conn_status ON public.agora_reversal_queue(connection_id, status);
CREATE TRIGGER update_agora_reversal_queue_updated_at BEFORE UPDATE ON public.agora_reversal_queue
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();