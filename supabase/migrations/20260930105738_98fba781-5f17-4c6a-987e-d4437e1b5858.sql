create or replace function public.reconciliation_v2_analytics_daily(p_connection_id uuid, p_from date, p_to date)
returns table(business_day date, category text, revenue_minor numeric, quantity numeric, ticket_count bigint, currency text)
language sql stable security definer set search_path to ''
as $$
  with w as (
    select p.*, pg_catalog.row_number() over (partition by p.canonical_identity order by p.business_day desc, p.chunk_no desc, p.source_line_item_id desc) rn
    from reconciliation_private.analytics_line_projection p
    where p.connection_id = p_connection_id and p.business_day between p_from and p_to
      and p.canonical_identity is not null and p.amount is not null
  )
  select w.business_day, w.category, pg_catalog.sum(w.revenue_minor), pg_catalog.sum(w.signed_quantity), pg_catalog.count(distinct w.ticket_id),
    case when pg_catalog.count(distinct w.currency) = 1 then pg_catalog.min(w.currency) end
  from w where w.rn = 1 and p_to - p_from <= 92
  group by w.business_day, w.category
$$;
revoke all on function public.reconciliation_v2_analytics_daily(uuid, date, date) from public, anon, authenticated;
grant execute on function public.reconciliation_v2_analytics_daily(uuid, date, date) to service_role;