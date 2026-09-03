\set ON_ERROR_STOP on

-- Read-only performance evidence for the fleet-runtime staging gate.
-- Run as a diagnostic role with pg_stat_* visibility. This script never writes.
BEGIN TRANSACTION READ ONLY;

SELECT
  current_database() AS database_name,
  current_setting('max_connections')::int AS max_connections,
  current_setting('shared_buffers') AS shared_buffers,
  current_setting('effective_cache_size') AS effective_cache_size,
  pg_size_pretty(pg_database_size(current_database())) AS database_size,
  now() AS observed_at;

SELECT
  count(*) AS total_connections,
  count(*) FILTER (WHERE state = 'active') AS active_connections,
  count(*) FILTER (WHERE state = 'idle') AS idle_connections,
  count(*) FILTER (WHERE wait_event_type = 'Lock') AS lock_waiters,
  count(*) FILTER (WHERE wait_event = 'ClientRead') AS client_read_waiters
FROM pg_stat_activity
WHERE datname = current_database();

SELECT
  round(
    100 * sum(blks_hit)::numeric / nullif(sum(blks_hit + blks_read), 0),
    2
  ) AS cache_hit_percent,
  pg_size_pretty(sum(temp_bytes)::bigint) AS cumulative_temp_bytes,
  sum(temp_files) AS cumulative_temp_files
FROM pg_stat_database
WHERE datname = current_database();

SELECT
  calls,
  round(total_exec_time::numeric, 2) AS total_exec_ms,
  round(mean_exec_time::numeric, 2) AS mean_exec_ms,
  round(max_exec_time::numeric, 2) AS max_exec_ms,
  rows,
  left(regexp_replace(query, '\\s+', ' ', 'g'), 240) AS query_sample
FROM pg_stat_statements
WHERE query ILIKE '%sales_line_items%'
   OR query ILIKE '%sales_events%'
   OR query ILIKE '%outbound_tasks%'
   OR query ILIKE '%runtime_idempotency%'
ORDER BY total_exec_time DESC
LIMIT 30;

WITH indexes AS (
  SELECT
    indexrelid,
    indrelid,
    pg_get_indexdef(indexrelid) AS definition
  FROM pg_index
  WHERE indrelid IN (
    'public.sales_events'::regclass,
    'public.sales_line_items'::regclass,
    'public.stock_sync_log'::regclass,
    'public.outbound_tasks'::regclass,
    'public.runtime_idempotency'::regclass,
    'public.provider_products'::regclass
  )
)
SELECT
  indrelid::regclass AS table_name,
  definition,
  array_agg(indexrelid::regclass ORDER BY indexrelid::regclass::text) AS duplicate_indexes
FROM indexes
GROUP BY indrelid, definition
HAVING count(*) > 1
ORDER BY indrelid::regclass::text, definition;

SELECT
  policy.schemaname,
  policy.tablename,
  policy.cmd,
  policy.roles,
  policy.policyname,
  policy.qual,
  policy.with_check
FROM pg_policies policy
WHERE policy.schemaname = 'public'
  AND policy.tablename IN (
    'pos_connections',
    'winerim_push_tracking',
    'winerim_wines',
    'agora_fleet_read_model'
  )
ORDER BY policy.tablename, policy.cmd, policy.policyname;

SELECT
  relname AS table_name,
  seq_scan,
  idx_scan,
  n_live_tup,
  n_dead_tup,
  last_analyze,
  last_autoanalyze,
  last_autovacuum
FROM pg_stat_user_tables
WHERE relname IN (
  'sales_events',
  'sales_line_items',
  'stock_sync_log',
  'outbound_tasks',
  'runtime_idempotency',
  'provider_products',
  'agora_fleet_read_model'
)
ORDER BY relname;

ROLLBACK;
