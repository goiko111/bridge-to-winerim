CREATE OR REPLACE FUNCTION public.schedule_next_queue_batch(fn_url text, service_key text, conn_id text)
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
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object(
      'action', 'process-xml-outbound-queue',
      'connectionId', conn_id,
      'serverLoop', true
    )
  );
END;
$$;