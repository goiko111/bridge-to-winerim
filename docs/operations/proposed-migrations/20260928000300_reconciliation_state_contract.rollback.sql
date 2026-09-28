-- Safe rollback: refuse to restore the legacy constraint after canonical-only rows exist.
do $$
begin
  if exists (
    select 1 from public.reconciliation_v2_results
    where state in ('HISTORY_MISSING','STOCK_MISSING','BOTH_MISSING','OPEN')
  ) then
    raise exception 'ROLLBACK_BLOCKED_CANONICAL_STATE_ROWS_EXIST';
  end if;
end $$;

drop view if exists public.reconciliation_v2_dashboard;
drop view if exists public.reconciliation_v2_latest;

alter table public.reconciliation_v2_results
  drop constraint if exists reconciliation_v2_results_state_check;
alter table public.reconciliation_v2_results
  add constraint reconciliation_v2_results_state_check check (state in (
    'MATCHED','MISSING_IN_WINERIM','EXTRA_IN_WINERIM','QUANTITY_MISMATCH','AMOUNT_MISMATCH',
    'CONFIRMED_DUPLICATE','PROBABLE_DUPLICATE','PARTIAL_STOCK','STOCK_UNKNOWN','STOCK_CONFLICT',
    'AMBIGUOUS','SOURCE_INCOMPLETE','DELETED_OR_CANCELLED','OPEN_PENDING','REVERSAL_PENDING',
    'RESOLVED_EXTERNALLY','EXTERNAL_RESOLUTION_EVIDENCE_INCOMPLETE','CARDINALITY_CONFLICT'
  ));

create view public.reconciliation_v2_latest
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

create view public.reconciliation_v2_dashboard
with (security_invoker = true) as
select connection_id,business_day,state,count(*) as line_count,
       sum(coalesce((agora_line->>'amountMinor')::bigint,0)) as revenue_minor,
       max(last_seen_at) as freshness_at
from public.reconciliation_v2_latest
group by connection_id,business_day,state;
revoke all on public.reconciliation_v2_dashboard from public,anon,authenticated;
grant select on public.reconciliation_v2_dashboard to service_role;
