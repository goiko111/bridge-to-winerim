create or replace function reconciliation_private.refresh_analytics_day(p_connection_id uuid, p_business_day date, p_only_missing boolean)
returns jsonb
language plpgsql volatile security invoker set search_path = '' set timezone = 'UTC' as $$
declare v_n integer; v_h text; v_j jsonb;
begin
  if p_connection_id is null or p_business_day is null then raise exception 'ANALYTICS_ARGS_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from public.pos_connections c where c.id = p_connection_id) then
    raise exception 'ANALYTICS_CONNECTION_NOT_FOUND' using errcode = '22023'; end if;
  if p_only_missing and exists (select 1 from reconciliation_private.analytics_projection_days d where d.connection_id = p_connection_id and d.business_day = p_business_day and d.status = 'COMPLETE') then
    select jsonb_build_object('businessDay', d.business_day, 'skipped', true, 'lines', d.line_count, 'sliceHash', d.slice_hash) into strict v_j
      from reconciliation_private.analytics_projection_days d where d.connection_id = p_connection_id and d.business_day = p_business_day;
    return v_j;
  end if;

  delete from reconciliation_private.analytics_line_projection p where p.connection_id = p_connection_id and p.business_day = p_business_day;

  with ev as materialized (
    select e.id, e.provider_doc_id, e.business_day, e.doc_type,
      ((pg_catalog.row_number() over (partition by e.business_day order by e.id)) - 1) / 200 as chunk_no,
      reconciliation_private.rv2_text(e.raw_json->'lifecycleId') r_lifecycle, reconciliation_private.rv2_text(e.raw_json->'documentId') r_document,
      reconciliation_private.rv2_ident(reconciliation_private.rv2_field(e.raw_json, 'globalId', 'GlobalId')) r_gid,
      reconciliation_private.rv2_ident(reconciliation_private.rv2_field(e.raw_json, 'number', 'Number')) r_number,
      (reconciliation_private.rv2_truthy(e.raw_json->'isRefund') or (coalesce(e.raw_json->>'kind', '') || ' ' || e.doc_type) ~* 'refund') r_refund,
      coalesce(reconciliation_private.rv2_text(e.raw_json->'currency'), case when pg_catalog.jsonb_typeof(e.raw_json->'amounts') = 'object' then reconciliation_private.rv2_text(e.raw_json->'amounts'->'currency') end) r_currency,
      case when pg_catalog.jsonb_typeof(e.raw_json) = 'object' then e.raw_json end raw
    from public.sales_events e
    where e.connection_id = p_connection_id and e.business_day = p_business_day
      and e.doc_type ~* '(invoice|refund)' and e.doc_type !~* '(open|draft|ticket|order|void|cancelled|canceled)'
  ),
  containers as (
    select ev.id event_id, ev.raw container from ev where ev.raw is not null
    union all
    select ev.id, it from ev,
      lateral pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(ev.raw->'invoiceItems') = 'array' then ev.raw->'invoiceItems'
        when pg_catalog.jsonb_typeof(ev.raw->'InvoiceItems') = 'array' then ev.raw->'InvoiceItems' else '[]'::jsonb end) it
    where ev.raw is not null and pg_catalog.jsonb_typeof(it) = 'object'
  ),
  cand0 as (
    select c.event_id, reconciliation_private.rv2_ident(reconciliation_private.rv2_field(c.container, 'globalId', 'GlobalId')) c_gid, l,
      reconciliation_private.rv2_norm(reconciliation_private.rv2_num(reconciliation_private.rv2_field(l, 'quantity', 'Quantity'))) qty
    from containers c,
      lateral pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(c.container->'lines') = 'array' then c.container->'lines'
        when pg_catalog.jsonb_typeof(c.container->'Lines') = 'array' then c.container->'Lines' else '[]'::jsonb end) l
    where pg_catalog.jsonb_typeof(l) = 'object'
  ),
  cand as materialized (
    select event_id, c_gid, qty, l,
      reconciliation_private.rv2_ident(reconciliation_private.rv2_field(l, 'providerProductId', 'ProductId')) pid,
      reconciliation_private.rv2_norm(reconciliation_private.rv2_num(reconciliation_private.rv2_field(l, 'totalAmount', 'TotalAmount'))) a1,
      case when qty is null then null else reconciliation_private.rv2_norm(reconciliation_private.rv2_num(reconciliation_private.rv2_field(l, 'unitPrice', 'UnitPrice')) * qty) end a2,
      case when qty is null then null else reconciliation_private.rv2_norm(reconciliation_private.rv2_num(reconciliation_private.rv2_field(l, 'productPrice', 'ProductPrice')) * qty) end a3
    from cand0
  ),
  li as materialized (
    select s.id line_id, s.provider_product_id, s.format, s.quantity, s.total_amount, s.winerim_product_id, s.mapped, s.family, s.created_at,
      s.name, coalesce(nullif(reconciliation_private.rv2_trim(s.provider_product_id), ''), E'\\x01') pid_key,
      coalesce(reconciliation_private.rv2_norm(s.quantity), -999999999999) qty_key, reconciliation_private.rv2_norm(s.total_amount) amt_key,
      case when s.provider_sold_at is null then null else 'T:' || pg_catalog.floor(extract(epoch from s.provider_sold_at) * 1000)::bigint::text end tkey,
      ev.id event_id, ev.provider_doc_id, ev.business_day, ev.doc_type, ev.chunk_no, ev.r_lifecycle, ev.r_document, ev.r_gid, ev.r_number, ev.r_refund, ev.r_currency
    from ev join public.sales_line_items s on s.sales_event_id = ev.id
  ),
  pre as (
    select li.line_id, li.tkey, li.name, cand.c_gid, cand.l
    from li join cand on cand.event_id = li.event_id
      and coalesce(cand.pid, E'\\x01') = li.pid_key
      and coalesce(cand.qty, -999999999999) = li.qty_key
    where li.amt_key is not null and li.amt_key in (cand.a1, cand.a2, cand.a3)
  ),
  pairs as (
    select pre.line_id, pre.c_gid, pre.l from pre
    where reconciliation_private.rv2_time_key(reconciliation_private.rv2_field(pre.l, 'soldAt', 'CreationDate')) is not distinct from pre.tkey
      and (reconciliation_private.rv2_ntext(reconciliation_private.rv2_field(pre.l, 'productName', 'ProductName') #>> '{}') = '' or reconciliation_private.rv2_ntext(pre.name) = ''
        or reconciliation_private.rv2_ntext(reconciliation_private.rv2_field(pre.l, 'productName', 'ProductName') #>> '{}') = reconciliation_private.rv2_ntext(pre.name))
  ),
  pair_agg0 as (
    select line_id, pg_catalog.count(*) n, (pg_catalog.array_agg(c_gid))[1] c_gid, (pg_catalog.array_agg(l))[1] l from pairs group by line_id
  ),
  pair_agg as (
    select line_id, n, c_gid,
      reconciliation_private.rv2_num(reconciliation_private.rv2_field(l, 'totalAmount', 'TotalAmount')) total_amt,
      reconciliation_private.rv2_text(reconciliation_private.rv2_field(l, 'soldAt', 'CreationDate')) sold_text,
      reconciliation_private.rv2_ident(reconciliation_private.rv2_field(l, 'lineId', 'LineId')) line_ident,
      reconciliation_private.rv2_ident(reconciliation_private.rv2_field(l, 'index', 'Index')) line_index
    from pair_agg0
  ),
  ident as (
    select li.*, p.total_amt,
      case when p.n = 1 then coalesce(p.total_amt, li.total_amount) end amount,
      case when p.n = 1 then coalesce(li.r_lifecycle, li.r_document, p.c_gid, li.r_gid, li.r_number, reconciliation_private.rv2_text(pg_catalog.to_jsonb(li.provider_doc_id))) end ord,
      case when p.n = 1 then coalesce(p.line_ident, case when coalesce(p.c_gid, li.r_gid) is not null and p.line_index is not null then coalesce(p.c_gid, li.r_gid) || ':' || p.line_index end) end src_line,
      case when p.n = 1 then p.sold_text end eff
    from li left join pair_agg p on p.line_id = li.line_id
  ),
  keyed as (
    select ident.*,
      case when ord is not null and src_line is not null and eff is not null and nullif(provider_product_id, '') is not null then
        pg_catalog.concat_ws('|',
          case when r_refund then 'REFUND' else 'SALE' end,
          ord, src_line, provider_product_id, coalesce(format, ''), quantity::float8::text,
          coalesce(total_amt::float8::text, total_amount::float8::text, ''), eff) end identity,
      (doc_type ~* 'refund') is_ret
    from ident
  ),
  rows as (
    select k.line_id, k.event_id, k.business_day, k.chunk_no::integer chunk_no, k.identity, k.amount, k.provider_doc_id ticket, k.is_ret,
      case when k.mapped = true and coalesce(k.winerim_product_id, '') <> '' then 'WINE'
        else coalesce(
          (select r.category from public.reconciliation_v2_category_rules r where r.connection_id = p_connection_id and coalesce(r.provider_product_id, '') = coalesce(k.provider_product_id, '') and coalesce(r.family_key, '') = coalesce(k.family, '') order by r.category limit 1),
          (select r.category from public.reconciliation_v2_category_rules r where r.connection_id = p_connection_id and coalesce(r.provider_product_id, '') = coalesce(k.provider_product_id, '') and coalesce(r.family_key, '') = '' order by r.category limit 1),
          (select r.category from public.reconciliation_v2_category_rules r where r.connection_id = p_connection_id and coalesce(r.provider_product_id, '') = '' and coalesce(r.family_key, '') = coalesce(k.family, '') order by r.category limit 1),
          'UNCLASSIFIED') end category,
      (case when k.is_ret then -1 else 1 end) * pg_catalog.abs(k.quantity) sqty,
      case when k.amount is null then null else (case when k.is_ret then -1 else 1 end) * pg_catalog.abs(pg_catalog.floor(k.amount * 100 + 0.5)) end rev,
      k.r_currency currency, k.created_at
    from keyed k
  )
  insert into reconciliation_private.analytics_line_projection as t (connection_id, source_line_item_id, sales_event_id, business_day, chunk_no, canonical_identity, amount, ticket_id, is_return, category, signed_quantity, revenue_minor, currency, source_updated_at, row_hash, refreshed_at)
  select p_connection_id, r.line_id, r.event_id, r.business_day, r.chunk_no, r.identity, r.amount, r.ticket, r.is_ret, r.category, r.sqty, r.rev, r.currency, r.created_at,
    pg_catalog.md5(pg_catalog.concat_ws('|', r.line_id, r.event_id, r.business_day, r.chunk_no, coalesce(r.identity, '<null>'), coalesce(r.amount::text, '<null>'), r.ticket, r.is_ret, r.category, coalesce(r.sqty::text, '<null>'), coalesce(r.rev::text, '<null>'), coalesce(r.currency, '<null>'))),
    pg_catalog.now()
  from rows r
  on conflict (connection_id, source_line_item_id) do update set sales_event_id = excluded.sales_event_id, business_day = excluded.business_day, chunk_no = excluded.chunk_no,
    canonical_identity = excluded.canonical_identity, amount = excluded.amount, ticket_id = excluded.ticket_id, is_return = excluded.is_return, category = excluded.category,
    signed_quantity = excluded.signed_quantity, revenue_minor = excluded.revenue_minor, currency = excluded.currency, source_updated_at = excluded.source_updated_at,
    row_hash = excluded.row_hash, refreshed_at = excluded.refreshed_at;

  delete from reconciliation_private.analytics_projection_days d
   where d.connection_id = p_connection_id and d.business_day <> p_business_day
     and d.line_count <> (select pg_catalog.count(*) from reconciliation_private.analytics_line_projection q where q.connection_id = p_connection_id and q.business_day = d.business_day);

  select pg_catalog.count(*), coalesce(pg_catalog.md5(pg_catalog.string_agg(p.row_hash, ',' order by p.source_line_item_id)), pg_catalog.md5(''))
    into v_n, v_h from reconciliation_private.analytics_line_projection p where p.connection_id = p_connection_id and p.business_day = p_business_day;
  insert into reconciliation_private.analytics_projection_days (connection_id, business_day, status, line_count, slice_hash, refreshed_at)
    values (p_connection_id, p_business_day, 'COMPLETE', v_n, v_h, pg_catalog.now())
    on conflict (connection_id, business_day) do update set status = 'COMPLETE', line_count = excluded.line_count, slice_hash = excluded.slice_hash, refreshed_at = excluded.refreshed_at;
  return jsonb_build_object('businessDay', p_business_day, 'skipped', false, 'lines', v_n, 'sliceHash', v_h);
end $$;
revoke all on function reconciliation_private.refresh_analytics_day(uuid,date,boolean) from public, anon, authenticated;
grant execute on function reconciliation_private.refresh_analytics_day(uuid,date,boolean) to service_role;