alter table public.reconciliation_v2_results
  drop constraint if exists reconciliation_v2_results_state_check;
alter table public.reconciliation_v2_results
  add constraint reconciliation_v2_results_state_check check (state in (
    'MATCHED','HISTORY_MISSING','STOCK_MISSING','BOTH_MISSING','STOCK_UNKNOWN','AMBIGUOUS',
    'SOURCE_INCOMPLETE','DELETED_OR_CANCELLED','OPEN',
    'MISSING_IN_WINERIM','EXTRA_IN_WINERIM','QUANTITY_MISMATCH','AMOUNT_MISMATCH',
    'CONFIRMED_DUPLICATE','PROBABLE_DUPLICATE','PARTIAL_STOCK','STOCK_CONFLICT',
    'OPEN_PENDING','REVERSAL_PENDING','RESOLVED_EXTERNALLY',
    'EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE','CARDINALITY_CONFLICT'
  ));

create or replace view public.reconciliation_v2_latest
with (security_invoker = true) as
select result.*,
  case result.state
    when 'MATCHED' then 'MATCHED'
    when 'RESOLVED_EXTERNALLY' then 'MATCHED'
    when 'HISTORY_MISSING' then 'HISTORY_MISSING'
    when 'MISSING_IN_WINERIM' then 'HISTORY_MISSING'
    when 'STOCK_MISSING' then 'STOCK_MISSING'
    when 'PARTIAL_STOCK' then 'STOCK_MISSING'
    when 'STOCK_CONFLICT' then 'STOCK_MISSING'
    when 'BOTH_MISSING' then 'BOTH_MISSING'
    when 'STOCK_UNKNOWN' then 'STOCK_UNKNOWN'
    when 'EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE' then 'STOCK_UNKNOWN'
    when 'SOURCE_INCOMPLETE' then 'SOURCE_INCOMPLETE'
    when 'DELETED_OR_CANCELLED' then 'DELETED_OR_CANCELLED'
    when 'REVERSAL_PENDING' then 'DELETED_OR_CANCELLED'
    when 'OPEN' then 'OPEN'
    when 'OPEN_PENDING' then 'OPEN'
    else 'AMBIGUOUS'
  end::text as canonical_state,
  'v3'::text as state_contract_version
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
select connection_id,business_day,canonical_state as state,count(*) as line_count,
       sum(coalesce((agora_line->>'amountMinor')::bigint,0)) as revenue_minor,
       max(last_seen_at) as freshness_at
from public.reconciliation_v2_latest
group by connection_id,business_day,canonical_state;
revoke all on public.reconciliation_v2_dashboard from public,anon,authenticated;
grant select on public.reconciliation_v2_dashboard to service_role;

comment on view public.reconciliation_v2_latest is 'State contract v3: canonical_state is the public state; state preserves the persisted source value for traceability.';