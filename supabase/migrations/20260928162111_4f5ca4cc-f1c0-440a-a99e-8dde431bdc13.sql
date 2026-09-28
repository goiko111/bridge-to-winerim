do $$ declare n int; begin
update public.winerim_restaurant_bindings set verified_via='candidate_sales_records_2026-09-26', verified_at=now()
where connection_id='1c5177f1-9459-4ee9-8b6e-4780f8b6b96b' and winerim_restaurant_id=346 and status='ACTIVE';
get diagnostics n = row_count; if n<>1 then raise exception 'expected 1 binding, got %', n; end if; end $$;