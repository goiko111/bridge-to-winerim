create schema if not exists reconciliation_private;
revoke all on schema reconciliation_private from public, anon, authenticated;
grant usage on schema reconciliation_private to service_role;

create or replace function reconciliation_private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

create table public.winerim_restaurant_bindings (
  connection_id uuid primary key references public.pos_connections(id) on delete cascade,
  fleet_scope text not null default 'primary',
  winerim_restaurant_id bigint not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','EXCLUDED','DISABLED','UNVERIFIED')),
  exclusion_reason text,
  verified_via text not null default 'fleet_read_token_restaurants',
  verified_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'EXCLUDED') = (exclusion_reason is not null)),
  unique (fleet_scope, winerim_restaurant_id)
);
create trigger winerim_restaurant_bindings_touch before update on public.winerim_restaurant_bindings
for each row execute function reconciliation_private.touch_updated_at();

create table public.reconciliation_v2_connection_exclusions (
  connection_id uuid primary key references public.pos_connections(id) on delete cascade,
  reason text not null,
  source text not null,
  created_at timestamptz not null default now()
);

do $$
declare matched integer;
begin
  select count(*) into matched
  from public.pos_connections
  where id = '706b952e-767d-41af-9cba-8e225b16a877'::uuid;
  if matched <> 1 then
    raise exception 'RECONCILIATION_EXCLUSION_IDENTITY_NOT_UNIQUE: 706b952e-767d-41af-9cba-8e225b16a877';
  end if;
  insert into public.reconciliation_v2_connection_exclusions(connection_id, reason, source)
  values ('706b952e-767d-41af-9cba-8e225b16a877'::uuid, 'client_closed', 'stable_connection_id_2026-09-28');
end $$;

create table public.winerim_sync_checkpoints (
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  stream text not null check (stream in ('sales_records','stock_movements','stock_snapshot')),
  cursor text,
  after_id bigint,
  overlap_from timestamptz,
  last_complete_at timestamptz,
  last_request_id uuid,
  coverage_complete boolean not null default false,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (connection_id, stream)
);
create index winerim_sync_checkpoints_freshness_idx on public.winerim_sync_checkpoints(stream, last_complete_at desc);
create trigger winerim_sync_checkpoints_touch before update on public.winerim_sync_checkpoints
for each row execute function reconciliation_private.touch_updated_at();

