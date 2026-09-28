-- Additive, read-only candidate verification. No sales or stock payload is persisted.
create table public.reconciliation_v2_candidate_probe_audit (
  id uuid primary key default gen_random_uuid(), requested_by uuid not null,
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  restaurant_id bigint not null check (restaurant_id > 0), business_day date not null,
  outcome text not null default 'STARTED' check (outcome in ('STARTED','COMPLETE','SOURCE_INCOMPLETE','FAILED')),
  pages_read integer not null default 0 check (pages_read >= 0), record_count integer not null default 0 check (record_count >= 0),
  evidence_hash text check (evidence_hash is null or evidence_hash ~ '^[0-9a-f]{64}$'), error_code text,
  started_at timestamptz not null default now(), completed_at timestamptz,
  check ((outcome = 'STARTED') = (completed_at is null))
);
create index reconciliation_v2_candidate_probe_rate_idx on public.reconciliation_v2_candidate_probe_audit(requested_by, restaurant_id, started_at desc);
create index reconciliation_v2_candidate_probe_connection_idx on public.reconciliation_v2_candidate_probe_audit(connection_id, business_day, started_at desc);
alter table public.reconciliation_v2_candidate_probe_audit enable row level security;
revoke all on public.reconciliation_v2_candidate_probe_audit from public, anon, authenticated;
grant all on public.reconciliation_v2_candidate_probe_audit to service_role;

create or replace function public.reconciliation_v2_begin_candidate_probe(p_requested_by uuid, p_connection_id uuid, p_restaurant_id bigint, p_business_day date)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid; recent_count integer; hourly_count integer;
begin
  if p_requested_by is null or p_restaurant_id <= 0 or p_business_day is null then raise exception 'invalid candidate probe'; end if;
  if not exists (select 1 from public.pos_connections where id = p_connection_id) then raise exception 'connection not found'; end if;
  if exists (select 1 from public.reconciliation_v2_connection_exclusions where connection_id = p_connection_id) then raise exception 'connection excluded'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_requested_by::text || ':' || p_restaurant_id::text, 0));
  select count(*) into recent_count from public.reconciliation_v2_candidate_probe_audit where requested_by=p_requested_by and restaurant_id=p_restaurant_id and started_at > now()-interval '60 seconds';
  select count(*) into hourly_count from public.reconciliation_v2_candidate_probe_audit where requested_by=p_requested_by and started_at > now()-interval '1 hour';
  if recent_count > 0 or hourly_count >= 10 then raise exception 'candidate probe rate limited'; end if;
  insert into public.reconciliation_v2_candidate_probe_audit(requested_by,connection_id,restaurant_id,business_day)
  values(p_requested_by,p_connection_id,p_restaurant_id,p_business_day) returning id into result_id;
  return result_id;
end $$;
revoke all on function public.reconciliation_v2_begin_candidate_probe(uuid,uuid,bigint,date) from public,anon,authenticated;
grant execute on function public.reconciliation_v2_begin_candidate_probe(uuid,uuid,bigint,date) to service_role;