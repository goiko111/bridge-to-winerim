CREATE OR REPLACE FUNCTION public.schedule_next_catalog_batch(fn_url text, service_key text, conn_id text, next_offset integer, next_batch_size integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM net.http_post(
    url := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object(
      'action', 'fetch-catalog',
      'connectionId', conn_id,
      'mode', 'enrich',
      'detailOffset', next_offset,
      'detailBatchSize', next_batch_size
    )
  );
END;
$function$;