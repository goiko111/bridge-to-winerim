REVOKE EXECUTE ON FUNCTION public.claim_outbound_tasks(uuid, text[], integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rescue_zombie_outbound_tasks() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.invoke_connection_health_monitor(text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.invoke_connection_health_monitor_secure(text, text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.schedule_next_catalog_batch(text, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.schedule_next_queue_batch(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.claim_outbound_tasks(uuid, text[], integer) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.rescue_zombie_outbound_tasks() TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.invoke_connection_health_monitor(text, text, boolean) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.invoke_connection_health_monitor_secure(text, text, text, boolean) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.schedule_next_catalog_batch(text, text, text, integer, integer) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.schedule_next_queue_batch(text, text, text) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, text) TO authenticated, service_role;