create table public.winerim_sales_records (
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  sale_id bigint not null,
  restaurant_id bigint not null,
  status text not null check (status in ('confirmed','pending','rejected')),
  effective_at timestamp not null,
  time_reliable boolean not null,
  recorded_at timestamptz,
  source_updated_at timestamptz not null,
  wine_id bigint not null,
  price_id bigint not null,
  stock_id bigint,
  format_key text,
  qty numeric not null,
  served_qty numeric,
  amount_minor bigint,
  currency text,
  source_origin text,
  source_channel text,
  source_contract text,
  external_order_id text,
  raw jsonb not null check (jsonb_typeof(raw) = 'object'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (connection_id, sale_id)
);
create index winerim_sales_records_day_idx on public.winerim_sales_records(connection_id, effective_at, sale_id);
create index winerim_sales_records_updated_idx on public.winerim_sales_records(connection_id, source_updated_at, sale_id);
create index winerim_sales_records_external_idx on public.winerim_sales_records(connection_id, external_order_id) where external_order_id is not null;

create table public.winerim_sales_lines (
  connection_id uuid not null,
  sale_id bigint not null,
  line_id text not null,
  sale_detail_id bigint,
  line_type text not null check (line_type in ('sale','serving')),
  source_system text,
  external_order_id text,
  source_line_id text,
  invoice_id text,
  receipt_id text,
  wine_id bigint not null,
  price_id bigint,
  stock_id bigint,
  format_key text,
  qty numeric not null,
  unit_amount_minor bigint,
  total_amount_minor bigint,
  effective_at timestamp not null,
  stock_effect_known boolean not null,
  stock_effect_status text not null,
  stock_applied boolean,
  stock_movement_ids bigint[],
  stock_movement_difference numeric,
  stock_unbacked_qty numeric,
  raw jsonb not null check (jsonb_typeof(raw) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (connection_id, line_id),
  foreign key (connection_id, sale_id) references public.winerim_sales_records(connection_id, sale_id) on delete cascade
);
create index winerim_sales_lines_sale_fk_idx on public.winerim_sales_lines(connection_id, sale_id);
create index winerim_sales_lines_exact_source_idx on public.winerim_sales_lines(connection_id, source_system, external_order_id, source_line_id, format_key)
  where source_system is not null and external_order_id is not null and source_line_id is not null;
create index winerim_sales_lines_receipt_idx on public.winerim_sales_lines(connection_id, receipt_id) where receipt_id is not null;

create table public.winerim_sale_deletions (
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  sale_id bigint not null,
  sale_detail_id bigint,
  line_id text not null,
  reason text not null check (reason in ('sale_cancelled','empty_bottle_discarded','product_deleted','line_deleted')),
  deleted_at timestamptz not null,
  effective_at timestamp,
  external_order_id text,
  raw jsonb not null check (jsonb_typeof(raw) = 'object'),
  created_at timestamptz not null default now(),
  primary key (connection_id, line_id, deleted_at)
);
create index winerim_sale_deletions_sale_idx on public.winerim_sale_deletions(connection_id, sale_id, deleted_at desc);

create table public.winerim_stock_movements (
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  movement_id bigint not null,
  restaurant_id bigint not null,
  recorded_at timestamptz not null,
  wine_id bigint,
  price_id bigint,
  stock_id bigint,
  format_key text,
  quantity_before numeric,
  quantity_change numeric,
  quantity_after numeric,
  stock_controlled boolean not null,
  category text not null,
  cause text,
  linked_sale_id bigint,
  linked_sale_detail_ids bigint[],
  receipt_id text,
  order_id text,
  reference_type text,
  reference_id text,
  raw jsonb not null check (jsonb_typeof(raw) = 'object'),
  created_at timestamptz not null default now(),
  primary key (connection_id, movement_id),
  check (quantity_before is null or quantity_change is null or quantity_after is null or quantity_after - quantity_before = quantity_change)
);
create index winerim_stock_movements_cursor_idx on public.winerim_stock_movements(connection_id, movement_id);
create index winerim_stock_movements_sale_idx on public.winerim_stock_movements(connection_id, linked_sale_id) where linked_sale_id is not null;
create index winerim_stock_movements_receipt_idx on public.winerim_stock_movements(connection_id, receipt_id) where receipt_id is not null;

create table public.winerim_stock_snapshots (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  restaurant_id bigint not null,
  captured_at timestamptz not null,
  source_contract text not null default 'html_api_token_v2_stock',
  complete boolean not null,
  page_count integer not null check (page_count >= 0),
  item_count integer not null check (item_count >= 0),
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (connection_id, content_hash)
);
create index winerim_stock_snapshots_latest_idx on public.winerim_stock_snapshots(connection_id, captured_at desc);

create table public.winerim_stock_snapshot_items (
  snapshot_id uuid not null references public.winerim_stock_snapshots(id) on delete cascade,
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  stock_id bigint not null,
  wine_id bigint not null,
  wine_name text,
  vintage text,
  slugname text,
  format_key text,
  price_amount numeric,
  stock numeric,
  stock_active boolean not null,
  threshold numeric,
  threshold_active boolean not null,
  max_qty numeric,
  raw jsonb not null check (jsonb_typeof(raw) = 'object'),
  primary key (snapshot_id, stock_id)
);
create index winerim_stock_snapshot_items_connection_idx on public.winerim_stock_snapshot_items(connection_id, stock_id, snapshot_id);

create table public.reconciliation_v2_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  restaurant_id bigint not null,
  business_day date not null,
  mode text not null default 'AUDIT_ONLY' check (mode = 'AUDIT_ONLY'),
  status text not null check (status in ('RUNNING','COMPLETE','SOURCE_INCOMPLETE','FAILED')),
  agora_complete boolean not null default false,
  winerim_complete boolean not null default false,
  stock_complete boolean not null default false,
  source_cutoff_at timestamptz not null,
  pages_read integer not null default 0,
  expected_pages integer,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, business_day, source_cutoff_at)
);
create index reconciliation_v2_runs_status_idx on public.reconciliation_v2_runs(status, started_at desc);
create index reconciliation_v2_runs_connection_day_idx on public.reconciliation_v2_runs(connection_id, business_day desc);
create trigger reconciliation_v2_runs_touch before update on public.reconciliation_v2_runs
for each row execute function reconciliation_private.touch_updated_at();

