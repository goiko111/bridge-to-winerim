
-- Índice cubriente para idempotencia: connection + task_type + status (parcial, solo pendientes)
CREATE INDEX IF NOT EXISTS idx_outbound_tasks_pending_lookup
  ON public.outbound_tasks (connection_id, task_type, status)
  WHERE status IN ('QUEUED','RUNNING');

-- Índice por wine_id extraído del JSON (acelera .contains payload_json wine_id)
CREATE INDEX IF NOT EXISTS idx_outbound_tasks_wine_id
  ON public.outbound_tasks ((payload_json->>'_winerim_wine_id'))
  WHERE task_type = 'AGORA_XML_UPSERT_PRODUCT';

-- Índice para detectar fallos en ventana 24h
CREATE INDEX IF NOT EXISTS idx_outbound_tasks_failed_recent
  ON public.outbound_tasks (connection_id, task_type, status, created_at DESC)
  WHERE status IN ('FAILED','BLOCKED');

-- Backoff: cuándo puede reintentarse una tarea
ALTER TABLE public.outbound_tasks
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_outbound_tasks_ready_to_run
  ON public.outbound_tasks (connection_id, status, next_retry_at)
  WHERE status = 'QUEUED';

-- Circuit breaker en pos_connections
ALTER TABLE public.pos_connections
  ADD COLUMN IF NOT EXISTS circuit_breaker_paused_until timestamptz,
  ADD COLUMN IF NOT EXISTS circuit_breaker_reason text,
  ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;
