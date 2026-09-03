-- Secure cron helper for connection-health-monitor.
--
-- Use an anon/publishable key only as the normal Edge Function bearer token,
-- and gate email notifications with a separate MONITOR_CRON_SECRET header.
-- This avoids putting the service role key in pg_cron SQL.

CREATE OR REPLACE FUNCTION public.invoke_connection_health_monitor_secure(
  fn_url text,
  bearer_key text,
  monitor_secret text,
  notify_clients boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM net.http_post(
    url := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || bearer_key,
      'apikey', bearer_key,
      'X-Monitor-Secret', monitor_secret
    ),
    body := jsonb_build_object(
      'provider', 'agora',
      'sendEmails', true,
      'notifyClients', notify_clients
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_connection_health_monitor_secure(text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invoke_connection_health_monitor_secure(text, text, text, boolean) TO service_role;
