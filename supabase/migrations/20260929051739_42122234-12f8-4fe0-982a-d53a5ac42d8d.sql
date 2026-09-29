create or replace function public.reconciliation_v2_json_array(p_value jsonb, p_field text) returns jsonb
language plpgsql immutable set search_path = '' as $f$
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then return '[]'::jsonb; end if;
  if jsonb_typeof(p_value) <> 'array' then raise exception 'invalid % payload: %', p_field, jsonb_typeof(p_value); end if;
  return p_value;
end $f$;
revoke all on function public.reconciliation_v2_json_array(jsonb,text) from public,anon,authenticated;
grant execute on function public.reconciliation_v2_json_array(jsonb,text) to service_role;

create or replace function public.reconciliation_v2_commit_sales_page(
  p_connection_id uuid, p_restaurant_id bigint, p_request_id uuid, p_records jsonb, p_deletions jsonb,
  p_next_cursor text, p_has_more boolean, p_overlap_from timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare item jsonb; line jsonb; affected integer := 0;
begin
  if not exists (select 1 from public.winerim_restaurant_bindings b where b.connection_id=p_connection_id and b.winerim_restaurant_id=p_restaurant_id and b.status='ACTIVE') then raise exception 'binding mismatch'; end if;
  if jsonb_typeof(p_records) <> 'array' or jsonb_typeof(p_deletions) <> 'array' then raise exception 'invalid page payload'; end if;
  for item in select value from jsonb_array_elements(p_records) loop
    insert into public.winerim_sales_records(connection_id,sale_id,restaurant_id,status,effective_at,time_reliable,recorded_at,source_updated_at,wine_id,price_id,stock_id,format_key,qty,served_qty,amount_minor,currency,source_origin,source_channel,source_contract,external_order_id,raw,updated_at)
    values (p_connection_id,(item->>'saleId')::bigint,p_restaurant_id,item->>'status',(item->>'effectiveAt')::timestamp,(item->>'timeReliable')::boolean,nullif(item->>'recordedAt','')::timestamptz,(item->>'updatedAt')::timestamptz,(item#>>'{wine,wineId}')::bigint,(item#>>'{variant,priceId}')::bigint,nullif(item#>>'{variant,stockId}','')::bigint,item#>>'{variant,format}',(item->>'qty')::numeric,nullif(item->>'servedQty','')::numeric,case when item#>>'{amounts,total}' is null then null else round((item#>>'{amounts,total}')::numeric*100)::bigint end,item#>>'{amounts,currency}',item#>>'{source,origin}',item#>>'{source,channel}',item#>>'{source,contract}',item#>>'{source,externalOrderId}',item,now())
    on conflict (connection_id,sale_id) do update set status=excluded.status,effective_at=excluded.effective_at,time_reliable=excluded.time_reliable,recorded_at=excluded.recorded_at,source_updated_at=excluded.source_updated_at,wine_id=excluded.wine_id,price_id=excluded.price_id,stock_id=excluded.stock_id,format_key=excluded.format_key,qty=excluded.qty,served_qty=excluded.served_qty,amount_minor=excluded.amount_minor,currency=excluded.currency,source_origin=excluded.source_origin,source_channel=excluded.source_channel,source_contract=excluded.source_contract,external_order_id=excluded.external_order_id,raw=excluded.raw,updated_at=now();
    delete from public.winerim_sales_lines where connection_id=p_connection_id and sale_id=(item->>'saleId')::bigint;
    for line in select value from jsonb_array_elements(public.reconciliation_v2_json_array(item->'lines','lines')) loop
      insert into public.winerim_sales_lines(connection_id,sale_id,line_id,sale_detail_id,line_type,source_system,external_order_id,source_line_id,invoice_id,receipt_id,wine_id,price_id,stock_id,format_key,qty,unit_amount_minor,total_amount_minor,effective_at,stock_effect_known,stock_effect_status,stock_applied,stock_movement_ids,stock_movement_difference,stock_unbacked_qty,raw)
      values (p_connection_id,(item->>'saleId')::bigint,line->>'lineId',nullif(line->>'saleDetailId','')::bigint,line->>'lineType',line#>>'{source,sourceSystem}',coalesce(line#>>'{source,externalOrderId}',item#>>'{source,externalOrderId}'),line#>>'{source,sourceLineId}',line#>>'{source,invoiceId}',line#>>'{source,receiptId}',(item#>>'{wine,wineId}')::bigint,(item#>>'{variant,priceId}')::bigint,nullif(item#>>'{variant,stockId}','')::bigint,coalesce(line->>'format',item#>>'{variant,format}'),(line->>'qty')::numeric,case when line->>'unitAmount' is null then null else round((line->>'unitAmount')::numeric*100)::bigint end,case when line->>'totalAmount' is null then null else round((line->>'totalAmount')::numeric*100)::bigint end,(line->>'effectiveAt')::timestamp,(line#>>'{stockEffect,known}')::boolean,line#>>'{stockEffect,status}',nullif(line#>>'{stockEffect,stockApplied}','')::boolean,array(select (m->>'stockMovementId')::bigint from jsonb_array_elements(public.reconciliation_v2_json_array(line#>'{stockEffect,movements}','stockEffect.movements')) m),(select sum(nullif(m->>'difference','')::numeric) from jsonb_array_elements(public.reconciliation_v2_json_array(line#>'{stockEffect,movements}','stockEffect.movements')) m),nullif(line#>>'{stockEffect,unbackedQty}','')::numeric,line);
    end loop;
    affected := affected + 1;
  end loop;
  for item in select value from jsonb_array_elements(p_deletions) loop
    insert into public.winerim_sale_deletions(connection_id,sale_id,sale_detail_id,line_id,reason,deleted_at,effective_at,external_order_id,raw)
    values(p_connection_id,(item->>'saleId')::bigint,nullif(item->>'saleDetailId','')::bigint,item->>'lineId',item->>'reason',(item->>'deletedAt')::timestamptz,nullif(item->>'effectiveAt','')::timestamp,item->>'externalOrderId',item)
    on conflict do nothing;
  end loop;
  insert into public.winerim_sync_checkpoints(connection_id,stream,cursor,overlap_from,last_complete_at,last_request_id,coverage_complete,last_error_code)
  values(p_connection_id,'sales_records',p_next_cursor,p_overlap_from,case when not p_has_more then now() end,p_request_id,not p_has_more,null)
  on conflict(connection_id,stream) do update set cursor=excluded.cursor,overlap_from=greatest(public.winerim_sync_checkpoints.overlap_from,excluded.overlap_from),last_complete_at=coalesce(excluded.last_complete_at,public.winerim_sync_checkpoints.last_complete_at),last_request_id=excluded.last_request_id,coverage_complete=excluded.coverage_complete,last_error_code=null;
  return jsonb_build_object('records',affected,'nextCursor',p_next_cursor,'hasMore',p_has_more);
end $$;
revoke all on function public.reconciliation_v2_commit_sales_page(uuid,bigint,uuid,jsonb,jsonb,text,boolean,timestamptz) from public,anon,authenticated;
grant execute on function public.reconciliation_v2_commit_sales_page(uuid,bigint,uuid,jsonb,jsonb,text,boolean,timestamptz) to service_role;