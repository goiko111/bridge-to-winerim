create or replace function public.rv2_field(o jsonb, c text, p text) returns jsonb
language sql immutable as $$
  select case when o is null or jsonb_typeof(o) <> 'object' then null
    else coalesce(case when jsonb_typeof(o->c) = 'null' then null else o->c end, o->p) end
$$;
create or replace function public.rv2_trim(s text) returns text
language sql immutable as $$ select pg_catalog.regexp_replace(s, '^\s+|\s+$', '', 'g') $$;
create or replace function public.rv2_text(j jsonb) returns text
language sql immutable as $$
  select case when jsonb_typeof(j) = 'string' and public.rv2_trim(j #>> '{}') <> '' then public.rv2_trim(j #>> '{}') end
$$;
create or replace function public.rv2_ident(j jsonb) returns text
language sql immutable as $$
  select case
    when j is null or jsonb_typeof(j) = 'null' then null
    when jsonb_typeof(j) = 'string' then nullif(public.rv2_trim(j #>> '{}'), '')
    when jsonb_typeof(j) = 'number' then trim_scale((j #>> '{}')::numeric)::text
    when jsonb_typeof(j) = 'boolean' then j #>> '{}'
    else j::text end
$$;
create or replace function public.rv2_num(j jsonb) returns numeric
language sql immutable as $$
  select case
    when j is null or jsonb_typeof(j) = 'null' then null
    when jsonb_typeof(j) = 'number' then (j #>> '{}')::numeric
    when jsonb_typeof(j) = 'boolean' then case when (j #>> '{}') = 'true' then 1 else 0 end
    when jsonb_typeof(j) = 'string' then case
      when (j #>> '{}') = '' then null
      when public.rv2_trim(j #>> '{}') = '' then 0
      when public.rv2_trim(j #>> '{}') ~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$' then public.rv2_trim(j #>> '{}')::numeric
      else null end
    else null end
$$;
create or replace function public.rv2_norm(n numeric) returns numeric
language sql immutable as $$ select case when n is null then null else floor(n * 1000000 + 0.5) / 1000000 end $$;
create or replace function public.rv2_ntext(s text) returns text
language sql immutable as $$
  select pg_catalog.regexp_replace(lower(public.rv2_trim(pg_catalog.regexp_replace(normalize(coalesce(s, ''), NFD), '[\u0300-\u036f]', '', 'g'))), '\s+', ' ', 'g')
$$;
-- Time key without per-call exception blocks; relies on the caller's TimeZone (the aggregate sets UTC).
create or replace function public.rv2_time_key(j jsonb) returns text
language sql stable as $$
  select case
    when public.rv2_text(j) is null then null
    when pg_input_is_valid(public.rv2_text(j), 'timestamptz') then 'T:' || floor(extract(epoch from public.rv2_text(j)::timestamptz) * 1000)::bigint::text
    else 'S:' || public.rv2_text(j) end
$$;
create or replace function public.rv2_truthy(j jsonb) returns boolean
language sql immutable as $$
  select case
    when j is null or jsonb_typeof(j) = 'null' then false
    when jsonb_typeof(j) = 'boolean' then (j #>> '{}') = 'true'
    when jsonb_typeof(j) = 'number' then (j #>> '{}')::numeric <> 0
    when jsonb_typeof(j) = 'string' then (j #>> '{}') <> ''
    else true end
$$;
do $$ declare f text; begin
  foreach f in array array['rv2_field(jsonb,text,text)','rv2_trim(text)','rv2_text(jsonb)','rv2_ident(jsonb)','rv2_num(jsonb)','rv2_norm(numeric)','rv2_ntext(text)','rv2_time_key(jsonb)','rv2_truthy(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;