create table public.reconciliation_v2_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.reconciliation_v2_runs(id) on delete cascade,
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  restaurant_id bigint not null,
  business_day date not null,
  source_line_key text not null,
  state text not null check (state in (
    'MATCHED','MISSING_IN_WINERIM','EXTRA_IN_WINERIM','QUANTITY_MISMATCH','AMOUNT_MISMATCH',
    'CONFIRMED_DUPLICATE','PROBABLE_DUPLICATE','PARTIAL_STOCK','STOCK_UNKNOWN','STOCK_CONFLICT',
    'AMBIGUOUS','SOURCE_INCOMPLETE','DELETED_OR_CANCELLED','OPEN_PENDING','REVERSAL_PENDING',
    'RESOLVED_EXTERNALLY','EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE','CARDINALITY_CONFLICT')),
  agora_line jsonb,
  winerim_line jsonb,
  evidence jsonb not null default '{}'::jsonb,
  manual_action text not null,
  mode text not null default 'AUDIT_ONLY' check (mode = 'AUDIT_ONLY'),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revision_hash text not null,
  unique (connection_id, business_day, source_line_key)
);
create index reconciliation_v2_results_run_fk_idx on public.reconciliation_v2_results(run_id);
create index reconciliation_v2_results_filter_idx on public.reconciliation_v2_results(connection_id, business_day desc, state);

create table public.reconciliation_v2_evidence (
  id uuid primary key default gen_random_uuid(),
  result_id uuid not null references public.reconciliation_v2_results(id) on delete cascade,
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  evidence_type text not null,
  source_ref text not null,
  payload jsonb not null default '{}'::jsonb,
  content_hash text not null,
  captured_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (result_id, evidence_type, content_hash)
);
create index reconciliation_v2_evidence_result_fk_idx on public.reconciliation_v2_evidence(result_id);

