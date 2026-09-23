create or replace view public.review_winerim_variants_all with (security_invoker = true) as
with declared as (
  select f.connection_id, f.winerim_id, upper(f.format_key) as format_key,
         f.sale_price, f.cost_price, f.stock_id,
         coalesce(f.source_variant, f.format_key) as variant_source,
         'WINE_FORMATS'::text as origin,
         f.is_active as format_is_active
  from winerim_wine_formats f
), derived as (
  select w1.connection_id, w1.winerim_id, v.format_key, v.sale_price, v.cost_price,
         v.stock_id, v.format_key as variant_source, 'WINE_COLUMNS'::text as origin,
         true as format_is_active
  from winerim_wines w1
  cross join lateral (values
    ('BOTTLE'::text, w1.bottle_sale_price, w1.bottle_purchase_price, w1.bottle_stock_id),
    ('GLASS'::text, w1.glass_sale_price, w1.glass_cost_price, w1.glass_stock_id),
    ('MAGNUM'::text, w1.magnum_sale_price, w1.magnum_purchase_price, w1.magnum_stock_id)
  ) v(format_key, sale_price, cost_price, stock_id)
  where v.sale_price is not null or v.stock_id is not null
), unioned as (
  select * from declared
  union all
  select d.* from derived d
  where not exists (
    select 1 from declared dc
    where dc.connection_id = d.connection_id and dc.winerim_id = d.winerim_id
      and dc.format_key = d.format_key)
)
select w.connection_id, w.winerim_id, w.name, w.vintage, w.winery, w.region,
       w.grape_variety, w.wine_type, w.sku, w.ean, w.is_active,
       u.format_key, u.sale_price, u.cost_price, u.stock_id, u.variant_source,
       u.origin, u.format_is_active,
       review_format_liters(u.format_key) as capacity_liters
from winerim_wines w
join unioned u on u.connection_id = w.connection_id and u.winerim_id = w.winerim_id;

revoke all on public.review_winerim_variants_all from anon;
grant select on public.review_winerim_variants_all to authenticated;

drop function if exists public.review_search_winerim_variants(uuid, text, text, integer, integer);

create function public.review_search_winerim_variants(
  p_connection_id uuid,
  p_query text default null,
  p_format text default null,
  p_limit integer default 25,
  p_offset integer default 0,
  p_include_inactive boolean default false
) returns table(
  winerim_id text, name text, vintage text, winery text, region text,
  grape_variety text, wine_type text, sku text, ean text, format_key text,
  capacity_liters numeric, sale_price numeric, cost_price numeric, stock_id bigint,
  variant_source text, origin text, wine_is_active boolean,
  format_is_active boolean, total_count bigint
) language sql stable set search_path = public as $$
with terms as (
  select array_remove(string_to_array(public.review_normalize_text(coalesce(p_query, '')), ' '), '') as t
), base as (
  select v.*,
         public.review_normalize_text(concat_ws(' ',
           v.name, v.vintage, v.winery, v.region, v.grape_variety, v.wine_type,
           v.winerim_id, v.sku, v.ean, v.format_key, v.variant_source)) as haystack
  from public.review_winerim_variants_all v
  where v.connection_id = p_connection_id
    and (coalesce(p_include_inactive, false)
         or (v.is_active = true and v.format_is_active = true))
), matched as (
  select b.* from base b, terms
  where (cardinality(terms.t) = 0
         or (select bool_and(position(x in b.haystack) > 0) from unnest(terms.t) as x))
    and (p_format is null or p_format = '' or p_format = 'SIN_DATO' or b.format_key = p_format)
)
select m.winerim_id, m.name, m.vintage, m.winery, m.region, m.grape_variety,
       m.wine_type, m.sku, m.ean, m.format_key, m.capacity_liters, m.sale_price,
       m.cost_price, m.stock_id, m.variant_source, m.origin,
       m.is_active as wine_is_active, m.format_is_active,
       count(*) over () as total_count
from matched m
order by m.is_active desc, m.format_is_active desc, m.name, m.format_key
limit greatest(coalesce(p_limit, 25), 1) offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.review_search_winerim_variants(uuid, text, text, integer, integer, boolean) from anon;
grant execute on function public.review_search_winerim_variants(uuid, text, text, integer, integer, boolean) to authenticated;