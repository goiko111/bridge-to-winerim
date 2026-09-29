create or replace function public.reconciliation_v2_analytics_aggregate(p_connection_id uuid, p_from date, p_to date, p_anchor date)
returns jsonb
language plpgsql stable security invoker set search_path = public set timezone = 'UTC' as $$
declare result jsonb;
begin
  if p_connection_id is null or p_from is null or p_to is null or p_anchor is null then
    raise exception 'ANALYTICS_ARGS_REQUIRED' using errcode = '22023'; end if;
  if p_from >= p_to then raise exception 'ANALYTICS_WINDOW_INVALID' using errcode = '22023'; end if;
  if p_to - p_from > 28 then raise exception 'ANALYTICS_WINDOW_TOO_LARGE' using errcode = '22023'; end if;
  if p_anchor < p_from or p_anchor >= p_to then raise exception 'ANALYTICS_ANCHOR_OUTSIDE_WINDOW' using errcode = '22023'; end if;
  if not exists (select 1 from public.pos_connections c where c.id = p_connection_id) then
    raise exception 'ANALYTICS_CONNECTION_NOT_FOUND' using errcode = '22023'; end if;

  with ev as materialized (
    select e.id, e.provider_doc_id, e.business_day, e.doc_type, e.raw_json raw,
      ((row_number() over (partition by e.business_day order by e.id)) - 1) / 200 as chunk_no
    from public.sales_events e
    where e.connection_id = p_connection_id and e.business_day >= p_from and e.business_day < p_to
      and e.doc_type ~* '(invoice|refund)' and e.doc_type !~* '(open|draft|ticket|order|void|cancelled|canceled)'
  ),
  containers as (
    select ev.id event_id, ev.raw container from ev where jsonb_typeof(ev.raw) = 'object'
    union all
    select ev.id, it from ev,
      lateral jsonb_array_elements(case when jsonb_typeof(ev.raw->'invoiceItems') = 'array' then ev.raw->'invoiceItems'
        when jsonb_typeof(ev.raw->'InvoiceItems') = 'array' then ev.raw->'InvoiceItems' else '[]'::jsonb end) it
    where jsonb_typeof(ev.raw) = 'object' and jsonb_typeof(it) = 'object'
  ),
  cand as materialized (
    select c.event_id, c.container, l,
      public.rv2_ident(public.rv2_field(l, 'providerProductId', 'ProductId')) pid,
      public.rv2_norm(public.rv2_num(public.rv2_field(l, 'quantity', 'Quantity'))) qty
    from containers c,
      lateral jsonb_array_elements(case when jsonb_typeof(c.container->'lines') = 'array' then c.container->'lines'
        when jsonb_typeof(c.container->'Lines') = 'array' then c.container->'Lines' else '[]'::jsonb end) l
    where jsonb_typeof(l) = 'object'
  ),
  li as materialized (
    select s.id line_id, s.provider_product_id, s.format, s.quantity, s.total_amount, s.winerim_product_id, s.mapped, s.family, s.name,
      s.provider_sold_at, ev.id event_id, ev.provider_doc_id, ev.business_day, ev.doc_type, ev.raw, ev.chunk_no
    from ev join public.sales_line_items s on s.sales_event_id = ev.id
  ),
  pairs as (
    select li.line_id, cand.l, cand.container
    from li join cand on cand.event_id = li.event_id
      and coalesce(cand.pid, E'\\x01') = coalesce(nullif(public.rv2_trim(li.provider_product_id), ''), E'\\x01')
      and coalesce(cand.qty, -999999999999) = coalesce(public.rv2_norm(li.quantity), -999999999999)
    where li.total_amount is not null
      and public.rv2_norm(li.total_amount) in (
        public.rv2_norm(public.rv2_num(public.rv2_field(cand.l, 'totalAmount', 'TotalAmount'))),
        public.rv2_norm(public.rv2_num(public.rv2_field(cand.l, 'unitPrice', 'UnitPrice')) * cand.qty),
        public.rv2_norm(public.rv2_num(public.rv2_field(cand.l, 'productPrice', 'ProductPrice')) * cand.qty))
      and public.rv2_time_key(public.rv2_field(cand.l, 'soldAt', 'CreationDate')) is not distinct from
        case when li.provider_sold_at is null then null else 'T:' || floor(extract(epoch from li.provider_sold_at) * 1000)::bigint::text end
      and (public.rv2_ntext(public.rv2_field(cand.l, 'productName', 'ProductName') #>> '{}') = ''
        or public.rv2_ntext(li.name) = ''
        or public.rv2_ntext(public.rv2_field(cand.l, 'productName', 'ProductName') #>> '{}') = public.rv2_ntext(li.name))
  ),
  pair_agg as (
    select line_id, count(*) n, (array_agg(l))[1] l, (array_agg(container))[1] container from pairs group by line_id
  ),
  matched as (
    select li.*, coalesce(p.n, 0) n, p.l, p.container from li left join pair_agg p on p.line_id = li.line_id
  ),
  ident as (
    select matched.*,
      case when n = 1 then coalesce(public.rv2_num(public.rv2_field(l, 'totalAmount', 'TotalAmount')), li_amount) end amount,
      case when n = 1 then coalesce(
        public.rv2_text(raw->'lifecycleId'), public.rv2_text(raw->'documentId'),
        public.rv2_ident(public.rv2_field(container, 'globalId', 'GlobalId')), public.rv2_ident(public.rv2_field(raw, 'globalId', 'GlobalId')),
        public.rv2_ident(public.rv2_field(raw, 'number', 'Number')), public.rv2_text(to_jsonb(provider_doc_id))) end ord,
      case when n = 1 then coalesce(public.rv2_ident(public.rv2_field(l, 'lineId', 'LineId')),
        case when coalesce(public.rv2_ident(public.rv2_field(container, 'globalId', 'GlobalId')), public.rv2_ident(public.rv2_field(raw, 'globalId', 'GlobalId'))) is not null
          and public.rv2_ident(public.rv2_field(l, 'index', 'Index')) is not null
          then coalesce(public.rv2_ident(public.rv2_field(container, 'globalId', 'GlobalId')), public.rv2_ident(public.rv2_field(raw, 'globalId', 'GlobalId'))) || ':' || public.rv2_ident(public.rv2_field(l, 'index', 'Index')) end) end src_line,
      case when n = 1 then public.rv2_text(public.rv2_field(l, 'soldAt', 'CreationDate')) end eff
    from (select matched.*, total_amount li_amount from matched) matched
  ),
  keyed as (
    select ident.*,
      case when ord is not null and src_line is not null and eff is not null and nullif(provider_product_id, '') is not null then
        concat_ws('|',
          case when public.rv2_truthy(raw->'isRefund') or (coalesce(raw->>'kind', '') || ' ' || doc_type) ~* 'refund' then 'REFUND' else 'SALE' end,
          ord, src_line, provider_product_id, coalesce(format, ''), quantity::float8::text,
          coalesce(public.rv2_num(public.rv2_field(l, 'totalAmount', 'TotalAmount'))::float8::text, total_amount::float8::text, ''), eff) end identity
    from ident
  ),
  stats as (
    select count(*) identity_lines, count(*) filter (where identity is null) missing_identity, count(*) filter (where amount is null) missing_amount from keyed
  ),
  dedup as (
    select * from (
      select k.*, row_number() over (partition by identity order by business_day desc, chunk_no desc, line_id desc) rn
      from keyed k where identity is not null and amount is not null) x where rn = 1
  ),
  lines as (
    select d.business_day d, d.provider_doc_id ticket, (d.doc_type ~* 'refund') is_return,
      coalesce(public.rv2_text(d.raw->'currency'), case when jsonb_typeof(d.raw->'amounts') = 'object' then public.rv2_text(d.raw->'amounts'->'currency') end) currency,
      case when d.mapped = true and coalesce(d.winerim_product_id, '') <> '' then 'WINE'
        else coalesce(
          (select r.category from public.reconciliation_v2_category_rules r where r.connection_id = p_connection_id and coalesce(r.provider_product_id, '') = coalesce(d.provider_product_id, '') and coalesce(r.family_key, '') = coalesce(d.family, '') order by r.category limit 1),
          (select r.category from public.reconciliation_v2_category_rules r where r.connection_id = p_connection_id and coalesce(r.provider_product_id, '') = coalesce(d.provider_product_id, '') and coalesce(r.family_key, '') = '' order by r.category limit 1),
          (select r.category from public.reconciliation_v2_category_rules r where r.connection_id = p_connection_id and coalesce(r.provider_product_id, '') = '' and coalesce(r.family_key, '') = coalesce(d.family, '') order by r.category limit 1),
          'UNCLASSIFIED') end category,
      (case when d.doc_type ~* 'refund' then -1 else 1 end) * abs(d.quantity) qty,
      (case when d.doc_type ~* 'refund' then -1 else 1 end) * abs(floor(d.amount * 100 + 0.5)) rev
    from dedup d
  ),
  expanded as (
    select 'DAY' period, d period_start, * from lines
    union all select 'WEEK', d - (extract(isodow from d)::int - 1), * from lines
    union all select 'MONTH', date_trunc('month', d)::date, * from lines
    union all select 'ROLLING_7D', p_anchor - 6, * from lines where d between p_anchor - 6 and p_anchor
    union all select 'ROLLING_28D', p_anchor - 27, * from lines where d between p_anchor - 27 and p_anchor
  ),
  buckets as (
    select period, period_start, category, sum(qty) quantity, sum(rev) revenue, count(distinct ticket) tickets,
      case when count(distinct currency) = 1 then min(currency) end currency
    from expanded group by period, period_start, category
    union all
    select period, period_start, 'ALL', sum(qty), sum(rev), count(distinct ticket),
      case when count(distinct currency) = 1 then min(currency) end
    from expanded group by period, period_start
  )
  select jsonb_build_object(
    'identityLines', (select identity_lines from stats),
    'missingIdentityLines', (select missing_identity from stats),
    'missingAmountLines', (select missing_amount from stats),
    'includedLines', (select count(*) from lines),
    'anchorLines', (select count(*) from lines where d = p_anchor),
    'anchorCategoryLines', coalesce((select jsonb_object_agg(category, n) from (select category, count(*) n from lines where d = p_anchor group by category) a), '{}'::jsonb),
    'buckets', coalesce((select jsonb_agg(jsonb_build_object('period', period, 'periodStart', period_start, 'category', category, 'quantity', quantity, 'revenueMinor', revenue, 'ticketCount', tickets, 'currency', currency)
      order by period, period_start, category) from buckets), '[]'::jsonb)
  ) into result;
  return result;
end $$;