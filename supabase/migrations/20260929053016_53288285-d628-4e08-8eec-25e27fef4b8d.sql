-- Analytics source projection: returns only the raw_json keys the analytics identity/amount/currency
-- logic reads, so the Worker never transports or parses full raw_json for the 28-day window.
create or replace function public.reconciliation_v2_project_raw_line(l jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(l) = 'object' then jsonb_strip_nulls(jsonb_build_object(
    'providerProductId', l->'providerProductId', 'ProductId', l->'ProductId',
    'quantity', l->'quantity', 'Quantity', l->'Quantity',
    'totalAmount', l->'totalAmount', 'TotalAmount', l->'TotalAmount',
    'unitPrice', l->'unitPrice', 'UnitPrice', l->'UnitPrice',
    'productPrice', l->'productPrice', 'ProductPrice', l->'ProductPrice',
    'soldAt', l->'soldAt', 'CreationDate', l->'CreationDate',
    'productName', l->'productName', 'ProductName', l->'ProductName',
    'lineId', l->'lineId', 'LineId', l->'LineId',
    'index', l->'index', 'Index', l->'Index')) else null end
$$;

create or replace function public.reconciliation_v2_project_raw_lines(a jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(a) = 'array' then coalesce((
    select jsonb_agg(public.reconciliation_v2_project_raw_line(e) order by o)
    from jsonb_array_elements(a) with ordinality as t(e, o) where jsonb_typeof(e) = 'object'), '[]'::jsonb) else null end
$$;

create or replace function public.reconciliation_v2_project_raw(r jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(r) = 'object' then jsonb_strip_nulls(jsonb_build_object(
    'lifecycleId', r->'lifecycleId', 'documentId', r->'documentId',
    'globalId', r->'globalId', 'GlobalId', r->'GlobalId',
    'number', r->'number', 'Number', r->'Number',
    'isRefund', r->'isRefund', 'kind', r->'kind', 'currency', r->'currency',
    'amounts', case when jsonb_typeof(r->'amounts') = 'object' then jsonb_build_object('currency', r->'amounts'->'currency') end,
    'lines', public.reconciliation_v2_project_raw_lines(r->'lines'),
    'Lines', public.reconciliation_v2_project_raw_lines(r->'Lines'),
    'invoiceItems', case when jsonb_typeof(r->'invoiceItems') = 'array' then coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('globalId', e->'globalId', 'GlobalId', e->'GlobalId',
        'lines', public.reconciliation_v2_project_raw_lines(e->'lines'), 'Lines', public.reconciliation_v2_project_raw_lines(e->'Lines'))) order by o)
      from jsonb_array_elements(r->'invoiceItems') with ordinality as t(e, o) where jsonb_typeof(e) = 'object'), '[]'::jsonb) end,
    'InvoiceItems', case when jsonb_typeof(r->'InvoiceItems') = 'array' then coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('globalId', e->'globalId', 'GlobalId', e->'GlobalId',
        'lines', public.reconciliation_v2_project_raw_lines(e->'lines'), 'Lines', public.reconciliation_v2_project_raw_lines(e->'Lines'))) order by o)
      from jsonb_array_elements(r->'InvoiceItems') with ordinality as t(e, o) where jsonb_typeof(e) = 'object'), '[]'::jsonb) end
  )) else null end
$$;

create or replace function public.reconciliation_v2_analytics_events(p_connection_id uuid, p_from date, p_to date)
returns table(id uuid, provider_doc_id text, business_day date, doc_type text, raw_json jsonb)
language sql stable set search_path = public as $$
  select e.id, e.provider_doc_id, e.business_day, e.doc_type, public.reconciliation_v2_project_raw(e.raw_json)
  from public.sales_events e
  where e.connection_id = p_connection_id and e.business_day >= p_from and e.business_day < p_to
    and e.doc_type ~* '(invoice|refund)' and e.doc_type !~* '(open|draft|ticket|order|void|cancelled|canceled)'
  order by e.business_day, e.id
$$;

revoke all on function public.reconciliation_v2_project_raw_line(jsonb) from public, anon, authenticated;
revoke all on function public.reconciliation_v2_project_raw_lines(jsonb) from public, anon, authenticated;
revoke all on function public.reconciliation_v2_project_raw(jsonb) from public, anon, authenticated;
revoke all on function public.reconciliation_v2_analytics_events(uuid, date, date) from public, anon, authenticated;
grant execute on function public.reconciliation_v2_project_raw_line(jsonb) to service_role;
grant execute on function public.reconciliation_v2_project_raw_lines(jsonb) to service_role;
grant execute on function public.reconciliation_v2_project_raw(jsonb) to service_role;
grant execute on function public.reconciliation_v2_analytics_events(uuid, date, date) to service_role;