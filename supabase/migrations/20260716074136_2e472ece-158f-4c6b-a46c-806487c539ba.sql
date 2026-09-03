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
declare acquired_token text;
begin
  if p_job not in ('catalog', 'sales-stock', 'outbound-queue', 'activation') then
    raise exception 'Unsupported Agora lock job: %', p_job;
  end if;
  insert into public.agora_dispatch_locks (connection_id, job, lock_token, locked_until, acquired_at)
  values (p_connection_id, p_job, p_lock_token, now() + make_interval(secs => greatest(30, least(p_ttl_seconds, 1800))), now())
  on conflict (connection_id) do update
  set job = excluded.job, lock_token = excluded.lock_token, locked_until = excluded.locked_until, acquired_at = now()
  where public.agora_dispatch_locks.locked_until <= now()
     or public.agora_dispatch_locks.lock_token = excluded.lock_token
  returning lock_token into acquired_token;
  return coalesce(acquired_token = p_lock_token, false);
end;
$$;

revoke all on function public.acquire_agora_dispatch_lock(uuid, text, text, integer) from public;
grant execute on function public.acquire_agora_dispatch_lock(uuid, text, text, integer) to service_role;