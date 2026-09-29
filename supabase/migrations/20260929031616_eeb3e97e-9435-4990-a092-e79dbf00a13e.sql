create table public.reconciliation_v2_scheduler_identities (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  key_sha256 text not null unique check (key_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
grant all on public.reconciliation_v2_scheduler_identities to service_role;
revoke all on public.reconciliation_v2_scheduler_identities from public, anon, authenticated;
alter table public.reconciliation_v2_scheduler_identities enable row level security;

create table public.reconciliation_v2_scheduler_state (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  business_day date not null,
  pipeline_version text not null,
  status text not null check (status in ('RUNNING','SUCCEEDED','SOURCE_INCOMPLETE','FAILED','BLOCKED')),
  error_code text,
  attempts integer not null default 0,
  run_id uuid,
  evidence jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, business_day, pipeline_version)
);
grant all on public.reconciliation_v2_scheduler_state to service_role;
revoke all on public.reconciliation_v2_scheduler_state from public, anon, authenticated;
alter table public.reconciliation_v2_scheduler_state enable row level security;
create index reconciliation_v2_scheduler_state_recent_idx on public.reconciliation_v2_scheduler_state(connection_id, updated_at desc);
create trigger update_reconciliation_v2_scheduler_state_updated_at before update on public.reconciliation_v2_scheduler_state
  for each row execute function public.update_updated_at_column();