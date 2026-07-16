create table if not exists public.agora_dispatch_locks (
  connection_id uuid not null references public.pos_connections(id) on delete cascade,
  job text not null check (job in ('catalog', 'sales-stock', 'outbound-queue', 'activation')),
  lock_token text not null,
  locked_until timestamptz not null,
  acquired_at timestamptz not null default now(),
  primary key (connection_id)
);

alter table public.agora_dispatch_locks enable row level security;

revoke all on public.agora_dispatch_locks from anon, authenticated;
grant select, insert, update, delete on public.agora_dispatch_locks to service_role;

create or replace function public.acquire_agora_dispatch_lock(
  p_connection_id uuid,
  p_job text,
  p_lock_token text,
  p_ttl_seconds integer default 540
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  acquired_token text;
begin
  if p_job not in ('catalog', 'sales-stock', 'outbound-queue', 'activation') then
    raise exception 'Unsupported Agora lock job: %', p_job;
  end if;

  insert into public.agora_dispatch_locks (
    connection_id,
    job,
    lock_token,
    locked_until,
    acquired_at
  ) values (
    p_connection_id,
    p_job,
    p_lock_token,
    now() + make_interval(secs => greatest(30, least(p_ttl_seconds, 1800))),
    now()
  )
  on conflict (connection_id) do update
  set job = excluded.job,
      lock_token = excluded.lock_token,
      locked_until = excluded.locked_until,
      acquired_at = now()
  where public.agora_dispatch_locks.locked_until <= now()
     or public.agora_dispatch_locks.lock_token = excluded.lock_token
  returning lock_token into acquired_token;

  return coalesce(acquired_token = p_lock_token, false);
end;
$$;

create or replace function public.release_agora_dispatch_lock(
  p_connection_id uuid,
  p_job text,
  p_lock_token text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  removed_count integer;
begin
  if p_job not in ('catalog', 'sales-stock', 'outbound-queue', 'activation') then
    return false;
  end if;

  delete from public.agora_dispatch_locks
  where connection_id = p_connection_id
    and lock_token = p_lock_token;

  get diagnostics removed_count = row_count;
  return removed_count > 0;
end;
$$;

revoke all on function public.acquire_agora_dispatch_lock(uuid, text, text, integer) from public;
revoke all on function public.release_agora_dispatch_lock(uuid, text, text) from public;
grant execute on function public.acquire_agora_dispatch_lock(uuid, text, text, integer) to service_role;
grant execute on function public.release_agora_dispatch_lock(uuid, text, text) to service_role;
