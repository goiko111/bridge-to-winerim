-- Read-only preflight. Run before applying the proposal migration.
select to_regclass('public.pos_connections') as pos_connections,
       to_regclass('public.user_roles') as user_roles,
       to_regclass('public.sales_events') as sales_events,
       to_regclass('public.sales_line_items') as sales_line_items,
       to_regclass('public.agora_reversal_audit') as agora_reversal_audit;

select to_regprocedure('public.can_access_connection(uuid)') as can_access_connection,
       to_regprocedure('public.is_platform_admin()') as is_platform_admin;

select table_name, column_name, data_type
from information_schema.columns
where table_schema='public' and table_name in ('pos_connections','user_roles','sales_events','sales_line_items','agora_reversal_audit')
order by table_name, ordinal_position;

-- PRE-MIGRATION HARD GATE. Must return exactly one row. The migration aborts
-- if this stable connection identity cannot be resolved uniquely.
select count(*) as stable_excluded_connection_matches
from public.pos_connections
where id='706b952e-767d-41af-9cba-8e225b16a877'::uuid;

-- The checks below run AFTER the migration in staging.
-- Must remain 19 before external verification is enabled.
select count(*) as authoritative_sale_candidates
from public.agora_reversal_audit audit
join public.winerim_restaurant_bindings binding on binding.connection_id=audit.connection_id and binding.status='ACTIVE'
where audit.identity_scope='SALE' and audit.evidence_classification like 'CONFIRMED_DUPLICATE%';

-- DETAIL/glass remains blocked; expected current evidence set is six.
select count(*) as blocked_detail_cases
from public.agora_reversal_audit audit
join public.winerim_restaurant_bindings binding on binding.connection_id=audit.connection_id and binding.status='ACTIVE'
where audit.identity_scope='DETAIL' and audit.evidence_classification like 'CONFIRMED_DUPLICATE%';

-- Persisted exclusion must exist once and must not have an active binding.
select exclusion.connection_id, exclusion.reason,
       exists(select 1 from public.winerim_restaurant_bindings binding where binding.connection_id=exclusion.connection_id and binding.status='ACTIVE') as active_binding_exists
from public.reconciliation_v2_connection_exclusions exclusion
where exclusion.connection_id='706b952e-767d-41af-9cba-8e225b16a877'::uuid;

-- Run after applying in staging: raw tables must have no authenticated SELECT.
select table_name, privilege_type, grantee
from information_schema.role_table_grants
where table_schema='public'
  and table_name in ('winerim_sales_records','winerim_sales_lines','winerim_stock_movements','winerim_sync_checkpoints','reconciliation_v2_locks')
  and grantee in ('authenticated','anon','public')
order by table_name, grantee;