create table public.reconciliation_v2_manual_actions (
  id uuid primary key default gen_random_uuid(),
  result_id uuid not null references public.reconciliation_v2_results(id) on delete cascade,
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  action_type text not null check (action_type in ('REVIEW','ACKNOWLEDGE','EXPORT','COMMENT')),
  status text not null default 'OPEN' check (status in ('OPEN','ACKNOWLEDGED','CLOSED')),
  note text,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reconciliation_v2_manual_actions_result_fk_idx on public.reconciliation_v2_manual_actions(result_id, status);
create trigger reconciliation_v2_manual_actions_touch before update on public.reconciliation_v2_manual_actions
for each row execute function reconciliation_private.touch_updated_at();

create table public.reconciliation_v2_external_resolutions (
  id uuid primary key default gen_random_uuid(),
  audit_case_id uuid not null references public.agora_reversal_audit(id) on delete cascade,
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  case_fingerprint text not null,
  candidate_targets jsonb not null check (jsonb_typeof(candidate_targets) = 'array'),
  evidence_hash text not null,
  verdict text not null check (verdict in ('RESOLVED_EXTERNALLY','EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE','NOT_CANCELLED_YET','BLOCKED_DETAIL_SCOPE','NOT_ELIGIBLE','CONFLICT','CARDINALITY_CONFLICT')),
  missing text[] not null default '{}',
  evidence jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (audit_case_id, evidence_hash)
);
create index reconciliation_v2_external_resolution_case_idx on public.reconciliation_v2_external_resolutions(audit_case_id, checked_at desc);
create index reconciliation_v2_external_resolution_connection_idx on public.reconciliation_v2_external_resolutions(connection_id, verdict, checked_at desc);

alter table public.agora_reversal_audit add column if not exists external_resolution_status text
  check (external_resolution_status is null or external_resolution_status in ('RESOLVED_EXTERNALLY','EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE','CARDINALITY_CONFLICT'));

create table public.reconciliation_v2_analytics_series (
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  business_day date not null,
  category text not null check (category in ('WINE','OTHER_BEVERAGE','FOOD','UNCLASSIFIED')),
  revenue_minor bigint not null default 0,
  quantity numeric not null default 0,
  ticket_count integer not null default 0,
  classified_line_count integer not null default 0,
  source_line_count integer not null default 0,
  currency text,
  freshness_at timestamptz not null,
  coverage_complete boolean not null,
  updated_at timestamptz not null default now(),
  primary key (connection_id, business_day, category)
);
create index reconciliation_v2_analytics_series_day_idx on public.reconciliation_v2_analytics_series(business_day desc, connection_id);

create table public.reconciliation_v2_category_rules (
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  provider_product_id text,
  family_key text,
  category text not null check (category in ('WINE','OTHER_BEVERAGE','FOOD','UNCLASSIFIED')),
  evidence_source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (provider_product_id is not null or family_key is not null),
  unique nulls not distinct (connection_id, provider_product_id, family_key)
);
create index reconciliation_v2_category_rules_lookup_idx on public.reconciliation_v2_category_rules(connection_id, provider_product_id, family_key);
create trigger reconciliation_v2_category_rules_touch before update on public.reconciliation_v2_category_rules
for each row execute function reconciliation_private.touch_updated_at();

create table public.reconciliation_v2_analytics_aggregates (
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  period_kind text not null check (period_kind in ('DAY','WEEK','MONTH','ROLLING_7D','ROLLING_28D')),
  period_start date not null,
  category text not null check (category in ('WINE','OTHER_BEVERAGE','FOOD','UNCLASSIFIED','ALL')),
  revenue_minor bigint not null default 0,
  revenue_share numeric,
  quantity numeric not null default 0,
  ticket_count integer not null default 0,
  coverage_complete boolean not null,
  freshness_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (connection_id, period_kind, period_start, category)
);

create table public.reconciliation_v2_locks (
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  stream text not null,
  owner_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (connection_id, stream)
);
create index reconciliation_v2_locks_expiry_idx on public.reconciliation_v2_locks(expires_at);

do $$ declare t text; begin
  foreach t in array array[
    'winerim_restaurant_bindings','reconciliation_v2_connection_exclusions','winerim_sync_checkpoints','winerim_sales_records','winerim_sales_lines',
    'winerim_sale_deletions','winerim_stock_movements','winerim_stock_snapshots','winerim_stock_snapshot_items',
    'reconciliation_v2_runs','reconciliation_v2_results','reconciliation_v2_evidence','reconciliation_v2_manual_actions',
    'reconciliation_v2_external_resolutions','reconciliation_v2_category_rules','reconciliation_v2_analytics_series','reconciliation_v2_analytics_aggregates','reconciliation_v2_locks'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

create or replace function public.reconciliation_v2_commit_movement_page(
  p_connection_id uuid, p_restaurant_id bigint, p_request_id uuid, p_movements jsonb,
  p_next_after_id bigint, p_has_more boolean, p_overlap_from timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare item jsonb; affected integer := 0;
begin
  if not exists (select 1 from public.winerim_restaurant_bindings b where b.connection_id=p_connection_id and b.winerim_restaurant_id=p_restaurant_id and b.status='ACTIVE') then raise exception 'binding mismatch'; end if;
  if jsonb_typeof(p_movements) <> 'array' then raise exception 'invalid movement payload'; end if;
  for item in select value from jsonb_array_elements(p_movements) loop
    insert into public.winerim_stock_movements(connection_id,movement_id,restaurant_id,recorded_at,wine_id,price_id,stock_id,format_key,quantity_before,quantity_change,quantity_after,stock_controlled,category,cause,linked_sale_id,linked_sale_detail_ids,receipt_id,order_id,reference_type,reference_id,raw)
    values(p_connection_id,(item->>'movementId')::bigint,p_restaurant_id,(item->>'recordedAt')::timestamptz,nullif(item#>>'{wine,wineId}','')::bigint,nullif(item#>>'{variant,priceId}','')::bigint,nullif(item#>>'{variant,stockId}','')::bigint,item#>>'{variant,format}',nullif(item->>'quantityBefore','')::numeric,nullif(item->>'change','')::numeric,nullif(item->>'quantityAfter','')::numeric,(item->>'stockControlled')::boolean,item->>'category',item->>'cause',nullif(item#>>'{sale,saleId}','')::bigint,array(select value::bigint from jsonb_array_elements_text(coalesce(item#>'{sale,saleDetailIds}','[]'::jsonb))),item#>>'{sale,receiptId}',item#>>'{sale,orderId}',item#>>'{reference,type}',item#>>'{reference,id}',item)
    on conflict(connection_id,movement_id) do update set recorded_at=excluded.recorded_at,wine_id=excluded.wine_id,price_id=excluded.price_id,stock_id=excluded.stock_id,format_key=excluded.format_key,quantity_before=excluded.quantity_before,quantity_change=excluded.quantity_change,quantity_after=excluded.quantity_after,stock_controlled=excluded.stock_controlled,category=excluded.category,cause=excluded.cause,linked_sale_id=excluded.linked_sale_id,linked_sale_detail_ids=excluded.linked_sale_detail_ids,receipt_id=excluded.receipt_id,order_id=excluded.order_id,reference_type=excluded.reference_type,reference_id=excluded.reference_id,raw=excluded.raw;
    affected := affected + 1;
  end loop;
  insert into public.winerim_sync_checkpoints(connection_id,stream,after_id,overlap_from,last_complete_at,last_request_id,coverage_complete,last_error_code)
  values(p_connection_id,'stock_movements',p_next_after_id,p_overlap_from,case when not p_has_more then now() end,p_request_id,not p_has_more,null)
  on conflict(connection_id,stream) do update set after_id=greatest(coalesce(public.winerim_sync_checkpoints.after_id,0),coalesce(excluded.after_id,0)),overlap_from=greatest(public.winerim_sync_checkpoints.overlap_from,excluded.overlap_from),last_complete_at=coalesce(excluded.last_complete_at,public.winerim_sync_checkpoints.last_complete_at),last_request_id=excluded.last_request_id,coverage_complete=excluded.coverage_complete,last_error_code=null;
  return jsonb_build_object('movements',affected,'nextAfterId',p_next_after_id,'hasMore',p_has_more);
end $$;

create or replace function public.reconciliation_v2_commit_stock_snapshot(
  p_connection_id uuid, p_restaurant_id bigint, p_request_id uuid, p_captured_at timestamptz,
  p_content_hash text, p_complete boolean, p_page_count integer, p_items jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare snapshot_id uuid; item jsonb;
begin
  if not exists (select 1 from public.winerim_restaurant_bindings b where b.connection_id=p_connection_id and b.winerim_restaurant_id=p_restaurant_id and b.status='ACTIVE') then raise exception 'binding mismatch'; end if;
  if not p_complete or jsonb_typeof(p_items) <> 'array' then raise exception 'incomplete stock snapshot'; end if;
  insert into public.winerim_stock_snapshots(connection_id,restaurant_id,captured_at,complete,page_count,item_count,content_hash)
  values(p_connection_id,p_restaurant_id,p_captured_at,true,p_page_count,jsonb_array_length(p_items),p_content_hash)
  on conflict(connection_id,content_hash) do update set captured_at=excluded.captured_at returning id into snapshot_id;
  for item in select value from jsonb_array_elements(p_items) loop
    insert into public.winerim_stock_snapshot_items(snapshot_id,connection_id,stock_id,wine_id,wine_name,vintage,slugname,format_key,price_amount,stock,stock_active,threshold,threshold_active,max_qty,raw)
    values(snapshot_id,p_connection_id,(item->>'id')::bigint,(item#>>'{winePrice,wine,id}')::bigint,item#>>'{winePrice,wine,name}',item#>>'{winePrice,wine,vintage}',item#>>'{winePrice,wine,slugname}',item#>>'{winePrice,variant}',nullif(item#>>'{winePrice,price}','')::numeric,nullif(item->>'stock','')::numeric,(item->>'stockActive')::boolean,nullif(item->>'treshold','')::numeric,(item->>'tresholdActive')::boolean,nullif(item->>'maxQty','')::numeric,item)
    on conflict(snapshot_id,stock_id) do update set stock=excluded.stock,stock_active=excluded.stock_active,threshold=excluded.threshold,threshold_active=excluded.threshold_active,max_qty=excluded.max_qty,raw=excluded.raw;
  end loop;
  insert into public.winerim_sync_checkpoints(connection_id,stream,last_complete_at,last_request_id,coverage_complete,last_error_code)
  values(p_connection_id,'stock_snapshot',p_captured_at,p_request_id,true,null)
  on conflict(connection_id,stream) do update set last_complete_at=excluded.last_complete_at,last_request_id=excluded.last_request_id,coverage_complete=true,last_error_code=null;
  return snapshot_id;
end $$;

create or replace function public.reconciliation_v2_commit_run(
  p_run_id uuid, p_connection_id uuid, p_restaurant_id bigint, p_business_day date,
  p_source_cutoff_at timestamptz, p_completeness jsonb, p_results jsonb, p_metrics jsonb, p_analytics jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare item jsonb; complete boolean;
begin
  complete := coalesce((p_completeness->>'agoraComplete')::boolean,false) and coalesce((p_completeness->>'winerimComplete')::boolean,false);
  insert into public.reconciliation_v2_runs(id,connection_id,restaurant_id,business_day,status,agora_complete,winerim_complete,stock_complete,source_cutoff_at,pages_read,expected_pages,completed_at,metrics)
  values(p_run_id,p_connection_id,p_restaurant_id,p_business_day,case when complete then 'COMPLETE' else 'SOURCE_INCOMPLETE' end,coalesce((p_completeness->>'agoraComplete')::boolean,false),coalesce((p_completeness->>'winerimComplete')::boolean,false),coalesce((p_completeness->>'stockComplete')::boolean,false),p_source_cutoff_at,coalesce((p_completeness->>'pagesRead')::integer,0),nullif(p_completeness->>'expectedPages','')::integer,now(),coalesce(p_metrics,'{}'::jsonb))
  on conflict(id) do update set status=excluded.status,agora_complete=excluded.agora_complete,winerim_complete=excluded.winerim_complete,stock_complete=excluded.stock_complete,pages_read=excluded.pages_read,expected_pages=excluded.expected_pages,completed_at=now(),metrics=excluded.metrics;
  for item in select value from jsonb_array_elements(p_results) loop
    insert into public.reconciliation_v2_results(run_id,connection_id,restaurant_id,business_day,source_line_key,state,agora_line,winerim_line,evidence,manual_action,revision_hash)
    values(p_run_id,p_connection_id,p_restaurant_id,p_business_day,item->>'sourceLineKey',case when complete then item->>'state' else 'SOURCE_INCOMPLETE' end,item->'agora',item->'winerim',coalesce(item->'evidence','{}'::jsonb),item->>'manualAction',item->>'revisionHash')
    on conflict(connection_id,business_day,source_line_key) do update set run_id=excluded.run_id,state=excluded.state,agora_line=excluded.agora_line,winerim_line=excluded.winerim_line,evidence=excluded.evidence,manual_action=excluded.manual_action,last_seen_at=now(),revision_hash=excluded.revision_hash;
  end loop;
  if complete then
    delete from public.reconciliation_v2_analytics_series where connection_id=p_connection_id and business_day=p_business_day;
    for item in select value from jsonb_array_elements(coalesce(p_analytics->'series','[]'::jsonb)) loop
      insert into public.reconciliation_v2_analytics_series(connection_id,business_day,category,revenue_minor,quantity,ticket_count,classified_line_count,source_line_count,currency,freshness_at,coverage_complete)
      values(p_connection_id,(item->>'businessDay')::date,item->>'category',(item->>'revenueMinor')::bigint,(item->>'quantity')::numeric,(item->>'ticketCount')::integer,(item->>'classifiedLineCount')::integer,(item->>'sourceLineCount')::integer,item->>'currency',(item->>'freshnessAt')::timestamptz,true)
      on conflict(connection_id,business_day,category) do update set revenue_minor=excluded.revenue_minor,quantity=excluded.quantity,ticket_count=excluded.ticket_count,classified_line_count=excluded.classified_line_count,source_line_count=excluded.source_line_count,currency=excluded.currency,freshness_at=excluded.freshness_at,coverage_complete=true,updated_at=now();
    end loop;
    for item in select value from jsonb_array_elements(coalesce(p_analytics->'aggregates','[]'::jsonb)) loop
      insert into public.reconciliation_v2_analytics_aggregates(connection_id,period_kind,period_start,category,revenue_minor,revenue_share,quantity,ticket_count,coverage_complete,freshness_at)
      values(p_connection_id,item->>'period',(item->>'periodStart')::date,item->>'category',(item->>'revenueMinor')::bigint,nullif(item->>'revenueShare','')::numeric,(item->>'quantity')::numeric,(item->>'ticketCount')::integer,true,(item->>'freshnessAt')::timestamptz)
      on conflict(connection_id,period_kind,period_start,category) do update set revenue_minor=excluded.revenue_minor,revenue_share=excluded.revenue_share,quantity=excluded.quantity,ticket_count=excluded.ticket_count,coverage_complete=true,freshness_at=excluded.freshness_at,updated_at=now();
    end loop;
  end if;
  return p_run_id;
end $$;

create or replace function public.reconciliation_v2_claim_lock(p_connection_id uuid, p_stream text, p_owner_id uuid, p_ttl_seconds integer default 180)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  if p_ttl_seconds < 30 or p_ttl_seconds > 900 then raise exception 'invalid lock ttl'; end if;
  insert into public.reconciliation_v2_locks(connection_id, stream, owner_id, expires_at)
  values (p_connection_id, p_stream, p_owner_id, now() + make_interval(secs => p_ttl_seconds))
  on conflict (connection_id, stream) do update set
    owner_id = excluded.owner_id, expires_at = excluded.expires_at, updated_at = now()
  where public.reconciliation_v2_locks.expires_at < now() or public.reconciliation_v2_locks.owner_id = p_owner_id;
  get diagnostics changed = row_count;
  return changed = 1;
end $$;

create or replace function public.reconciliation_v2_release_lock(p_connection_id uuid, p_stream text, p_owner_id uuid)
returns boolean language sql security definer set search_path = '' as $$
  with deleted as (delete from public.reconciliation_v2_locks where connection_id = p_connection_id and stream = p_stream and owner_id = p_owner_id returning 1)
  select exists(select 1 from deleted);
$$;

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
    for line in select value from jsonb_array_elements(coalesce(item->'lines','[]'::jsonb)) loop
      insert into public.winerim_sales_lines(connection_id,sale_id,line_id,sale_detail_id,line_type,source_system,external_order_id,source_line_id,invoice_id,receipt_id,wine_id,price_id,stock_id,format_key,qty,unit_amount_minor,total_amount_minor,effective_at,stock_effect_known,stock_effect_status,stock_applied,stock_movement_ids,stock_movement_difference,stock_unbacked_qty,raw)
      values (p_connection_id,(item->>'saleId')::bigint,line->>'lineId',nullif(line->>'saleDetailId','')::bigint,line->>'lineType',line#>>'{source,sourceSystem}',coalesce(line#>>'{source,externalOrderId}',item#>>'{source,externalOrderId}'),line#>>'{source,sourceLineId}',line#>>'{source,invoiceId}',line#>>'{source,receiptId}',(item#>>'{wine,wineId}')::bigint,(item#>>'{variant,priceId}')::bigint,nullif(item#>>'{variant,stockId}','')::bigint,coalesce(line->>'format',item#>>'{variant,format}'),(line->>'qty')::numeric,case when line->>'unitAmount' is null then null else round((line->>'unitAmount')::numeric*100)::bigint end,case when line->>'totalAmount' is null then null else round((line->>'totalAmount')::numeric*100)::bigint end,(line->>'effectiveAt')::timestamp,(line#>>'{stockEffect,known}')::boolean,line#>>'{stockEffect,status}',nullif(line#>>'{stockEffect,stockApplied}','')::boolean,array(select (m->>'stockMovementId')::bigint from jsonb_array_elements(coalesce(line#>'{stockEffect,movements}','[]'::jsonb)) m),(select sum(nullif(m->>'difference','')::numeric) from jsonb_array_elements(coalesce(line#>'{stockEffect,movements}','[]'::jsonb)) m),nullif(line#>>'{stockEffect,unbackedQty}','')::numeric,line);
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

create or replace function public.reconciliation_v2_record_external_resolution(
  p_audit_case_id uuid, p_connection_id uuid, p_case_fingerprint text, p_candidate_targets jsonb,
  p_evidence_hash text, p_verdict text, p_missing text[], p_evidence jsonb, p_checked_at timestamptz
) returns uuid language plpgsql security definer set search_path = '' as $$
declare audit_row public.agora_reversal_audit; result_id uuid;
begin
  select * into audit_row from public.agora_reversal_audit where id=p_audit_case_id and connection_id=p_connection_id for update;
  if not found then raise exception 'audit case not found'; end if;
  if audit_row.case_fingerprint is distinct from p_case_fingerprint or audit_row.candidate_targets is distinct from p_candidate_targets then raise exception 'audit identity changed'; end if;
  insert into public.reconciliation_v2_external_resolutions(audit_case_id,connection_id,case_fingerprint,candidate_targets,evidence_hash,verdict,missing,evidence,checked_at)
  values(p_audit_case_id,p_connection_id,p_case_fingerprint,p_candidate_targets,p_evidence_hash,p_verdict,p_missing,p_evidence,p_checked_at)
  on conflict(audit_case_id,evidence_hash) do update set verdict=excluded.verdict,missing=excluded.missing,evidence=excluded.evidence,checked_at=excluded.checked_at returning id into result_id;
  update public.agora_reversal_audit set external_resolution_status = case when p_verdict in ('RESOLVED_EXTERNALLY','EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE','CARDINALITY_CONFLICT') then p_verdict else null end where id=p_audit_case_id;
  return result_id;
end $$;

revoke all on function public.reconciliation_v2_claim_lock(uuid,text,uuid,integer) from public,anon,authenticated;
revoke all on function public.reconciliation_v2_release_lock(uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.reconciliation_v2_commit_sales_page(uuid,bigint,uuid,jsonb,jsonb,text,boolean,timestamptz) from public,anon,authenticated;
revoke all on function public.reconciliation_v2_commit_movement_page(uuid,bigint,uuid,jsonb,bigint,boolean,timestamptz) from public,anon,authenticated;
revoke all on function public.reconciliation_v2_commit_stock_snapshot(uuid,bigint,uuid,timestamptz,text,boolean,integer,jsonb) from public,anon,authenticated;
revoke all on function public.reconciliation_v2_commit_run(uuid,uuid,bigint,date,timestamptz,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.reconciliation_v2_record_external_resolution(uuid,uuid,text,jsonb,text,text,text[],jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.reconciliation_v2_claim_lock(uuid,text,uuid,integer) to service_role;
grant execute on function public.reconciliation_v2_release_lock(uuid,text,uuid) to service_role;
grant execute on function public.reconciliation_v2_commit_sales_page(uuid,bigint,uuid,jsonb,jsonb,text,boolean,timestamptz) to service_role;
grant execute on function public.reconciliation_v2_commit_movement_page(uuid,bigint,uuid,jsonb,bigint,boolean,timestamptz) to service_role;
grant execute on function public.reconciliation_v2_commit_stock_snapshot(uuid,bigint,uuid,timestamptz,text,boolean,integer,jsonb) to service_role;
grant execute on function public.reconciliation_v2_commit_run(uuid,uuid,bigint,date,timestamptz,jsonb,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.reconciliation_v2_record_external_resolution(uuid,uuid,text,jsonb,text,text,text[],jsonb,timestamptz) to service_role;

create or replace view public.reconciliation_v2_latest
with (security_invoker = true) as
select result.*
from public.reconciliation_v2_results result
join (
  select distinct on (connection_id,business_day) id,connection_id,business_day
  from public.reconciliation_v2_runs
  order by connection_id,business_day,source_cutoff_at desc,created_at desc
) latest on latest.id=result.run_id and latest.connection_id=result.connection_id and latest.business_day=result.business_day;
revoke all on public.reconciliation_v2_latest from public,anon,authenticated;
grant select on public.reconciliation_v2_latest to service_role;

create or replace view public.reconciliation_v2_dashboard
with (security_invoker = true) as
select connection_id,business_day,state,count(*) as line_count,
       sum(coalesce((agora_line->>'amountMinor')::bigint,0)) as revenue_minor,
       max(last_seen_at) as freshness_at
from public.reconciliation_v2_latest
group by connection_id,business_day,state;
revoke all on public.reconciliation_v2_dashboard from public,anon,authenticated;
grant select on public.reconciliation_v2_dashboard to service_role;

comment on table public.reconciliation_v2_manual_actions is 'Manual review metadata only. No repair, sales, stock or reversal executor exists in this package.';
comment on table public.winerim_stock_snapshots is 'GET /api/v2/stock contract comes from API_TOKEN_V2_DOCUMENTATION.html; deployment is gated until canonical OpenAPI includes the same route/schema.';