-- Rollback de 20260928_winerim_fleet_evidence.sql. Antes: exportar evidencias si se quieren conservar.
DROP TRIGGER IF EXISTS guard_queue_not_resolved_externally ON public.agora_reversal_queue;
DROP FUNCTION IF EXISTS public.guard_queue_not_resolved_externally();
DROP TRIGGER IF EXISTS guard_agora_resolved_externally ON public.agora_reversal_audit;
DROP FUNCTION IF EXISTS public.guard_agora_resolved_externally();
UPDATE public.agora_reversal_audit SET workflow_status = 'PENDING_REVIEW'
  WHERE workflow_status IN ('RESOLVED_EXTERNALLY','EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE');
ALTER TABLE public.agora_reversal_audit DROP CONSTRAINT agora_reversal_audit_workflow_status_check;
ALTER TABLE public.agora_reversal_audit ADD CONSTRAINT agora_reversal_audit_workflow_status_check CHECK (workflow_status = ANY (ARRAY[
  'PENDING_REVIEW','VERIFIED','REJECTED','READY_TO_REVERSE','REVERSED','FAILED']));
DROP TABLE IF EXISTS public.winerim_daily_reconciliation;
DROP TABLE IF EXISTS public.winerim_external_resolution_evidence;
DROP TABLE IF EXISTS public.winerim_restaurant_links;
